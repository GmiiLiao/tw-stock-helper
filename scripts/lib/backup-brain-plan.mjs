// ─────────────────────────────────────────────────────────────────────────────
// 第二大腦備份：涵蓋範圍表＋讀取計畫（純函式；backup-brain.mjs 使用，測試見 backup-brain-plan.test.mjs）
//
// ⚠ 這張表就是「本地第二大腦的涵蓋範圍」契約。沒列進 DATED／CONTENT_DIFF／SKIP 的集合
//   只會進 singletons.json（每集合最多 SINGLETON_MAX_DOCS 份，取 id 最大＝最新的）。
//   新增會逐日長出文件的集合（id 是日期，或「前綴-日期」）時，**必須同步加進 DATED**，
//   否則只會留下最新的 200 份，而且每天的讀取量會跟著文件數一直變多。
//   2026-08-10 四源稽核：8 個逐日歸檔集合一直不在表上（orderFlowArchive 已累積 735 天），全部只存在雲端。
//
// 2026-10-08（WP0，個股分析頁×第二大腦稽核）修正：
//   ① singletons 舊版 `limit(25)` 依 id 升冪，等於只留**最舊**的 25 份：
//      newsVerdict 缺 10-06 之後與 latest；mopsNews、earningsCallPreviews 也快要被截斷。
//      改成先 count()：200 份以內全抓，超過才取 id 最大（最新）的 200 份，並在 manifest 記「截斷」與告警，不再靜默。
//   ② 29 個逐日集合從 singletons 移進 DATED（每份文件一個檔）。mopsNews 另外照舊整包放進 singletons.json
//      （wiki 的 scripts/lib/stock-wiki/load-local.mjs 讀 S.mopsNews），內容取自本機 DATED 檔，不多讀雲端。
//   ③ DATED 改「增量」讀取：平日只讀 id ≥ 截止日（預設近 7 天）的文件，以及所有非日期 id（latest、summary…）；
//      每個集合每 7 天全量比對一次，依集合名分散到一週 7 天，不會集中在同一天全量。
//      以下情況一律全量：沒有狀態記錄、增量區間以外的舊文件本機比雲端少（有文件沒備到）、帶 --full。
//      舊版每天全讀：光 chipArchive 一個集合就是 1,028 份、163 MB，而且每天再加 1 份。
//   ④ 每個集合記錄耗時；整輪用時接近 daemon execScript 的 10 分鐘逾時就告警，
//      超過 60% 時把「到期的週期性全量比對」延到下一輪（缺檔與沒有狀態記錄的全量不延）。
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86400000;
const TAIPEI_OFFSET_MS = 8 * 3600000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 計畫版本：manifest／狀態檔會記下，改了讀取規則就加 1 */
export const PLAN_VERSION = 2;
/** 增量模式預設往回讀幾個日曆日（同日文件會被 daemon 事後補寫：chipArchive 15:10 收盤、16:xx 法人、21:45 資券） */
export const DEFAULT_LOOKBACK_DAYS = 7;
/** 每個 DATED 集合多久全量比對一次（雲端常事後回補歷史，例如 chipArchive/2026-03-02 五個月後才補齊） */
export const FULL_SWEEP_DAYS = 7;
/** singletons 每集合最多備幾份；超過就只取最新的、並告警（舊版是 limit(25) 且取最舊） */
export const SINGLETON_MAX_DOCS = 200;
/** singletons 某集合超過這個份數就提醒「是不是會一直長」 */
export const SINGLETON_WARN_DOCS = 25;
/** 未分類集合裡有這麼多份日期型 id，就提醒「應該列進 DATED」 */
export const SINGLETON_DATED_WARN = 3;
/** 整輪時間預算＝daemon execScript('backup-brain.mjs', …, 10) 的逾時 */
export const RUN_BUDGET_MS = 10 * 60000;
/** 用掉這個比例就告警 */
export const BUDGET_WARN_RATIO = 0.7;
/** 用掉這個比例之後，到期的週期性全量比對延到下一輪 */
export const FULL_DEFER_RATIO = 0.6;

/**
 * 逐日集合（每份文件一個檔）。欄位：
 *   id            集合名
 *   families      日期型 id 的前綴（預設 ['']＝id 本身就是日期，例如 2026-10-08、2026-10-08-mta1lo46）；
 *                 前綴之外的 id（latest、summary、scoreboard…）每輪都讀
 *   lookbackDays  增量模式往回讀幾天（月份 id、週資料要放寬）
 *   slot          （選填）固定在一週的第幾天（0–6）全量比對；不填就由集合名雜湊
 */
