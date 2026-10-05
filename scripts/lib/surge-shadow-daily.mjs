// ── 起漲影子（a35 shadow）每日流程的決策邏輯（純函式，不碰 I/O）────────────────────────────
// 協調器 scripts/surge-lab/a35_shadow_daily.mjs 用：哪一天要產生名單、哪一天已錯過、哪些名單要對答案、哪幾天要補抓除權息、
// 有沒有研究程序正在改寫共用快取、鎖是否還有人持有。
//   · 下一交易日一律由休市日曆推得（Firestore system/tradingCalendar ∪ 本機官方鏡像休市表）；平日落在日曆未涵蓋的年份就丟錯，
//     不猜「下一個週一～五」（2026-10-09、10-26 是補假）。與 a35_shadow_lib.py 的 next_trading_day 同一條規則（兩邊測試同一組案例）。
//   · 錯過＝現在已過「下一交易日 08:45」還沒有事前凍結名單（名單本身的凍結閘是 09:00，留 15 分鐘給訓練）。
//   · 產生條件＝收盤＋法人到齊（canonical-gate.archiveDayStatus）、站上 pred 已定版，**且模型輸入到齊**（資券／借券兩市、上市當沖；
//     modelInputsStatus）——模型吃 ML／MS／LEND／DT 等 11 欄，這些 19:45～21:49 才進歸檔；只看收盤＋法人會在 17:30 就用殘缺資料凍結（2026-10-04 審查）。
//   · 臨時休市（颱風假）事前不在日曆：對答案以「現在的」日曆重算下一交易日；整天沒有歸檔、之後的交易日卻有歸檔的日子
//     記為「疑似臨時休市」與一般缺口分開，日曆補上後自動排除。
// 影子模式：不取代、不修改站上預測。非投資建議。
import { TSE_SAMPLES } from './canonical-gate.mjs';

export const RESEARCH_ENV_VARS = ['SURGE_OFFICIAL_LIMIT', 'SURGE_REVENUE', 'SURGE_PIT_STRICT', 'SURGE_DATASET_SUFFIX'];
export const PIPELINE_START = '2026-10-02';      // 第一份事前凍結名單的打分日；更早的日子只有歷史回推，不算缺口
export const DEADLINE_HHMM = '08:45';
export const TRADING_MARK_RE = /開始交易|最後交易/;
export const LOOKBACK_DOCS = 8;                  // 每輪讀最近幾份 chipArchive（只取判斷到齊需要的欄位）
/** 上櫃資券／借券樣本——與 ai-daemon archiveChipDaily 的 hasOtcMargin／hasOtcLend 同一組 */
export const OTC_MARGIN_SAMPLES = ['6274', '8069', '5483'];
/** dayTradeJson 只收上市（設計限制，見 ai-daemon 註解）；寫入端 > 100 檔才寫 */
export const MIN_DAYTRADE_CODES = 100;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 環境中有設的研究用變數（有設＝存在，空字串也算） */
export const envLeak = env => RESEARCH_ENV_VARS.filter(k => Object.prototype.hasOwnProperty.call(env || {}, k));

export function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow = iso => new Date(`${iso}T00:00:00Z`).getUTCDay();
export const rocToIso = roc => (/^\d{7}$/.test(String(roc || '')) ? `${+String(roc).slice(0, 3) + 1911}-${String(roc).slice(3, 5)}-${String(roc).slice(5, 7)}` : null);

/**
 * 休市日曆：Firestore 文件（holidays／coverYear／official）與鏡像原文列（{Name, Date 民國 7 碼}）取聯集。
 * @returns {{ holidays:Set<string>, covered:Set<number>, sources:string[] } | null}
 */
export function makeCalendar(fsDoc, mirrorRows) {
  const holidays = new Set(); const covered = new Set(); const sources = [];
  if (fsDoc && Array.isArray(fsDoc.holidays) && fsDoc.holidays.length) {
    for (const d of fsDoc.holidays) holidays.add(String(d));
    const cy = fsDoc.coverYear ?? (Array.isArray(fsDoc.official) && fsDoc.official.length ? String(fsDoc.official[0]).slice(0, 4) : null);
    if (cy) covered.add(Number(cy));
    sources.push('firestore:system/tradingCalendar');
  }
  if (Array.isArray(mirrorRows) && mirrorRows.length) {
    let n = 0;
    for (const row of mirrorRows) {
      const iso = rocToIso(row?.Date);
      if (!iso) continue;
      n++; covered.add(Number(iso.slice(0, 4)));
      if (!TRADING_MARK_RE.test(String(row.Name || ''))) holidays.add(iso);
    }
    if (n) sources.push('mirror:twse_oa_holidaySchedule');
  }
  return sources.length ? { holidays, covered, sources } : null;
}

