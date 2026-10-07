// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）。
// 規範 .claude/skills/tw-ai-stoploss/SKILL.md（stop-v1.1）；簽章照實作計畫 warroom/stoploss/v1.1/impl-plan.md §1.2。
// 本檔宣告集線器 ai-stoploss.mjs 匯出的全部函式（實作分在 ai-stoploss-{base,lines,core,event,text,llm,plan}.mjs 與 news-rule-classes.mjs）。

// ── 版本與參數 ────────────────────────────────────────────────────────────────
export const STOP_SPEC_VERSION: 'stop-v1.1';
export interface EventTierParam { tier: 'strong' | 'mild'; minWeight: number; atrMult: number; minPct: number }
export const STOP_PARAMS: Readonly<{
  capPct: 8;
  bandRatchet: boolean; bandAtrMult: 0.5; bandClampLo: 0.85; bandClampHi: 0.97; bandMinBars: 15;
  beTriggerPct: 10; trailTriggerPct: 20; trailAtr: 3;
  eventTiers: readonly EventTierParam[]; eventHoldDays: 5; eventRearmDays: 5;
  clearMult: 1.02; nearAtr: 1; nearPctFallback: 2; suspectLo: 0.25; suspectHi: 5; staleSec: 300;
  disciplineFromDay: 2; shadowMinDays: 20; archiveFrom: string;
}>;

/** 誰訂的停損：系統線一律 'system'（v1 的 'cost' 改名）；'ai'、'user' 第二階段。不得用它判斷是哪一條線（看 StopSource） */
export type StopBasis = 'system' | 'ai' | 'user';
/** 生效停損目前由哪一條線決定 */
export type StopSource = 'cost' | 'atrBand' | 'breakeven' | 'trail' | 'event';
/** 系統線恆為 'stop'；'aboveCost' 留給第二階段 */
export type StopLine = 'stop' | 'aboveCost';
export type VersionReason = 'init' | 'ratchet' | 'lineRaise' | 'exAdjust' | 'costCorrection'
  | 'eventTighten' | 'eventExpire' | 'bandDown' | 'userSet' | 'aiActivate';
export type LotChange = 'init' | 'buy' | 'sell' | 'edit' | 'selfAdjust' | 'exit';
/** ＝ warroom-session WAR_SEGMENTS */
export type WarSegment = 'pre' | 'preclear' | 'open' | 'mid' | 'tail' | 'auction' | 'closing' | 'after' | 'nontrading';
export type TouchKind = 'touch' | 'gap' | 'close' | 'late';
export type NotJudgedReason = 'segment' | 'noTodayTrade' | 'badLow' | 'exPending' | 'suspectCost' | 'noStop' | 'setTodayLate';
/** 觸及成立但一級暫緩／降為二級 */
export type HoldReason = 'exUnconfirmed' | 'exUnknown';
/** 警示文件上的觸及判定價（不與 StopBasis 同名） */
export type TouchBasis = 'low' | 'trade' | 'officialLow';
/** 規則類利空事件類別（新聞技能 §4.1 代號；scripts/lib/news-rule-classes.mjs） */
export type RuleClassCode = 'C16a' | 'C23' | 'C22' | 'C13b' | 'C17' | 'C16b' | 'C15a' | 'C11a' | 'C15c' | 'C20b';
export type EventTier = 'strong' | 'mild' | 'none';

// ── 檔位與漲跌停
export function isEtfCode(code: string): boolean;
export function tickOf(price: number, isEtf?: boolean): number;
/** -1 向下、+1 向上（ceilTick）、0 四捨五入；非正數回 NaN */
export function roundTick(price: number, dir: -1 | 0 | 1, isEtf?: boolean): number;
export function ceilTick(price: number, isEtf?: boolean): number | null;
export function floorTick(price: number, isEtf?: boolean): number | null;
export function onTick(price: number, isEtf?: boolean): boolean;
export function limitPrices(refPrice: number | null, isEtf?: boolean, noLimit?: boolean): { up: number; down: number } | null;

// ── 日期與交易日（休市日曆由呼叫端注入）
export function normYmd(s: unknown): string;
export function nextTradingYmd(ymd: string, isTradingDay?: (ymd: string) => boolean): string | null;
export function prevTradingYmd(ymd: string, isTradingDay?: (ymd: string) => boolean): string | null;
/** 從 ymd 起往後數 n 個交易日（n=0 回 ymd） */
export function addTradingDays(ymd: string, n: number, isTradingDay?: (ymd: string) => boolean): string | null;
/** [from, to] 兩端都含的交易日數 */
export function countTradingDays(fromYmd: string, toYmd: string, isTradingDay?: (ymd: string) => boolean): number;

