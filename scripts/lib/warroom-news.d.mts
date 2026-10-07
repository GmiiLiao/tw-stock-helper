// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { RuleClassCode, ClassWeightBand } from './news-rule-classes.mjs';

/** 影響權重旁一律附的說明（「研究期·只顯示」） */
export const NEWS_WEIGHT_NOTE: string;
export const NEWS_TIER_CUTS: Readonly<{ strong: number; mid: number }>;
export const NEWS_TIER_LABEL: Readonly<Record<NewsTier, string>>;
export const NEWS_TEXT_MAX: Readonly<{ reason: number; quote: number; revision: number }>;
export const PASS_LABEL: Readonly<Record<NewsPass, string>>;
export const PREMARKET_PASSES: readonly NewsPass[];
export const GATE_D: string;
export const GATE_E: string;
export const RULE_LEGAL_PREFIX: '【規則】';
export const HARD_FACT_TYPES: readonly string[];
export const PRICE_BULLETIN_RE: RegExp;
export const ATTENTION_RE: RegExp;
/** §4.1 C20b 信評機構字樣（利空判別遇到不套 §1.6） */
export const CREDIT_RATING_RE: RegExp;
/** §1.5 法律事件字樣（只用來揭露「可能為法律事件」與豁免 §1.4／§1.6） */
export const LEGAL_TEXT_RE: RegExp;
/** 沒走四角色挑戰的短標與說明 */
export const UNCHALLENGED_TAG: string;
export const UNCHALLENGED_NOTE: string;
/** 可能為法律事件（未經規則確認）的揭露句 */
export const POSSIBLE_LEGAL_NOTE: string;
/** C16a 舊案的事實標籤「涉訟中」與說明句（2026-10-07 N1(b)：不改判利空、不發 Z2、不收緊停損） */
export const LITIGATION_TAG: '涉訟中';
export const LITIGATION_NOTE: string;
/** 規則類利空延續（ruleCont）的說明句 */
export function continuationNote(rf: string | null | undefined): string;
export const NEWS_REPEAT_KEEP_DAYS: number;

/**
 * bull／bear／neutral＝AI 讀內文的判別｜insufficient 資訊不足（沒讀到內文）｜unjudged 未判別（AI 未回應）
 * ｜attention 關注度（規範 §1.6，不判方向）｜excluded 價格描述（規範 §1.4，剔除）
 */
export type NewsSt = 'bull' | 'bear' | 'neutral' | 'insufficient' | 'unjudged' | 'attention' | 'excluded';
export type NewsPass = 'evening' | 'night' | 'morning' | 'intraday';
export type NewsTier = 'strong' | 'mid' | 'weak';
export type NewsFresh = 'today' | 'prev' | 'next' | 'unknown';

