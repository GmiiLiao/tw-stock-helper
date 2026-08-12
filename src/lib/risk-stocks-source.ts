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

// 手寫快取 → memoize（同 fundamentals-server 的理由：in-flight 合流＋失敗負快取）。
// 四個上游並行、各 8s 上限 ⇒ timeoutMs 12s。兩清單皆空視為降級（正常日極少見，
// 走 30s 負快取重試的代價只是四次輕量 fetch）。
const _riskStocks = memoize('risk-stocks', TTL, async (): Promise<RiskStocksResult> => {

  const [twAtt, twDisp, tpAtt, tpDisp] = await Promise.all([
    fetchJSON('https://openapi.twse.com.tw/v1/announcement/notice'),
    fetchJSON('https://openapi.twse.com.tw/v1/announcement/punish'),
    fetchJSON('https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information'),
    fetchJSON('https://www.tpex.org.tw/openapi/v1/tpex_disposal_information'),
  ]);

  const attention: RiskStockInfo[] = [];
  const disposition: RiskStockInfo[] = [];
  const rows = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

  // TWSE 注意（端點在無注意股時會回一筆全空白的佔位列，靠 code/reason 檢查濾掉）
  for (const it of rows(twAtt)) {
    const code = str(it.Code || it['證券代號']);
    const reason = str(it.TradingInfoForAttention || it['注意交易資訊']);
    if (isCode(code) && reason) {
      attention.push({ code, name: str(it.Name || it['證券名稱']), type: 'attention', reason: reason.slice(0, 200), source: 'TWSE' });
    }
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
  // TPEx 注意
  for (const it of rows(tpAtt)) {
    const code = str(it.SecuritiesCompanyCode || it.Code);
    const reason = str(it.TradingInformation || it.Reason);
    if (isCode(code) && reason) {
      attention.push({ code, name: str(it.CompanyName || it.Name), type: 'attention', reason: reason.slice(0, 200), source: 'TPEx' });
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

  return { attention, disposition, fetchedAt: new Date().toISOString() };
}, { timeoutMs: 12_000, isDegraded: v => {
  const r = v as RiskStocksResult; return !r.attention.length && !r.disposition.length;
} });

export async function fetchRiskStocks(): Promise<RiskStocksResult> {
  return (await _riskStocks()) ?? { attention: [], disposition: [], fetchedAt: new Date().toISOString() };
}