// ── 文字格式
/** 停損相關價格的顯示（依檔位定小數位、千分位逗號） */
export function stopPxText(p: number, isEtf?: boolean): string;
export function costPxText(p: number): string;
export function hhmmText(ms: number): string;
export function mmddText(ymd: string): string;
export function signedPctText(n: number, digits?: number): string;
export function signedAmountText(n: number): string;
export function pnlClauseText(pnlPct: number | null | undefined): string;
export const BREAKEVEN_NET_NOTE: string;
export interface SourceLabelCtx {
  /** short：觸及類句子；row：一般列與 basisText；prompt：LLM 提示詞（llm-contract §1.1） */
  form?: 'short' | 'row' | 'prompt';
  adjCost?: number | null; hasExTable?: boolean; capPct?: number;
  sourceDate?: string | null; ratchet?: boolean;
  holdHighPct?: number | null; holdHigh?: number | null; fresh?: boolean; isEtf?: boolean;
  effectiveFrom?: string | null; expiresAfter?: string | null; label?: string | null;
}
/** 綁定來源的畫面標籤（唯一格式）：成本線、ATR 帶、保本線、追蹤線、事件收緊·MM/DD 類別名 */
export function stopSourceLabel(src: StopSource | null | undefined, ctx?: SourceLabelCtx): string;
export type StopFactKind = 'row' | 'touch' | 'gap' | 'closeTouch' | 'lateTouch' | 'digest' | 'exAdjust' | 'exPending'
  | 'exUnconfirmed' | 'exUnknown' | 'suspect' | 'trailBreak' | 'auction' | 'preOpen' | 'stale' | 'limitDown'
  | 'disposition' | 'seededDigest' | 'provisional' | 'tradeBasis'
  | 'eventTighten' | 'eventDeferred' | 'eventNoBite' | 'eventExpire' | 'linesStale' | 'pnl' | 'noOfficialBars';
/** 事實句範本（只描述事實；測試逐一掃禁用詞） */
export function stopFactText(kind: StopFactKind, data: Readonly<Record<string, unknown>>): string;
export const STOP_FACT_KINDS: readonly StopFactKind[];

// ── 部位彙總與事件係數
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

// ── 過渡期（第一階段）口徑
/** 與 daemon 停損推播同口徑（AI 停損 >0 優先，否則均價×0.92） */
export function legacyPushStop(avgCost: number, aiStopLoss: number | null | undefined):
  { price: number; source: 'ai' | 'cost' } | null;
/** 與 daemon 停損紀律、崩盤防禦同口徑：max(ATR 帶, 均價×0.92) */
export function legacyDisciplineStop(avgCost: number, aiStopLoss: number | null | undefined): number | null;

// ── 官方日 K 與組成線原料（SKILL §3A、§5、§2 A3）
export interface DayBar { date: string; o: number | null; h: number; l: number; c: number; v?: number | null }
export type BarArchive = 'chip' | 'etf' | 'emerging';
export const BAR_ARCHIVES: Readonly<Record<BarArchive, string>>;
/** 代號 → 官方日 K 歸檔種類；興櫃必須由呼叫端告知 market 'emerging' */
export function barArchiveOf(code: string, market?: 'listed' | 'otc' | 'emerging' | null): BarArchive | null;
/** chipArchive 一律可用；ETF／興櫃歸檔要在 verifiedArchives 內（通過驗證）才算可用 */
export function hasOfficialBars(code: string, opts?: { market?: 'listed' | 'otc' | 'emerging' | null; verifiedArchives?: ReadonlySet<BarArchive> | readonly BarArchive[] }): boolean;
export function adjustBars(raw: ReadonlyArray<Partial<DayBar> & { date: string; c: number }>, ex: ExTable): DayBar[];
/** 簡單平均 14 個 TR（同 indicators.ts calculateATR）；<15 根 ⇒ null */
export function atr14Of(bars: readonly DayBar[]): number | null;
/** calculateAtrStop 移植：supportHint＝MA20×0.98、近 10 日低；支撐−0.5×ATR；夾 [close×0.85, close×0.97]；向下取檔；<15 根 ⇒ null */
export function atrBandOf(bars: readonly DayBar[], isEtf?: boolean):
  { price: number; dataDate: string; close: number; atr14: number; support: number } | null;