export const DATED = [
  { id: 'chipArchive', slot: 4 },   // 最大的集合（1,028 份、163 MB）：單獨一天全量比對
  { id: 'chipDaily' }, { id: 'newsDaily' }, { id: 'morningNote' }, { id: 'marketReports' },
  { id: 'premarketBrief' },
  { id: 'picksHistory', lookbackDays: 35 },   // daemon 在 10／20 個交易日後才 merge 回填 eval10／eval20（約 14–28 日曆日）
  { id: 'limitUpForecast', families: ['pred-', 'review-'] },   // pred-／review-日期；latest、live、scoreboard 每輪讀
  { id: 'marketWind' }, { id: 'sectorWind' },
  { id: 'dailyHeatmap' },        // 2026-10-04：每日熱力報告頁（本機另有 second-brain/daily-heatmap 定版檔）
  { id: 'dailyAnalyst' },        // 2026-10-05：每日 AI 分析師團隊（公開分析文字；本機另有 second-brain/daily-analyst 定版檔）
  { id: 'dailyAnalystFocus' },   // 2026-10-05：同上的管理員專用「資料觀察名單」（含個股；只留本機，不外流）
  // ↓ 2026-08-10 補：先前完全未備份的歷史序列
  { id: 'tdccArchive', lookbackDays: 14 },      // 集保股權分散（每週；官方只留 51 週，斷了就永遠補不回）
  { id: 'revenueArchive', lookbackDays: 70, slot: 6 },   // MOPS 月營收（id＝YYYY-MM；daemon 每天補最近 2 個月 ⇒ 往回 70 天才涵蓋得到）
  { id: 'orderFlowArchive', slot: 0 }, { id: 'intradayArchive', slot: 1 }, { id: 'bookDepthArchive', slot: 3 },
  { id: 'snap0930Archive' }, { id: 'volSurgeArchive', slot: 2 }, { id: 'asiaPremarketArchive' },
  // ↓ 2026-08-11 補：第 2 套預選的 60 日前瞻實記。實驗資料本身，雲端掉了就算不回來。
  { id: 'swingCurvePicks', lookbackDays: 40 },   // 到期時 merge 回填 res5／res20（20 個交易日≈28 日曆日，含長假）
  // ↓ 2026-10-08 WP0：原本在 singletons 被 limit(25) 截斷、或會一直長的逐日集合（id 逐一核對過是日期）
  { id: 'newsVerdict', slot: 0 },   // rating 用的新聞判別（每份約 450 KB）
  { id: 'newsDigest' },
  { id: 'mopsNews' },           // 重大訊息；另見 SINGLETON_FROM_LOCAL（singletons.json 照舊保留完整一份）
  { id: 'gapLimitUp' }, { id: 'limitUpRecommend' },
  { id: 'squeezeRecommend' }, { id: 'squeezeReport' }, { id: 'squeezeReview' }, { id: 'squeezeTraining' },
  { id: 'squeezePicks' }, { id: 'squeezePicksLedger' },
  { id: 'surgeShadow', slot: 5, families: ['fwd-', 'hist-', 'surge-v2-', 'tracks-raw-gap-'] },   // 起漲影子（surge-lab）；lab-*、index、surge-v2 等每輪讀
  { id: 'tailTrack' }, { id: 'shortCandidates' }, { id: 'shortTraining' }, { id: 'sectorSpot' },
  { id: 'swingHold' }, { id: 'swingFormula' }, { id: 'scoringV3' },
  { id: 'stopEventShadow' }, { id: 'stopSpecAudit' },
  { id: 'openSensor' }, { id: 'openSensorUniverse' },   // 開盤感應器逐日文件（openSensorStats/outside、openSensorMeta 留 singletons）
  { id: 'aiDaytradeLab' }, { id: 'aiLabLearn' }, { id: 'aiSwingLab' }, { id: 'daytradeJournal' },
  { id: 'prelimitExp' },        // 漲停前夜 5 日實驗（已結束；仍是日期 id）
  { id: 'revenueDates', lookbackDays: 70 },     // id＝YYYY-MM
];

/** 內容比對型：每份文件一個檔，每輪全讀、內容變了才寫（文件數以個股宇宙為上限，不隨時間成長） */
export const CONTENT_DIFF = [
  'finReports', 'stockHistory', 'stockPeBand', 'stockAI', 'userPerf', 'indexHistory',
  'earningsCallPreviews',   // 2026-10-08 WP0：id＝股票代號（原 singletons 21 份，再 4 份就會被截斷）
];