const parseObj = s => { try { const o = s ? JSON.parse(s) : null; return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };

/**
 * 模型輸入（收盤＋法人之外）是否已進歸檔：資券（上市＋上櫃）、借券（上市＋上櫃）、當沖（上市）。
 * 判斷與 daemon 寫入端同一組樣本（hasOtcMargin：值為真；hasOtcLend：鍵存在，借券餘額可為 0）；欄位缺就照實列入 missing，不補預設值。
 * @returns {{ ready: boolean, missing: string[], counts: { margin: number|null, lending: number|null, dayTrade: number|null } }}
 */
export function modelInputsStatus(doc) {
  const mg = parseObj(doc?.marginJson), ld = parseObj(doc?.lendingJson), dt = parseObj(doc?.dayTradeJson);
  const missing = [];
  if (!mg || !TSE_SAMPLES.some(c => mg[c])) missing.push('上市資券');
  if (!mg || !OTC_MARGIN_SAMPLES.some(c => mg[c])) missing.push('上櫃資券');
  if (!ld || !TSE_SAMPLES.some(c => ld[c] !== undefined)) missing.push('上市借券');
  if (!ld || !OTC_MARGIN_SAMPLES.some(c => ld[c] !== undefined)) missing.push('上櫃借券');
  if (!dt || Object.keys(dt).length <= MIN_DAYTRADE_CODES) missing.push('上市當沖');
  const n = o => (o ? Object.keys(o).length : null);
  return { ready: missing.length === 0, missing, counts: { margin: n(mg), lending: n(ld), dayTrade: n(dt) } };
}

/** 是否交易日（平日且不在休市表；不檢查涵蓋年份——只用來篩已存在的歸檔日） */
export const isTradingDay = (iso, cal) => dow(iso) !== 0 && dow(iso) !== 6 && !cal.holidays.has(iso);

/** iso 之後第一個交易日。平日落在日曆未涵蓋的年份 ⇒ 丟錯（不猜）。 */
export function nextTradingDay(iso, cal) {
  if (!cal) throw new Error('沒有休市日曆（Firestore 與本機鏡像都讀不到）');
  let d = iso;
  for (let i = 0; i < 31; i++) {
    d = addDaysIso(d, 1);
    if (dow(d) === 0 || dow(d) === 6) continue;
    if (!cal.covered.has(Number(d.slice(0, 4)))) throw new Error(`休市日曆未涵蓋 ${d.slice(0, 4)} 年（來源 ${cal.sources.join('、')}）——無法判定 ${iso} 的下一交易日`);
    if (!cal.holidays.has(d)) return d;
  }
  throw new Error(`${iso} 之後 31 天內找不到交易日（日曆異常）`);
}

/** (fromExcl, toIncl] 之間的交易日（升冪） */
export function tradingDaysBetween(fromExcl, toIncl, cal) {
  const out = [];
  for (let d = addDaysIso(fromExcl, 1); d <= toIncl; d = addDaysIso(d, 1)) if (isTradingDay(d, cal)) out.push(d);
  return out;
}

/** 台北時間 'YYYY-MM-DDTHH:MM'（台灣無日光節約，固定 +8） */
export const taipeiNow = (ms = Date.now()) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 16);
export const deadlineOf = (nextTD, hhmm = DEADLINE_HHMM) => `${nextTD}T${hhmm}`;

/**
 * 每個候選打分日的處置（升冪處理）：
 *   done＝out/shadow_{日}.json 已存在；missed＝已過下一交易日 08:45 仍沒有名單（已記過的不重記）；
 *   produce＝期限前、收盤＋法人到齊（archiveDayStatus.ready）、站上 pred 已定版（canonicalAt）且模型輸入到齊（inputsReady）；
 *   waiting＝期限前但條件未齊，或整天沒有歸檔文件、之後也還沒有任何歸檔（可能是臨時休市，待判斷）；
 *   suspected＝整天沒有歸檔文件、之後的交易日卻已有歸檔（疑似臨時休市或整日未歸檔；與一般缺口分開，休市日曆補上後就不在視窗內）。
 * days：[{ date, found, ready, missing, canonical, inputsReady, inputsMissing }]——視窗內每個交易日一筆（沒有歸檔文件 found=false）。
 * blocks：之前各輪 preflight 因研究程序擋下的時刻（台北 'YYYY-MM-DDTHH:MM'）；期限前被擋過的缺口會在原因註明。
 */