export interface HoldHigh { price: number; dataDate: string; complete: boolean; from?: string | null }
export function holdHighClose(bars: readonly DayBar[], firstDate: string | null,
  opts?: { archiveFrom?: string; isTradingDay?: (ymd: string) => boolean }): HoldHigh | null;
export function stepHoldHigh(prev: HoldHigh | null, bar: Partial<DayBar> | null, exEvents: readonly ExEvent[]): HoldHigh | null;
export function profitLines(adjCost: number, holdHigh: number | null, atr14: number | null, isEtf?: boolean):
  { beLine: number | null; trailLine: number | null };
export function exCoverageOf(ex: ExTable, barsFrom: string | null, dataDate: string | null, barDates?: readonly string[] | null):
  { ok: boolean; exGapBars: number };
/** 日 K 結構斷點門檻（分割／反分割候選；與 official-bars.structuralBreaks 預設同值） */
export const STRUCT_BREAK: Readonly<{ lo: number; hi: number }>;
/** ETF 日 K 視窗裡沒有係數涵蓋的結構斷點 ⇒ 斷點之前的根數（SKILL §2A 閘門 ⑦）；沒有回 0 */
export function uncoveredBreakBars(bars: ReadonlyArray<Partial<DayBar> & { date: string; c: number }>, ex: ExTable,
  isTradingDay?: ((ymd: string) => boolean) | null): number;
export interface LineInputs {
  dataDate: string | null; close: number | null; atr14: number | null; barsFrom: string | null;
  atrBand: { price: number; dataDate: string } | null;
  holdHigh: HoldHigh | null;
  exGapBars?: number;
  /** 代號沒有可用的官方日 K（ETF／興櫃歸檔驗證前、或歸檔沒有這檔） */
  noOfficialBars?: boolean;
  /** 日 K 由 daemon 盤前讀本機官方鏡像供給的歸檔種類（2026-10-06 R8）；chipArchive 的不帶。驗證前 legacyBranchActive 仍為真 */
  archive?: 'etf' | 'emerging';
}
export function lineInputsOf(bars: ReadonlyArray<Partial<DayBar> & { date: string; c: number }>, firstDate: string | null,
  prevHoldHigh: HoldHigh | null, ex: ExTable,
  opts?: { isEtf?: boolean; checkBreaks?: boolean; isTradingDay?: (ymd: string) => boolean; archiveFrom?: string; dataDate?: string }): LineInputs;
/** 前端暫算（停損簿上線前）的組成線：ATR 帶＝持股分析 stopLoss 向下取檔、資料日＝前一交易日；沒有帶回 null */
export function frontLinesOf(input: { ratingBand: number | null | undefined; prevTradingYmd: string | null; isEtf?: boolean }): LineInputs | null;