/**
 * 不備份。users 由 backupUsers 另外深度匯出（含子集合）。
 *   activity_logs：log 噪音、可捨棄。
 *   alertDedup：通知去重鍵（{種類}_{日期}），只用來避免重推，災後遺失最多重推一天，不值得逐日留存。
 */
export const SKIP_COLLECTIONS = ['activity_logs', 'users', 'alertDedup'];

/**
 * 在 DATED 逐份備份之外，singletons.json 也要放一份完整內容的集合（取自本機 DATED 檔，不多讀雲端）。
 *   mopsNews：wiki（scripts/lib/stock-wiki/load-local.mjs）讀 S.mopsNews 的全部日期。
 * 留在 singletons 的多份集合（2026-10-08 逐一核對，id 不是日期、份數有上限）：
 *   stopBooks、aiLabAccess、aiSwingMembers（uid）、aiNotes（股票代號）、system、marketSnapshot、newsVerdictReview（具名）、
 *   openSensorStats（outside）、openSensorMeta（rho、threshold）。
 */
export const SINGLETON_FROM_LOCAL = ['mopsNews'];

const pad2 = (n) => String(n).padStart(2, '0');
const isoOfUtcMs = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
const utcMsOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };

/** 台北日曆日 YYYY-MM-DD（與機器時區無關） */
export const taipeiDay = (ms = Date.now()) => isoOfUtcMs(ms + TAIPEI_OFFSET_MS);
/** iso 加減日曆日 */
export const addDays = (iso, n) => isoOfUtcMs(utcMsOf(iso) + n * DAY_MS);
/** b − a 的日曆日數 */
export const daysBetween = (a, b) => Math.round((utcMsOf(b) - utcMsOf(a)) / DAY_MS);
/** 1970-01-01 起的日序（用來排一週 7 個全量比對槽位） */
export const dayNumber = (iso) => Math.round(utcMsOf(iso) / DAY_MS);

/** 檔名：與舊版一致（非 [\w.-] 一律換成 _） */
export const safeFileName = (id) => String(id).replace(/[^\w.-]/g, '_');

/** 增量模式的截止日：id（去掉前綴後）≥ 這天的文件才讀 */
export const cutFor = (spec, today) => addDays(today, -(spec.lookbackDays ?? DEFAULT_LOOKBACK_DAYS));

