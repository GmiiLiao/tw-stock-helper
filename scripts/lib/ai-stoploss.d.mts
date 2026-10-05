// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）。
// 簽章照實作計畫 warroom/stoploss/impl-plan.md §1.2；本檔只宣告 ai-stoploss.mjs 目前實作的子集（戰情 v2 需要的部分）。
export const STOP_SPEC_VERSION: 'stop-v1';
export const STOP_PARAMS: Readonly<{
  capPct: 8; clearMult: 1.02; nearAtr: 1; nearPctFallback: 2; aiMinAtr: 2; aiMinPct: 5;
  trailFromPct: 10; trailGivebackPct: 8; suspectLo: 0.25; suspectHi: 5; staleSec: 300;
  disciplineFromDay: 2; shadowMinDays: 20;
}>;

export type StopBasis = 'cost' | 'ai' | 'user';
/** v1 恆為 'stop'；'aboveCost' 留給第二階段 */
export type StopLine = 'stop' | 'aboveCost';
export type VersionReason = 'init' | 'ratchet' | 'exAdjust' | 'userSet' | 'costCorrection' | 'aiActivate';
export type LotChange = 'init' | 'buy' | 'sell' | 'edit' | 'selfAdjust' | 'exit';
/** ＝ warroom-session WAR_SEGMENTS */
export type WarSegment = 'pre' | 'preclear' | 'open' | 'mid' | 'tail' | 'auction' | 'closing' | 'after' | 'nontrading';
export type TouchKind = 'touch' | 'gap' | 'close' | 'late';
export type NotJudgedReason = 'segment' | 'noTodayTrade' | 'badLow' | 'exPending' | 'suspectCost' | 'noStop' | 'setTodayLate';
/** 觸及成立但一級暫緩／降為二級 */
export type HoldReason = 'exUnconfirmed' | 'exUnknown';

// ── 檔位與漲跌停
export function isEtfCode(code: string): boolean;
export function tickOf(price: number, isEtf?: boolean): number;
/** -1 向下、+1 向上（ceilTick）、0 四捨五入；非正數回 NaN */
export function roundTick(price: number, dir: -1 | 0 | 1, isEtf?: boolean): number;
export function onTick(price: number, isEtf?: boolean): boolean;
export function limitPrices(refPrice: number | null, isEtf?: boolean, noLimit?: boolean): { up: number; down: number } | null;

// ── 部位彙總
export function normYmd(s: unknown): string;
export interface HoldingLot { id?: string; code: string; name?: string; buyPrice: number; quantity: number; buyDate?: string }
export interface LotSnap { id: string; buyPrice: number; qty: number; buyDate: string | null }
export interface Position {
  code: string; name: string;
  /** 張（可含小數＝零股） */
  qty: number;
  /** 買進均價（每股）＝Σ 買價×張 ÷ Σ 張 */
  avgCost: number;
  firstDate: string | null;
  lastBuyDate: string | null;
  lots: LotSnap[];
}
export function aggregatePositions(lots: ReadonlyArray<HoldingLot | null | undefined> | null | undefined): Position[];

// ── 事件係數
/** f＝事件後參考價 ÷ 事件前收盤 */
export type ExEvent = readonly [date: string, factor: number];
export interface ExTable { events: readonly ExEvent[]; coverFrom: string | null; coverTo: string | null }
/** 沒有係數表（前端退回）：不還原、不判 exUnknown，依據文字標「未含除權息調整」 */
export const EMPTY_EX_TABLE: ExTable;
export function exTableFor(code: string,
  mergedItems: ReadonlyArray<{ date: string; code: string; factor: number }>,
  cover: { from: string; to: string }): ExTable;
export function adjustedCost(pos: Position, ex: ExTable, selfAdjusted?: Readonly<Record<string, readonly string[]>>):
  { adjCost: number; exUnknown: boolean; applied: string[] };
export function classifyLotChange(prevLots: readonly LotSnap[] | null, cur: readonly LotSnap[], ex: ExTable, isEtf?: boolean):
  { changes: LotChange[]; editedIds: string[]; selfAdjusted: Record<string, string[]> };

// ── 過渡期（第一階段）：與 daemon 停損推播同口徑（＝已移除的 warroom-stop.stopAnchor）
export function legacyPushStop(avgCost: number, aiStopLoss: number | null | undefined):
  { price: number; source: 'ai' | 'cost' } | null;

