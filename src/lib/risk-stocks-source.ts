// ── 注意股／處置股：全站唯一來源 ────────────────────────────────────────
//
// ⚠ 這個檔案存在的理由（2026-08-11）：同一段抓取＋解析邏輯原本有**兩份複本**
//   （src/app/api/twse/risk-stocks/route.ts 與 src/lib/scoring-server.ts），
//   兩份都接錯端點，而我只修了其中一份 —— 另一份繼續錯，而且它影響的是**評分**。
//   複本正是這個 bug 會出現第二次的原因，所以合併成單一來源。
//   **新增消費端請 import 這裡，不要再複製一份解析。**
//
// 各端點的真實身分（都經實測，不是照名字猜的）：
//   TWSE 注意 = announcement/notice          欄位 Code / TradingInfoForAttention
//   TWSE 處置 = announcement/punish          欄位 Code / ReasonsOfDisposition / DispositionPeriod
//   TPEx 注意 = tpex_trading_warning_information  欄位 SecuritiesCompanyCode / TradingInformation
//   TPEx 處置 = tpex_disposal_information         欄位 SecuritiesCompanyCode / DispositionReasons
//
// ⚠ 曾經接錯的兩支，**不要再用**：
//   · exchangeReport/TWT48U_ALL —— 是**除權息預告表**（Exdividend / CashDividend，日期在未來）。
//     被當成注意股時，每一檔即將除權息的股票都被標成注意股：
//     線上實測 133 檔注意股裡 105 檔是假的，且在評分路徑上每檔白扣 20 分。
//   · opendata/t187ap10_L —— 是**月營收連續不足達X個月**名單，出表日期停在 1100427（2021），
//     而且是寬表不是逐檔清單。被當成處置股時解析結果恆為空
//     ⇒ 真正的上市處置股完全偵測不到，該扣的 40 分沒扣（錯誤方向與上一條相反）。
//
// ⚠ **絕對不要給 reason 一個寫死的 fallback**。原本四處都寫 `|| '列為注意股票'`，
//   於是端點換了、欄位對不上時程式不會壞，只會安靜地把每一列印成一句像模像樣的話——
//   有清單、有檔數、有理由，畫面完全看不出異常。這是上述兩個 bug 能存活數月的唯一原因。
//   注意股缺理由＝視為不是注意股（跳過）；處置股則保留（在名單上本身就是事實），
//   但要明說「來源未提供事由」，不要編。

import { memoize } from './singleflight';
import { holidaysAgeMs, isTradingYmd } from './market-clock';
import { primeHolidays } from './api-cache';

export interface RiskStockInfo {
  code: string;
  name: string;
  type: 'attention' | 'disposition';
  reason: string;
  measures?: string;
  startDate?: string;
  endDate?: string;
  source: 'TWSE' | 'TPEx';
}

export interface RiskStocksResult {
  attention: RiskStockInfo[];
  disposition: RiskStockInfo[];
  fetchedAt: string;
  /** 上市／上櫃注意股名單的「公布日」（ISO）。注意股是公布日隔天生效的狀態，畫面要標名單日期，不能讓人以為是即時判定。 */
  twseAttentionDate?: string | null;
  tpexAttentionDate?: string | null;
}

const TTL = 5 * 60 * 1000;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' };