export function planDays({ days, cal, nowTw, hasList, missedBefore = new Set(), start = PIPELINE_START, blocks = [] }) {
  const plan = { produce: [], missed: [], waiting: [], done: [], errors: [], suspected: [] };
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const laterArchive = date => sorted.some(x => x.date > date && x.found !== false);
  for (const d of sorted) {
    if (!DAY_RE.test(d.date || '') || d.date < start) continue;
    if (hasList(d.date)) { plan.done.push(d.date); continue; }
    let nextTD;
    try { nextTD = nextTradingDay(d.date, cal); } catch (e) { plan.errors.push({ date: d.date, error: String(e.message || e) }); continue; }
    const deadline = deadlineOf(nextTD);
    if (d.found === false && laterArchive(d.date)) {
      plan.suspected.push({ scoringDay: d.date, reason: '整天沒有歸檔、之後的交易日已有歸檔：疑似臨時休市（颱風假等）或整日未歸檔，待休市日曆確認' });
      continue;
    }
    if (nowTw >= deadline) {
      if (d.found === false) { plan.waiting.push({ date: d.date, nextTD, deadline, why: '整天沒有歸檔（可能是臨時休市）：待之後交易日歸檔或休市日曆確認' }); continue; }
      if (!missedBefore.has(d.date)) {
        const blocked = blocks.filter(b => b > `${d.date}T13:30` && b < deadline);
        const reason = !d.ready ? `收盤歸檔未到齊（${(d.missing || []).join('、') || '未知'}）`
          : !d.canonical ? '站上 pred 未定版（無 canonicalAt）'
          : !d.inputsReady ? `模型輸入未到齊（${(d.inputsMissing || []).join('、') || '未知'}）`
          : blocked.length ? `期限前未產生：研究程序占用共用快取（preflight 擋下 ${blocked.length} 輪，最後 ${blocked.at(-1)}）`
          : '期限前未產生（協調器未執行或失敗）';
        plan.missed.push({ scoringDay: d.date, targetDay: nextTD, deadline, reason });
      }
      continue;
    }
    if (d.ready && d.canonical && d.inputsReady === true) plan.produce.push({ date: d.date, nextTD, deadline });
    else plan.waiting.push({ date: d.date, nextTD, deadline,
      why: !d.ready ? `收盤歸檔未到齊：${(d.missing || []).join('、')}` : !d.canonical ? '站上 pred 尚未定版' : `模型輸入未到齊：${(d.inputsMissing || []).join('、') || '未知'}` });
  }
  return plan;
}

/** 缺口／疑似休市紀錄裡，打分日已被（更新後的）休市日曆判為非交易日者剔除——臨時休市補進日曆後就不再算缺口 */
export const pruneNonTrading = (list, cal) => (list || []).filter(r => !r?.scoringDay || isTradingDay(r.scoringDay, cal));

/** 對答案的有效目標日：以「現在的」休市日曆重算打分日的下一交易日（臨時休市事後才進日曆）；日曆算不出時退回封印的 targetDay */
export function effectiveTarget(f, cal) {
  try { return nextTradingDay(f.scoringDay, cal); } catch { return f.targetDay; }
}

/**
 * 要對答案的事前凍結名單：還沒有對應封印的 shadow_score 檔，且有效目標日的收盤歸檔已到齊（只需收盤，archiveCloseReady）。
 * forward：[{ scoringDay, targetDay, sha256 }]；scoreSha：Map(scoringDay → 已有 score 檔的 frozenSha256)；closeReady：Set(日期)；
 * targetOf：有效目標日（effectiveTarget；預設＝封印的 targetDay）。回傳附 sealedTargetDay，兩者不同＝封印後日曆才補上臨時休市。
 */
export function scorePlan({ forward, scoreSha, closeReady, targetOf = f => f.targetDay }) {
  return forward.filter(f => scoreSha.get(f.scoringDay) !== f.sha256 && closeReady.has(targetOf(f)))
    .map(f => ({ scoringDay: f.scoringDay, targetDay: targetOf(f), sealedTargetDay: f.targetDay }))
    .sort((a, b) => a.scoringDay.localeCompare(b.scoringDay));
}

/** 除權息補抓檔的完整度：2＝兩市、1＝只有上市、0＝都失敗、-1＝沒有檔 */
export const exrightRank = rec => (!rec ? -1 : !rec.error ? 2 : rec.twseOnly ? 1 : 0);

/**
 * 要補抓除權息的日子：exright-history 之後到 upto 的交易日，沒有檔就抓；不完整（只有上市／都失敗）的只在 retryFrom 之後重試。
 * 每輪最多 cap 天（網路節制：每天 2 個請求、間隔 ≥3 秒），新日子優先。
 */
export function exrightPlan({ tradingDays, historyTo, files, upto, retryFrom, cap = 5 }) {
  const days = tradingDays.filter(d => d > historyTo && d <= upto).sort().reverse();
  const missing = days.filter(d => !files.has(d));
  const retry = days.filter(d => files.has(d) && exrightRank(files.get(d)) < 2 && d >= retryFrom);
  return [...missing, ...retry].slice(0, cap);
}

