// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export type WarSegment = 'pre' | 'preclear' | 'open' | 'mid' | 'tail' | 'auction' | 'closing' | 'after' | 'nontrading';

export interface WarNextNode {
  /** 節點名稱（「開盤」「盤中段」「13:20 當沖平倉」…） */
  label: string;
  /** 節點時刻 epoch ms */
  at: number;
  /** 距節點 ms（≥0） */
  msLeft: number;
}

export interface WarClock {
  segment: WarSegment;
  /** PHASE_LABELS 的索引；盤前／清空＝0…盤後＝6；非交易日＝-1 */
  phaseIndex: number;
  /** 交易日 08:30 之前（segment 為 'after'，但語意是「今天還沒開始」） */
  beforeOpen: boolean;
  /** 台北當日分鐘數（含小數） */
  minute: number;
  /** 台北日期 YYYY-MM-DD */
  ymd: string;
  next: WarNextNode | null;
  /** 「距開盤 18 分」；無下一節點為 '' */
  countdown: string;
}

export const WAR_NODES: Readonly<{
  preStart: number; preclear: number; open: number; mid: number; tail: number;
  dtFlat: number; auction: number; closing: number; after: number;
}>;
export const WAR_SEGMENTS: readonly WarSegment[];
export const SEGMENT_LABEL: Readonly<Record<WarSegment, string>>;
export const PHASE_LABELS: readonly string[];

export function taipeiMinuteOfDay(ms: number): number;
export function taipeiDayStart(ms: number): number;
export function taipeiYmd(ms: number): string;
export function warSegmentAt(ms: number, tradingDay: boolean): WarSegment;
export function phaseIndexOf(segment: WarSegment): number;
export function nextNodeAt(ms: number, tradingDay: boolean): WarNextNode | null;
export function fmtCountdown(msLeft: number): string;
export function countdownText(next: WarNextNode | null): string;
export function warClockAt(ms: number, tradingDay: boolean): WarClock;
export function shouldPollWarRoomAt(ms: number, tradingDay: boolean, hidden?: boolean): boolean;
export function msUntilPollWindow(ms: number, tradingDay: boolean): number | null;
