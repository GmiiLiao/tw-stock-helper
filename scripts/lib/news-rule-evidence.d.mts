// 型別橋接：規則類利空事實題的判定細節、稽核軌跡、延續、當日沿用（唯一實作 news-rule-evidence.mjs；2026-10-07 N1(b)／N2）。
import type { RuleClassCode, RuleFactResult, RuleFactText, RuleTriggerArticle, RuleVerdictFields } from './news-rule-classes.mjs';

export const RULE_CONT_TRADING_DAYS: number;
export const RULE_EVIDENCE_MAX: Readonly<{ ctx: number; title: number; src: number; ans: number; quote: number; dateText: number; qctx: number }>;
export const RULE_DOC_SOFT_MAX: number;
export const QUOTE_MIN_CHARS: number;
export const ACCIDENT_LINK_RE: RegExp;
export const ACCIDENT_CONTEXT_RE: RegExp;
export const QUOTE_CTX_BACK: number;
export const QUOTE_CTX_FWD: number;

export interface NewsWindow { from: string; to: string }
export interface DateSpan { lo: string; hi: string }

export function normForQuote(text: unknown): string;
export function quoteInArticles(quote: unknown, articles: ReadonlyArray<{ title?: string; content?: string }> | null | undefined): boolean;
export function parseLegalFactDetail(answer: unknown): { newDev: 'yes' | 'no' | null; date: string | null; quote: string | null };
export function factDateSpan(text: unknown, todayYmd: string): DateSpan | null;
export function windowRelation(span: DateSpan | null | undefined, window: NewsWindow | null | undefined): 'in' | 'out' | 'unknown';
export function quoteDateRelation(quote: unknown, window: NewsWindow | null | undefined, todayYmd: string): 'in' | 'out' | 'none';
export function quoteClauseOf(quote: unknown, articles: ReadonlyArray<{ title?: string; content?: string }> | null | undefined): string | null;
export function isBackgroundClause(text: unknown): boolean;
export function resolveRuleFact(code: string, answer: string | null | undefined, opts?: {
  articles?: ReadonlyArray<Partial<RuleTriggerArticle>>; window?: NewsWindow | null; todayYmd?: string | null; day?: string | null; key?: string | null;
}): RuleFactResult & { state: RuleFactText; answered: boolean };
export function ruleFactKey(input: {
  code: string; cls: string; day: string; window?: NewsWindow | null; articles?: ReadonlyArray<{ title?: string; content?: string }>;
}): string;
export function reuseRuleFact(prevVerdict: unknown, code: string, key: string | null | undefined): (RuleFactResult & { state: RuleFactText }) | null;
export function asReused<T extends RuleFactResult>(fact: T | null | undefined): T | null;
export function reconcileAccident<T extends Record<string, RuleFactResult | null | undefined>>(
  facts: T, byCode: Partial<Record<RuleClassCode, ReadonlyArray<{ title?: string; content?: string }>>> | null | undefined,
): T;
export function eventDateSpan(text: unknown): DateSpan | null;
/** N4：新事件日期整段晚於舊的（a.lo > b.hi）；任一邊讀不到 ⇒ false */
export function eventDateLater(a: unknown, b: unknown): boolean;
export function ruleEventDateOf(verdict: unknown, cls: string): string | null;
export function ruleTrailEligible(verdict: unknown): boolean;
export function withRuleTrail<T extends Record<string, unknown>>(
  verdict: T, prevTrail: unknown, opts: { targetDate: string; contFromYmd?: string | null },
): T & Pick<RuleVerdictFields, 'ruleTrail' | 'ruleCont'>;
export function isRuleContinuation(verdict: unknown): boolean;
export function isRuleRenewal(verdict: unknown): boolean;
export function isLegalOngoing(verdict: unknown): boolean;
export interface RuleAuditCounts {
  asked?: Partial<Record<RuleClassCode, number>>;
  reused?: Partial<Record<RuleClassCode, number>>;
  fail?: Partial<Record<RuleClassCode, number>>;
  ans?: Partial<Record<RuleClassCode, Partial<Record<RuleFactText, number>>>>;
  quoteFail?: Partial<Record<RuleClassCode, number>>;
  cont?: Partial<Record<RuleClassCode, number>>;
  renew?: Partial<Record<RuleClassCode, number>>;
}
export function ruleAuditCounts(facts: Record<string, RuleFactResult | null | undefined> | null | undefined, verdict?: unknown): RuleAuditCounts;
export function slimRuleEvidence<T extends Record<string, unknown>>(verdicts: T, level?: 'text' | 'all'): T;
export function fitVerdictJson(verdicts: Record<string, unknown>, opts?: { maxBytes?: number; otherBytes?: number }): {
  json: string; level: 'full' | 'text' | 'all'; bytes: number | null;
};