/** 全市場精簡表的一列（newsVerdict/latest.verdictJson[code] 經規範 §1 程式強制後） */
export interface NewsEntry {
  st: NewsSt;
  /** 影響權重（after-market-news.rankMediaVerdicts 同一個數字，先驗 0–1；研究期·只顯示）；只有利多／利空才有，
   *  規則類利空而 AI 原判不是利空時為 null（w 屬於 AI 的方向） */
  w: number | null;
  /** 強度、信心、確定性、新穎性、已被預期（AI 原標籤） */
  s: string | null; c: string | null; ct: string | null; nv: string | null; pr: string | null;
  /** 事件類型（AI 的 L1 抽取；'法律' 不等於規則覆寫） */
  ev: string | null;
  /** 法律事件（C16a）規則判定（§1.5）＝ rc === 'C16a' */
  lg: boolean;
  /** 規則類利空的類別（news-rule-classes：daemon 程式規則判定；只有 C16a 的 label 被覆寫為利空，其他類別 label 不改〔2026-10-06 R1〕、AI 原判在 ra）；不是規則類利空為 null */
  rc: RuleClassCode | null;
  /** 規則類別的子類別（例 C15a 'giftOrTrust'，類別權重另計） */
  rs: string | null;
  /** 規則判定時 AI 的原判（與利空不同時才有，例「中性」） */
  ra: string | null;
  /** 規則類利空的延續：首次判定的適用日（daemon ruleCont；同一檔同類別有效期內重複觸發——不當新事件、不重複推播、Z2 只列二級） */
  rf: string | null;
  /** 涉訟中：C16a 舊案（事件日期在新聞視窗外、只在背景句出現；ruleFacts.C16a==='old'）——事實標籤，不影響 st、不進 Z2 */
  lt: boolean;
  /** 可能為法律事件（AI 自判利空、未經規則確認：事件類型法律或依據句有檢調／搜索／起訴等字樣）；只揭露、不升級 */
  pl: boolean;
  /** 走過四角色挑戰 */
  ch: boolean;
  /** 承接自哪一個適用日（不是今天新判） */
  cr: string | null;
  /** 判讀時刻（epoch ms） */
  at: number | null;
  p: NewsPass | null;
  qv: number | null;
  qf: number | null;
  /** 對不上原文的數字個數 */
  un: number;
  /** 讀了幾篇 */
  n: number | null;
  /** 理由（利多／利空／關注度／價格描述才給） */
  r: string | null;
  /** AI 摘的關鍵句（沒有逐字核對；利空、強的利多、關注度／價格描述才給；「無」＝null） */
  kq: string | null;
  /** daemon E 階段逐字核對通過的第一條引文（§1.8；利空、強的利多才給） */
  vq: string | null;
  /** 四角色挑戰的修正說明（只給利空） */
  rv: string | null;
  /** 戰情改判（關注度／價格描述）時 AI 的原判 */
  ai: string | null;
}

export interface NewsMeta {
  /** 判別適用的交易日 */
  targetDate: string | null;
  lastPass: NewsPass | null;
  updatedAt: number | null;
  covered: number;
}

export interface NewsBoard { meta: NewsMeta; map: Record<string, NewsEntry> }

export interface NewsCtx { fresh: NewsFresh; targetDate: string | null; applicableYmd: string | null }

export interface NewsLampView {
  tone: 'up' | 'dn' | 'flat' | 'none' | 'na';
  tier: NewsTier | null;
  tierLabel: string | null;
  label: string;
  /** 今日適用、非承接 */
  current: boolean;
  /** 非今日適用時的標記（承接 mm/dd、前交易日…） */
  old: string | null;
  legal: boolean;
  /** 規則類利空的類別短字（例「工安停工」「法律事件（法律判定前視為利空）」）；不是規則類利空為 null */
  rule: string | null;
  /** 涉訟中（C16a 舊案事實標籤；不是利空燈） */
  litig: boolean;
  title: string;
}

/** Z2 持股重大利空：只看規則類別的類別權重（high 一級、mid 二級；low 不列），不看影響權重 w */
export interface MajorBear {
  level: 1 | 2; basis: 'rule-legal' | 'rule-class'; scope: 'holding' | 'watch'; cls: RuleClassCode; band: Exclude<ClassWeightBand, 'low'>;
}

export interface MajorBearState {
  t: string | null;
  sent: Record<string, { at: number; rank: number; seq: number; cont: boolean }>;
  q: Record<string, string>;
}
export interface MajorBearItem { code: string; level: 1 | 2; seq: number; cont: boolean; mb: MajorBear; entry: NewsEntry }

/** 與 events.ts 的 WarEventInput 相容 */
export interface NewsWarEvent {
  id: string; at: number; kind: 'majorNegative' | 'newsVerdict'; level: 1 | 2; code: string; mine: true; source: 'M'; side: 'short'; text: string;
}

/** 與 warroom-feeds 的 FeedEvent 相容 */
export interface NewsFeedEvent {
  id: string; at: number; kind: 'newsVerdict'; code: string; name: string; text: string; source: 'M'; side?: 'long' | 'short';
}

export interface PremarketNewsRow { code: string; entry: NewsEntry; cat: number; mb: MajorBear | null; holding: boolean }

export interface NewsHealth { state: 'ok' | 'bad'; glyph: '●' | '▲'; text: string; note: string }

