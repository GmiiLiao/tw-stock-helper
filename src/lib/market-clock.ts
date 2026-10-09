/**
 * 交易時段唯一真相來源（single source of truth）
 *
 * 目前 codebase 有 **6 份互相不一致的實作**：
 *   twse-api-server.ts:194    09:00–13:31  ✅ 查假日
 *   useLiveQuotes.ts:20-28    09:00–13:35  ❌ 只看週末
 *   stock-intraday/route.ts:77 09:00–13:35 ❌
 *   WatchlistTracker.tsx:2130 09:00–13:31  ❌ 而且算完沒用到
 *   Header.tsx:114-122        h>=9 && h<14 ❌ 用 client 本地時區
 *   yahoo-quote/route.ts:88   09:00–13:31  ❌
 *
 * 後果：國定假日（例如春節）只要有人開著分頁，Header 與 WatchlistTracker
 * 仍會維持 5 秒輪詢。這比盤中被封更難向證交所解釋。
 *
 * 這一支同時解決兩件事：
 *   1. 統一口徑，client 與 server 共用同一份判斷
 *   2. 假日表改成可從 Firestore 讀取，不再寫死年份
 *      （twse-api-server.ts:148-149 的註解自己寫了「MUST be updated annually」——
 *        任何需要人類每年記得做一次的事，最終都會忘記）
 */

export type Session = 'closed' | 'pre-open' | 'regular' | 'post-close';

/** 台北時間，不受 server TZ / client 時區影響 */
function taipei(now: Date) {
  const tpe = new Date(now.getTime() + now.getTimezoneOffset() * 60_000 + 8 * 3_600_000);
  return {
    minutes: tpe.getHours() * 60 + tpe.getMinutes(),
    // YYYY-MM-DD：須與休市日曆（system/tradingCalendar → setHolidays）同格式。2026-10-04 前為 YYYYMMDD ⇒ isTradingDay 永遠比不中，國定假日被當交易日。
    ymd: `${tpe.getFullYear()}-${String(tpe.getMonth() + 1).padStart(2, '0')}-${String(tpe.getDate()).padStart(2, '0')}`,
    dow: tpe.getDay(),
  };
}

/** 台北日曆日 YYYY-MM-DD（client／server 共用，不受 server TZ／使用者時區影響；與 isTradingDay 同一份 taipei() 換算）。
 *  ⚠ 不要用 `new Date().toISOString().slice(0, 10)`：那是 UTC 日期，台北 00:00–08:00 會拿到前一天。
 *  「今天」語意才用這支；資料日請用來源自報日期或既有的資料日來源（boardDataDate 等）。 */
export function taipeiToday(now: Date = new Date()): string {
  return taipei(now).ymd;
}

const M = (h: number, m: number) => h * 60 + m;

/**
 * 休市日曆。預設為空 —— fail-open 只擋週末。
 * 這是刻意的：日曆載入失敗時，多打幾次沒資料的請求，
 * 遠好過整個交易日不輪詢。
 *
 * server 端由 daemon 寫入 Firestore `system/tradingCalendar`；
 * client 端由 /api/market-clock 帶下來。
 */
let holidays = new Set<string>();
let holidaysLoadedAt = 0;

export function setHolidays(ymds: Iterable<string>) {
  holidays = new Set(ymds);
  holidaysLoadedAt = Date.now();
}
export function holidaysAgeMs() {
  return holidaysLoadedAt === 0 ? Infinity : Date.now() - holidaysLoadedAt;
}

/** 以 YYYY-MM-DD 判是否交易日（週末＋休市日曆）；日曆未載入時只擋週末（fail-open，與 isTradingDay 同）。 */
export function isTradingYmd(ymd: string): boolean {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(ymd);
}

const MAX_TRADING_LOOKBACK_DAYS = 15;   // 最長連假（春節）＋週末仍遠小於此

