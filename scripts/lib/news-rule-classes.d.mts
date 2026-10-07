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
/** 稽核軌跡用：命中處前後各幾個字 */
export const TRIGGER_CTX_SPAN: number;
/** 第一個有效命中的觸發字與前後文（只供 ruleEvidence 記錄；不決定方向） */
export function ruleTriggerHit(code: string, text: string, span?: number): { trig: string; ctx: string } | null;
export interface RuleTriggerArticle {
  title: string; content: string;
  /** 發布時刻（ms）；C16a 事實題附發布日 */
  at: number | null;
  /** 內文來源（bodyFrom／src） */
  src: string | null;
  hit: { trig: string; ctx: string } | null;
}
export function ruleTriggerScan(
  articles: ReadonlyArray<{ title?: string; content?: string; at?: number | null; bodyFrom?: string; src?: string }>,
  isMentioned: ((text: string) => unknown) | null,
  maxChars?: number,
): { codes: RuleClassCode[]; byCode: Partial<Record<RuleClassCode, RuleTriggerArticle[]>> };
/** 發布時刻（ms）→ 台北日期 YYYY-MM-DD */
export function taipeiYmdOfMs(ms: unknown): string | null;
export function classWeightOf(code: string, sub?: string | null): { weight: number; source: string } | null;
/** C16a 另帶 window（新聞視窗 YYYY-MM-DD），同一題併問新進展、日期、逐字引用（2026-10-07 N1(b)） */
export function ruleFactQuestion(
  code: string, stock: { code: string; name?: string } | null,
  articles: ReadonlyArray<{ title?: string; content?: string; at?: number | null }>,
  opts?: { maxChars?: number; window?: { from: string; to: string } | null },
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
/** 'old'＝C16a 舊案（涉訟中）、'acc'＝C16a 實為工安事故後的相驗／調查（歸 C17）——2026-10-07 */
export type RuleFactText = 'yes' | 'no' | 'none' | 'old' | 'acc';
export const RULE_FACT_STATES: readonly RuleFactText[];
export const LEGAL_ONGOING_TAG: '涉訟中';
/** 一題的事實結果（新格式帶 state、ev；舊格式只有 yes、sub）→ ruleFacts 的值 */
export function factStateOf(ans: unknown): RuleFactText;
/** 每題的稽核軌跡（news-rule-evidence.mjs resolveRuleFact；欄位都可能缺） */
export interface RuleEvidence {
  key?: string; day?: string; trig?: string; ctx?: string; title?: string; src?: string; pub?: string; ans?: string; sub?: string;
  quote?: string; quoteOk?: boolean; newDev?: 'yes' | 'no'; dateText?: string; eventDate?: string; isNew?: boolean;
  /** 引用句在原文所在的子句（只在它否決新進展時記：why 'clauseDateOut'／'background'） */
  qctx?: string;
  why?: 'noAnswer' | 'unsure' | 'quote' | 'accident' | 'accidentC17' | 'notNew' | 'dateOut' | 'dateUnknown' | 'quoteDateOut' | 'clauseDateOut' | 'background';
  reused?: boolean;
}
export interface RuleFactResult { yes: boolean | null; sub: string | null; state?: RuleFactText; answered?: boolean; ev?: RuleEvidence }
export interface RuleVerdictFields {
  ruleClass?: RuleClassCode;
  ruleOverride?: string;
  ruleSub?: string;
  ruleHits?: RuleClassCode[];
  aiOriginal?: { label: string; reason: string };
  ruleFacts?: Partial<Record<RuleClassCode, RuleFactText>>;
  ruleEvidence?: Partial<Record<RuleClassCode, RuleEvidence>>;
  /** 各類別被當成新事件那次的適用日 since＋事件日期 eventDate（延續判定用）；N4 有效期內事件日期較晚的新進展換新時 renewOf＝被取代的舊事件日期（2026-10-07） */
  ruleTrail?: Partial<Record<RuleClassCode, { since: string; eventDate?: string; renewOf?: string }>>;
  /** 主類別是延續時＝首次判定的適用日 */
  ruleCont?: string;
}
export function applyRuleFacts<T extends Record<string, unknown>>(
  verdict: T,
  opts?: { facts?: Record<string, RuleFactResult | RuleFactAnswer | null> },
): T & RuleVerdictFields;
export const RULE_VERDICT_FIELDS: readonly (keyof RuleVerdictFields)[];
export function ruleFieldsOf(verdict: unknown): RuleVerdictFields;
export function ruleFactAnswered(verdict: unknown, code: string): boolean;