/** 這個集合固定在一週的哪一天全量比對（0–6） */
export function sweepSlot(spec) {
  if (Number.isInteger(spec.slot)) return ((spec.slot % FULL_SWEEP_DAYS) + FULL_SWEEP_DAYS) % FULL_SWEEP_DAYS;
  let h = 5381;
  for (const ch of String(spec.id)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h % FULL_SWEEP_DAYS;
}

/**
 * 增量讀取的文件 id 區間（左閉右開，null＝無界），依字典序排好。
 * 每個前綴 p 只排除 [p, p+截止日)，也就是「p 開頭、而且日期早於截止日」的舊文件；其餘 id 一律讀。
 * 所以前綴宣告錯了只會多讀、不會漏讀。例外是 ''：它排除字典序小於截止日的所有 id，只適用 id 本身就是日期的集合。
 * @param {string[]} families
 * @param {string} cut YYYY-MM-DD
 * @returns {{start: string|null, end: string|null}[]}
 */
export function incrementalRanges(families, cut) {
  const fams = [...new Set(families && families.length ? families : [''])].sort();
  const out = [];
  let start = null;
  for (const p of fams) {
    if (p !== '' && (start == null || p > start)) out.push({ start, end: p });
    start = p + cut;
  }
  out.push({ start, end: null });
  return out;
}

/** 這個 id 會不會被增量區間讀到（與 Firestore 文件 id 的字典序一致；本專案 id 皆為 ASCII） */
export const idInRanges = (ranges, id) => ranges.some(r => (r.start == null || id >= r.start) && (r.end == null || id < r.end));

/**
 * 這一輪要全量還是增量。
 * localOld／cloudOld：**增量區間以外**（不會被增量讀到的舊文件）的本機檔數與雲端份數。
 *   ⚠ 不能拿整個集合的份數比：逐日集合每天都會先在雲端多出當天那份，整體份數比對會天天判成「缺檔」而天天全量。
 *   舊文件雲端比本機多＝有文件從沒備到（新集合、本機檔被刪、雲端事後補了舊日期）⇒ 全量。
 * @param {{ spec: {id: string, slot?: number}, today: string, last?: {sweepDay?: string}|null, forceFull?: boolean,
 *           localOld: number, cloudOld: number|null, elapsedMs?: number, budgetMs?: number }} p
 * @returns {{ mode: 'full'|'incremental', reason: string }}
 */
export function decideMode({ spec, today, last, forceFull = false, localOld, cloudOld, elapsedMs = 0, budgetMs = RUN_BUDGET_MS }) {
  if (forceFull) return { mode: 'full', reason: 'flag-full' };
  if (cloudOld != null && localOld < cloudOld) return { mode: 'full', reason: 'local-missing' };   // 有舊文件沒備到：不延
  if (!last?.sweepDay || !ISO_DAY.test(last.sweepDay)) return { mode: 'full', reason: 'no-state' };       // 第一次：不延
  const age = daysBetween(last.sweepDay, today);
  const overdue = age >= FULL_SWEEP_DAYS;
  const slotDay = age >= 1 && sweepSlot(spec) === dayNumber(today) % FULL_SWEEP_DAYS;
  if (!overdue && !slotDay) return { mode: 'incremental', reason: 'recent-window' };
  if (elapsedMs > budgetMs * FULL_DEFER_RATIO) return { mode: 'incremental', reason: 'deferred-budget' };
  return { mode: 'full', reason: overdue ? 'weekly-overdue' : 'weekly-slot' };
}

/** 日期型 id：含 YYYY-MM-DD，或整個 id 是 YYYY-MM */
export const isDateLikeId = (id) => /\d{4}-\d{2}-\d{2}/.test(String(id)) || /^\d{4}-\d{2}$/.test(String(id));

/** 未分類（singletons）集合的告警 */
export function singletonWarnings(colId, { count, ids = [] }) {
  const out = [];
  if (count > SINGLETON_MAX_DOCS) out.push(`${colId}：雲端 ${count} 份超過上限 ${SINGLETON_MAX_DOCS}，只備了 id 最大的 ${SINGLETON_MAX_DOCS} 份（截斷）——請分類進 DATED 或 CONTENT_DIFF`);
  const dated = ids.filter(isDateLikeId).length;
  if (dated >= SINGLETON_DATED_WARN) out.push(`${colId}：${dated} 份日期型 id 卻未分類——應加進 backup-brain-plan.mjs 的 DATED（否則讀取量會一直變多）`);
  else if (count > SINGLETON_WARN_DOCS && count <= SINGLETON_MAX_DOCS) out.push(`${colId}：${count} 份（超過 ${SINGLETON_WARN_DOCS}），請確認是否會持續增長`);
  return out;
}

/** 時間預算：'ok'｜'warn'（≥70%）｜'over'（≥100%） */
export function budgetLevel(elapsedMs, budgetMs = RUN_BUDGET_MS) {
  if (elapsedMs >= budgetMs) return 'over';
  if (elapsedMs >= budgetMs * BUDGET_WARN_RATIO) return 'warn';
  return 'ok';
}

const FAMILY_RE = /^[A-Za-z][A-Za-z0-9_.-]*[-_]$/;

/** 表格自我檢查：重複、前綴格式、互為前綴、往回天數。回傳問題清單（空＝通過） */
export function validateTables({ dated = DATED, contentDiff = CONTENT_DIFF, skip = SKIP_COLLECTIONS, fromLocal = SINGLETON_FROM_LOCAL } = {}) {
  const problems = [];
  const seen = new Map();
  const note = (id, where) => { if (seen.has(id)) problems.push(`${id} 同時在 ${seen.get(id)} 與 ${where}`); else seen.set(id, where); };
  for (const s of dated) note(s.id, 'DATED');
  for (const id of contentDiff) note(id, 'CONTENT_DIFF');
  for (const id of skip) note(id, 'SKIP');
  for (const s of dated) {
    const fams = s.families || [''];
    for (const p of fams) if (p !== '' && !FAMILY_RE.test(p)) problems.push(`${s.id}：前綴「${p}」須以英文字母開頭、以 - 或 _ 結尾`);
    for (const a of fams) for (const b of fams) if (a !== b && a !== '' && b.startsWith(a)) problems.push(`${s.id}：前綴「${a}」是「${b}」的前綴，區間會重疊`);
    const lb = s.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    if (!Number.isInteger(lb) || lb < 1 || lb > 120) problems.push(`${s.id}：lookbackDays ${lb} 不合理（1–120）`);
  }
  const datedIds = new Set(dated.map(s => s.id));
  for (const id of fromLocal) if (!datedIds.has(id)) problems.push(`${id}：SINGLETON_FROM_LOCAL 取自本機 DATED 檔，必須同時列在 DATED`);
  return problems;
}