// ── v1 決定停損
export interface PrevStopState {
  stop: number; stopVersion: number; lots: readonly LotSnap[];
  exApplied: readonly string[]; selfAdjusted?: Readonly<Record<string, readonly string[]>>;
  startedAt: number; tradeDate: string;
}
export interface ResolveStopInput {
  position: Position; ex: ExTable; prev?: PrevStopState | null;
  /** v1 一律 null（未實作） */
  aiActive?: { price: number; basisText: string } | null;
  /** ND14（第二階段），v1 一律 null（未實作） */
  userStop?: number | null;
  isEtf?: boolean;
  /** 只用於成本可疑檢查 */
  lastPrice?: number | null;
  capPct?: number;
  /** 版本日：非交易日＝最後交易日（呼叫端以休市日曆算） */
  nowMs: number; tradeDate: string;
}
export interface StopResolution {
  specVersion: 'stop-v1';
  /** null＝不算（成本缺） */
  stop: number | null;
  line: StopLine;
  basis: StopBasis;
  /** 例：「成本線·還原成本 56.90 −8%」；沒有係數表時「成本線·買進均價 56.90 −8%·未含除權息調整」 */
  basisText: string;
  adjCost: number | null; costLine: number | null;
  /** 與 prev 相同時 versionReason=null */
  stopVersion: number; versionReason: VersionReason | null;
  startedAt: number; tradeDate: string;
  lotChanges: LotChange[]; exApplied: string[]; selfAdjusted: Record<string, string[]>;
  exUnknown: boolean; suspect: boolean;
  rejected: Array<{ code: 'invalid' | 'prevInvalid' | 'tooWide' | 'loosen'; detail: string }>;
}
export function resolveStop(input: ResolveStopInput): StopResolution;

// ── 觸發判定
export interface QuoteForJudge {
  price?: number; open?: number; high?: number; low?: number; volume?: number;
  live?: boolean; settled?: boolean; liveAt?: number | null; revealAt?: number | null;
  /** 主迴圈快照才有；前端報價沒有（⇒ setToday 一律不判） */
  realTrade?: boolean;
}
export function judgeSegment(nowMs: number, tradingDay: boolean): WarSegment;
export function segmentJudges(seg: WarSegment): boolean;
export function isTodayTrade(q: QuoteForJudge | null | undefined, todayYmd: string): boolean;
export function isSetToday(ver: { tradeDate: string; startedAt: number }, todayYmd: string, openMs: number): boolean;
export interface EvaluateTouchInput {
  stop: number; quote: QuoteForJudge | null; nowMs: number; todayYmd: string; tradingDay: boolean;
  exPending?: boolean; exUnconfirmed?: boolean; exUnknown?: boolean; suspect?: boolean;
  isEtf?: boolean; disposition?: boolean;
  refPrice?: number | null; noLimit?: boolean;
  setToday?: boolean; startedAt?: number | null;
  atr14?: number | null;
}
export interface TouchResult {
  status: 'ok' | 'near' | 'touched' | 'notJudged';
  kind: TouchKind | null; triggerPx: number | null;
  /** 開盤已跳過停損的幅度（百分比，(停損−開盤)÷停損×100） */
  skipPct: number | null;
  basis: 'low' | 'trade' | 'officialLow' | null;
  segment: WarSegment; notJudged: NotJudgedReason | null; hold: HoldReason | null;
  staleSec: number | null;
  /** 跌停／一字跌停／處置撮合／報價延遲／依成交價判定（事實句） */
  facts: string[];
}
export function evaluateTouch(input: EvaluateTouchInput): TouchResult;
/** pct＝(現價−停損)÷現價×100（未四捨五入）；near＝現價在停損上方且 ≤1×ATR14，沒有 ATR 時 ≤2% */
export function stopDistance(stop: number, price: number, atr14?: number | null):
  { pct: number; atrMultiple: number | null; near: boolean } | null;

// ── 觸及事件
export interface Episode {
  id: number; stopVersion: number; kind: TouchKind; triggerAt: number;
  /** seeded 且當下沒有觸及時為 null */
  triggerPx: number | null; skipPct: number | null;
  /** 事件起始交易日 */
  firstDate: string;
  /** 最後一次觸及更新的交易日 */
  lastDate: string;
  /** 官方收盤 ≤ 停損的交易日數 */
  closesBelow: number;
  /** 第一次判定時已在停損下（不發一級） */
  seeded?: boolean;
  /** 一級暫緩（exUnconfirmed 確認後釋放；exUnknown 不釋放） */
  hold?: HoldReason | null;
  level1Sent: boolean;
}
export function advanceEpisode(prev: Episode | null, ev: {
  touch: TouchResult; stopVersion: number; versionReason: VersionReason | null; todayYmd: string; nowMs: number; nextId: number;
  /** 擴充：第一次判定時部位已在停損下 ⇒ 開 seeded 事件、不發一級 */
  seeded?: boolean;
}): { episode: Episode | null; isNew: boolean; sendLevel1: boolean };
/** 官方收盤 > 停損×1.02 ⇒ ended；每個交易日只呼叫一次 */
export function settleEpisode(ep: Episode | null, ev: { officialClose: number; stop: number; dateYmd: string }):
  { episode: Episode | null; ended: boolean };

// ── 文案（只描述事實；測試逐一掃禁用詞）
export type StopFactKind = 'row' | 'touch' | 'gap' | 'closeTouch' | 'lateTouch' | 'digest' | 'exAdjust' | 'exPending'
  | 'exUnconfirmed' | 'exUnknown' | 'suspect' | 'trailBreak' | 'auction' | 'preOpen' | 'stale' | 'limitDown'
  | 'disposition' | 'seededDigest' | 'provisional' | 'tradeBasis';
/** 停損相關價格的顯示（依檔位定小數位、千分位逗號） */
export function stopPxText(p: number, isEtf?: boolean): string;
export function stopFactText(kind: StopFactKind, data: Readonly<Record<string, unknown>>): string;
export const STOP_FACT_KINDS: readonly StopFactKind[];
