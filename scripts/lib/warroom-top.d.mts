// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { StopBook, WarStopCtx } from './warroom-mine.mjs';
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
  /** 停損簿生效前 daemon 警示一律二級「我的」（觸停損一級由前端依規範判定，A7）；生效後 requireAck 的觸停損＝一級 'stopLoss' */
  kind: 'mine' | 'stopLoss';
  level: 1 | 2;
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
/** 停損簿生效後仍走舊分支的代號（ETF／興櫃歸檔驗證前）的註記 */
export const LEGACY_BRANCH_NOTE: string;
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

/** 逼近停損（規範 stop-v1.1，與 A1 同一支 warStopResOf；價格在停損下或距停損 ≤1 ATR，沒有 ATR14 時 ≤2%） */
export function nearStopList(
  holdings: readonly HoldingLike[] | null | undefined,
  prices: Readonly<Record<string, number>> | null | undefined,
  /** 本機事件表（前端暫算的棘輪上一版；與 A1、Z2 同一份） */
  book?: StopBook | null,
  /** 持股分析 ATR 帶、前一交易日、停損簿（與 A1 同一份）＋今天 */
  opts?: { ctx?: WarStopCtx | null; todayYmd?: string; nowMs?: number } | null,
): NearStop[];

export function isIndicativeMinute(minute: number): boolean;
/** opts.stopLive：停損簿已生效（phase 'live'）⇒ daemon 帶 requireAck＋id 的觸停損轉一級 */
export function eventFromDaemonAlert(a: unknown, todayYmd: string, opts?: { stopLive?: boolean } | null): DaemonAlertEvent | null;
export function severityRank(kind: string): number;
export function sortLevel1<T extends { kind: string; at: number }>(list: readonly T[]): T[];
