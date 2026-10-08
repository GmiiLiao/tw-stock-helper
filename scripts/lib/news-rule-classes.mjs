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
//   「是」⇒ 記規則欄位（ruleClass、ruleOverride、ruleSub、ruleHits、aiOriginal、ruleFacts）。
//   **只有法律類 C16a** 由程式把 label 覆寫為利空（2026-08-29 起的既有行為＋使用者規則「涉法律事件一律利空」；理由以「【規則】」開頭），
//   其他類別**不改** label／bullish／confidence／reason（使用者 2026-10-06 R1「ok 如建議」：label 連動推薦排序、個股評分、
//   做空候選、squeeze-train）。停損收緊與戰情 v2 一律以規則欄位辨識規則類利空（ruleClassOf，不看 label）。
//   寫入欄位在 ruleFieldsOf（三個寫入端共用）。
// 使用者 2026-10-07 裁定（「n1 b／n2 依建議／其它依建議」；新聞技能 §1.5、停損規範 §10A.2）：
//   N1(b) C16a 只有「新聞視窗內有新進展」（事件日期在本次視窗內、AI 逐字引用的法律事實句在內文找得到）才記 'yes' 並改判利空；
//     舊案（事件日期在視窗外、只在背景句出現）記 'old'＝「涉訟中」事實標籤，不改 label、不推播、不收緊停損。
//     C16a 的事實題併入同一題問「是否新進展、日期、逐字引用」（不增加 Ollama 呼叫）；判定在 news-rule-evidence.mjs resolveRuleFact。
//   N2 工安事故後的檢察官相驗、勞檢、事故調查、業務過失偵查不算 C16a（記 'acc'），歸 C17；事實題寫明不算。
//   ruleFacts 的值：'yes'｜'no'｜'none'（沒答、不確定、引用比不上）｜'old'（C16a 舊案·涉訟中）｜'acc'（C16a 實為工安事故調查）。
// 本檔是純資料＋純函式：不 import 任何模組、不碰網路、不讀時鐘（daemon 靜態 import 本檔）。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** 法律規則覆寫既有的理由前綴（daemon「【規則】涉檢調搜索…」；warroom-news RULE_LEGAL_PREFIX 同字，改了兩邊一起改） */
export const RULE_LEGAL_PREFIX = '【規則】';

/**
 * 規則判定「是」時會由程式把 newsVerdict 的 label 覆寫為利空的類別：只有法律事件 C16a（2026-08-29 起；使用者規則「涉法律事件一律利空」）。
 * 其他規則類別只記規則欄位、不改 label（使用者 2026-10-06 R1「ok 如建議」）。
 */
export const LABEL_OVERRIDE_CLASS = 'C16a';

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
      + '若對象是同業、客戶、供應商或其他公司，就不是；市調或研調機構的市場調查、問卷調查、搜索引擎都不算；'
      + '工安事故、火災、爆炸之後的檢察官相驗、勞動檢查、事故調查、業務過失偵查也不算（那屬工安停工，另有題目）。',
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
 * 一筆 newsVerdict 判別 → 規則類別代號（C16a…）或 null。只認程式規則判定留下的欄位，**不看 label**
 * （使用者 2026-10-06 R1：非法律類別的事實題答「是」時 daemon 不改 label，只記規則欄位；停損規範 §10A.1-C）：
 *   ① ruleClass（類別代號；daemon 2026-10-05 起寫）而且該類事實題答「是」（ruleFacts[ruleClass]==='yes'）；
 *   ② 舊資料的 C16a：ruleOverride==='legal-event' 或理由前綴「【規則】」——2026-08-29 版法律覆寫，當時一定同時把 label 覆寫為利空，
 *      所以這條仍要求 label＝利空（前綴或 key 與 label 對不上的資料不認，不猜）。
 * 非法律類別只有 ruleOverride、沒有 ruleClass＋事實「是」的資料不認（2026-10-05 前不存在這種資料）。
 * AI 自己的 eventType（'法律'／'處分'…）**不算**規則類別（範圍很廣，news-weight §1.3）。
 */