// ── 事件收緊（SKILL §10A；類別權重＝新聞技能 §4.1 baseWeight，先驗·未回測）
export interface RuleClassDef {
  code: RuleClassCode; key: string; label: string; weight: number; tightenEligible: boolean;
  scope: string; trigger: RegExp; fact: string; subWeights?: Readonly<Record<string, number>>;
  /** 觸發字命中處附近出現就不算觸發（例 C20b 的券商評等、目標價） */
  veto?: RegExp;
  /** 規則覆寫時理由的事件描述（2026-10-06 R1 起只有 C16a 會覆寫 newsVerdict 的 label／理由） */
  ruleText: string;
}
export const RULE_BEAR_CLASSES: readonly RuleClassDef[];
export const RULE_CLASS_BY_CODE: Readonly<Record<string, RuleClassDef>>;
export const RULE_CLASS_BY_KEY: Readonly<Record<string, RuleClassDef>>;
export const RULE_CLASS_CODES: readonly RuleClassCode[];
export const CLASS_WEIGHT_NOTE: string;
export function ruleClassOf(verdict: unknown): RuleClassCode | null;
export function ruleSubOf(verdict: unknown, code?: string | null): string | null;
export function classWeightOf(code: string, sub?: string | null): { weight: number; source: string } | null;
export function ruleReasonPrefix(code: string): string;
export interface EventTierInfo {
  tier: EventTier; atrMult: number | null; minPct: number | null; weight: number | null; weightSource: string | null;
  reason: 'notSignal' | 'belowWeight' | 'unknownClass' | null;
}
export function eventTierOf(cls: string, sub?: string | null): EventTierInfo;
/** floorTick(前收 − max(atrMult×ATR14, minPct%×前收)) */
export function eventLineOf(refClose: number | null, atr14: number | null, opts?: boolean | { isEtf?: boolean; atrMult?: number | null; minPct?: number | null }): number | null;
export interface RuleBearEvent {
  code: string; cls: RuleClassCode; clsKey: string; label: string; sub: string | null;
  /** `${code}:${cls}`（確定性；不用引文雜湊） */
  key: string;
  /** 事件日期（'YYYY-MM-DD' 或 'YYYY-MM-DD~YYYY-MM-DD'；延續軌跡優先、再看稽核軌跡；非 C16a 與舊資料 null）——N4 重新起算用（2026-10-07） */
  eventDate: string | null;
  pass: 'evening' | 'night' | 'morning' | 'intraday' | null; at: number; targetDate: string | null;
  weight: number | null; weightSource: string | null; tier: EventTier;
  /** 只記錄（研究期），不參與任何判斷 */
  research: { w: number | null; strength: string | null; confidence: string | null; eventType: string | null };
}
export function ruleBearEvents(doc: unknown, ctx: { applicableYmd: string; minAtMs?: number | null; classes?: readonly string[] }): RuleBearEvent[];
export interface EventOverlay {
  key: string; code?: string | null; cls: RuleClassCode; sub?: string | null; label: string | null;
  tier: EventTier; weight: number | null;
  /** state 'deferred' 時為 null（盤中成交價已低於收緊線，收盤後重算） */
  line: number | null; refClose: number | null; refYmd: string | null; atr14: number | null;
  effectiveFrom: string | null; expiresAfter: string | null;
  startedAt: number; source: 'premarket' | 'intraday' | 'deferred'; state: 'active' | 'deferred';
  deferredPx?: number | null; deferredLine?: number | null;
  /** 這一層的事件日期（N4：期限內來了更晚日期的新進展 ⇒ 換成新的一層、重新起算；2026-10-07）；沒有＝非 C16a 或 N4 前建立 */
  eventDate?: string | null;
  /** N4 換新時被取代的舊事件日期 */
  renewOf?: string | null;
  /**
   * N4 盤中換新、成交價已不高於新線（B3）：這一層（舊層）照常生效，換新延到 16:45 收盤班車以官方收盤重算（取新舊較高者）、
   * 次一交易日生效、期限從那天起算——比照首次事件的延後（2026-10-07 審查）。收盤班車處理後移除
   */
  renewPending?: EventRenewPending | null;
}
/** 掛在舊層上的延後換新（新層的欄位＋盤中當時的成交價與新線） */
export interface EventRenewPending {
  code?: string | null; sub?: string | null; label: string | null; tier: EventTier; weight: number | null; startedAt: number;
  eventDate: string; renewOf: string | null; deferredPx: number | null; deferredLine: number | null;
}
/** [key, 生效日, 最後有效日, 事件日期?]；保留到期後 eventRearmDays 個交易日（事件日期 2026-10-07 起有值才帶） */
export type EventSeen = readonly [key: string, effectiveFrom: string, expiresAfter: string, eventDate?: string];
export type EventOutcome = 'applied' | 'noBite' | 'deferred' | 'noRef' | 'boughtSameDay' | 'boughtAfter' | 'noFirstDate'
  | 'sameEvent' | 'expired' | 'belowWeight' | 'notSignal';
export interface EventRecord {
  key: string; cls: string; outcome: EventOutcome; line: number | null; tier: EventTier | null; weight: number | null;
  /** N4 重新起算（期限內事件日期較晚的新進展） */
  renew?: true;
}
export function stepEventOverlay(prev: readonly EventOverlay[] | null, input: {
  events?: readonly RuleBearEvent[]; seen?: readonly EventSeen[];
  baseStop?: number | null; firstDate?: string | null;
  refClose?: number | null; refYmd?: string | null; atr14?: number | null;
  lastTradePx?: number | null;
  todayYmd: string; nowMs: number; when: 'premarket' | 'intraday' | 'close';
  isTradingDay?: (ymd: string) => boolean; isEtf?: boolean;
}): { overlays: EventOverlay[]; seen: EventSeen[]; changed: Array<'tighten' | 'expire' | 'deferred'>; records: EventRecord[] };
export function activeOverlays(overlays: readonly EventOverlay[] | null | undefined, applyYmd?: string | null): EventOverlay[];
export function eventShadowRows(input: {
  events: readonly RuleBearEvent[]; barsByCode: Readonly<Record<string, readonly DayBar[]>>; dateYmd: string;
}): Array<Record<string, unknown>>;
export function missShadowRows(input: {
  universe: readonly string[]; barsByCode: Readonly<Record<string, readonly DayBar[]>>; newsDoc: unknown;
  dateYmd: string; applicableYmd: string; minAtMs?: number | null;
  mopsCodes?: ReadonlySet<string> | readonly string[]; eventCodes?: ReadonlySet<string> | readonly string[];
}): Array<Record<string, unknown>>;

