// 型別橋接：規則類利空事件類別與類別權重（唯一實作 news-rule-classes.mjs；新聞技能 §4.1、停損規範 SKILL §10A.2）。
export type RuleClassCode = 'C16a' | 'C23' | 'C22' | 'C13b' | 'C17' | 'C16b' | 'C15a' | 'C11a' | 'C15c' | 'C20b';
export interface RuleClassDef {
  code: RuleClassCode; key: string; label: string;
  /** 類別權重＝新聞技能 §4.1 baseWeight（先驗·未回測）；不是 AI 新聞識讀的結果權重 w */
  weight: number;
  /** false＝新聞技能明定不當訊號（C23 可買性問題），只記錄、不收緊停損 */
  tightenEligible: boolean;
  scope: string;
  /** 只用來觸發提問，不得直接決定方向或類別 */
  trigger: RegExp;
  /** 觸發字命中處前後 VETO_SPAN 字內出現就不算觸發（例 C20b 的券商評等、目標價） */
  veto?: RegExp;
  /** 規則覆寫時理由的事件描述（ruleOverrideReason；2026-10-06 R1 起只有 C16a 會覆寫 newsVerdict 的 label／理由） */
  ruleText: string;
  /** 要 AI 從內文回答的事實（{name} 代入公司名） */
  fact: string;
  subWeights?: Readonly<Record<string, number>>;
}
export const RULE_LEGAL_PREFIX: '【規則】';
/** 規則判定「是」時程式會覆寫 newsVerdict label 為利空的類別：只有 C16a（其他類別只記規則欄位；2026-10-06 R1） */
export const LABEL_OVERRIDE_CLASS: 'C16a';
export const CLASS_WEIGHT_NOTE: string;
export const VETO_SPAN: number;
export const RULE_BEAR_CLASSES: readonly RuleClassDef[];
export const RULE_CLASS_BY_CODE: Readonly<Record<string, RuleClassDef>>;
export const RULE_CLASS_BY_KEY: Readonly<Record<string, RuleClassDef>>;
export const RULE_CLASS_CODES: readonly RuleClassCode[];
export function ruleReasonPrefix(code: string): string;
/** 不看 label（2026-10-06 R1）：ruleClass 且 ruleFacts[ruleClass]==='yes'；舊資料 C16a（label 利空＋ruleOverride 'legal-event' 或「【規則】」前綴） */
export function ruleClassOf(verdict: unknown): RuleClassCode | null;
export function ruleSubOf(verdict: unknown, code?: string | null): string | null;
export function ruleClassesHit(text: string): RuleClassCode[];
export function ruleTriggerScan(
  articles: ReadonlyArray<{ title?: string; content?: string }>,
  isMentioned: ((text: string) => unknown) | null,
  maxChars?: number,
): { codes: RuleClassCode[]; byCode: Partial<Record<RuleClassCode, Array<{ title: string; content: string }>>> };
export function classWeightOf(code: string, sub?: string | null): { weight: number; source: string } | null;
export function ruleFactQuestion(
  code: string, stock: { code: string; name?: string } | null, articles: ReadonlyArray<{ title?: string; content?: string }>, opts?: { maxChars?: number },
): string;
/** 只看開頭的是／否；其他開頭（空白、不確定、「是否…」）回 null（未答，不猜） */
export function parseRuleFactAnswer(code: string, answer: string | null | undefined): RuleFactAnswer | null;

/** 類別權重分級切點（與停損 STOP_PARAMS.eventTiers 的 minWeight 同值） */
export const CLASS_WEIGHT_CUTS: Readonly<{ high: number; mid: number }>;
export type ClassWeightBand = 'high' | 'mid' | 'low';
export function classWeightBand(code: string, sub?: string | null): ClassWeightBand | null;
export function ruleClassText(code: string): string | null;
export type RuleFactAnswer = { yes: boolean; sub: string | null };
export function ruleOverrideReason(code: string, verdict: { label?: unknown; reason?: unknown } | null): string;
export type RuleFactText = 'yes' | 'no' | 'none';
export interface RuleVerdictFields {
  ruleClass?: RuleClassCode;
  ruleOverride?: string;
  ruleSub?: string;
  ruleHits?: RuleClassCode[];
  aiOriginal?: { label: string; reason: string };
  ruleFacts?: Partial<Record<RuleClassCode, RuleFactText>>;
}
export function applyRuleFacts<T extends Record<string, unknown>>(
  verdict: T,
  opts?: { facts?: Record<string, RuleFactAnswer | null> },
): T & RuleVerdictFields;
export const RULE_VERDICT_FIELDS: readonly (keyof RuleVerdictFields)[];
export function ruleFieldsOf(verdict: unknown): RuleVerdictFields;
export function ruleFactAnswered(verdict: unknown, code: string): boolean;
