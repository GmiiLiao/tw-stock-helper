// ── FinMind 下載的時段與限速窗（台北時間，2026-10-08 使用者規定）────────────────────
//   main（2023 起的大量下載）：隨時可跑；平日 08:30–13:45 每小時 ≤1,500（保留盤中即時報價的頻寬與 CPU），其他時間 ≤5,000。
//   idle（2023 以前的空閒佇列）：只在平日 15:30–08:00、週末與休市日跑（平日 08:00–15:30 自動暫停）。
//   兩者都避開 FinMind 週日 00:00–03:00 維護時段；daemon 重任務窗（官方鏡像同一張表）也降到 1,500。
import { DAEMON_BUSY_WINDOWS } from '../lib/official-mirror.mjs';

export const TPE_OFFSET_MS = 8 * 3600e3;
export const CAP_PEAK = 1500;
export const CAP_NORMAL = 5000;
const PEAK = [8 * 60 + 30, 13 * 60 + 45];
const IDLE_BLOCK = [8 * 60, 15 * 60 + 30];
const MAINTENANCE = { dow: 0, from: 0, to: 3 * 60 };
const MINUTE = 60e3;
const WEEK_MIN = 7 * 24 * 60;
export const WINDOWS = ['main', 'idle'];

export function taipeiParts(ms) {
  const d = new Date(ms + TPE_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), dow: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), iso: `${d.toISOString().slice(0, 19)}+08:00` };
}

const inRange = (m, [a, b]) => m >= a && m < b;
const isBusinessDay = (p, isHoliday) => p.dow >= 1 && p.dow <= 5 && !isHoliday(p.date);
const defaults = opts => ({ isHoliday: opts.isHoliday || (() => false), busyWindows: opts.busyWindows || DAEMON_BUSY_WINDOWS });

/** 該時刻的每小時請求上限。 */
export function hourlyCapAt(ms, opts = {}) {
  const { isHoliday, busyWindows } = defaults(opts);
  const p = taipeiParts(ms);
  if (isBusinessDay(p, isHoliday) && inRange(p.minutes, PEAK)) return CAP_PEAK;
  if (busyWindows.some(([a, b]) => inRange(p.minutes, [a, b]))) return CAP_PEAK;
  return CAP_NORMAL;
}

/**
 * { open, reason, cap }：window＝main｜idle。
 * opts.heavy（重資料集：單次回應數 MB 以上，例如 TXO 逐筆一次 107MB、30 秒）：降速時段（平日 08:30–13:45、daemon 重任務窗）整段暫停——
 *   每小時請求數上限對這種請求形同無效（1,500 次／小時根本跑不到，實際是連續下載約 28 Mbps＋串流解析與 gzip 的 CPU），
 *   擋不住「保留給盤中即時報價的頻寬與 CPU」（使用者 2026-10-08 規定；2026-10-09 審查補上）。
 */
export function windowState(ms, window, opts = {}) {
  if (!WINDOWS.includes(window)) throw new Error(`未知的 window：${window}（只接受 ${WINDOWS.join('／')}）`);
  const { isHoliday } = defaults(opts);
  const p = taipeiParts(ms);
  const cap = hourlyCapAt(ms, opts);
  if (p.dow === MAINTENANCE.dow && inRange(p.minutes, [MAINTENANCE.from, MAINTENANCE.to])) return { open: false, reason: 'FinMind 週日 00:00–03:00 維護時段', cap };
  if (opts.heavy && cap === CAP_PEAK) return { open: false, reason: '重資料集（單次回應數 MB）避開平日 08:30–13:45 與 daemon 重任務窗', cap };
  if (window === 'idle' && isBusinessDay(p, isHoliday) && inRange(p.minutes, IDLE_BLOCK)) return { open: false, reason: 'idle 窗：平日 08:00–15:30 暫停', cap };
  return { open: true, reason: null, cap };
}

/** 距離窗口打開還要多久（毫秒，以分鐘為步長；已開回 0）。 */
export function msUntilOpen(ms, window, opts = {}) {
  if (windowState(ms, window, opts).open) return 0;
  const start = Math.ceil(ms / MINUTE) * MINUTE;
  for (let i = 0; i <= WEEK_MIN + 1440; i++) {
    const t = start + i * MINUTE;
    if (windowState(t, window, opts).open) return t - ms;
  }
  return 24 * 3600e3;   // 理論上不會到：保守等一天再看
}

/** 一週（以 2026-10-05 週一 00:00 起算）可用的請求容量。休市日用 isHoliday 判斷。 */
export function weeklyCapacity(window, opts = {}) {
  const t0 = Date.UTC(2026, 9, 5, -8, 0);
  let total = 0;
  for (let i = 0; i < WEEK_MIN; i++) {
    const st = windowState(t0 + i * MINUTE, window, opts);
    if (st.open) total += st.cap / 60;
  }
  return total;
}

/** 以平均週容量估算 n 個請求要幾小時。 */
export function etaHours(n, window, opts = {}) {
  const perHour = weeklyCapacity(window, opts) / 168;
  return perHour > 0 ? n / perHour : Infinity;
}