async function fetchJSON(url: string): Promise<unknown> {
  try {
    const r = await fetch(url, { headers: UA, cache: 'no-store', signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const str = (v: unknown) => String(v ?? '').trim();
const isCode = (c: string) => /^\d{4,5}$/.test(c);

// 處置期間 → ISO。兩家格式不同，**都要吃**（2026-08-11 實測）：
//   TWSE punish：`115/08/07～115/08/20`（民國·帶斜線·全形波浪）
//   TPEx       ：`1150811~1150817`（民國·純數字）
// 只寫其中一種的話，另一家的起訖日會安靜地變成 undefined——
// 畫面上看起來就只是「沒有處置期間」，不會有人發現是解析漏了。
function splitPeriod(p: string): { startDate?: string; endDate?: string } {
  const toIso = (raw: string) => {
    const d = raw.replace(/\D/g, '');
    if (d.length < 6) return undefined;
    return `${+d.slice(0, -4) + 1911}-${d.slice(-4, -2)}-${d.slice(-2)}`;
  };
  const m = p.match(/(\d{2,3}[/\-]?\d{2}[/\-]?\d{2})\s*[~～-]\s*(\d{2,3}[/\-]?\d{2}[/\-]?\d{2})/);
  return m ? { startDate: toIso(m[1]), endDate: toIso(m[2]) } : {};
}

// ── 處置新制（2026-08-10 上路）校正 ─────────────────────────────────
// 證交所/櫃買修正處置制度：處置期間一般 5 個營業日、涉當沖注意 7 個營業日
// （原 10／12 日），且「已符合新天數者自實施日起即解除」。
// ⚠ 官方公告端點**不會回頭改舊公告的起迄日**——8046 實案（2026-08-14）：
//   公告仍寫 115/08/03～115/08/18，但新制下 8/3 起 7 個營業日 8/11 已滿、
//   8/12 起已解除；照抄公告會把人家多關 5 天，持股警示、評分扣分全跟著錯。
// 故迄日取「公告迄日」與「新制天數推算迄日」較早者，已屆滿者整筆剔除。
// ⚠ 3441 實案（2026-09-18）：營業日推算原本只跳週末，09-25 中秋、09-28 教師節沒算，
//   把官方正確的 09-18～09-30（7 個營業日）「縮短」成 09-28（那天根本休市）。
//   營業日一律走 system/tradingCalendar（primeHolidays）；日曆沒載到就**不縮短**、只剔除已屆滿。
const NEW_REGIME_START = '2026-08-10';

// 自 startIso 起算第 n 個營業日（start 當天算第 1 日；週末＋休市日曆都跳過）
export function nthTradingDay(startIso: string, n: number): string {
  const [y, m, d] = startIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const iso = () => dt.toISOString().slice(0, 10);
  let count = isTradingYmd(iso()) ? 1 : 0;
  let guard = 0;
  while (count < n && guard++ < 60) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    if (isTradingYmd(iso())) count++;
  }
  return iso();
}

export function applyNewDispositionRegime(list: RiskStockInfo[], today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })): RiskStockInfo[] {
  const calendarLoaded = holidaysAgeMs() !== Infinity;
  const out: RiskStockInfo[] = [];
  for (const d of list) {
    if (!d.startDate || !d.endDate) { out.push(d); continue; }          // 無日期可算 → 原樣保留
    if (d.endDate < NEW_REGIME_START) { out.push(d); continue; }        // 新制上路前已結束 → 歷史事實不動
    const days = /當沖|沖銷/.test(d.reason) ? 7 : 5;                    // 涉當沖 7 日、一般 5 日
    const newEnd = calendarLoaded ? nthTradingDay(d.startDate, days) : d.endDate;   // 無日曆 → 不縮短
    const effEnd = newEnd < d.endDate ? newEnd : d.endDate;
    if (effEnd < today) continue;                                       // 新制下已解除 → 剔除
    out.push(effEnd === d.endDate ? d : {
      ...d, endDate: effEnd,
      reason: `${d.reason}（依8/10處置新制縮短至 ${effEnd}）`.slice(0, 200),
    });
  }
  return out;
}

// 手寫快取 → memoize（同 fundamentals-server 的理由：in-flight 合流＋失敗負快取）。
// 四個上游並行、各 8s 上限 ⇒ timeoutMs 12s。兩清單皆空視為降級（正常日極少見，
// 走 30s 負快取重試的代價只是四次輕量 fetch）。
// ROC「115.09.16」／「1150916」→ ISO
const rocToIso = (v: string) => { const d = v.replace(/\D/g, ''); return d.length >= 7 ? `${+d.slice(0, -4) + 1911}-${d.slice(-4, -2)}-${d.slice(-2)}` : ''; };
const ymd = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(/-/g, '');

const _riskStocks = memoize('risk-stocks', TTL, async (): Promise<RiskStocksResult> => {
  // ⚠ 上市注意股不能只讀 openapi「當日公布」端點（2026-09-17 實案：尖點／全友／光罩三檔不見）：
  //   那支在新名單公布前（收盤後到傍晚，openapi 鏡像本來就落後一日）回一筆全空白佔位列，
  //   於是每天有大半時間上市注意股整批為 0，畫面只是「清單變短」，不報錯。
  //   注意股是「公布日隔天生效」的狀態 ⇒ 正解是 rwd 區間查詢最近 7 天、取**最新一個有資料的公布日**那批，
  //   並把名單日期回給畫面；openapi 當日端點只當補充（若它已有今天的，會是更新的那批）。
  await primeHolidays().catch(() => null);   // 處置營業日推算要用休市日曆；載不到走 fail-open（不縮短）
  const now = new Date(); const from = new Date(now.getTime() - 7 * 86400000);
  const [twAttRange, twAtt, twNote, twDisp, tpAtt, tpDisp] = await Promise.all([
    fetchJSON(`https://www.twse.com.tw/rwd/zh/announcement/notice?startDate=${ymd(from)}&endDate=${ymd(now)}&response=json`),
    fetchJSON('https://openapi.twse.com.tw/v1/announcement/notice'),
    fetchJSON('https://openapi.twse.com.tw/v1/announcement/notetrans'),
    fetchJSON('https://openapi.twse.com.tw/v1/announcement/punish'),
    fetchJSON('https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information'),
    fetchJSON('https://www.tpex.org.tw/openapi/v1/tpex_disposal_information'),
  ]);

  const attention: RiskStockInfo[] = [];
  const disposition: RiskStockInfo[] = [];
  const rows = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  let twseAttentionDate: string | null = null;
  let tpexAttentionDate: string | null = null;

  // TWSE 注意：rwd 區間 → 依日期分組取最新一批。欄位順序以 fields 對名，不寫死索引（端點身分要驗）。
  {
    const j = (twAttRange && typeof twAttRange === 'object') ? (twAttRange as { stat?: string; fields?: string[]; data?: unknown[][] }) : null;
    const fields = j?.fields || [];
    const iCode = fields.indexOf('證券代號'), iName = fields.indexOf('證券名稱'), iReason = fields.indexOf('注意交易資訊'), iDate = fields.indexOf('日期'), iCnt = fields.indexOf('累計次數');
    if (j?.stat === 'OK' && iCode >= 0 && iReason >= 0 && iDate >= 0) {
      const rowsByDay: Record<string, unknown[][]> = {};
      for (const r of (j.data || [])) { const d = rocToIso(str(r[iDate])); if (d) (rowsByDay[d] ||= []).push(r); }
      const latest = Object.keys(rowsByDay).sort().pop();
      if (latest) {
        twseAttentionDate = latest;
        for (const r of rowsByDay[latest]) {
          const code = str(r[iCode]), reason = str(r[iReason]);
          if (!isCode(code) || !reason) continue;
          const cnt = iCnt >= 0 ? str(r[iCnt]) : '';
          attention.push({ code, name: str(r[iName]), type: 'attention', reason: (cnt ? `累計 ${cnt} 次｜` : '') + reason.slice(0, 200), source: 'TWSE' });
        }
      }
    }
  }
  // openapi 當日端點：只有在區間查詢沒拿到、或它的日期更新時才用（無注意股時回一筆全空白佔位列，靠 code/reason 濾掉）
  {
    const list = rows(twAtt).filter(it => isCode(str(it.Code || it['證券代號'])) && str(it.TradingInfoForAttention || it['注意交易資訊']));
    const d0 = list.length ? rocToIso(str(list[0].Date || list[0]['日期'])) : '';
    if (list.length && (!twseAttentionDate || (d0 && d0 > twseAttentionDate))) {
      attention.splice(0, attention.length);   // 換成更新的那批
      twseAttentionDate = d0 || twseAttentionDate;
      for (const it of list) {
        attention.push({ code: str(it.Code || it['證券代號']), name: str(it.Name || it['證券名稱']), type: 'attention', reason: str(it.TradingInfoForAttention || it['注意交易資訊']).slice(0, 200), source: 'TWSE' });
      }
    }
  }
  // 注意累計次數可能達處置標準（notetrans）：只加註在已在名單上的檔，不把它當成注意股（不捏造身分）
  {
    const near = new Set(rows(twNote).map(it => str(it.Code)).filter(isCode));
    for (const a of attention) if (a.source === 'TWSE' && near.has(a.code)) a.reason = `⚠近期符合注意標準、累計次數可能達處置｜${a.reason}`.slice(0, 200);
  }
  // TWSE 處置
  for (const it of rows(twDisp)) {
    const code = str(it.Code || it['證券代號']);
    if (!isCode(code)) continue;
    const measures = str(it.DispositionMeasures || it['處置措施']);
    // ReasonsOfDisposition 只有「連續三次」這種極短字串，單獨看不出嚴重程度；
    // DispositionMeasures 是「第一次處置／第二次處置」——併起來才有判斷價值。
    const base = str(it.ReasonsOfDisposition || it['處置原因']);
    const reason = (base && measures ? `${base}（${measures}）` : base || measures) || '處置中（來源未提供事由）';
    disposition.push({
      code, name: str(it.Name || it['證券名稱']), type: 'disposition',
      reason: reason.slice(0, 200), measures: measures || undefined,
      ...splitPeriod(str(it.DispositionPeriod || it['處置期間'])), source: 'TWSE',
    });
  }
  // TPEx 注意（openapi 保留最後公布的名單，帶 Date 欄）
  for (const it of rows(tpAtt)) {
    const code = str(it.SecuritiesCompanyCode || it.Code);
    const reason = str(it.TradingInformation || it.Reason);
    if (isCode(code) && reason) {
      attention.push({ code, name: str(it.CompanyName || it.Name), type: 'attention', reason: reason.slice(0, 200), source: 'TPEx' });
      const d = rocToIso(str(it.Date || it['日期'])); if (d && (!tpexAttentionDate || d > tpexAttentionDate)) tpexAttentionDate = d;
    }
  }
  // TPEx 處置
  for (const it of rows(tpDisp)) {
    const code = str(it.SecuritiesCompanyCode || it.Code);
    if (!isCode(code)) continue;
    const measures = str(it.DisposalCondition || it['處置措施']);
    const reason = str(it.DispositionReasons || it.Reason) || measures || '處置中（來源未提供事由）';
    disposition.push({
      code, name: str(it.CompanyName || it.Name), type: 'disposition',
      reason: reason.slice(0, 200), measures: measures || undefined,
      ...splitPeriod(str(it.DispositionPeriod || it['處置期間'])), source: 'TPEx',
    });
  }

  return { attention, disposition: applyNewDispositionRegime(disposition), fetchedAt: new Date().toISOString(), twseAttentionDate, tpexAttentionDate };
}, { timeoutMs: 12_000, isDegraded: v => {
  const r = v as RiskStocksResult; return !r.attention.length && !r.disposition.length;
} });

export async function fetchRiskStocks(): Promise<RiskStocksResult> {
  return (await _riskStocks()) ?? { attention: [], disposition: [], fetchedAt: new Date().toISOString() };
}
