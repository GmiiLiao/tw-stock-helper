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
    ymd: `${tpe.getFullYear()}${String(tpe.getMonth() + 1).padStart(2, '0')}${String(tpe.getDate()).padStart(2, '0')}`,
    dow: tpe.getDay(),
  };
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

/* 相容層：讓既有呼叫點可以最小改動遷移過來 --------------------------- */

/** 取代 useLiveQuotes.ts:20-28 的 marketInterval() */
export const marketInterval = (fast = 5_000, slow = 60_000) =>
  pollInterval({ regularMs: fast, closedMs: slow });

/** 取代 Header.tsx:114-122 的 getInterval() */
export const headerInterval = () =>
  pollInterval({ regularMs: 5_000, preOpenMs: 15_000, closedMs: 60_000 });