/** `ps -axo pid=,ppid=,command=` 輸出 → [{ pid, ppid, command }] */
export function parsePs(text) {
  return String(text || '').split('\n').map(l => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

// 會改寫或大量讀取共用 .surge-cache 的研究程序（2026-10-04 決議清單＋本流程自己的步驟腳本）
export const FOREIGN_PATTERNS = [
  /\b(cv_official|build_v2|official_features|save_scores)\b/,
  /retrain_official/,
  /\b(build_lu1|a32_walkforward_prep|panel|a35_shadow_list|a35_shadow_score|a35_shadow_history)\.py\b/,
  /\bfetch_cache\.mjs\b/,
  /\ba37_tracks_\w+\.py\b/,          // T1 分軌前向（手動執行時協調器略過；協調器自己的子行程不算，見 foreignResearchProcs）
];
const NON_RUNNER = /^(\S*\/)?(ps|pgrep|grep|rg|less|more|tail|head|cat|vim?|nvim|nano|emacs)$/;

/** 不屬於本程序（含其子孫）的研究程序；看到就不跑，避免共用快取被同時改寫。 */
export function foreignResearchProcs(rows, selfPid) {
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r.pid); }
  const mine = new Set([selfPid]); const q = [selfPid];
  while (q.length) for (const k of kids.get(q.shift()) || []) if (!mine.has(k)) { mine.add(k); q.push(k); }
  return rows.filter(r => !mine.has(r.pid) && !NON_RUNNER.test(r.command.split(/\s+/)[0]) && FOREIGN_PATTERNS.some(re => re.test(r.command)));
}

/** 鎖目錄已存在時：持有者還活著＝busy；沒有持有者資料或持有者已死＝stale（可回收）。 */
export const lockVerdict = (owner, isAlive) => (owner && Number.isInteger(owner.pid) && isAlive(owner.pid) ? 'busy' : 'stale');

/** 缺口紀錄合併：依打分日去重（保留第一次記錄）、升冪、最多留 maxN 筆 */
export function mergeMissed(prev = [], add = [], maxN = 200) {
  const m = new Map();
  for (const r of [...prev, ...add]) if (r?.scoringDay && !m.has(r.scoringDay)) m.set(r.scoringDay, r);
  return [...m.values()].sort((a, b) => a.scoringDay.localeCompare(b.scoringDay)).slice(-maxN);
}

/**
 * 研究快取 priceEvents.json 的累積合併（fetch_cache.mjs 用；2026-10-04 審查）。
 * daemon 的 priceEvents/latest 是「最近約 90 個交易日」的滾動視窗、每天整份覆寫——直接覆寫快取的話，較舊的減資／面額變更事件
 * 會逐日滾出，訓練矩陣每次重建時這些股票的還原價出現假跳空、被判成結構斷點，訓練列靜默改變。
 * 規則：新文件視窗內（date ≥ cur.window.from）以新文件為準（daemon 在視窗內是整段重算，撤銷的事件也跟著撤銷）；
 *       視窗之前的舊事件永遠保留；新文件沒有視窗資訊時，依（代號, 日期）聯集、同鍵新值覆蓋。
 *       新文件讀不到（null／沒有 items）＝沿用舊檔（stale-if-error），不以空表覆蓋。
 * @returns {{ doc: object|null, kept: number, added: number, dropped: number, staleIfError: boolean }}
 */
export function mergePriceEvents(prev, cur) {
  const prevItems = Array.isArray(prev?.items) ? prev.items : [];
  if (!cur || !Array.isArray(cur.items)) return { doc: prev ?? null, kept: prevItems.length, added: 0, dropped: 0, staleIfError: true };
  const key = e => `${e?.code}|${e?.date}`;
  const from = cur.window?.from && DAY_RE.test(cur.window.from) ? cur.window.from : null;
  const curKeys = new Set(cur.items.map(key));
  const keep = prevItems.filter(e => (from ? String(e?.date) < from : !curKeys.has(key(e))));
  const dropped = from ? prevItems.filter(e => String(e?.date) >= from && !curKeys.has(key(e))).length : 0;
  const items = [...keep, ...cur.items].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.code).localeCompare(String(b.code)));
  const prevFrom = prev?.accumulated?.from ?? prev?.window?.from ?? null;
  const accFrom = [prevFrom, cur.window?.from].filter(Boolean).sort()[0] ?? null;
  return {
    doc: { ...cur, items, n: items.length, accumulated: { from: accFrom, latestWindow: cur.window ?? null, keptFromPrevious: keep.length, rule: 'window-authoritative; older events kept' } },
    kept: keep.length, added: cur.items.filter(e => !prevItems.some(p => key(p) === key(e))).length, dropped, staleIfError: false,
  };
}
