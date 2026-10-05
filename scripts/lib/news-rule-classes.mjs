// ─────────────────────────────────────────────────────────────────────────────
// 規則類利空事件類別（唯一實作）：新聞管線（daemon judgeOneStock 的規則判定）、AI 停損規範 stop-v1.1 的事件收緊
// （scripts/lib/ai-stoploss-event.mjs）、戰情顯示共用同一張表。單元測試 news-rule-classes.test.mjs。
//
// 規範出處：.claude/skills/tw-news-impact-analyst/SKILL.md §1.5（法律一律利空）、§1.7（能寫成規則的方向一律交給程式）、
//   §4.1（公司層事件表：方向標「−（規則）」的類別與 baseWeight）。停損規範 .claude/skills/tw-ai-stoploss/SKILL.md §10A.2。
// 使用者裁定（2026-10-05，第二輪 A4「做skills判定與加權重」）：
//   ① 新聞技能 §4.1 方向標「−（規則）」的利空類別一律做成「程式規則判定」：AI 只認定事實（主體是不是本檔、事件是不是屬實），
//      方向（利空）與類別由程式規則決定。
//   ② 每個類別一個「類別權重」＝新聞技能 §4.1 的 baseWeight（先驗·未回測）；停損收緊依類別權重決定收不收、收多少
//      （ai-stoploss-event.mjs eventTierOf）。
//   ⚠ 類別權重是**規則先驗**，不是 AI 新聞識讀的結果權重 w（rankMediaVerdicts 的強度×信心×…，研究期只顯示、不使用）。
//
// 觸發字（trigger）只用來「觸發提問」，**不得**直接決定方向或類別（新聞技能 §1.2；使用者規則「新聞調分須經 AI 讀內文」）。
//   觸發字要避開常見的非事件語意（2026-10-05 審查）：市調「調查」、組織「重整」、計畫性歲修「停機」、產品「停產」、
//   「爆炸性成長」、券商「評等」——這些一律不觸發；必要時以 veto（命中處前後 VETO_SPAN 字內出現就不算）排除。
// 新聞管線的接法（停損規範 SKILL §10A.2 第 1～7 步）：主判別（利多／利空／中性）定案之後，**每個命中的類別另問一次**
//   ruleFactQuestion（本機模型；主判別提示詞逐字不變）；parseRuleFactAnswer 只看開頭的「是／否」；applyRuleFacts 判定：
//   「是」⇒ label 由程式覆寫為利空（理由以 ruleReasonPrefix 開頭、記 aiOriginal），原判已是利空只補欄位。
//   寫入欄位在 ruleFieldsOf（三個寫入端共用）。
// 本檔是純資料＋純函式：不 import 任何模組、不碰網路、不讀時鐘（daemon 靜態 import 本檔）。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** 法律規則覆寫既有的理由前綴（daemon「【規則】涉檢調搜索…」；warroom-news RULE_LEGAL_PREFIX 同字，改了兩邊一起改） */
export const RULE_LEGAL_PREFIX = '【規則】';

/** 類別權重的出處字樣（畫面與紀錄一律附） */
export const CLASS_WEIGHT_NOTE = '類別權重＝新聞技能 §4.1 baseWeight（先驗·未回測）';

/** veto 檢查的範圍：觸發字命中處前後各幾個字 */
export const VETO_SPAN = 12;

/**
 * 規則類利空事件類別（新聞技能 §4.1 方向標「−（規則）」者，含 C13b 交易破局轉 −）。依類別權重由高到低排列。
 * - code：新聞技能事件代號；key：寫進 newsVerdict 的 ruleOverride（C16a 沿用既有 'legal-event'）
 * - label：畫面與事件收緊來源標籤用的類別名；ruleText：規則覆寫 label 時理由的事件描述（C16a 沿用 2026-08-29 版原文）
 * - weight：類別權重（先驗·未回測）；subWeights：子類別（例 C15a 贈與／信託 0.05）
 * - tightenEligible：false＝新聞技能明定不當訊號（C23 可買性問題），只記錄、不收緊停損
 * - trigger：觸發提問的字樣（不得直接決定方向）；veto：命中處前後 VETO_SPAN 字內出現就不算觸發
 * - fact：要 AI 從內文回答的事實（只回是／否＋一句說明；明寫不算的情形）
 */