// ── 決定停損
export interface PrevStopState {
  stop: number; stopVersion: number; lots: readonly LotSnap[];
  exApplied: readonly string[]; selfAdjusted?: Readonly<Record<string, readonly string[]>>;
  startedAt: number; tradeDate: string;
  /** v1.1 新增（v1 的上一版沒有：floorStop 視同 stop、其餘視同 null） */
  baseStop?: number | null; floorStop?: number | null; bandHold?: number | null;
  stopSource?: StopSource | null; sourceDate?: string | null;
  floorSource?: StopSource | null; floorSourceDate?: string | null; bandSourceDate?: string | null;
  basisText?: string | null; holdHigh?: HoldHigh | null; eventKeys?: readonly string[];
}
export interface ResolveStopInput {
  position: Position; ex: ExTable; prev?: PrevStopState | null;
  /** 組成線原料；null＝只有成本線 */
  lines?: LineInputs | null;
  /** 期限內的事件收緊疊加層（activeOverlays 過濾後） */
  events?: readonly EventOverlay[] | null;
  /** 預設 STOP_PARAMS.bandRatchet（true）；前端暫算傳 false */
  bandRatchet?: boolean;
  /** daemon 必傳；lines.dataDate ≠ 它 ⇒ linesStale。前端暫算不傳 ⇒ 不判 linesStale */
  latestCanonicalYmd?: string | null;
  /** 第二階段 */
  aiActive?: null; userStop?: null;
  isEtf?: boolean;
  /** 只用於成本可疑檢查 */
  lastPrice?: number | null;
  capPct?: number;
  /** 版本日：非交易日＝最後交易日（呼叫端以休市日曆算） */
  nowMs: number; tradeDate: string;
}
export interface StopResolution {
  specVersion: 'stop-v1.1';
  /** null＝不算（成本缺） */
  stop: number | null; baseStop: number | null; floorStop: number | null; bandHold: number | null;
  line: StopLine;
  basis: StopBasis;
  /** 一般列的依據，例：「成本線·還原成本 56.90 −8%」「ATR 帶·10/02 設定·只升不降」 */
  basisText: string;
  stopSource: StopSource | null; sourceDate: string | null;
  floorSource: StopSource | null; floorSourceDate: string | null; bandSourceDate: string | null;
  adjCost: number | null; costLine: number | null;
  /** 當日各組成線（ATR 帶今日值 bandLine 可能低於生效停損） */
  lines: { costLine: number | null; bandLine: number | null; beLine: number | null; trailLine: number | null; eventLine: number | null };
  linesStale: boolean; bandRejected: string | null; exGapBars: number;
  holdHigh: HoldHigh | null; atr14: number | null; noOfficialBars: boolean;
  /** 本版納入的事件收緊層 key */
  eventKeys: string[];
  /** 與 prev 相同時 versionReason=null */
  stopVersion: number; versionReason: VersionReason | null;
  startedAt: number; tradeDate: string;
  lotChanges: LotChange[]; exApplied: string[]; selfAdjusted: Record<string, string[]>;
  exUnknown: boolean; suspect: boolean;
  rejected: Array<{ code: 'invalid' | 'prevInvalid' | 'tooWide' | 'loosen' | 'bandInvalid' | 'exGap'; detail: string }>;
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
  /** 觸及判定價（寫進警示文件時改名 touchBasis） */
  basis: TouchBasis | null;
  segment: WarSegment | null; notJudged: NotJudgedReason | null; hold: HoldReason | null;
  staleSec: number | null;
  /** 跌停／一字跌停／處置撮合／報價延遲／依成交價判定（事實句） */
  facts: string[];
}
export function evaluateTouch(input: EvaluateTouchInput): TouchResult;
export function evaluateLateTouch(input: {
  stop: number; officialOpen: number | null; officialLow: number | null; dateYmd: string;
  hadEpisodeToday: boolean; setToday: boolean;
  exPending?: boolean; exUnconfirmed?: boolean; exUnknown?: boolean; suspect?: boolean;
  isEtf?: boolean; refPrice?: number | null; noLimit?: boolean;
}): TouchResult;
/** pct＝(現價−停損)÷現價×100（未四捨五入）；near＝現價在停損上方且 ≤1×ATR14，沒有 ATR 時 ≤2% */
export function stopDistance(stop: number, price: number, atr14?: number | null):
  { pct: number; atrMultiple: number | null; near: boolean } | null;