export function ruleClassOf(v) {
  if (!isObj(v)) return null;
  if (typeof v.ruleClass === 'string' && RULE_CLASS_BY_CODE[v.ruleClass]
    && isObj(v.ruleFacts) && v.ruleFacts[v.ruleClass] === 'yes') return v.ruleClass;
  if (v.label !== '利空') return null;
  if (v.ruleOverride === RULE_CLASS_BY_CODE.C16a.key) return 'C16a';
  if (typeof v.reason === 'string' && v.reason.startsWith(RULE_LEGAL_PREFIX)) return 'C16a';
  return null;
}

/** 判別的子類別（ruleSub，例 C15a 'giftOrTrust'）：只認該類別有登記的子類別，其餘回 null */
export function ruleSubOf(v, code = ruleClassOf(v)) {
  const c = code ? RULE_CLASS_BY_CODE[code] : null;
  if (!c || !c.subWeights || !isObj(v) || typeof v.ruleSub !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(c.subWeights, v.ruleSub) ? v.ruleSub : null;
}

/** 單一類別的第一個有效命中（命中處前後 VETO_SPAN 字內有 veto 字樣的不算）→ { index, text } 或 null */
function firstHit(c, t) {
  const re = new RegExp(c.trigger.source, c.trigger.flags.includes('g') ? c.trigger.flags : `${c.trigger.flags}g`);
  for (const m of t.matchAll(re)) {
    if (c.veto) {
      const win = t.slice(Math.max(0, m.index - VETO_SPAN), m.index + m[0].length + VETO_SPAN);
      if (c.veto.test(win)) continue;
    }
    return { index: m.index, text: m[0] };
  }
  return null;
}

/** 單一類別：有任一處命中觸發字、而且該處前後 VETO_SPAN 字內沒有 veto 字樣 */
function hitsClass(c, t) {
  return firstHit(c, t) != null;
}

/** 稽核軌跡（ruleEvidence）用：命中處前後各幾個字 */
export const TRIGGER_CTX_SPAN = 30;

/**
 * 文字對某類別的第一個有效命中 → { trig（觸發字）, ctx（命中處前後各 TRIGGER_CTX_SPAN 字，空白壓成一格）} 或 null。
 * 只供稽核軌跡（ruleEvidence）記錄「為什麼問了這一題」；觸發字仍然不決定方向（新聞技能 §1.2）。
 */
export function ruleTriggerHit(code, text, span = TRIGGER_CTX_SPAN) {
  const c = RULE_CLASS_BY_CODE[code];
  const t = String(text ?? '');
  if (!c || !t) return null;
  const h = firstHit(c, t);
  if (!h) return null;
  const ctx = t.slice(Math.max(0, h.index - span), h.index + h.text.length + span).replace(/\s+/g, ' ').trim();
  return { trig: h.text.slice(0, 16), ctx };
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
 * 回 { codes（依表內順序）, byCode: { [code]: [{ title, content, at, src, hit }] } }——只收「與本檔同時出現、而且命中該類別」的報導。
 * at＝發布時刻（ms；C16a 事實題附發布日，讓 AI 把「今日」「昨日」換成日期）；src＝內文來源；hit＝ruleTriggerHit（稽核軌跡用）。
 */
export function ruleTriggerScan(articles, isMentioned, maxChars = 1200) {
  const byCode = {};
  for (const a of Array.isArray(articles) ? articles : []) {
    const content = String(a?.content ?? '').slice(0, maxChars);
    const t = `${a?.title ?? ''} ${content}`;
    if (typeof isMentioned === 'function' && !isMentioned(t)) continue;
    const at = typeof a?.at === 'number' && Number.isFinite(a.at) ? a.at : null;
    const src = String(a?.bodyFrom || a?.src || '').trim() || null;
    for (const code of ruleClassesHit(t)) {
      (byCode[code] ||= []).push({ title: String(a?.title ?? ''), content, at, src, hit: ruleTriggerHit(code, t) });
    }
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

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 發布時刻（ms）→ 台北日期 'YYYY-MM-DD'；不是有限數字回 null */
export function taipeiYmdOfMs(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10) : null;
}

/**
 * C16a 事實題（2026-10-07 N1(b)＋N2）：同一題併問「對象是不是本公司」「是不是本次新聞視窗內的新進展」「日期」「逐字引用法律事實句」，
 * 不另開呼叫。window：{ from, to }（'YYYY-MM-DD'，＝judgeOneStock 的新聞視窗）；每篇附發布日。
 */
function legalFactQuestion(c, stock, articles, maxChars, window) {
  const who = `${stock?.code ?? ''} ${stock?.name ?? ''}`.trim();
  const body = (Array.isArray(articles) ? articles : []).map(a => {
    const pub = taipeiYmdOfMs(a?.at);
    return `【${a?.title ?? ''}】${pub ? `（發布 ${pub}）` : ''}${String(a?.content ?? '').slice(0, maxChars)}`;
  }).join('\n');
  const win = window && YMD_RE.test(String(window.from)) && YMD_RE.test(String(window.to))
    ? `本次新聞視窗：${window.from} ～ ${window.to}。\n` : '';
  return `以下是 ${who} 的相關報導（每篇附發布日期）。\n${body}\n\n${win}請回答：\n`
    + `1. ${c.fact.replaceAll('{name}', stock?.name ?? who)}\n`
    + '2. 這件法律事實是不是在本次新聞視窗內新發生、或有新進展（新的搜索、約談、起訴、羈押、判決、主管機關新處分）？'
    + '只在背景說明裡帶到的舊案（例如「該公司先前曾遭搜索」）不算新進展。\n'
    + '3. 這件事（或它的新進展）發生在哪一天？報導寫「今日」「昨日」就以該篇的發布日推算。\n\n'
    // ⚠ 格式說明不可用「是」開頭（模型照抄範本時會被讀成「是」）：每一行都寫成「只填…」
    + '照下列格式回答，一行一項：\n'
    + '回答: 第 1 題只填「是」「否」或「不確定」\n'
    + '新進展: 第 2 題只填「是」「否」或「不確定」\n'
    + '日期: 只填 YYYY-MM-DD，讀不出來填「不明」\n'
    + '引用: 「從上面報導逐字照抄描述這件法律事實的那一句，不可改寫」\n'
    + '說明: 一句話說明主體是誰、發生了什麼。內文讀不出來就回「不確定」，不要猜。';
}

/**
 * 事實提問（AI 只答事實；方向與類別由程式規則決定；停損規範 §10A.2-2：每個命中的類別問一次）。
 * articles：[{ title, content, at? }]（呼叫端只挑「與本檔同時出現、命中該類別」的報導）；maxChars：每篇內文最多幾字（預設 400）。
 * C16a 另帶 window（新聞視窗），改用 legalFactQuestion 的格式（同一題併問新進展、日期、逐字引用）；其他類別提示詞不變。
 */
export function ruleFactQuestion(code, stock, articles, { maxChars = 400, window = null } = {}) {
  const c = RULE_CLASS_BY_CODE[code];
  if (!c) return '';
  if (c.code === LABEL_OVERRIDE_CLASS) return legalFactQuestion(c, stock, articles, maxChars, window);
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
 * 只看開頭（Markdown 粗體記號、「回答:」標籤、引號先去掉；C16a 的多行格式第一行就是「回答: 是／否」）；
 * C15a 的「是·贈與信託」⇒ sub 'giftOrTrust'。
 */
export function parseRuleFactAnswer(code, answer) {
  const raw = String(answer ?? '').replace(/\*/g, '').trim();
  // 多行格式（C16a）：「回答:」那一行不一定在第一行（模型偶爾先寫說明）——有就讀那一行
  const line = raw.match(/(?:^|\n)\s*(?:回答|答案)\s*[:：]\s*([^\n]*)/);
  const a = (line ? line[1] : raw).trim()
    .replace(/^(?:答\s*[:：]\s*)?(?:第\s*1\s*題\s*[:：]?\s*|1\s*[.、:：)）]\s*)?/, '').replace(/^[「『"'“]+/, '');
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
 * 戰情 Z2「持股重大利空」的級別也讀這裡（warroom-news majorBearOf；使用者 2026-10-06 R2「ok 如建議」裁定維持，停損規範 §15A-1）。
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

/**
 * ruleFacts 的值（2026-10-07 起）：'yes' 是｜'no' 否｜'none' 沒答、不確定、呼叫失敗、C16a 引用比不上｜
 * 'old' C16a 舊案（事件日期在新聞視窗外、只在背景句出現）＝「涉訟中」事實標籤｜'acc' C16a 其實是工安事故後的相驗／調查（歸 C17）。
 * 只有 'yes' 算規則類別；'old'、'acc' 也算「已就法律事實問過並得到回答」（ruleFactAnswered）。
 */
export const RULE_FACT_STATES = Object.freeze(['yes', 'no', 'none', 'old', 'acc']);
/** C16a 舊案的事實標籤字樣（戰情、紀錄共用） */
export const LEGAL_ONGOING_TAG = '涉訟中';

/**
 * 一題的事實結果 → ruleFacts 的值。新格式帶 state（news-rule-evidence.mjs resolveRuleFact）；
 * 舊格式只有 parseRuleFactAnswer 的 { yes, sub }（null＝沒答）。
 */
export function factStateOf(ans) {
  if (ans == null || !isObj(ans)) return 'none';
  if (typeof ans.state === 'string' && RULE_FACT_STATES.includes(ans.state)) return ans.state;
  return ans.yes === true ? 'yes' : ans.yes === false ? 'no' : 'none';
}
const firstClause = s => String(s ?? '').replace(/[。\n].*$/, '').slice(0, 24);

/**
 * 規則覆寫時的理由（停損規範 §10A.2-3）：以 ruleReasonPrefix 開頭、附 AI 原判。
 * C16a 與 2026-08-29 版逐字相同：「【規則】涉檢調搜索，法律判定前視為利空（AI 原判中性：…）」；其他類別
 * 「【規則·財務危機】涉財務危機事件，依規則視為利空（AI 原判中性：…）」。長度控制：理由只取 AI 原判第一句前 24 字。
 * ⚠ 2026-10-06 R1 起 applyRuleFacts 只對 C16a 改寫理由；其他類別的字樣只留給顯示／紀錄用（newsVerdict 的 reason 不改）。
 */
export function ruleOverrideReason(code, verdict) {
  const c = RULE_CLASS_BY_CODE[code];
  if (!c) return '';
  const body = c.code === 'C16a' ? c.ruleText : `${c.ruleText}，依規則視為利空`;
  return `${ruleReasonPrefix(code)}${body}（AI 原判${verdict?.label ?? ''}：${firstClause(verdict?.reason)}）`;
}

/**
 * 規則類別判定（純函式；新聞技能 §1.5、§1.7，停損規範 SKILL §10A.2 第 3～5 步）：AI 只認定事實，方向與類別由這裡決定。
 * - facts：{ [code]: news-rule-evidence.mjs resolveRuleFact 的結果 { yes, sub, state, ev }，或舊格式 parseRuleFactAnswer 的結果 }
 *   （每個命中的類別另問一次；null＝沒答或呼叫失敗）。ruleFacts 記 factStateOf；有 ev 的記進 ruleEvidence（稽核軌跡）。
 * - state 'yes' 的類別中取類別權重最高者寫 ruleClass（同權重依表內順序），其餘寫 ruleHits（只記錄）；aiOriginal 記 AI 原判。
 *   C16a 的 'old'（舊案·涉訟中）與 'acc'（工安事故調查，2026-10-07 N2）不算「是」：不改 label、不寫 ruleClass。
 *   C16a 類別權重 0.90 是表內最高（與 C23 同權重時 C16a 在前），所以「C16a 答是」⇔ ruleClass＝'C16a'。
 * - ruleClass＝C16a 且 AI 原判不是利空 ⇒ label 由程式覆寫為利空（bullish false、信心「低」升「中」、理由與 2026-08-29 版逐字相同）；
 *   信心有升時 aiOriginal 另記 AI 原信心 confidence（2026-10-08）。
 * - 其他類別（C23、C22、C13b、C17、C16b、C15a、C11a、C15c、C20b）**只記規則欄位**，label／bullish／confidence／reason 一律不動
 *   （使用者 2026-10-06 R1：label 連動推薦排序、個股評分、做空候選、squeeze-train；停損收緊與戰情由 ruleClassOf 讀規則欄位）。
 * - AI 原判已是利空 ⇒ 只補欄位，理由不改（§10A.2-4 漏網修正）。「否」、沒答 ⇒ 維持 AI 原判，不猜。
 * 回新物件（不改輸入）；沒有問任何類別 ⇒ 原物件。新增欄位只放有值的（Firestore 不收 undefined）。
 */
export function applyRuleFacts(verdict, { facts = {} } = {}) {
  if (!isObj(verdict)) return verdict;
  const f = isObj(facts) ? facts : {};
  const asked = knownCodes(Object.keys(f));
  if (!asked.length) return verdict;
  const yes = asked.filter(c => factStateOf(f[c]) === 'yes');
  const out = { ...verdict, ruleFacts: Object.fromEntries(asked.map(c => [c, factStateOf(f[c])])) };
  const evidence = Object.fromEntries(asked.filter(c => isObj(f[c]?.ev)).map(c => [c, f[c].ev]));
  if (Object.keys(evidence).length) out.ruleEvidence = evidence;
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
  if (primary === LABEL_OVERRIDE_CLASS && verdict.label !== '利空') {
    out.label = '利空';
    out.bullish = false;
    out.confidence = verdict.confidence === '低' ? '中' : verdict.confidence;
    out.reason = ruleOverrideReason(primary, verdict);
    // 規則改了信心（低→中）⇒ AI 原信心一併記下（2026-10-08 審查：稽核軌跡；下游推論上限不得把規則調整後的值當 AI 原值）。
    //   aiOriginal.confidence 存在＝程式改過信心；沒改就不加欄位（既有文件形狀不變）。
    if (out.confidence !== verdict.confidence) out.aiOriginal = { ...out.aiOriginal, confidence: verdict.confidence ?? null };
  }
  return out;
}

/**
 * newsVerdict 三個寫入端（夜補、盤中、盤後／晨間）都要存的規則欄位。2026-10-07 加：
 *   ruleEvidence（每題的稽核軌跡：觸發字、前後文、標題與來源、AI 回答前 60 字、C16a 的引用／日期／是否新進展；news-rule-evidence.mjs）、
 *   ruleTrail（各類別首次判定「是」的適用日 since，延續判定用）、ruleCont（主類別是延續時＝首次判定的適用日）。
 */
export const RULE_VERDICT_FIELDS = Object.freeze([
  'ruleClass', 'ruleOverride', 'ruleSub', 'ruleHits', 'aiOriginal', 'ruleFacts', 'ruleEvidence', 'ruleTrail', 'ruleCont',
]);

/** 判別 → 要寫進 newsVerdict 的規則欄位（只回有值的；三個寫入端共用這一支，不各寫一份） */
export function ruleFieldsOf(v) {
  if (!isObj(v)) return {};
  const out = {};
  for (const k of RULE_VERDICT_FIELDS) if (v[k] != null) out[k] = v[k];
  return out;
}

/**
 * 這筆判別是否已就該類別問過事實並得到回答（是、否、舊案 'old'、工安事故調查 'acc'）——戰情「可能為法律事件」揭露用。
 * 讀 ruleFacts；ruleFocused 是 2026-10-05 審查前（事實題嵌在主判別時）的 C16a 聚焦提問欄位，只為讀舊資料保留。
 */
export function ruleFactAnswered(v, code) {
  if (!isObj(v)) return false;
  if (code === 'C16a' && (v.ruleFocused === 'yes' || v.ruleFocused === 'no')) return true;
  const a = isObj(v.ruleFacts) ? v.ruleFacts[code] : null;
  return a === 'yes' || a === 'no' || a === 'old' || a === 'acc';
}