/** 最後一個交易日（含今天）YYYY-MM-DD：今天是交易日＝今天，否則往前找。
 *  依專案規則「非交易日新建／修改資料的使用與記錄時間＝最後一個交易日」，非交易日要寫進資料的日期用這支。
 *  日曆未載入時只擋週末（與 isTradingYmd 同為 fail-open）。 */
export function lastTradingYmd(now: Date = new Date()): string {
  let ymd = taipeiToday(now);
  for (let i = 0; i < MAX_TRADING_LOOKBACK_DAYS && !isTradingYmd(ymd); i++) {
    const [y, m, d] = ymd.split('-').map(Number);
    ymd = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);   // 純日期運算（UTC 午夜），與時區無關
  }
  return ymd;
}

export function isTradingDay(now: Date = new Date()): boolean {
  const { ymd, dow } = taipei(now);
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(ymd);
}

export function getSession(now: Date = new Date()): Session {
  if (!isTradingDay(now)) return 'closed';
  const { minutes } = taipei(now);
  if (minutes >= M(8, 30) && minutes < M(9, 0)) return 'pre-open';
  if (minutes >= M(9, 0) && minutes < M(13, 30)) return 'regular';
  if (minutes >= M(14, 0) && minutes < M(14, 31)) return 'post-close';
  return 'closed';
}

export const isMarketOpen = (now?: Date) => getSession(now) === 'regular';

/**
 * 輪詢間隔的唯一決定點。
 *
 * 兩個關鍵行為，目前全站都沒有：
 *   1. 休市回 null → 呼叫端應該**完全停止**輪詢，不是降頻。
 *      13:30–09:00 是 19.5 小時，佔一天 81%。
 *   2. 分頁在背景（document.hidden）→ 直接停。
 *      目前 38 個輪詢點中 document.hidden 使用次數為 0，
 *      使用者把分頁丟在背景整夜，5 秒輪詢照樣打。
 */
// ── 揭示鎖相（2026-08-17）───────────────────────────────────────────
// TWSE MIS 每 5 秒在「整 5 秒牆鐘」揭示；daemon 快線在邊界+1s 抓、寫入約 +1.5s
// 落地。前端在「邊界+offset」讀（預設 +3s），全體使用者同一時刻拿到同一筆揭示
// ——單一時鐘同步擴散，而不是各層各自相位疊加出 0~18 秒的亂數延遲。
// CDN s-maxage=2~3 在此架構下是同時段內的合流器（第一個人回源、其他人共用）。
export function msToNextReveal(offsetMs = 3000): number {
  const now = Date.now();
  const next = Math.ceil((now - offsetMs) / 5000) * 5000 + offsetMs;
  return Math.max(50, next - now);
}

export function pollInterval(opts: {
  regularMs: number;
  preOpenMs?: number;
  closedMs?: number | null;
  now?: Date;
}): number | null {
  if (typeof document !== 'undefined' && document.hidden) return null;
  const s = getSession(opts.now);
  if (s === 'regular') return opts.regularMs;
  if (s === 'pre-open') return opts.preOpenMs ?? opts.regularMs * 2;
  if (s === 'post-close') return opts.closedMs === null ? null : (opts.closedMs ?? 60_000);
  return opts.closedMs === undefined ? null : opts.closedMs;
}

/**
 * 給「保留既有 setInterval、只是跳過這一輪」的最小改動用。
 *
 * 回傳 false 的兩種情況：
 *   - 分頁在背景（使用者根本看不到，打了也是浪費）
 *   - 台股休市（資料不會變，佔一天的 81%）
 *
 * 用法：在既有的 poll function 第一行加 `if (!shouldPollNow()) return;`
 * 計時器照跑但不發請求 —— 比改寫成 useSharedPoll 風險低得多，
 * 效果（省掉 81% 的無效請求）是一樣的。
 */