// ── 觸及事件與紀律
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
  /** 事件開始時的綁定來源（有傳才記） */
  stopSource?: StopSource | null;
}
export const EPISODE_CONTINUE_REASONS: readonly VersionReason[];
export function advanceEpisode(prev: Episode | null, ev: {
  touch: TouchResult; stopVersion: number; versionReason: VersionReason | null; todayYmd: string; nowMs: number; nextId: number;
  /** 第一次判定時部位已在停損下 ⇒ 開 seeded 事件、不發一級 */
  seeded?: boolean;
  stopSource?: StopSource | null;
}): { episode: Episode | null; isNew: boolean; sendLevel1: boolean };
/** 官方收盤 > 停損×1.02 ⇒ ended；每個交易日只呼叫一次 */
export function settleEpisode(ep: Episode | null, ev: { officialClose: number; stop: number; dateYmd: string }):
  { episode: Episode | null; ended: boolean };
/** 換版當下決定事件延續（EPISODE_CONTINUE_REASONS）或結束 */
export function carryEpisode(ep: Episode | null | undefined, res: Pick<StopResolution, 'stopVersion' | 'versionReason'> | null): Episode | null;
/** 事件第 N 個交易日（N ≥ 2 且前一交易日官方收盤 ≤ 停損才回 N） */
export function disciplineDay(ep: Episode | null, todayYmd: string, prevClose: number | null, stop: number, isTradingDay?: (ymd: string) => boolean): number | null;

// ── 推播與畫面文字（第 7、9、13 項；A6）
export const DISCIPLINE_TAIL: '— 請面對決策：停損或明確寫下續抱理由';
export const PLUNGE_TAIL_KEPT: '隔日沖偏多策略暫停追價。';
export const OVERNIGHT_EXIT_PHRASE: '出場時點';
export const FORBIDDEN_WORDS: readonly string[];
export function scanForbidden(text: string, opts?: { allowDisciplineTail?: boolean; allowExitTiming?: boolean }): string[];
export function disciplineTailCount(text: string): number;
export function disciplineDigest(items: ReadonlyArray<{
  code: string; name?: string; n: number; prevClose: number; stop: number;
  stopSource?: StopSource | null; sourceLabel?: string | null; triggerPx?: number | null; qty?: number; isEtf?: boolean;
}>): string | null;
export function stopTouchPushText(d: {
  code: string; name?: string; touch: TouchResult; stop: number; sourceLabel?: string | null;
  price?: number | null; pnlPct?: number | null; at?: number | null; isEtf?: boolean;
}): string;
export function stopPushTextS2b(d: { code: string; name?: string; price: number; stop: number; legacySource: 'ai' | 'cost'; pnlPct: number }): string;
export function trailPushTextS2b(d: { code: string; name?: string; price: number; line: number; hwm: number; pnlPct: number }): string;
export function disciplinePushTextS2b(d: { code: string; name?: string; stopPrice: number; days: number; price: number; lossPct: number; p0?: number | null; qty?: number }): string;
export function defenseListText(d: { red: number; amber: number; green: number; phase?: 's2b' | 's5' }): string;
export function defensePushText(d: { median: number; n: number; m: number }): string;
export function plungePushText(d: { pct: number; from: number; to: number }): string;
export function watchDropPushText(d: { name?: string; code: string; mv: number; price: number; chg: number }): string;
export function watchDropSummaryText(d: { name?: string; code: string; mv: number; price: number }): string;
export function overnightOpenPushText(d: { list: string }): string;

// ── LLM 停損文字（第 4 項：只引用）
export const STOP_PROMPT_RULE: string;
export const STOP_REF_FORMAT: string;
export function stopPromptLines(res: (Partial<StopResolution> & { isEtf?: boolean }) | null, extra?: { exAdjusted?: boolean; event?: EventOverlay | null }): string[];
export function hypotheticalStop(buyPoint: number | null, band: number | null, isEtf?: boolean): number | null;
export function hypotheticalStopLine(buyPoint: number | null, band: number | null, isEtf?: boolean): string;
export function parseStopRef(text: string): number | null;
export function stripStopRef(text: string): string;
export function extractStopPrices(text: string, ctx: { refPrice?: number | null }): Array<{ value: number; raw: string; sentence: string; index: number }>;
export interface LlmStopViolation {
  rule: 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
  code: 'refMissing' | 'refMismatch' | 'textMismatch' | 'stopAbovePrice' | 'buyAsStop' | 'bandAsStop';
  field: string; found?: number; fixed?: number; sentence?: string;
}
export function validateLlmStopText(fields: Readonly<Record<string, string>>, ctx: {
  stop: number; refPrice?: number | null; band?: number | null; buyPoints?: readonly number[]; lastPrice?: number | null;
  stopRef?: number | null; isEtf?: boolean; mode: 'measure' | 'enforce';
}): { fields: Record<string, string>; violations: LlmStopViolation[] };