export const RULE_BEAR_CLASSES = Object.freeze([
  Object.freeze({
    code: 'C16a', key: 'legal-event', label: '法律事件', weight: 0.9, tightenEligible: true,
    ruleText: '涉檢調搜索，法律判定前視為利空',
    scope: '檢調搜索、搜查、約談、起訴、羈押、背信、掏空、主管機關調查（對象是本公司、子公司或負責人）',
    // 不用裸「調查」：「TrendForce 調查」「調查顯示」等市調會誤觸發（舊 HARD_NEGATIVE 本來就不含；戰情 LEGAL_TEXT_RE 同理）
    trigger: /檢調|搜索(?!引擎)|搜查|約談|起訴|羈押|背信|掏空|調查局|地檢署|檢察官|偵辦|(?:檢方|檢察|主管機關|金管會|證期局|證交所|櫃買中心|公平會|法務部).{0,8}調查|涉(?:嫌|案).{0,8}調查/,
    fact: '這些報導中的檢調搜索、約談、起訴或主管機關調查，對象是不是 {name} 這家公司本身（含其子公司或負責人）？'
      + '若對象是同業、客戶、供應商或其他公司，就不是；市調或研調機構的市場調查、問卷調查、搜索引擎都不算。',
  }),
  Object.freeze({
    code: 'C23', key: 'trading-restriction', label: '交易限制', weight: 0.9, tightenEligible: false,
    ruleText: '交易限制（變更交易方法／全額交割／停止買賣／下市櫃）',
    scope: '變更交易方法、全額交割、停止買賣、下市（新聞技能：屬可買性問題，排除或加警示，不當成訊號）',
    trigger: /變更交易方法|全額交割|停止買賣|終止上市|終止上櫃|下市|下櫃/,
    fact: '{name} 本身是不是被主管機關或交易所宣布變更交易方法、全額交割、停止買賣或終止上市（櫃）？產品下市、其他公司下市都不算。',
  }),
  Object.freeze({
    code: 'C22', key: 'financial-distress', label: '財務危機', weight: 0.85, tightenEligible: true,
    ruleText: '涉財務危機事件',
    scope: '退票、重整、非無保留意見、延遲申報、背書或資金貸與異常',
    // 「重整」只認法院的公司重整（組織重整、重整旗鼓不算）；「保留意見」排除「無保留意見」（標準意見）
    trigger: /退票|跳票|聲請重整|公司重整|重整(?:裁定|程序|聲請|計畫案)|破產|非無保留|(?<!無)保留意見|無法表示意見|否定意見|延遲申報|延後申報|未(?:能)?如期申報|背書保證.{0,6}(?:異常|逾限|超限)|資金貸與.{0,6}(?:異常|逾限|超限)|財務危機|債務違約/,
    fact: '報導中的退票、法院公司重整或破產、會計師非無保留意見、延遲申報或背書／資金貸與異常，是不是發生在 {name} 這家公司本身（含子公司）？'
      + '是否為已發生的事實（不是傳聞或預測）？組織調整、業務重整、重整旗鼓都不算。',
  }),
  Object.freeze({
    code: 'C13b', key: 'tender-failed', label: '公開收購破局', weight: 0.8, tightenEligible: true,
    ruleText: '公開收購或併購破局',
    scope: '本檔是被收購方，公開收購或併購交易破局、終止或撤回',
    trigger: /公開收購.{0,10}(?:破局|終止|停止|失敗|撤回|未達|喊卡)|收購案.{0,6}(?:破局|終止|喊卡)|併購.{0,6}(?:破局|終止|喊卡)/,
    fact: '{name} 是不是被收購方，而且這筆公開收購或併購交易已經破局、終止或撤回（不是傳聞）？',
  }),
  Object.freeze({
    code: 'C17', key: 'accident', label: '工安停工', weight: 0.7, tightenEligible: true,
    ruleText: '本公司工安／停工事件',
    scope: '本公司工安、火災、停工、天災',
    // 停工／停產／停機要帶事故語境（計畫性歲修、產品停產不算）；「爆炸」要帶廠區或事故語境（「爆炸性成長」不算）
    trigger: /工安|火災|失火|起火|火警|氣爆|(?:發生|廠區?|工廠|廠房|產線|機台|鍋爐|反應槽|儲槽|管線).{0,4}爆炸|爆炸(?:事故|意外|案)|(?:事故|意外|火災|工安|地震|颱風|淹水|水災|停電|跳電|斷電|勒令|污染|罷工).{0,10}(?:停工|停產|停機|停線)|(?:停工|停產|停機|停線).{0,10}(?:事故|意外|受損|損失)|淹水|水災|天災|地震.{0,6}(?:受損|停工|停產)|颱風.{0,6}(?:受損|停工|停產)/,
    fact: '發生工安、火災、爆炸、停工或天災受損的，是不是 {name} 本身（含子公司）的廠區或產線？是否為已發生的事實？'
      + '計畫性歲修、停止生產某項產品、客戶或同業的事故、比喻用語（例如「爆炸性成長」）都不算。',
  }),
  Object.freeze({
    code: 'C16b', key: 'penalty-lawsuit', label: '裁罰訴訟', weight: 0.35, tightenEligible: true,
    ruleText: '本公司遭裁罰或為訴訟被告',
    scope: '主管機關裁罰、重大訴訟（本公司為被告）',
    trigger: /裁罰|罰鍰|罰款|開罰|處以罰|訴訟|求償|被告|假扣押|假處分|侵權/,
    fact: '被主管機關裁罰、或在訴訟中當被告的，是不是 {name} 本身（含子公司或負責人）？{name} 是原告、或只是提到其他公司的訴訟，都不算。',
  }),
  Object.freeze({
    code: 'C15a', key: 'insider-transfer', label: '內部人轉讓', weight: 0.3, tightenEligible: true,
    subWeights: Object.freeze({ giftOrTrust: 0.05 }),
    ruleText: '內部人申報轉讓',
    scope: '董監或大股東申報轉讓（贈與或信託轉讓權重降到 0.05）',
    trigger: /申報轉讓|轉讓持股|申讓|(?:董監|大股東|董事長|總經理).{0,6}(?:賣股|出脫|轉讓|減持)/,
    fact: '申報轉讓的是不是 {name} 的董監或大股東？轉讓方式是不是贈與或信託（回「是·贈與信託」或「是·一般」或「否」）？',
  }),
  Object.freeze({
    code: 'C11a', key: 'capital-reduction-loss', label: '減資彌補虧損', weight: 0.25, tightenEligible: true,
    ruleText: '減資彌補虧損',
    scope: '減資：彌補虧損（方向 0～−）',
    trigger: /減資.{0,12}彌補虧損|彌補虧損.{0,12}減資/,
    fact: '是不是 {name} 本身決議或公告以減資彌補虧損？',
  }),
  Object.freeze({
    code: 'C15c', key: 'pledge-up', label: '設質增加', weight: 0.2, tightenEligible: true,
    ruleText: '內部人設質增加',
    scope: '董監或大股東設質比上升（月頻慢變數）',
    trigger: /設質/,
    fact: '設質比上升的是不是 {name} 的董監或大股東持股？解除設質不算。',
  }),
  Object.freeze({
    code: 'C20b', key: 'credit-downgrade', label: '信評調降', weight: 0.15, tightenEligible: true,
    ruleText: '信用評等遭調降',
    scope: '信評機構調降評等或展望',
    // 只認信用評等機構；券商或外資的投資評等、目標價屬 C20a（規則方向 0、只記 attention，新聞技能 §1.6），不觸發
    trigger: /(?:信評|信用評[等級]|惠譽|穆迪|標準普爾|標普|中華信評|Fitch|Moody|S&P).{0,16}(?:調降|下調|降至|降評|負向|負面)|(?:調降|下調).{0,8}(?:信評|信用評[等級])/i,
    veto: /目標價|券商|外資|投顧|投資評等|買進評等|S&P\s*500|標普\s*500|標準普爾\s*500/i,
    fact: '被信用評等機構（惠譽、穆迪、標準普爾、中華信評）調降信用評等或展望的，是不是 {name} 本身？券商或外資調降投資評等、目標價都不算。',
  }),
]);