// 開盤前 5 分鐘的清空窗（使用者 2026-08-31 指定）。
// 盤後要繼續顯示**當日最終結算資料**——收盤後把畫面清成 0 檔等於把
// 當天的資訊丟掉，而使用者盤後正是要看那個。
// 只有在「今天要開盤、且再 5 分鐘就開」時才清空：
//   那一刻昨日資料已無參考價值，今日又還沒開始。
export function inPreOpenBlackout(now: Date = new Date()): boolean {
  if (!isTradingDay(now)) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= 8 * 60 + 55 && m < 9 * 60;
}

export function shouldPollNow(now?: Date): boolean {
  if (typeof document !== 'undefined' && document.hidden) return false;
  return getSession(now) !== 'closed';
}

/** shouldPollNow 再加上收盤定價窗 13:30–13:45（2026-09-28）：getSession 把 13:30–14:00 算休市，
 *  但收盤集合競價結果 13:30 後才揭示——盤中才變的即時資料（報價、雷達、五檔、量增）若在 13:30 停輪詢，
 *  畫面會停在收盤前最後一拍直到 14:00。新接閘的即時輪詢用這支；shouldPollNow 本身語意不動。 */
export function shouldPollThroughClose(now: Date = new Date()): boolean {
  if (shouldPollNow(now)) return true;
  if (typeof document !== 'undefined' && document.hidden) return false;
  if (!isTradingDay(now)) return false;
  const { minutes } = taipei(now);
  return minutes >= M(13, 30) && minutes < M(13, 45);
}

/** 只擋背景分頁，不擋休市 —— 給美股/daemon 驅動、休市時仍會更新的資料用 */
export function isForeground(): boolean {
  return typeof document === 'undefined' || !document.hidden;
}

/** 全站台股報價的統一節奏（使用者 2026-09-02「盤中為 3 秒更新·全站同步」）：
 *  盤中鎖相「揭示邊界+3s」（揭示 5 秒一拍、+1s 快線抓、+3s 各層快取已回填）、
 *  盤前 15s、休市/背景分頁 10 分鐘。
 *  ⚠ 所有顯示**台股股價**的輪詢都應該用這一個時鐘——這是 2026-08-17
 *  「單一時鐘同步擴散」設計的全站版；各自 setInterval 會把相位疊回亂數延遲。
 *  含美盤/ADR 的元件（Header）除外：那些休市時仍在動，節奏需求不同。 */
export function liveQuoteInterval(): number {
  if (!isForeground()) return 600_000;
  const s = getSession();
  if (s === 'regular') return msToNextReveal(3000);   // 鎖相：揭示邊界+3s
  if (s === 'pre-open') return 15_000;
  return 600_000;
}

/** 鎖相輪詢迴圈＋回前景立即恢復——全站報價輪詢的標準件。回傳 stop 函式。
 *  ⚠ 為什麼必須帶 visibilitychange（2026-09-02 使用者回報「報價完全沒有變化」）：
 *  liveQuoteInterval 在背景分頁排 10 分鐘檔，而**間隔是排程當下算的**——
 *  切去 LINE 再切回來，那顆計時器不會自己縮短，報價就凍住最久 10 分鐘。
 *  Header 在 2026-08-11 就修過這個（加 onVis 立即重排），但 useLiveQuotes 系
 *  一直沒有；2026-09-02 又把自選/戰情接上同一節奏，等於把缺陷面擴大——
 *  回前景恢復必須內建在標準件裡，不能靠每個呼叫端自己記得。
 *
 *  G3-20（2026-10-04）三個防呆，對既有呼叫端相容（fn 回 void 時行為與舊版相同）：
 *  1. 在途旗標：fn 回 Promise 時，上一輪未結束不再疊打（慢網路下 3 秒拍不會疊成 N 條並行請求）；
 *     在途超過 INFLIGHT_STALE_MS 視為卡死，放行下一輪（避免一個 hang 住的請求永久停掉輪詢）。
 *  2. 失敗退避：fn 的 Promise reject ⇒ 下一拍間隔加倍（上限 BACKOFF_CAP_MS，且不短於原間隔）；成功一次即歸零。
 *     fn 自行 catch 的呼叫端不受影響（照舊固定節奏）。
 *  3. 卸載 abort：fn 收到 AbortSignal，stop() 時 abort——可直接傳給 fetch，卸載後不再寫 state。
 *  fn 仍以 fire-and-forget 執行：fetch 失敗不得斷輪詢鏈。 */