// ── 狀態文件 stopBooks/{uid}（daemon 單一寫入；本人唯讀）
export interface StopBookPosition {
  qty: number; avgCost: number; firstDate: string | null; lots: LotSnap[];
  ex: ExTable; exApplied: string[]; selfAdjusted: Record<string, string[]>; adjCost: number | null; adjDate: string;
  exPending: boolean; exUnconfirmed: boolean; exUnknown: boolean;
  stop: number | null; baseStop: number | null; floorStop: number | null; bandHold: number | null;
  line: StopLine; basis: StopBasis; basisText: string; costLine: number | null;
  stopSource: StopSource | null; sourceDate: string | null; floorSource: StopSource | null; floorSourceDate: string | null; bandSourceDate: string | null;
  lines: StopResolution['lines']; lineInputs: LineInputs | null; linesStale: boolean;
  stopVersion: number; versionReason: VersionReason | null; startedAt: number; tradeDate: string;
  atr14: number | null; atrPct: number | null; suspect: boolean;
  events: EventOverlay[]; eventSeen: EventSeen[]; eventKeys: string[];
  holdHigh: HoldHigh | null; noOfficialBars: boolean; exGapBars: number;
  episode: Episode | null;
  /** 第一次 live 判定完成（seeded 只在 false 時判） */
  ticked: boolean;
  /** 影子期對照（舊推播、舊紀律、持股分析 ATR 帶）；切換兩週後移除 */
  legacy: { push: number | null; discipline: number | null; ratingBand: number | null } | null;
}
export interface StopBookDoc {
  specVersion: 'stop-v1.1'; phase: 'shadow' | 'live'; dataDate: string; updatedAt: number;
  positions: Record<string, StopBookPosition>; nextEpisodeId: number;
  /** daemon 每次寫停損簿時一併寫入的已驗證官方鏡像歸檔種類（＝STOP_VERIFIED_ARCHIVES；前端 bookStopOf 用同一份，2026-10-06 審查） */
  verifiedArchives?: BarArchive[];
}
export type AlertDoc = Record<string, unknown>;

// ── daemon 整合純函式
/** 組成線來自 daemon 盤前讀本機官方鏡像、而該歸檔種類尚未驗證（不在 verifiedArchives）⇒ 種類；否則 null（2026-10-06 R8） */
export function unverifiedArchiveOf(lineInputs: LineInputs | null | undefined, verifiedArchives?: ReadonlySet<BarArchive> | readonly BarArchive[]): 'etf' | 'emerging' | null;
/** 停損簿的一檔留在第一階段口徑（不論 phase）：noOfficialBars，或組成線來自尚未驗證的官方鏡像歸檔（daemon 與前端 bookStopOf 共用） */
export function legacyCodeActive(bp: Partial<StopBookPosition> | Record<string, unknown> | null | undefined,
  opts?: { verifiedArchives?: ReadonlySet<BarArchive> | readonly BarArchive[] | null }): boolean;
/** 停損簿不存在／非 live／版本不符 ⇒ true；有 code 時，該檔 legacyCodeActive ⇒ true */
export function legacyBranchActive(book: StopBookDoc | null | undefined, code?: string | null,
  opts?: { verifiedArchives?: ReadonlySet<BarArchive> | readonly BarArchive[] }): boolean;
