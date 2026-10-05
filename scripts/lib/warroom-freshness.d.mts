// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { WarSegment } from './warroom-session.mjs';

export type FreshKind = 'quote' | 'index' | 'list' | 'sector' | 'news';
export type StampState = 'live' | 'delayed' | 'stale' | 'closed' | 'prev' | 'preopen';
export type RowAge = 'fresh' | 'aging' | 'old' | 'notrade' | 'none';

export interface StampInfo {
  state: StampState;
  /** ● ◐ ▲ ■ ◆ ○ */
  glyph: string;
  /** 完整文字（含符號），例：「● 即時 10:42:15」「◐ 延遲 3 分」「▲ 過期 7 分·重試中」 */
  text: string;
  /** 資料年齡（分，無條件捨去）；prev／closed／preopen／無資料為 null */
  ageMin: number | null;
}

export interface StampInput {
  kind: FreshKind;
  /** 資料本身的時間（epoch ms）；null＝沒有資料 */
  asOf: number | null;
  now: number;
  segment: WarSegment;
  /** 只有開盤後才有意義（家數、榜單、族群、報價）：盤前一律「○ 未開盤」 */
  openOnly?: boolean;
  /** 即時狀態的字，預設「即時」 */
  liveLabel?: string;
}

export const FRESH_THRESHOLDS: Readonly<Record<FreshKind, Readonly<{ delayMs: number; staleMs: number }>>>;
export const ROW_AGE: Readonly<{ agingMs: number; oldMs: number }>;
export const STAMP_GLYPH: Readonly<Record<StampState, string>>;

export function hhmmss(ms: number): string;
export function hhmm(ms: number): string;
export function mmdd(ms: number): string;
export function toEpochMs(v: unknown): number | null;
export function stampOf(input: StampInput): StampInfo;
export function rowAgeOf(
  q: { revealAt?: number | null; source?: string; volume?: number } | null | undefined,
  now: number,
  segment: WarSegment,
): RowAge;