const INFLIGHT_STALE_MS = 30_000;
const BACKOFF_CAP_MS = 120_000;

export function startLiveLoop(
  fn: (signal: AbortSignal) => unknown,
  intervalFn: () => number = liveQuoteInterval,
): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  let inflightSince = 0;          // 0＝無在途
  let failures = 0;
  const ac = new AbortController();

  const nextDelay = () => {
    const base = intervalFn();
    if (failures === 0) return base;
    return Math.max(base, Math.min(base * 2 ** failures, BACKOFF_CAP_MS));
  };
  const run = () => {
    if (!alive) return;
    if (inflightSince && Date.now() - inflightSince < INFLIGHT_STALE_MS) return;   // 上一輪還在跑 → 跳過這拍
    let r: unknown;
    try { r = fn(ac.signal); } catch { failures += 1; return; }
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      const started = Date.now();
      inflightSince = started;
      (r as Promise<unknown>).then(
        () => { failures = 0; },
        () => { if (alive) failures += 1; },
      ).finally(() => { if (inflightSince === started) inflightSince = 0; });
    }
  };
  const schedule = () => {
    if (!alive) return;
    clearTimeout(t);
    t = setTimeout(tick, nextDelay());
  };
  const tick = () => {
    if (!alive) return;
    run();
    schedule();
  };
  schedule();
  const onVis = () => {
    if (typeof document === 'undefined' || document.hidden || !alive) return;
    run();                                  // 先補一次，不讓使用者等（在途中則跳過）
    schedule();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  return () => {
    alive = false;
    clearTimeout(t);
    ac.abort();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
  };
}

/** 台股「盤中（含收盤後緩衝）」時窗，給輪詢間隔函式用（G3-18·2026-10-04 收斂 12 份手寫版）。
 *  與手寫版差異：看休市日曆（isTradingDay），國定假日不再當盤中用快節奏。
 *  endMinutes 預設 13:35（原手寫版口徑）；ShortPanel 用 13:45。台北時間，不受 client 時區影響。 */
export function isTwTradingHours(endMinutes: number = M(13, 35), now: Date = new Date()): boolean {
  if (!isTradingDay(now)) return false;
  const { minutes } = taipei(now);
  return minutes >= M(9, 0) && minutes < endMinutes;
}

/** 目前的 MIS 揭示拍號（整 5 秒牆鐘）。放進報價請求的 query，讓 CDN 快取鍵
 *  按拍分開：每拍第一個請求必回源、同拍所有使用者共享同一份——
 *  取代「s-maxage 過期＋stale-while-revalidate 先回舊值」的殘影行為
 *  （2026-09-02 實測鎖相打仍平均 7.9s 資料齡、1/8 拍 ≤5s，元凶就是 SWR 殘影）。
 *  用戶時鐘偏差只會讓該用戶自成快取鍵，不會拿到錯資料。 */
export const revealTick = () => Math.floor(Date.now() / 5000);

/* 相容層：讓既有呼叫點可以最小改動遷移過來 --------------------------- */

/** 取代 useLiveQuotes.ts:20-28 的 marketInterval() */
export const marketInterval = (fast = 5_000, slow = 60_000) =>
  pollInterval({ regularMs: fast, closedMs: slow });

/** 取代 Header.tsx:114-122 的 getInterval() */
export const headerInterval = () =>
  pollInterval({ regularMs: 5_000, preOpenMs: 15_000, closedMs: 60_000 });