export function mergeAlertsKeepUnacked(prev: readonly AlertDoc[], incoming: readonly AlertDoc[], max?: number): AlertDoc[];
export function prevStateOf(bp: StopBookPosition | null | undefined): PrevStopState | null;
export function planBookRefresh(input: {
  holdings: readonly HoldingLot[]; book: StopBookDoc | null;
  exTables?: Readonly<Record<string, ExTable>>; lastPrices?: Readonly<Record<string, number | null>>;
  lineInputs?: Readonly<Record<string, LineInputs | null>>;
  newsEvents?: readonly RuleBearEvent[];
  refCloses?: Readonly<Record<string, number | null>>; refYmds?: Readonly<Record<string, string | null>>;
  when: 'premarket' | 'intraday' | 'nontrading';
  latestCanonicalYmd?: string | null; nowMs: number; tradeDate: string; isTradingDay?: (ymd: string) => boolean;
  exState?: Readonly<Record<string, { pending?: boolean; unconfirmed?: boolean }>>;
  names?: Readonly<Record<string, string>>;
  /** S5 切換當天：清掉影子期的事件，第一輪 live 判定以 seeded 彙總處理已在停損下的部位 */
  resetEpisodes?: boolean;
  /** 已驗證的官方鏡像歸檔種類（預設空）：live 時，組成線來自其他種類（尚未驗證）的代號不發 v1.1 警示（R8） */
  verifiedArchives?: ReadonlySet<BarArchive> | readonly BarArchive[];
}): { bookPatch: Record<string, StopBookPosition | null>; docOnlyAlerts: AlertDoc[]; eventRecords: AlertDoc[] };
export function planUserStopTick(input: {
  uid: string; holdings: readonly HoldingLot[]; book: StopBookDoc | null;
  quotes: Readonly<Record<string, QuoteForJudge>>;
  nowMs: number; openMs: number; todayYmd: string; tradingDay?: boolean;
  dispositionCodes?: ReadonlySet<string> | readonly string[];
  exState?: Readonly<Record<string, { pending?: boolean; unconfirmed?: boolean }>>;
  refPrices?: Readonly<Record<string, number | null>>;
  intradayEvents?: readonly RuleBearEvent[];
  dedupHas?: (key: string) => boolean;
  isTradingDay?: (ymd: string) => boolean; latestCanonicalYmd?: string | null;
  names?: Readonly<Record<string, string>>;
  /** 已驗證的官方鏡像歸檔種類（預設空）：live 時，組成線來自其他種類（尚未驗證）的代號不發 v1.1 警示（R8） */
  verifiedArchives?: ReadonlySet<BarArchive> | readonly BarArchive[];
}): {
  pushAlerts: AlertDoc[]; docOnlyAlerts: AlertDoc[]; bookPatch: Record<string, StopBookPosition>; dedupKeys: string[];
  suppressOtherTypes: ReadonlySet<string>; nextEpisodeId: number; eventRecords: AlertDoc[];
};
export function planCloseSettle(input: {
  uid: string; holdings: readonly HoldingLot[]; book: StopBookDoc | null;
  /** noLimit：沒有漲跌幅限制（興櫃）；open 缺（興櫃官方日資料沒有開盤價）⇒ 不判跳空 */
  official: Readonly<Record<string, { open: number | null; high?: number; low: number; close: number; noLimit?: boolean }>>;
  lineInputs: Readonly<Record<string, LineInputs | null>>;
  dateYmd: string; openMs: number; isTradingDay?: (ymd: string) => boolean;
  exState?: Readonly<Record<string, { pending?: boolean; unconfirmed?: boolean }>>;
  refPrices?: Readonly<Record<string, number | null>>; dedupHas?: (key: string) => boolean; nowMs: number;
  names?: Readonly<Record<string, string>>;
  /** 已驗證的官方鏡像歸檔種類（預設空）：live 時，組成線來自其他種類（尚未驗證）的代號不發 v1.1 警示（R8） */
  verifiedArchives?: ReadonlySet<BarArchive> | readonly BarArchive[];
  /** 只處理這些代號（其餘部位不動）；省略＝全部。收盤結算排除鏡像代號、下一交易日盤前只補這些代號（R8） */
  codes?: ReadonlySet<string> | readonly string[] | null;
}): {
  pushAlerts: AlertDoc[]; docOnlyAlerts: AlertDoc[]; bookPatch: Record<string, StopBookPosition>; dedupKeys: string[];
  missedLive: string[]; nextEpisodeId: number; eventRecords: AlertDoc[];
};
export function planDisciplineDigest(input: {
  uid: string; book: StopBookDoc | null; holdings: readonly HoldingLot[];
  prevCloses: Readonly<Record<string, number | null>>; todayYmd: string; isTradingDay?: (ymd: string) => boolean;
  dedupHas?: (key: string) => boolean; nowMs?: number; names?: Readonly<Record<string, string>>;
  /** 已驗證的官方鏡像歸檔種類（預設空）：live 時，組成線來自其他種類（尚未驗證）的代號不發 v1.1 警示（R8） */
  verifiedArchives?: ReadonlySet<BarArchive> | readonly BarArchive[];
}): { alert: AlertDoc | null; dedupKey: string | null };
