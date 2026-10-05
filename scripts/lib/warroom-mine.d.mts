// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { Position, StopResolution, TouchResult, Episode, LotSnap, PrevStopState, VersionReason } from './ai-stoploss.mjs';

export const SHARES_PER_LOT: number;

export function grossPnl(avgCost: number, lots: number, price: number | null | undefined): { amount: number; pct: number } | null;
export function lastCloseOf(q: { source?: string; price?: number; prevClose?: number } | null | undefined): number | null;
export function dayPnlOf(
  lots: ReadonlyArray<{ qty: number; buyPrice: number; buyDate: string | null }>,
  quote: { price: number; prevClose: number } | null | undefined,
  todayYmd: string,
): { amount: number; base: number } | null;
export function sumDayPnl(parts: ReadonlyArray<{ amount: number; base: number } | null | undefined>): { amount: number; pct: number; counted: number } | null;
export function mergeTradedBefore<T extends Record<string, { price: number; revealAt: number }>>(
  prev: T,
  quotes: Readonly<Record<string, { price: number; revealAt: number | null; source: string }>>,
  cutoffMs: number,
): T;
export function taipeiAt(ymd: string, hh: number, mm: number): number;

/** 戰情報價（WarQuote 形）的必要欄位 */
export interface WarQuoteLike {
  price: number; open: number; high: number; low: number; volume: number;
  prevClose?: number; revealAt: number | null; fetchedAt: number | null; source: string;
}
export function judgeQuoteOf(q: WarQuoteLike | null | undefined): {
  price: number; open: number; high: number; low: number; volume: number; live: boolean; liveAt: number | null; revealAt: number | null;
} | null;

/** 本機事件表的一檔 → resolveStop 的 prev（停損簿未上線的退回：棘輪與持股變動分類的上一版）；不合法回 null */
export function stopPrevOf(entry: StopEpisodeEntry | null | undefined): PrevStopState | null;
/** 停損簿未上線時的暫算停損（空係數表；prev＝本機事件表這一檔，沒有就從成本線起算） */
export function provisionalStop(
  position: Position, lastPrice: number | null | undefined, nowMs?: number, todayYmd?: string, entry?: StopEpisodeEntry | null,
): StopResolution;
/** 英文字尾 ETF（00631L、00632R…；規範 §15-1 檔位待核實） */
export function isSuffixEtfCode(code: string): boolean;

export type WarStopLevel = 'hit' | 'near' | 'ok';
export interface WarStopView {
  res: StopResolution;
  stop: number | null;
  isEtf: boolean;
  /** 今日盤中才生效的停損（今天有買進，或本裝置 09:00 後偵測到換版；前端沒有真成交旗標 ⇒ 今日不判定觸及） */
  setToday: boolean;
  touch: TouchResult;
  /** 距停損%（1 位小數；≤0＝在停損價或以下） */
  distPct: number | null;
  level: WarStopLevel | null;
  /** A1 第二行原因句（事實句；含停損價——只在使用者自己的畫面） */
  reason: string | null;
  /** 距停損欄提示：停損 X（規範 stop-v1·依據·前端暫算） */
  title: string;
}
export function warStopView(input: {
  position: Position;
  quote: WarQuoteLike | null;
  calcPrice: number | null;
  priceLabel?: string;
  nowMs: number;
  todayYmd: string;
  tradingDay: boolean;
  disposition?: boolean;
  /** 本機事件表這一檔（棘輪的上一版）；A1、抽屜、Z2 要帶同一份 */
  entry?: StopEpisodeEntry | null;
}): WarStopView;

/** 今日判定狀態（快看抽屜用）：觸及／未觸及／不判定的原因；沒有停損回 '' */
export function stopJudgeText(v: WarStopView | null | undefined): string;

// ── Z2 一級「觸停損」本機事件表
export interface StopEpisodeEntry {
  stop: number; ver: number; settledYmd: string; ep: Episode | null;
  /** 這一版的逐筆快照（null＝沒有快照） */
  lots: LotSnap[] | null;
  /** 本裝置偵測到這一版的時刻與版本日（第一次進表＝0／''） */
  startedAt: number; tradeDate: string;
}
/** 代號 → 本機事件表一檔（TopStore.stopBook） */
export type StopBook = Readonly<Record<string, StopEpisodeEntry>>;
export interface StopEpisodeState { nextId: number; byCode: Readonly<Record<string, StopEpisodeEntry>> }
export function parseStopEpisodes(raw: unknown): StopEpisodeState;
export function serializeStopEpisodes(state: StopEpisodeState): { v: 1; nextId: number; byCode: Readonly<Record<string, StopEpisodeEntry>> };
export interface StopEpisodeRow {
  code: string;
  stop: number | null;
  touch: TouchResult;
  /** 觸及當下報價的揭示時間（事件時間）；沒有用 nowMs */
  at?: number | null;
  /** 今日有真成交時的昨收（MIS 昨收）；否則 null */
  prevClose: number | null;
  /** 前一交易日 YYYY-MM-DD */
  prevYmd: string | null;
  /** 這一輪的逐筆快照（position.lots） */
  lots?: readonly LotSnap[] | null;
  /** resolveStop 的換版原因（帶本機表當 prev 算出） */
  reason?: VersionReason | null;
  /** 成本資料可疑（停損警示暫停，改發二級） */
  suspect?: boolean;
}
export function stepStopEpisodes(
  state: StopEpisodeState, rows: readonly StopEpisodeRow[], ctx: { todayYmd: string; nowMs: number; versionYmd?: string },
): { state: StopEpisodeState; changed: boolean; sendLevel1: string[]; seeded: string[]; late: string[] };
export function stopEventId(code: string, ver: number, epId: number): string;
export interface StopWarEvent {
  id: string; at: number; kind: 'stopLoss' | 'mine'; level: 1 | 2; code?: string; mine: true; text: string;
}
export function stopLevel1Events(state: StopEpisodeState, names: ReadonlyMap<string, string>, todayYmd: string): StopWarEvent[];
export function stopSeededEvent(state: StopEpisodeState, names: ReadonlyMap<string, string>, todayYmd: string): StopWarEvent | null;
/** 成本資料可疑：每檔每日一則二級（文字不寫成本、比值與停損價） */
export function stopSuspectEvents(codes: readonly string[], names: ReadonlyMap<string, string>, todayYmd: string, nowMs: number): StopWarEvent[];