export const RULE_CLASS_BY_CODE = Object.freeze(Object.fromEntries(RULE_BEAR_CLASSES.map(c => [c.code, c])));
export const RULE_CLASS_BY_KEY = Object.freeze(Object.fromEntries(RULE_BEAR_CLASSES.map(c => [c.key, c])));
export const RULE_CLASS_CODES = Object.freeze(RULE_BEAR_CLASSES.map(c => c.code));

/** 理由前綴：C16a 沿用既有「【規則】」；其他類別「【規則·{類別名}】」（不得與法律前綴相同，戰情 isRuleLegal 只認法律那一個） */
export function ruleReasonPrefix(code) {
  const c = RULE_CLASS_BY_CODE[code];
  if (!c) return '';
  return c.code === 'C16a' ? RULE_LEGAL_PREFIX : `【規則·${c.label}】`;
}

/**
 * 一筆 newsVerdict 判別 → 規則類別代號（C16a…）或 null。只認程式規則判定留下的欄位，而且 label 必須是「利空」
 * （停損規範 §10A.1-C；規則判定「是」時 daemon 會把 label 覆寫為利空，所以有效的規則判別一定是利空）：
 *   ruleClass（類別代號；daemon 2026-10-05 起寫）＞ ruleOverride（類別 key；C16a＝'legal-event'）＞ 理由前綴「【規則】」（C16a 舊資料）。
 * AI 自己的 eventType（'法律'／'處分'…）**不算**規則類別（範圍很廣，news-weight §1.3）。
 */
