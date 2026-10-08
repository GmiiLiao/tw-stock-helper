// ─────────────────────────────────────────────────────────────────────────────
// 新聞判別·盤後趟的排程與重試條件（2026-10-08）
//
// 事故：舊條件是 `mins >= 23*60 && _nvEveDate !== today`（時鐘）。2026-10-07 23:00 開跑的盤後趟在 01:35 失敗
//   （文件超過 1MB，見 news-verdict-codec.mjs），而午夜後 mins >= 23*60 不成立 ⇒ 當晚不再重試，適用日 10-08 的判別整趟丟失。
// 新條件：以「這一晚的盤後趟——適用日 targetDate——尚未完成」為準，跨午夜到死線（05:00，與 computeNewsVerdictBatch 的死線同值）前都會重試。
//   完成鍵＝`${targetDate}@${這一晚}`：
//   · 只用 targetDate 不夠——週五、週六、週日晚上的盤後趟適用日都是週一，週末的新聞要靠後兩晚判（使用者 08-28「非交易日也跑」），
//     若只看 targetDate，週六、週日晚會被當成「已完成」整趟跳過。
//   · 「這一晚」＝23:00 起算的日曆日：23:00–23:59 是今天，00:00–04:59 是昨天（跨午夜仍是同一晚、同一個適用日）。
//   完成鍵由 daemon 存進 system/daemonJobMarks.nvEvening（成功才寫、開機讀回）——重啟不會把已完成的那晚再跑一次，
//   中途被中斷的那晚則會在死線前補跑。
// 重試節制：同一晚最多 NV_EVENING_MAX_TRIES 次、間隔至少 NV_EVENING_RETRY_GAP_MS（整趟要跑 1～2 小時，不可失敗就立刻整趟重來）。
// ⚠ 取捨（寫明）：光靠 dailyJobsLoop 的循序順序不夠——盤後趟在 01:15 之後失敗時，同一輪會直接進夜間補判（重試要隔 10 分鐘），
//   補判跑完寫 night-backfill.json，台股 wiki 年報萃取（02:00–06:30，scripts/lib/stock-wiki/annual-report.mjs）一看到訊號就開始用 Ollama，
//   與盤後趟的重試搶同一個 Ollama（萃取只在送出前看 llm.json，會在判別兩檔之間插隊）。
//   所以 daemon 以 eveningPassPending 擋夜間補判：這一晚的盤後趟未完成、未用完次數、05:00 死線前（含等重試間隔的空檔）⇒ 補判先不跑。
//   代價：夜間補判與等它的 wiki 萃取都延後、萃取時間被壓縮（盤後趟重試到 05:00 時補判跑到 06:30 死線，萃取當晚可能整晚沒有時間）。
//   適用日的判別（隔日開盤要用、評分與推薦都讀）優先於 wiki 萃取進度；重試有次數上限且 05:00 死線硬停，不會吃掉 06:30 之後的排程。
// 純函式；單元測試 news-verdict-retry.test.mjs。
// ─────────────────────────────────────────────────────────────────────────────

/** 盤後趟開跑時刻（台北·分鐘） */
export const NV_EVENING_START_MIN = 23 * 60;
/** 盤後趟死線（台北·分鐘；computeNewsVerdictBatch('evening', 5 * 60) 同值） */
export const NV_EVENING_DEADLINE_MIN = 5 * 60;
/** 同一晚最多嘗試次數 */
export const NV_EVENING_MAX_TRIES = 3;
/** 失敗後至少隔多久再試 */
export const NV_EVENING_RETRY_GAP_MS = 10 * 60_000;

/**
 * 這一晚的盤後趟要不要跑。
 * @param {object} o
 * @param {number} o.mins  台北時間的分鐘數（0–1439）
 * @param {string} o.today  台北日曆日 YYYY-MM-DD
 * @param {string} o.yesterday  台北日曆日的前一天
 * @param {string | null} o.target  適用交易日（newsVerdictTargetIso('evening', tw)；跨午夜同值）
 * @param {string | null} [o.done]  已完成的完成鍵
 * @param {{ key: string, n: number, at: number } | null} [o.fail]  這一晚的失敗紀錄
 * @param {number} [o.now]  ms
 * @returns {{ due: boolean, key: string | null, exhausted?: boolean }}
 */
export function eveningPassDue({ mins, today, yesterday, target, done = null, fail = null, now = 0 }) {
  const night = mins >= NV_EVENING_START_MIN ? today : mins < NV_EVENING_DEADLINE_MIN ? yesterday : null;
  if (!night || !target) return { due: false, key: null };
  const key = `${target}@${night}`;
  if (done === key) return { due: false, key };
  if (fail && fail.key === key) {
    if (fail.n >= NV_EVENING_MAX_TRIES) return { due: false, key, exhausted: true };
    if (now - fail.at < NV_EVENING_RETRY_GAP_MS) return { due: false, key };
  }
  return { due: true, key };
}

/**
 * 這一晚的盤後趟是否仍「待完成」：尚未完成、尚未用完重試次數、仍在死線（05:00）前——含失敗後等重試間隔的空檔（due＝false 但仍待完成）。
 * daemon 的夜間補判要等它（2026-10-08 審查）：補判跑完會寫 night-backfill.json，wiki 年報萃取一看到就開始用 Ollama，
 * 而萃取只在每次送出前看 llm.json（daemon 只在每個 LLM 工作開始／結束時寫）⇒ 會在盤後趟重試的兩檔之間插隊。
 * 參數同 eveningPassDue（done／fail 要傳當下的值）。
 * @param {Parameters<typeof eveningPassDue>[0]} o
 * @returns {boolean}
 */
export function eveningPassPending(o) {
  const r = eveningPassDue(o);
  return !!r.key && r.key !== o.done && !r.exhausted;
}

/** 記一次失敗（回新物件；換了一晚就從 1 起算） */
export function eveningPassFailed(fail, key, now) {
  return { key, n: fail && fail.key === key ? fail.n + 1 : 1, at: now };
}
