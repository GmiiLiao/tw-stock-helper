// 盤中戰情 v2 時段（前端與伺服器共用）。
// 邏輯唯一實作在 scripts/lib/warroom-session.mjs（有單元測試）；這裡只負責注入 market-clock 的休市日曆（isTradingDay）
// 與分頁前景判斷。不要在別處重寫時段判斷（CLAUDE.md「交易時段只有一個真相來源」）。
import { isTradingDay } from '@/lib/market-clock';
import {
  warSegmentAt, warClockAt, shouldPollWarRoomAt, msUntilPollWindow,
  SEGMENT_LABEL, PHASE_LABELS, WAR_NODES, countdownText, fmtCountdown, taipeiYmd,
  type WarSegment, type WarClock, type WarNextNode,
} from '../../../scripts/lib/warroom-session.mjs';

export type { WarSegment, WarClock, WarNextNode };
export { SEGMENT_LABEL, PHASE_LABELS, WAR_NODES, countdownText, fmtCountdown, taipeiYmd };

const msOf = (now?: Date | number) => (now == null ? Date.now() : typeof now === 'number' ? now : now.getTime());
const tradingAt = (ms: number) => isTradingDay(new Date(ms));
const isHidden = () => typeof document !== 'undefined' && document.hidden;

/** 目前時段：'pre'|'preclear'|'open'|'mid'|'tail'|'auction'|'closing'|'after'|'nontrading' */
export function warSegment(now?: Date | number): WarSegment {
  const ms = msOf(now);
  return warSegmentAt(ms, tradingAt(ms));
}

/** 時段＋下一節點倒數（指揮列、A2 用） */
export function warClock(now?: Date | number): WarClock {
  const ms = msOf(now);
  return warClockAt(ms, tradingAt(ms));
}

/** 戰情頁輪詢閘門：交易日 08:30–13:45 且分頁在前景才 true（critique L10：shouldPollNow 在 14:00–14:31 仍回 true） */
export function shouldPollWarRoom(now?: Date | number): boolean {
  const ms = msOf(now);
  return shouldPollWarRoomAt(ms, tradingAt(ms), isHidden());
}

/** 距今日輪詢窗（08:30）開始的 ms；今天不會再開始回 null。給輪詢間隔函式「盤前提早喚醒」用。 */
export function msUntilWarPollWindow(now?: Date | number): number | null {
  const ms = msOf(now);
  return msUntilPollWindow(ms, tradingAt(ms));
}

/** 盤中有成交的時段（價格、價齡、閃色只在這些時段有意義） */
export function isTradingSegment(seg: WarSegment): boolean {
  return seg === 'open' || seg === 'mid' || seg === 'tail' || seg === 'auction' || seg === 'closing';
}

/** 價格類一級警示暫停的時段：盤前試撮、清空窗、收盤集合競價（試撮指示價可能不成交） */
export function isIndicativeSegment(seg: WarSegment): boolean {
  return seg === 'pre' || seg === 'preclear' || seg === 'auction';
}