export function ruleClassOf(v) {
  if (!isObj(v) || v.label !== '利空') return null;
  if (typeof v.ruleClass === 'string' && RULE_CLASS_BY_CODE[v.ruleClass]) return v.ruleClass;
  if (typeof v.ruleOverride === 'string' && RULE_CLASS_BY_KEY[v.ruleOverride]) return RULE_CLASS_BY_KEY[v.ruleOverride].code;
  if (typeof v.reason === 'string' && v.reason.startsWith(RULE_LEGAL_PREFIX)) return 'C16a';
  return null;
}

/** 判別的子類別（ruleSub，例 C15a 'giftOrTrust'）：只認該類別有登記的子類別，其餘回 null */
export function ruleSubOf(v, code = ruleClassOf(v)) {
  const c = code ? RULE_CLASS_BY_CODE[code] : null;
  if (!c || !c.subWeights || !isObj(v) || typeof v.ruleSub !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(c.subWeights, v.ruleSub) ? v.ruleSub : null;
}

/** 單一類別：有任一處命中觸發字、而且該處前後 VETO_SPAN 字內沒有 veto 字樣 */
function hitsClass(c, t) {
  if (!c.veto) return c.trigger.test(t);
  const re = new RegExp(c.trigger.source, c.trigger.flags.includes('g') ? c.trigger.flags : `${c.trigger.flags}g`);
  for (const m of t.matchAll(re)) {
    const win = t.slice(Math.max(0, m.index - VETO_SPAN), m.index + m[0].length + VETO_SPAN);
    if (!c.veto.test(win)) return true;
  }
  return false;
}

/** 文字命中哪些類別的觸發字（只用來決定「要不要問 AI 事實」；回傳依表內順序、不重複） */
export function ruleClassesHit(text) {
  const t = String(text ?? '');
  if (!t) return [];
  return RULE_BEAR_CLASSES.filter(c => hitsClass(c, t)).map(c => c.code);
}

/**
 * 判別實際讀到的報導 → 各類別的觸發與要給 AI 看的報導（daemon judgeOneStock 用；新聞技能 §1.2 觸發只決定要不要問）。
 * articles：[{ title, content }]（判別實際餵進提示詞的那幾篇）；isMentioned(text)：本檔是否被指名（daemon countMentions）；
 * maxChars：只看內文前幾字（＝主判別提示詞給得到的長度；模型看不到的段落問了也答不出來）。
 * 回 { codes（依表內順序）, byCode: { [code]: [{ title, content }] } }——只收「與本檔同時出現、而且命中該類別」的報導。
 */
export function ruleTriggerScan(articles, isMentioned, maxChars = 1200) {
  const byCode = {};
  for (const a of Array.isArray(articles) ? articles : []) {
    const content = String(a?.content ?? '').slice(0, maxChars);
    const t = `${a?.title ?? ''} ${content}`;
    if (typeof isMentioned === 'function' && !isMentioned(t)) continue;
    for (const code of ruleClassesHit(t)) (byCode[code] ||= []).push({ title: String(a?.title ?? ''), content });
  }
  return { codes: RULE_CLASS_CODES.filter(c => byCode[c]), byCode };
}

/** 類別權重（先驗·未回測）：子類別（例 C15a giftOrTrust）有登記就用子類別；未知類別回 null */
export function classWeightOf(code, sub = null) {
  const c = RULE_CLASS_BY_CODE[code];
  if (!c) return null;
  const w = sub && c.subWeights && typeof c.subWeights[sub] === 'number' ? c.subWeights[sub] : c.weight;
  return { weight: w, source: `新聞技能 §4.1 ${c.code}${sub && w !== c.weight ? `（${sub}）` : ''}·先驗·未回測` };
}

/**
 * 事實提問（AI 只答事實；方向與類別由程式規則決定；停損規範 §10A.2-2：每個命中的類別問一次）。
 * articles：[{ title, content }]（呼叫端只挑「與本檔同時出現、命中該類別」的報導）；maxChars：每篇內文最多幾字（預設 400）。
 */
export function ruleFactQuestion(code, stock, articles, { maxChars = 400 } = {}) {
  const c = RULE_CLASS_BY_CODE[code];
  if (!c) return '';
  const who = `${stock?.code ?? ''} ${stock?.name ?? ''}`.trim();
  const body = (Array.isArray(articles) ? articles : [])
    .map(a => `【${a?.title ?? ''}】${String(a?.content ?? '').slice(0, maxChars)}`).join('\n');
  return `以下是 ${who} 的相關報導。\n${body}\n\n只回答一個問題：${c.fact.replaceAll('{name}', stock?.name ?? who)}\n`
    + '只回：「是」或「否」，再用一句話說明主體是誰、事件是否已發生。內文讀不出來就回「不確定」，不要猜。';
}

/** 回答開頭的「是」：後面必須是結尾、空白、標點、「·」或「的」（「是否…」「是不是…」不算回答） */
const YES_RE = /^是(?:的)?(?=$|[\s，,。.、:：;；!！?？·・（(「『」』"'”’\-—／/])/;
const NO_RE = /^(?:否|不是|非(?=$|[\s，,。.、:：;；!！」』"'”’]))/;

/**
 * 事實回答 → { yes:true, sub } ｜ { yes:false, sub:null } ｜ null（未答：空白、「不確定」、「是否…」等其他開頭——不猜）。
 * 只看開頭（Markdown 粗體記號、引號先去掉）；C15a 的「是·贈與信託」⇒ sub 'giftOrTrust'。
 */
export function parseRuleFactAnswer(code, answer) {
  const a = String(answer ?? '').replace(/\*/g, '').trim().replace(/^[「『"'“]+/, '');
  if (NO_RE.test(a)) return { yes: false, sub: null };
  if (!YES_RE.test(a)) return null;
  if (code === 'C15a' && /^是\s*[·・.、，,]?\s*(?:贈與|信託)/.test(a)) return { yes: true, sub: 'giftOrTrust' };
  return { yes: true, sub: null };
}

// ── 類別權重分級（先驗·未回測） ────────────────────────────────────────────

const EPS = 1e-9;

/**
 * 類別權重分級切點：≥high ⇒ 'high'、≥mid ⇒ 'mid'、其餘 'low'。與停損 STOP_PARAMS.eventTiers 的 minWeight（0.7／0.3）同值
 * （news-rule-classes.test.mjs 釘住兩邊同值）。停損收緊級別仍由 ai-stoploss-event.mjs eventTierOf 決定（另看 tightenEligible）；
 * 戰情 Z2「持股重大利空」的級別也讀這裡（warroom-news majorBearOf；是否沿用待使用者裁定，見停損規範 §15）。
 */
export const CLASS_WEIGHT_CUTS = Object.freeze({ high: 0.7, mid: 0.3 });

/** 類別（＋子類別）→ 'high'｜'mid'｜'low'；未知類別 null。只看類別權重，**不看** AI 識讀結果權重 w */
export function classWeightBand(code, sub = null) {
  const cw = classWeightOf(code, sub);
  if (!cw) return null;
  if (cw.weight >= CLASS_WEIGHT_CUTS.high - EPS) return 'high';
  if (cw.weight >= CLASS_WEIGHT_CUTS.mid - EPS) return 'mid';
  return 'low';
}

/** 畫面用的類別短字：C16a「法律事件（法律判定前視為利空）」，其餘為類別名；未知類別 null */
export function ruleClassText(code) {
  const c = RULE_CLASS_BY_CODE[code];
  if (!c) return null;
  return c.code === 'C16a' ? '法律事件（法律判定前視為利空）' : c.label;
}

// ── 新聞管線：規則判定 ─────────────────────────────────────────────────────

/** 依表內順序、去重、只留已登記的類別 */
function knownCodes(codes) {
  const want = new Set(Array.isArray(codes) ? codes : []);
  return RULE_CLASS_CODES.filter(c => want.has(c));
}

const factText = ans => (ans == null ? 'none' : ans.yes ? 'yes' : 'no');
const firstClause = s => String(s ?? '').replace(/[。\n].*$/, '').slice(0, 24);

/**
 * 規則覆寫時的理由（停損規範 §10A.2-3）：以 ruleReasonPrefix 開頭、附 AI 原判。
 * C16a 與 2026-08-29 版逐字相同：「【規則】涉檢調搜索，法律判定前視為利空（AI 原判中性：…）」；其他類別
 * 「【規則·財務危機】涉財務危機事件，依規則視為利空（AI 原判中性：…）」。長度控制：理由只取 AI 原判第一句前 24 字。
 */
export function ruleOverrideReason(code, verdict) {
  const c = RULE_CLASS_BY_CODE[code];
  if (!c) return '';
  const body = c.code === 'C16a' ? c.ruleText : `${c.ruleText}，依規則視為利空`;
  return `${ruleReasonPrefix(code)}${body}（AI 原判${verdict?.label ?? ''}：${firstClause(verdict?.reason)}）`;
}

/**
 * 規則類別判定（純函式；新聞技能 §1.5、§1.7，停損規範 SKILL §10A.2 第 3～5 步）：AI 只認定事實，方向與類別由這裡決定。
 * - facts：{ [code]: parseRuleFactAnswer 的結果 }（每個命中的類別另問一次；null＝沒答或呼叫失敗）。
 * - 「是」的類別中取類別權重最高者寫 ruleClass（同權重依表內順序），其餘寫 ruleHits（只記錄）；aiOriginal 記 AI 原判。
 * - AI 原判不是利空 ⇒ label 由程式覆寫為利空（bullish false、信心「低」升「中」、理由 ruleOverrideReason；C16a 與 2026-08-29 版逐字相同）。
 *   AI 原判已是利空 ⇒ 只補欄位，理由不改（§10A.2-4 漏網修正）。「否」、沒答 ⇒ 維持 AI 原判，不猜。
 * 回新物件（不改輸入）；沒有問任何類別 ⇒ 原物件。新增欄位只放有值的（Firestore 不收 undefined）。
 */
export function applyRuleFacts(verdict, { facts = {} } = {}) {
  if (!isObj(verdict)) return verdict;
  const f = isObj(facts) ? facts : {};
  const asked = knownCodes(Object.keys(f));
  if (!asked.length) return verdict;
  const yes = asked.filter(c => f[c]?.yes === true);
  const out = { ...verdict, ruleFacts: Object.fromEntries(asked.map(c => [c, factText(f[c])])) };
  if (!yes.length) return out;
  const subOf = c => {
    const s = f[c]?.sub ?? null;
    const subs = RULE_CLASS_BY_CODE[c].subWeights;
    return s && subs && Object.prototype.hasOwnProperty.call(subs, s) ? s : null;
  };
  const weightOf = c => classWeightOf(c, subOf(c)).weight;
  const primary = yes.reduce((best, c) => (weightOf(c) > weightOf(best) + EPS ? c : best), yes[0]);
  out.ruleClass = primary;
  out.ruleOverride = RULE_CLASS_BY_CODE[primary].key;
  if (subOf(primary)) out.ruleSub = subOf(primary);
  const hits = yes.filter(c => c !== primary);
  if (hits.length) out.ruleHits = hits;
  out.aiOriginal = { label: String(verdict.label ?? ''), reason: firstClause(verdict.reason) };
  if (verdict.label !== '利空') {
    out.label = '利空';
    out.bullish = false;
    out.confidence = verdict.confidence === '低' ? '中' : verdict.confidence;
    out.reason = ruleOverrideReason(primary, verdict);
  }
  return out;
}

/** newsVerdict 三個寫入端（夜補、盤中、盤後／晨間）都要存的規則欄位 */
export const RULE_VERDICT_FIELDS = Object.freeze(['ruleClass', 'ruleOverride', 'ruleSub', 'ruleHits', 'aiOriginal', 'ruleFacts']);

/** 判別 → 要寫進 newsVerdict 的規則欄位（只回有值的；三個寫入端共用這一支，不各寫一份） */
export function ruleFieldsOf(v) {
  if (!isObj(v)) return {};
  const out = {};
  for (const k of RULE_VERDICT_FIELDS) if (v[k] != null) out[k] = v[k];
  return out;
}

/**
 * 這筆判別是否已就該類別問過事實並得到是／否——戰情「可能為法律事件」揭露用。
 * 讀 ruleFacts；ruleFocused 是 2026-10-05 審查前（事實題嵌在主判別時）的 C16a 聚焦提問欄位，只為讀舊資料保留。
 */
export function ruleFactAnswered(v, code) {
  if (!isObj(v)) return false;
  if (code === 'C16a' && (v.ruleFocused === 'yes' || v.ruleFocused === 'no')) return true;
  const a = isObj(v.ruleFacts) ? v.ruleFacts[code] : null;
  return a === 'yes' || a === 'no';
}
