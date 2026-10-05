// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）

export const NEWS_WEIGHT_NOTE: string;
export const NEWS_TIER_CUTS: Readonly<{ strong: number; mid: number }>;
export const NEWS_TIER_LABEL: Readonly<Record<NewsTier, string>>;
export const NEWS_TEXT_MAX: Readonly<{ reason: number; quote: number; revision: number }>;
export const PASS_LABEL: Readonly<Record<NewsPass, string>>;
export const PREMARKET_PASSES: readonly NewsPass[];
export const GATE_D: string;
export const GATE_E: string;
export const RULE_LEGAL_PREFIX: string;
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
export const MAJOR_BEAR_RULE: Readonly<{ strongW: number; legalTypeW: number; legalTypes: readonly string[] }>;
/** 權重門檻類一級警示的實際級別（使用者裁定前＝2） */
export const WEIGHT_GATE_LEVEL: 1 | 2;
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
  /** 影響權重（after-market-news.rankMediaVerdicts 同一個數字，先驗 0–1）；只有利多／利空才有 */
  w: number | null;
  /** 強度、信心、確定性、新穎性、已被預期（AI 原標籤） */
  s: string | null; c: string | null; ct: string | null; nv: string | null; pr: string | null;
  /** 事件類型（AI 的 L1 抽取；'法律' 不等於規則覆寫） */
  ev: string | null;
  /** daemon 法律規則覆寫（§1.5） */
  lg: boolean;
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
  title: string;
}

export interface MajorBear { level: 1 | 2; basis: 'rule-legal' | 'weight' | 'legal-type'; scope: 'holding' | 'watch' }

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
export function newsKpi(
  codes: readonly string[], map: Record<string, NewsEntry> | null | undefined, ctx: NewsCtx | null | undefined,
): { bear: number; missing: number; old: number; na: number };
export function majorBearOf(
  entry: NewsEntry | null | undefined,
  opts: { scope?: 'holding' | 'watch'; ctx: NewsCtx | null | undefined; minAtMs?: number | null },
): MajorBear | null;
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