export function tpeHhmm(ms: number | null | undefined): string;
export function ymdShort(ymd: string | null | undefined): string;
export function newsTimeTag(atMs: number, nowMs: number): string;
export function isRuleBear(v: unknown): boolean;
export function isRuleLegal(v: unknown): boolean;
export function isAiRead(v: unknown): boolean;
export function isPriceBulletin(v: unknown): boolean;
export function isAttentionOnly(v: unknown): boolean;
export function isPossibleLegalBear(v: unknown): boolean;
export function verdictState(v: unknown): NewsSt;
export function newsTier(w: number | null | undefined): NewsTier | null;
export function newsBoardFromDoc(doc: Record<string, unknown> | null | undefined): NewsBoard | null;
export function newsCtxOf(meta: NewsMeta | null | undefined, applicableYmd: string | null | undefined): NewsCtx;
export function isCurrentEntry(entry: NewsEntry | null | undefined, ctx: NewsCtx | null | undefined): boolean;
/** 今日適用、非承接、但沒走四角色挑戰（可能是 14 日舊聞回退或挑戰失敗） */
export function isUnchallengedEntry(entry: NewsEntry | null | undefined, ctx: NewsCtx | null | undefined): boolean;
export function isNewsUniverse(code: string): boolean;
export function newsLampView(entry: NewsEntry | null | undefined, ctx: NewsCtx | null | undefined, opts?: { universe?: boolean }): NewsLampView;
export function newsShortText(entry: NewsEntry | null | undefined, ctx: NewsCtx | null | undefined, opts?: { universe?: boolean }): string;
export function newsWeightText(entry: NewsEntry | null | undefined): string | null;
/** 規則類利空的說明句（類別、類別權重〔先驗·未回測，不是 w〕、AI 原判）；不是規則類利空回 null */
export function ruleClassNote(entry: NewsEntry | null | undefined): string | null;
export function newsKpi(
  codes: readonly string[], map: Record<string, NewsEntry> | null | undefined, ctx: NewsCtx | null | undefined,
): { bear: number; missing: number; old: number; na: number };
export function majorBearOf(
  entry: NewsEntry | null | undefined,
  opts: { scope?: 'holding' | 'watch'; ctx: NewsCtx | null | undefined; minAtMs?: number | null },
): MajorBear | null;
export function majorBearNote(mb: MajorBear | null | undefined): string | null;
export function quoteHash(s: string | null | undefined): string;
export function initialMajorBearState(): MajorBearState;
export function parseMajorBearState(raw: unknown): MajorBearState;
export function stepMajorBear(
  prev: MajorBearState | null | undefined,
  cands: readonly { code: string; entry: NewsEntry; mb: MajorBear | null }[],
  opts: { targetDate: string | null | undefined },
): { state: MajorBearState; items: MajorBearItem[]; changed: boolean };
export function majorBearText(code: string, name: string | null | undefined, item: MajorBearItem): string;
export function majorBearEvents(items: readonly MajorBearItem[], names: ReadonlyMap<string, string> | null | undefined, targetDate: string): NewsWarEvent[];
export function b2MarketNewsEvents(board: NewsBoard | null | undefined, opts: { todayYmd: string; cap?: number }): NewsFeedEvent[];
export function activeNewsCodes(board: NewsBoard | null | undefined, todayYmd: string): string[];
export function mineNewsEvents(
  board: NewsBoard | null | undefined,
  opts: {
    holdings: ReadonlySet<string>; watch: ReadonlySet<string>; pinned: ReadonlySet<string>;
    ctx: NewsCtx | null | undefined; minAtMs?: number | null; nowMs: number;
  },
): NewsFeedEvent[];
export function premarketNewsRows(
  board: NewsBoard | null | undefined,
  opts: { holdings: readonly string[]; watch: readonly string[]; ctx: NewsCtx | null | undefined; minAtMs?: number | null },
): { rows: PremarketNewsRow[]; missing: string[]; na: string[] };
export function newsHealthOf(meta: NewsMeta | null | undefined, ctx: NewsCtx | null | undefined): NewsHealth;
