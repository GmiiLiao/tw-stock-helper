// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { StopBook } from './warroom-mine.mjs';
export interface TopCounts {
  limitUp: number;
  limitDown: number;
  up: number;
  down: number;
  /** counted − up − down（daemon 沒存平盤數，由有效檔數推得） */
  flat: number;
  /** 有效檔數（4 碼非 00、排除興櫃、有有效價格） */
  counted: number;
  live: number | null;
}

export interface TopLevel {
  key: string;
  label: string;
  /** 該級距歷史「全日收盤」均漲停數（非同時刻） */
  luExp: number | null;
  ldExp: number | null;
}

export interface TopPulse {
  /** marketPulse.updatedAt（資料本身的時間） */
  asOf: number | null;
  marketNow: boolean | null;
  basis: 'live' | 'settled' | null;
  counts: TopCounts | null;
  level: TopLevel | null;
  twiiChg: number | null;
  /** 累積成交值（億） */
  value: number | null;
  /** 昨日全日成交值（億；daemon 以收盤價×張數估） */
  prevValue: number | null;
  valueVsPrevFullDay: number | null;
  otcChg: number | null;
}

export interface TopPattern { key: string; label: string; date: string | null; at: number | null }
export interface TopHeartbeat { lastHeartbeat: number | null; active: boolean | null }
export interface TopHotLag { at: number | null; p50: number | null; p90: number | null; freshPct: number | null }
export interface TopTaifex { date: string | null; foreignTxfNetOI: number | null; putCallRatio: number | null; asOf: number | null }

export interface DangerState {
  ymd: string;
  lastAsOf: number;
  streak: number;
  clearStreak: number;
  active: boolean;
  seq: number;
  lastFire: number;
}

/** distPct：距停損%（1 位小數；≤0＝已觸及） */
export interface NearStop { code: string; name: string; distPct: number }

export interface HoldingLike { id?: string; code: string; name?: string; buyPrice: number; quantity: number; buyDate?: string }

export interface DaemonAlertEvent {
  id: string;
  at: number;
  /** daemon 警示一律二級「我的」（觸停損一級改由前端依規範 stop-v1 判定） */
  kind: 'mine';
  level: 2;
  code?: string;
  mine: true;
  text: string;
}

export const DANGER_RULE: Readonly<{
  fromMinute: number; untilMinute: number; minLimitDown: number; ratio: number; beats: number; clearBeats: number; refireMs: number;
}>;
export const PATTERN_LABEL: Readonly<Record<string, string>>;
export const LEVEL_TONE: Readonly<Record<string, 'up' | 'dn' | 'flat' | 'danger'>>;
export const DAEMON_ALERT_LABEL: Readonly<Record<string, string>>;
/** daemon 停損類推播（舊算法）的 type：'stop'、'discipline' */
export const LEGACY_STOP_TYPES: readonly string[];
export const LEGACY_STOP_NOTE: string;
export const LEVEL1_ORDER: readonly string[];

export function normalizePulse(doc: unknown): TopPulse | null;
export function normalizePattern(doc: unknown, todayYmd: string): TopPattern | null;
export function normalizeHeartbeat(doc: unknown): TopHeartbeat | null;
export function normalizeHotLag(doc: unknown): TopHotLag | null;
export function normalizeTaifex(doc: unknown): TopTaifex | null;

export function dangerMet(counts: { limitUp: number; limitDown: number } | null | undefined): boolean;
export function initialDangerState(ymd: string): DangerState;
export function stepDanger(
  prev: DangerState | null | undefined,
  beat: { asOf: number | null; counts: { limitUp: number; limitDown: number } | null } | null | undefined,
): { state: DangerState; fired: boolean };
export function parseDangerState(raw: unknown, ymd: string): DangerState;

/** 逼近停損（規範 stop-v1 暫算：成本線、未含除權息調整；價格在停損下或距停損 ≤2%） */
export function nearStopList(
  holdings: readonly HoldingLike[] | null | undefined,
  prices: Readonly<Record<string, number>> | null | undefined,
  /** 本機事件表（棘輪的上一版；與 A1、Z2 同一份） */
  book?: StopBook | null,
): NearStop[];

export function isIndicativeMinute(minute: number): boolean;
export function eventFromDaemonAlert(a: unknown, todayYmd: string): DaemonAlertEvent | null;
export function severityRank(kind: string): number;
export function sortLevel1<T extends { kind: string; at: number }>(list: readonly T[]): T[];
