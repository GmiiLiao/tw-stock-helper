// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2 的時段切分（純函式·唯一實作）
//
// 前端（src/lib/warroom/session.ts）與伺服器端 build-*（同一支 session.ts）共用；
// 「今天是不是交易日」由呼叫端注入（market-clock 的 isTradingDay，休市日曆在那裡）。
// 時間一律以 epoch ms 計算台北時間（固定 UTC+8、台灣無日光節約）——不吃 server／瀏覽器的本地時區。
//
// 時段（2026-10-05 使用者定案「照預覽頁」）：
//   pre 08:30–08:55 盤前試撮 · preclear 08:55–09:00 清空（只清價格欄）· open 09:00–09:30 開盤段
//   mid 09:30–12:45 盤中段 · tail 12:45–13:25 尾盤段（撿尾盤資料起點）· auction 13:25–13:30 收盤集合競價
//   closing 13:30–13:45 收盤定價窗 · after 13:45 後（交易日 08:30 前也歸 after：沿用前一交易日資料）
//   nontrading 非交易日
//
// 輪詢閘門 shouldPollWarRoomAt：交易日 08:30–13:45 才 true（critique L10：market-clock 的 shouldPollNow
// 在 14:00–14:31 post-close 仍回 true，戰情頁 13:45 後要全頁凍結，故另設這道閘門）。
// 單元測試：node --test scripts/lib/warroom-session.test.mjs
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const TPE_OFFSET_MS = 8 * 3_600_000;
const MIN_MS = 60_000;
const M = (h, m) => h * 60 + m;
const pad2 = n => String(n).padStart(2, '0');

/** 時段節點（台北「當日分鐘數」） */
export const WAR_NODES = Object.freeze({
  preStart: M(8, 30), preclear: M(8, 55), open: M(9, 0), mid: M(9, 30), tail: M(12, 45),
  dtFlat: M(13, 20), auction: M(13, 25), closing: M(13, 30), after: M(13, 45),
});
const N = WAR_NODES;

export const WAR_SEGMENTS = Object.freeze(['pre', 'preclear', 'open', 'mid', 'tail', 'auction', 'closing', 'after', 'nontrading']);

export const SEGMENT_LABEL = Object.freeze({
  pre: '盤前', preclear: '試撮清空', open: '開盤', mid: '盤中', tail: '尾盤',
  auction: '收盤競價', closing: '定價', after: '盤後', nontrading: '休市',
});

/** 指揮列的時段膠囊（索引＝phaseIndexOf 的回傳） */
export const PHASE_LABELS = Object.freeze(['盤前', '開盤', '盤中', '尾盤', '收盤競價', '定價', '盤後']);

const PHASE_INDEX = Object.freeze({ pre: 0, preclear: 0, open: 1, mid: 2, tail: 3, auction: 4, closing: 5, after: 6, nontrading: -1 });

/** 下一個節點（倒數用）：[起（含）, 迄（不含）, 目標分鐘, 標籤] */
const NEXT_NODES = Object.freeze([
  [0, N.preStart, N.preStart, '盤前試撮'],
  [N.preStart, N.open, N.open, '開盤'],
  [N.open, N.mid, N.mid, '盤中段'],
  [N.mid, N.tail, N.tail, '尾盤'],
  [N.tail, N.dtFlat, N.dtFlat, '13:20 當沖平倉'],
  [N.dtFlat, N.auction, N.auction, '收盤競價'],
  [N.auction, N.closing, N.closing, '收盤'],
  [N.closing, N.after, N.after, '定價結束'],
]);

/** 台北當日分鐘數（含小數；00:00＝0） */
export function taipeiMinuteOfDay(ms) {
  const t = (((ms + TPE_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
  return t / MIN_MS;
}

/** 台北當日 00:00 的 epoch ms */
export function taipeiDayStart(ms) {
  return Math.floor((ms + TPE_OFFSET_MS) / DAY_MS) * DAY_MS - TPE_OFFSET_MS;
}

/** 台北日期 YYYY-MM-DD（與休市日曆同格式） */
export function taipeiYmd(ms) {
  const d = new Date(ms + TPE_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 時段判定。tradingDay＝呼叫端以休市日曆判好的「今天是否交易日」。 */
export function warSegmentAt(ms, tradingDay) {
  if (!tradingDay) return 'nontrading';
  const m = taipeiMinuteOfDay(ms);
  if (m < N.preStart) return 'after';
  if (m < N.preclear) return 'pre';
  if (m < N.open) return 'preclear';
  if (m < N.mid) return 'open';
  if (m < N.tail) return 'mid';
  if (m < N.auction) return 'tail';
  if (m < N.closing) return 'auction';
  if (m < N.after) return 'closing';
  return 'after';
}

export function phaseIndexOf(segment) {
  return PHASE_INDEX[segment] ?? -1;
}

/** 下一個節點；13:45 後與非交易日回 null（盤後不倒數到隔日——隔日是否交易要看日曆） */
export function nextNodeAt(ms, tradingDay) {
  if (!tradingDay) return null;
  const m = taipeiMinuteOfDay(ms);
  for (const [from, to, target, label] of NEXT_NODES) {
    if (m >= from && m < to) {
      const at = taipeiDayStart(ms) + target * MIN_MS;
      return { label, at, msLeft: Math.max(0, at - ms) };
    }
  }
  return null;
}

/** 倒數長度：未滿 1 小時「18 分」，滿 1 小時「2:03」 */
export function fmtCountdown(msLeft) {
  const totalMin = Math.max(0, Math.ceil(msLeft / MIN_MS));
  if (totalMin < 60) return `${totalMin} 分`;
  return `${Math.floor(totalMin / 60)}:${pad2(totalMin % 60)}`;
}

/** 「距開盤 18 分」「距尾盤 2:03」「距 13:20 當沖平倉 15 分」；沒有下一節點回 '' */
export function countdownText(next) {
  if (!next) return '';
  const sep = /^\d/.test(next.label) ? ' ' : '';
  return `距${sep}${next.label} ${fmtCountdown(next.msLeft)}`;
}

/** 指揮列與 A2 用的時鐘快照 */
export function warClockAt(ms, tradingDay) {
  const segment = warSegmentAt(ms, tradingDay);
  const minute = taipeiMinuteOfDay(ms);
  const next = nextNodeAt(ms, tradingDay);
  return {
    segment,
    phaseIndex: phaseIndexOf(segment),
    beforeOpen: !!tradingDay && minute < N.preStart,
    minute,
    ymd: taipeiYmd(ms),
    next,
    countdown: countdownText(next),
  };
}

/** 戰情頁輪詢閘門：交易日 08:30–13:45、分頁在前景 */
export function shouldPollWarRoomAt(ms, tradingDay, hidden = false) {
  if (hidden || !tradingDay) return false;
  const m = taipeiMinuteOfDay(ms);
  return m >= N.preStart && m < N.after;
}

/** 距今日輪詢窗開始（08:30）還有多少 ms；已過或非交易日回 null（今天不會再開始） */
export function msUntilPollWindow(ms, tradingDay) {
  if (!tradingDay) return null;
  const at = taipeiDayStart(ms) + N.preStart * MIN_MS;
  return ms < at ? at - ms : null;
}
