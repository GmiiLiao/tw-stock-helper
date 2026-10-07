// 規則事實題的判定細節、稽核軌跡、延續、當日沿用 單元測試：node --test scripts/lib/news-rule-evidence.test.mjs
// 使用者 2026-10-07 裁定「n1 b／n2 依建議／其它依建議」：
//   3037 型舊案背景句（只標涉訟中、不改判）、2367 型工安事故相驗（歸 C17）、延續（不當新事件）、同日沿用（不重問）、引用比不上（不算）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULE_CONT_TRADING_DAYS, RULE_DOC_SOFT_MAX, ACCIDENT_LINK_RE, ACCIDENT_CONTEXT_RE, normForQuote, quoteInArticles, parseLegalFactDetail, factDateSpan,
  windowRelation, quoteDateRelation, quoteClauseOf, isBackgroundClause, resolveRuleFact, ruleFactKey, reuseRuleFact, asReused, reconcileAccident,
  ruleTrailEligible, withRuleTrail, isRuleContinuation, isLegalOngoing, ruleAuditCounts, slimRuleEvidence, fitVerdictJson,
  eventDateSpan, eventDateLater, ruleEventDateOf, isRuleRenewal,
} from './news-rule-evidence.mjs';
import {
  applyRuleFacts, ruleFieldsOf, ruleClassOf, ruleFactQuestion, parseRuleFactAnswer, ruleTriggerScan, ruleTriggerHit, factStateOf,
  ruleFactAnswered, RULE_CLASS_BY_CODE, RULE_LEGAL_PREFIX, LEGAL_ONGOING_TAG, RULE_FACT_STATES, TRIGGER_CTX_SPAN,
} from './news-rule-classes.mjs';
import { STOP_PARAMS } from './ai-stoploss-base.mjs';

const TODAY = '2026-10-07';
const WIN = { from: '2026-10-03', to: TODAY };
const AT = ymd => Date.parse(`${ymd}T09:30:00+08:00`);
const OPTS = (articles, extra = {}) => ({ articles, window: WIN, todayYmd: TODAY, day: TODAY, key: 'k1', ...extra });

// 3037 欣興型：報導主體是 ABF 載板需求，內文夾帶 8 月搜索的舊背景句
const ART_3037 = {
  title: '欣興ABF載板需求回溫 法人看好第四季', at: AT('2026-10-06'), src: '經濟日報',
  content: '欣興受惠AI伺服器帶動ABF載板需求回溫，第四季稼動率可望提升。欣興8月遭檢調搜索，公司強調營運正常。法人看好明年成長。',
};
// 新進展型：視窗內新的搜索
const ART_NEW = {
  title: '調查局搜索欣興總部', at: AT('2026-10-06'), src: '工商時報',
  content: '調查局今日搜索欣興總部並約談財務主管，欣興表示將配合調查，營運正常。',
};
// 2367 燿華型：工安事故後的相驗
const ART_2367 = {
  title: '燿華廠區工安意外 一死一傷', at: AT('2026-10-06'), src: '自由時報',
  content: '燿華宜蘭廠今日發生工安意外，造成一死一傷，部分產線停工。新北地檢署檢察官今日到場相驗罹難員工，勞檢單位同步介入。',
};
const scanOf = (art, name) => ruleTriggerScan([art], t => t.includes(name), 1200);
const legalAns = ({ yes = '是', nd = '否', date = '2026-08-25', quote = '欣興8月遭檢調搜索' } = {}) =>
  `回答: ${yes}\n新進展: ${nd}\n日期: ${date}\n引用: 「${quote}」\n說明: 對象是欣興本身。`;
const AI = (over = {}) => ({ label: '中性', bullish: false, confidence: '中', strength: '弱', reason: 'ABF 需求回溫，影響有限。其餘略', basis: 'content', challenged: true, ...over });

test('延續有效期＝停損事件收緊期限（同一個「同一事件」口徑）；狀態表與標籤字樣', () => {
  assert.equal(RULE_CONT_TRADING_DAYS, STOP_PARAMS.eventHoldDays);
  assert.deepEqual([...RULE_FACT_STATES], ['yes', 'no', 'none', 'old', 'acc']);
  assert.equal(LEGAL_ONGOING_TAG, '涉訟中');
  assert.ok(RULE_DOC_SOFT_MAX < 1_048_576);
});

test('C16a 事實題（N1(b)＋N2）：同一題併問新進展、日期、逐字引用；附新聞視窗與發布日；寫明工安相驗不算；其他類別提示詞不變', () => {
  const scan = scanOf(ART_3037, '欣興');
  assert.deepEqual(scan.codes, ['C16a']);
  const a = scan.byCode.C16a[0];
  assert.equal(a.at, ART_3037.at);
  assert.equal(a.src, '經濟日報');
  assert.equal(a.hit.trig, '檢調');
  assert.ok(a.hit.ctx.includes('8月遭檢調搜索') && a.hit.ctx.length <= 2 + 2 * TRIGGER_CTX_SPAN + 2);
  const q = ruleFactQuestion('C16a', { code: '3037', name: '欣興' }, scan.byCode.C16a, { maxChars: 1200, window: WIN });
  for (const s of ['本次新聞視窗：2026-10-03 ～ 2026-10-07', '（發布 2026-10-06）', '新進展:', '日期:', '引用:', '逐字照抄', '背景說明裡帶到的舊案', '相驗', '勞動檢查', '業務過失']) {
    assert.ok(q.includes(s), s);
  }
  // 格式說明不可用「是」開頭（照抄範本會被讀成「是」）
  assert.ok(!/\n(?:回答|新進展)\s*[:：]\s*是/.test(q));
  assert.equal(parseRuleFactAnswer('C16a', '回答: 第 1 題只填「是」「否」或「不確定」\n新進展: 第 2 題只填「是」「否」或「不確定」'), null);
  assert.deepEqual(parseLegalFactDetail('回答: 第 1 題只填…\n新進展: 第 2 題只填「是」「否」或「不確定」\n日期: 只填 YYYY-MM-DD，讀不出來填「不明」\n引用: 「從上面報導逐字照抄描述這件法律事實的那一句，不可改寫」'),
    { newDev: null, date: null, quote: '從上面報導逐字照抄描述這件法律事實的那一句，不可改寫' });
  const q17 = ruleFactQuestion('C17', { code: '2367', name: '燿華' }, [{ title: 't', content: 'c' }], { maxChars: 1200, window: WIN });
  assert.ok(q17.includes('只回答一個問題') && !q17.includes('新進展'));
  assert.ok(RULE_CLASS_BY_CODE.C16a.fact.includes('檢察官相驗') && RULE_CLASS_BY_CODE.C16a.fact.includes('另有題目'));
  assert.deepEqual(ruleTriggerHit('C99', 'x'), null);
});

test('回答解析：「回答:」那一行不一定在第一行；「1.」「第 1 題」前綴；新進展、日期、引用（含後備：第一段「…」）', () => {
  assert.deepEqual(parseRuleFactAnswer('C16a', '說明: 對象是本公司\n回答: 是\n新進展: 否'), { yes: true, sub: null });
  assert.deepEqual(parseRuleFactAnswer('C16a', '1. 否，是同業'), { yes: false, sub: null });
  assert.deepEqual(parseRuleFactAnswer('C16a', '第1題：是'), { yes: true, sub: null });
  assert.equal(parseRuleFactAnswer('C16a', '回答: 不確定\n新進展: 是'), null);
  assert.deepEqual(parseLegalFactDetail(legalAns()), { newDev: 'no', date: '2026-08-25', quote: '欣興8月遭檢調搜索' });
  assert.deepEqual(parseLegalFactDetail('回答: 是\n新進展: 沒有新進展\n日期: 不明'), { newDev: 'no', date: null, quote: null });
  assert.equal(parseLegalFactDetail('新進展: 是，今日搜索').newDev, 'yes');
  assert.equal(parseLegalFactDetail('新進展: 不確定').newDev, null);
  assert.equal(parseLegalFactDetail('回答: 是\n說明: 報導寫「調查局今日搜索欣興總部」').quote, '調查局今日搜索欣興總部');
});

test('日期：完整日期、民國、月日（推年）、整月、整年、去年；視窗關係；引用句裡的絕對日期（有今日、昨日就不用）', () => {
  const sp = t => factDateSpan(t, TODAY);
  assert.deepEqual(sp('2026-10-06'), { lo: '2026-10-06', hi: '2026-10-06' });
  assert.deepEqual(sp('115年10月6日'), { lo: '2026-10-06', hi: '2026-10-06' });
  assert.deepEqual(sp('10/06'), { lo: '2026-10-06', hi: '2026-10-06' });
  assert.deepEqual(sp('12月3日'), { lo: '2025-12-03', hi: '2025-12-03' }, '沒寫年份而落在今天之後 ⇒ 去年');
  assert.deepEqual(sp('8月'), { lo: '2026-08-01', hi: '2026-08-31' });
  assert.deepEqual(sp('2026-08'), { lo: '2026-08-01', hi: '2026-08-31' });
  assert.deepEqual(sp('2025年'), { lo: '2025-01-01', hi: '2025-12-31' });
  assert.deepEqual(sp('去年'), { lo: '2025-01-01', hi: '2025-12-31' });
  assert.equal(sp('不明'), null);
  assert.equal(sp('2026-02-30'), null);
  assert.equal(windowRelation(sp('2026-10-06'), WIN), 'in');
  assert.equal(windowRelation(sp('8月'), WIN), 'out');
  assert.equal(windowRelation(sp('10月'), WIN), 'unknown', '整月跨視窗邊界 ⇒ 不確定（不算新進展）');
  assert.equal(windowRelation(null, WIN), 'unknown');
  assert.equal(quoteDateRelation('欣興8月遭檢調搜索', WIN, TODAY), 'out');
  assert.equal(quoteDateRelation('檢調今(7)日搜索欣興，調查其2025年的交易', WIN, TODAY), 'none', '有相對時間字樣');
  assert.equal(quoteDateRelation('檢調10月6日搜索欣興', WIN, TODAY), 'in');
  assert.equal(quoteDateRelation('調查局搜索欣興總部', WIN, TODAY), 'none');
  assert.equal(quoteDateRelation('欣興8月25日上午遭檢調搜索', WIN, TODAY), 'out', '時段字（上午）不算相對日子');
});

test('3037 型舊案背景句：對象是本公司，但事件日期在視窗外 ⇒ old（涉訟中）——不改 label、沒有 ruleClass、不是規則類利空', () => {
  const scan = scanOf(ART_3037, '欣興');
  const f = resolveRuleFact('C16a', legalAns(), OPTS(scan.byCode.C16a));
  assert.equal(f.state, 'old');
  assert.equal(f.yes, false);
  assert.deepEqual([f.ev.quoteOk, f.ev.isNew, f.ev.why, f.ev.eventDate, f.ev.newDev], [true, false, 'notNew', '2026-08-25', 'no']);
  assert.deepEqual([f.ev.trig, f.ev.title, f.ev.src, f.ev.pub, f.ev.key, f.ev.day], ['檢調', ART_3037.title, '經濟日報', '2026-10-06', 'k1', TODAY]);
  assert.ok(f.ev.ans.length <= 60 && f.ev.ans.startsWith('回答: 是'));
  // AI 說「是新進展」卻把舊案標成視窗內日期：引用句自己寫「8 月」⇒ 仍是舊案（10/05–10/07 誤判的型態）
  const mis = resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-10-06' }), OPTS(scan.byCode.C16a));
  assert.deepEqual([mis.state, mis.ev.why], ['old', 'quoteDateOut']);
  // AI 說是新進展、日期 8 月 ⇒ dateOut；日期讀不出來 ⇒ dateUnknown（都只是涉訟中）
  assert.equal(resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-08-25' }), OPTS(scan.byCode.C16a)).ev.why, 'dateOut');
  const unk = resolveRuleFact('C16a', legalAns({ nd: '是', date: '不明', quote: '欣興8月遭檢調搜索，公司強調營運正常' }), OPTS(scan.byCode.C16a));
  assert.deepEqual([unk.state, unk.ev.why], ['old', 'dateUnknown']);
  const v = applyRuleFacts(AI(), { facts: { C16a: f } });
  assert.deepEqual([v.label, v.reason, v.ruleClass, v.ruleOverride], ['中性', AI().reason, undefined, undefined]);
  assert.deepEqual(v.ruleFacts, { C16a: 'old' });
  assert.equal(v.ruleEvidence.C16a.why, 'notNew');
  assert.equal(ruleClassOf(v), null);
  assert.equal(isLegalOngoing(v), true);
  assert.equal(ruleFactAnswered(v, 'C16a'), true, '舊案也算已回答（戰情不標「可能為法律事件」）');
  assert.equal(factStateOf(f), 'old');
});

test('新進展：AI 說是新進展、日期在視窗內、引用逐字找得到 ⇒ yes，照 2026-08-29 版覆寫為利空', () => {
  const scan = scanOf(ART_NEW, '欣興');
  const f = resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-10-06', quote: '調查局今日搜索欣興總部並約談財務主管' }), OPTS(scan.byCode.C16a));
  assert.deepEqual([f.state, f.yes, f.ev.isNew, f.ev.quoteOk, f.ev.eventDate], ['yes', true, true, true, '2026-10-06']);
  assert.equal(f.ev.why, undefined);
  const v = applyRuleFacts(AI(), { facts: { C16a: f } });
  assert.equal(v.label, '利空');
  assert.equal(v.reason, `${RULE_LEGAL_PREFIX}涉檢調搜索，法律判定前視為利空（AI 原判中性：ABF 需求回溫，影響有限）`);
  assert.equal(ruleClassOf(v), 'C16a');
  assert.equal(isLegalOngoing(v), false);
  // 引用標點、空白不同也算逐字（沿用 E 引用強制的正規化）
  assert.equal(quoteInArticles('調查局今日搜索欣興總部，並約談財務主管', scan.byCode.C16a), true);
  assert.equal(normForQuote('「調查局」今日， 搜索'), '調查局今日搜索');
});

test('引用比不上就不算：改寫、拼接、太短、沒給引用 ⇒ none（連涉訟中也不給），計數記 quoteFail', () => {
  const arts = scanOf(ART_NEW, '欣興').byCode.C16a;
  for (const quote of ['調查局今天搜索了欣興的總部', '欣興遭搜索並遭起訴', '搜索', '']) {
    const f = resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-10-06', quote }), OPTS(arts));
    assert.deepEqual([f.state, f.yes, f.ev.quoteOk, f.ev.why], ['none', null, false, 'quote'], quote);
    const v = applyRuleFacts(AI(), { facts: { C16a: f } });
    assert.deepEqual([v.label, v.ruleFacts.C16a, ruleClassOf(v)], ['中性', 'none', null]);
  }
  const f = resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-10-06', quote: '假的句子不在內文裡面' }), OPTS(arts));
  assert.deepEqual(ruleAuditCounts({ C16a: f }), { asked: { C16a: 1 }, ans: { C16a: { none: 1 } }, quoteFail: { C16a: 1 } });
});

test('2367 型工安事故相驗（N2）：C16a 引用是相驗／勞檢 ⇒ acc；C17 同時答「是」⇒ 主類別 C17，label 維持 AI 原判（R1）', () => {
  const scan = ruleTriggerScan([ART_2367], t => t.includes('燿華'), 1200);
  assert.deepEqual(scan.codes, ['C16a', 'C17']);
  const f16 = resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-10-06', quote: '新北地檢署檢察官今日到場相驗罹難員工' }), OPTS(scan.byCode.C16a));
  assert.deepEqual([f16.state, f16.yes, f16.ev.why], ['acc', false, 'accident']);
  const f17 = resolveRuleFact('C17', '是，燿華宜蘭廠發生工安意外', OPTS(scan.byCode.C17));
  assert.equal(f17.state, 'yes');
  const facts = reconcileAccident({ C16a: f16, C17: f17 }, scan.byCode);
  const v = applyRuleFacts(AI({ label: '利空', reason: '工安意外停工' }), { facts });
  assert.deepEqual([v.ruleClass, v.ruleHits, v.label, v.reason], ['C17', undefined, '利空', '工安意外停工']);
  assert.deepEqual(v.ruleFacts, { C16a: 'acc', C17: 'yes' });
  assert.equal(ruleClassOf(v), 'C17');
  const neutral = applyRuleFacts(AI(), { facts });
  assert.deepEqual([neutral.label, neutral.ruleClass], ['中性', 'C17'], 'C17 不改 label（R1）');
  assert.ok(ACCIDENT_LINK_RE.test('檢方偵辦業務過失致死'));
});

test('N2 同一起事故（引用句沒有事故字樣）：C17 答「是」而 C16a 的引用出現在 C17 的報導裡 ⇒ acc；不同報導的法律事件照舊 C16a 為主', () => {
  const art = { title: '燿華廠區火災 檢調搜索', at: AT('2026-10-06'), content: '燿華宜蘭廠昨晚發生火災，部分產線停工。新北地檢署今日指揮檢調搜索燿華宜蘭廠辦公室。' };
  const scan = ruleTriggerScan([art], t => t.includes('燿華'), 1200);
  assert.deepEqual(scan.codes, ['C16a', 'C17']);
  const f16 = resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-10-07', quote: '新北地檢署今日指揮檢調搜索燿華宜蘭廠辦公室' }), OPTS(scan.byCode.C16a));
  assert.equal(f16.state, 'yes');
  const f17 = resolveRuleFact('C17', '是', OPTS(scan.byCode.C17));
  const facts = reconcileAccident({ C16a: f16, C17: f17 }, scan.byCode);
  assert.deepEqual([facts.C16a.state, facts.C16a.ev.why], ['acc', 'accidentC17']);
  assert.equal(f16.state, 'yes', '不改輸入');
  assert.equal(applyRuleFacts(AI(), { facts }).ruleClass, 'C17');
  // C16a 的報導與工安報導是不同篇（不同事件）⇒ 照舊 C16a 為主、覆寫利空
  const other = { title: '燿華前董座涉背信 遭起訴', at: AT('2026-10-06'), content: '新北地檢署今日依背信罪起訴燿華前董事長，指其掏空子公司資金。' };
  const scan2 = ruleTriggerScan([art, other], t => t.includes('燿華'), 1200);
  const g16 = resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-10-06', quote: '新北地檢署今日依背信罪起訴燿華前董事長' }), OPTS(scan2.byCode.C16a));
  const g = reconcileAccident({ C16a: g16, C17: resolveRuleFact('C17', '是', OPTS(scan2.byCode.C17)) }, scan2.byCode);
  const v = applyRuleFacts(AI(), { facts: g });
  assert.deepEqual([v.ruleClass, v.ruleHits, v.label], ['C16a', ['C17'], '利空']);
  assert.equal(reconcileAccident({ C16a: g16 }, scan2.byCode).C16a.state, 'yes', 'C17 沒答「是」⇒ 不動');
});

test('非 C16a 類別：答案照舊（是／否／不確定），軌跡記觸發字與回答；C15a 子類別進軌跡', () => {
  const scan = scanOf(ART_2367, '燿華');
  const yes = resolveRuleFact('C17', '**是**，燿華宜蘭廠工安意外', OPTS(scan.byCode.C17));
  assert.deepEqual([yes.state, yes.yes, yes.ev.trig, yes.ev.quote], ['yes', true, '工安', undefined]);
  assert.deepEqual([resolveRuleFact('C17', '否，是客戶的廠', OPTS([])).state, resolveRuleFact('C17', '不確定', OPTS([])).state], ['no', 'none']);
  const empty = resolveRuleFact('C17', null, OPTS([]));
  assert.deepEqual([empty.state, empty.answered, empty.ev.why], ['none', false, 'noAnswer']);
  const gift = resolveRuleFact('C15a', '是·贈與信託，董事長贈與子女', OPTS([]));
  assert.deepEqual([gift.state, gift.sub, gift.ev.sub], ['yes', 'giftOrTrust', 'giftOrTrust']);
});

test('同日沿用：同一檔同類別同一組報導、同日同視窗 ⇒ 鍵相同、沿用前一筆的答案（不重問）；換日、換視窗、報導變動 ⇒ 重問', () => {
  const arts = scanOf(ART_3037, '欣興').byCode.C16a;
  const base = { code: '3037', cls: 'C16a', day: TODAY, window: WIN, articles: arts };
  const key = ruleFactKey(base);
  assert.equal(ruleFactKey({ ...base }), key);
  for (const diff of [{ day: '2026-10-08' }, { window: { from: '2026-10-06', to: TODAY } }, { articles: [{ ...arts[0], content: `${arts[0].content}更新` }] }, { cls: 'C17' }, { code: '2367' }]) {
    assert.notEqual(ruleFactKey({ ...base, ...diff }), key, JSON.stringify(Object.keys(diff)));
  }
  const first = resolveRuleFact('C16a', legalAns(), OPTS(arts, { key }));
  const prev = applyRuleFacts(AI(), { facts: { C16a: first } });
  const again = reuseRuleFact(prev, 'C16a', key);
  assert.deepEqual([again.state, again.yes, again.ev.reused, again.ev.eventDate], ['old', false, true, '2026-08-25']);
  assert.equal(reuseRuleFact(prev, 'C16a', 'other-key'), null);
  assert.equal(reuseRuleFact(prev, 'C17', key), null);
  assert.equal(reuseRuleFact(null, 'C16a', key), null);
  // 呼叫失敗（沒回覆）不沿用
  const failed = applyRuleFacts(AI(), { facts: { C16a: resolveRuleFact('C16a', '', OPTS(arts, { key })) } });
  assert.equal(reuseRuleFact(failed, 'C16a', key), null);
  // 沿用的不算題數；計數分開
  assert.deepEqual(ruleAuditCounts({ C16a: again }), { reused: { C16a: 1 } });
  assert.deepEqual(ruleAuditCounts({ C16a: first, C17: resolveRuleFact('C17', null, OPTS([])) }), { asked: { C16a: 1, C17: 1 }, fail: { C17: 1 }, ans: { C16a: { old: 1 } } });
  assert.deepEqual(asReused(first).ev.reused, true);
  assert.equal(first.ev.reused, undefined, '不改原物件');
  // 沿用的「是」再套一次結果相同（同一組報導同日不會一下是、一下否）
  const yesArts = scanOf(ART_NEW, '欣興').byCode.C16a;
  const y = resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-10-06', quote: '調查局今日搜索欣興總部' }), OPTS(yesArts, { key: 'ky' }));
  const pv = applyRuleFacts(AI(), { facts: { C16a: y } });
  const rv = applyRuleFacts(AI(), { facts: { C16a: reuseRuleFact(pv, 'C16a', 'ky') } });
  assert.deepEqual([rv.label, rv.ruleClass, rv.ruleFacts.C16a, rv.ruleEvidence.C16a.reused], ['利空', 'C16a', 'yes', true]);
});

test('延續：首次判定的適用日記進 ruleTrail；之後的適用日在有效期內重複觸發 ⇒ ruleCont；同一適用日重判不是延續；過期 ⇒ 新事件', () => {
  const yesV = applyRuleFacts(AI(), { facts: { C16a: { yes: true, sub: null, state: 'yes', ev: { eventDate: '2026-10-05' } } } });
  const d1 = withRuleTrail(yesV, null, { targetDate: '2026-10-05', contFromYmd: '2026-09-29' });
  assert.deepEqual(d1.ruleTrail, { C16a: { since: '2026-10-05', eventDate: '2026-10-05' } });
  assert.equal(d1.ruleCont, undefined);
  assert.equal(isRuleContinuation(d1), false);
  const sameDay = withRuleTrail(yesV, d1.ruleTrail, { targetDate: '2026-10-05', contFromYmd: '2026-09-29' });
  assert.equal(sameDay.ruleCont, undefined, '同一適用日的重判（晨間→盤中）不是延續');
  const d2 = withRuleTrail(yesV, d1.ruleTrail, { targetDate: '2026-10-06', contFromYmd: '2026-09-30' });
  assert.equal(d2.ruleCont, '2026-10-05');
  assert.equal(isRuleContinuation(d2), true);
  assert.equal(d2.label, '利空', '延續：規則方向不變（仍為利空），只是不當新事件');
  // 中間某次沒觸發（中性、沒問事實）：軌跡照帶，之後再觸發仍是延續
  const quiet = withRuleTrail(AI(), d2.ruleTrail, { targetDate: '2026-10-07', contFromYmd: '2026-10-01' });
  assert.deepEqual([quiet.ruleTrail.C16a.since, quiet.ruleCont], ['2026-10-05', undefined]);
  const d4 = withRuleTrail(yesV, quiet.ruleTrail, { targetDate: '2026-10-08', contFromYmd: '2026-10-02' });
  assert.equal(d4.ruleCont, '2026-10-05');
  // 有效期過了（since < contFrom）⇒ 新事件、新的 since
  const late = withRuleTrail(yesV, quiet.ruleTrail, { targetDate: '2026-10-13', contFromYmd: '2026-10-07' });
  assert.deepEqual([late.ruleTrail.C16a.since, late.ruleCont], ['2026-10-13', undefined]);
  // 舊案（old）不建軌跡；軌跡外的雜項丟掉；輸入不變
  const oldV = applyRuleFacts(AI(), { facts: { C16a: { yes: false, sub: null, state: 'old' } } });
  assert.equal(withRuleTrail(oldV, null, { targetDate: '2026-10-07' }).ruleTrail, undefined);
  assert.deepEqual(withRuleTrail(AI(), { C99: { since: '2026-10-05' }, C17: { since: 'bad' }, C22: { since: '2026-10-09' } }, { targetDate: '2026-10-07' }), AI());
  assert.deepEqual(yesV.ruleTrail, undefined);
  // 延續只看主類別；計數記 cont
  assert.deepEqual(ruleAuditCounts({}, d2), { cont: { C16a: 1 } });
  assert.deepEqual(ruleFieldsOf(d2).ruleCont, '2026-10-05');
  assert.equal(withRuleTrail(yesV, null, { targetDate: 'bad' }), yesV);
});

test('審查修正·3037 迴歸：AI 從舊案背景句挑沒有日期的子字串、說是新進展 ⇒ 仍是舊案（子句寫 8 月 ⇒ clauseDateOut；背景字樣 ⇒ background）', () => {
  const art = { title: '欣興ABF載板需求回溫', at: AT('2026-10-06'), src: '經濟日報', content: '欣興今年8月遭檢調搜索，公司強調營運正常；法人指出ABF載板需求回溫。' };
  const arts = scanOf(art, '欣興').byCode.C16a;
  assert.equal(quoteClauseOf('遭檢調搜索，公司強調營運正常', arts), '欣興今年8月遭檢調搜索，公司強調營運正常');
  assert.equal(quoteClauseOf('不在內文裡的句子喔', arts), null);
  const ans = quote => legalAns({ nd: '是', date: '2026-10-06', quote });
  const own = resolveRuleFact('C16a', ans('欣興今年8月遭檢調搜索'), OPTS(arts));
  assert.deepEqual([own.state, own.ev.why, own.ev.qctx], ['old', 'quoteDateOut', undefined], '引用句自己寫 8 月：沿用原判定');
  for (const quote of ['遭檢調搜索，公司強調營運正常', '檢調搜索，公司強調營運正常']) {
    const f = resolveRuleFact('C16a', ans(quote), OPTS(arts));
    assert.equal(f.ev.quoteOk, true, quote);
    assert.deepEqual([f.state, f.yes, f.ev.isNew, f.ev.why], ['old', false, false, 'clauseDateOut'], quote);
    assert.equal(f.ev.qctx, '欣興今年8月遭檢調搜索，公司強調營運正常');
    assert.equal(applyRuleFacts(AI(), { facts: { C16a: f } }).label, '中性', '不改判');
  }
  // 沒寫日期、但子句帶背景字樣（先前、曾遭、日前曾）而沒有今日／昨日 ⇒ 舊案
  const bgArt = { title: '欣興擴產', at: AT('2026-10-06'), content: '欣興先前遭檢調搜索，公司強調營運正常。另據了解，欣興日前曾遭調查局約談主管，公司未回應。' };
  const bgArts = scanOf(bgArt, '欣興').byCode.C16a;
  const bg = resolveRuleFact('C16a', ans('遭檢調搜索，公司強調營運正常'), OPTS(bgArts));
  assert.deepEqual([bg.state, bg.ev.why, bg.ev.qctx], ['old', 'background', '欣興先前遭檢調搜索，公司強調營運正常']);
  assert.equal(resolveRuleFact('C16a', ans('遭調查局約談主管'), OPTS(bgArts)).ev.why, 'background', '「日前曾」的日前不算相對日子');
  assert.equal(isBackgroundClause('曾姓負責人遭調查局約談'), false, '單獨的「曾」不算');
  assert.equal(isBackgroundClause('調查局今(7)日再度搜索，此前已約談'), false, '有相對日子字樣 ⇒ 不是背景句');
  // 新進展跟在舊案後面、在不同子句：不被同一句前半的舊日期否決（只看子句）
  const nd = { title: '欣興再遭約談', at: AT('2026-10-07'), content: '繼今年8月遭搜索後，調查局今再度約談欣興董事長，公司表示配合。' };
  const f = resolveRuleFact('C16a', ans('調查局今再度約談欣興董事長'), OPTS(scanOf(nd, '欣興').byCode.C16a));
  assert.deepEqual([f.state, f.ev.why, f.ev.qctx], ['yes', undefined, undefined]);
  // 子句裡同時有視窗內與視窗外日期 ⇒ 不否決
  const both = { title: '欣興遭起訴', at: AT('2026-10-07'), content: '欣興8月遭搜索10月6日檢方起訴董事長。' };
  assert.equal(resolveRuleFact('C16a', ans('檢方起訴董事長'), OPTS(scanOf(both, '欣興').byCode.C16a)).state, 'yes');
});

test('審查修正·N2 收窄：沒有 C17 語境的「事故」「爆炸」不吃掉 C16a（理專挪用事故＋搜索仍是 C16a 利空）；C17 報導裡、C17 沒答否 ⇒ acc', () => {
  for (const t of ['事故', '爆炸', '死傷', '傷亡', '理專挪用事故']) assert.equal(ACCIDENT_LINK_RE.test(t), false, t);
  for (const t of ['相驗', '勞檢', '工安', '職災', '火災', '氣爆', '爆炸事故', '業務過失']) assert.equal(ACCIDENT_LINK_RE.test(t), true, t);
  for (const t of ['事故', '爆炸', '死傷', '傷亡']) assert.equal(ACCIDENT_CONTEXT_RE.test(t), true, t);
  const fin = { title: '調查局搜索中信金', at: AT('2026-10-06'), content: '調查局今(6)日搜索中信金總部，偵辦高層涉嫌隱匿理專挪用事故並背信，約談三名主管。' };
  const scan = scanOf(fin, '中信金');
  assert.deepEqual(scan.codes, ['C16a'], 'C17 沒有觸發');
  const f = resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-10-06', quote: '調查局今(6)日搜索中信金總部，偵辦高層涉嫌隱匿理專挪用事故並背信' }), OPTS(scan.byCode.C16a));
  assert.deepEqual([f.state, f.yes], ['yes', true]);
  const facts = reconcileAccident({ C16a: f }, scan.byCode);
  assert.equal(facts.C16a.state, 'yes');
  const v = applyRuleFacts(AI(), { facts });
  assert.deepEqual([v.label, v.ruleClass], ['利空', 'C16a'], '2026-08-29 硬規定：被搜索就是利空');
  // 工安報導裡的較寬字樣：C17 沒答（呼叫失敗）⇒ acc；C17 答「否」（不是本公司的廠）⇒ 照 C16a
  const acc = { title: '燿華廠區爆炸', at: AT('2026-10-06'), content: '燿華宜蘭廠房發生爆炸造成二死三傷，部分產線停工。檢方今日偵辦燿華爆炸造成死傷責任。' };
  const s2 = scanOf(acc, '燿華');
  assert.deepEqual(s2.codes, ['C16a', 'C17']);
  const g = resolveRuleFact('C16a', legalAns({ nd: '是', date: '2026-10-06', quote: '檢方今日偵辦燿華爆炸造成死傷責任' }), OPTS(s2.byCode.C16a));
  assert.equal(g.state, 'yes', '較寬字樣不在 resolveRuleFact 直接判 acc');
  const r1 = reconcileAccident({ C16a: g, C17: resolveRuleFact('C17', null, OPTS(s2.byCode.C17)) }, s2.byCode);
  assert.deepEqual([r1.C16a.state, r1.C16a.ev.why], ['acc', 'accident']);
  assert.equal(reconcileAccident({ C16a: g }, s2.byCode).C16a.state, 'acc', 'C17 沒問（只有觸發）也算 C17 語境');
  const r2 = reconcileAccident({ C16a: g, C17: resolveRuleFact('C17', '否，是客戶的廠', OPTS(s2.byCode.C17)) }, s2.byCode);
  assert.equal(r2.C16a.state, 'yes', 'C17 答否 ⇒ 不吃掉 C16a');
});

test('審查修正·延續只從「被當成新事件」的那次起算：首日沒挑戰過、只是次要類別、label 不是利空、承接 ⇒ 不起算；隔日照新事件', () => {
  const yes16 = { C16a: { yes: true, sub: null, state: 'yes', ev: { eventDate: '2026-10-06' } } };
  const base = applyRuleFacts(AI(), { facts: yes16 });
  assert.equal(ruleTrailEligible(base), true);
  for (const [why, v] of [
    ['沒挑戰過', { ...base, challenged: false }], ['承接', { ...base, carriedFrom: '2026-10-05' }], ['沒讀內文', { ...base, basis: 'title' }],
    ['label 不是利空', applyRuleFacts(AI(), { facts: { C17: { yes: true, sub: null, state: 'yes' } } })], ['沒有規則類別', AI()], ['壞輸入', null],
  ]) assert.equal(ruleTrailEligible(v), false, why);
  // 首日（10/06）挑戰失敗 ⇒ 不起算；隔日（10/07）挑戰過 ⇒ 新事件（since 10/07、不是延續）
  const d1 = withRuleTrail({ ...base, challenged: false }, null, { targetDate: '2026-10-06', contFromYmd: '2026-09-30' });
  assert.deepEqual([d1.ruleTrail, d1.ruleCont], [undefined, undefined]);
  const d2 = withRuleTrail(base, d1.ruleTrail, { targetDate: '2026-10-07', contFromYmd: '2026-10-01' });
  assert.deepEqual([d2.ruleTrail, d2.ruleCont, isRuleContinuation(d2)], [{ C16a: { since: '2026-10-07', eventDate: '2026-10-06' } }, undefined, false]);
  // C23（不收緊）當主類別、C17 只在 ruleHits：C17 不起算；隔日 C17 自己當主類別 ⇒ 新事件
  const c23 = applyRuleFacts(AI({ label: '利空' }), { facts: { C23: { yes: true, sub: null, state: 'yes' }, C17: { yes: true, sub: null, state: 'yes' } } });
  assert.deepEqual([c23.ruleClass, c23.ruleHits], ['C23', ['C17']]);
  const e1 = withRuleTrail(c23, null, { targetDate: '2026-10-06' });
  assert.deepEqual(e1.ruleTrail, { C23: { since: '2026-10-06' } }, '只有主類別起算');
  const c17 = applyRuleFacts(AI({ label: '利空' }), { facts: { C17: { yes: true, sub: null, state: 'yes' } } });
  const e2 = withRuleTrail(c17, e1.ruleTrail, { targetDate: '2026-10-07' });
  assert.deepEqual([e2.ruleCont, e2.ruleTrail.C17, e2.ruleTrail.C23], [undefined, { since: '2026-10-07' }, { since: '2026-10-06' }]);
  // 非法律類別 label 照 AI 原判：AI 判中性的 C17 不起算（推播、Z2 都沒當過新事件），隔日 AI 判利空 ⇒ 新事件
  const n1 = withRuleTrail(applyRuleFacts(AI(), { facts: { C17: { yes: true, sub: null, state: 'yes' } } }), null, { targetDate: '2026-10-06' });
  assert.equal(n1.ruleTrail, undefined);
  assert.equal(withRuleTrail(c17, n1.ruleTrail, { targetDate: '2026-10-07' }).ruleCont, undefined);
});

test('文件大小：verdictJson＋seenJson 逼近上限 ⇒ 先去證據文字欄、再整段拿掉；判別本身不動；沒證據的判別照原物件', () => {
  const ev = { key: 'k', day: TODAY, trig: '檢調', ctx: 'x'.repeat(80), title: 't'.repeat(40), src: '經濟日報', pub: TODAY, ans: 'a'.repeat(60), quote: 'q'.repeat(60), quoteOk: true, eventDate: '2026-08-25', isNew: false, why: 'notNew' };
  const verdicts = { 3037: { ...AI(), ruleFacts: { C16a: 'old' }, ruleEvidence: { C16a: ev } }, 2330: AI() };
  const text = slimRuleEvidence(verdicts, 'text');
  assert.deepEqual(text['3037'].ruleEvidence.C16a, { key: 'k', day: TODAY, trig: '檢調', pub: TODAY, quoteOk: true, eventDate: '2026-08-25', isNew: false, why: 'notNew' });
  assert.equal(text['2330'], verdicts['2330']);
  const all = slimRuleEvidence(verdicts, 'all');
  assert.equal(all['3037'].ruleEvidence, undefined);
  assert.deepEqual(all['3037'].ruleFacts, { C16a: 'old' });
  assert.ok(verdicts['3037'].ruleEvidence.C16a.ctx, '不改輸入');
  assert.equal(fitVerdictJson(verdicts).level, 'full');
  const bytes = o => new TextEncoder().encode(JSON.stringify(o)).length;
  const full = bytes(verdicts);
  const slim = bytes(text);
  assert.equal(fitVerdictJson(verdicts, { maxBytes: slim + 1, otherBytes: 0 }).level, 'text');
  assert.equal(fitVerdictJson(verdicts, { maxBytes: full + 100, otherBytes: 101 }).level, 'text', 'seenJson 的位元組要算進去');
  const r = fitVerdictJson(verdicts, { maxBytes: 10 });
  assert.equal(r.level, 'all');
  assert.ok(r.bytes > 0 && full > slim);
  assert.deepEqual(JSON.parse(r.json)['3037'].ruleFacts, { C16a: 'old' });
});

test('端到端（10/07 裁定）：寫入端欄位 → 停損 ruleBearEvents 只收新進展的 C16a（舊案、延續、工安相驗不收）→ 戰情：涉訟中只是標籤、延續 Z2 降二級、不重複列突發', async () => {
  const { ruleBearEvents, missShadowRows } = await import('./ai-stoploss.mjs');
  const { newsBoardFromDoc, newsCtxOf, majorBearOf, newsLampView, newsShortText, stepMajorBear, majorBearText, LITIGATION_TAG } = await import('./warroom-news.mjs');
  const YMD = '2026-10-07';
  const at = Date.parse(`${YMD}T10:25:00+08:00`);
  const minAtMs = Date.parse('2026-10-06T13:30:00+08:00');
  const write = v => ({
    label: v.label, confidence: v.confidence, strength: v.strength, reason: v.reason, basis: v.basis, n: 3, pass: 'intraday', at,
    challenged: true, gate: null, quoteVerified: 1, eventType: '法律', ...ruleFieldsOf(v),
  });
  const judge = (art, name, answers, prevTrail = null) => {
    const scan = ruleTriggerScan([art], t => t.includes(name), 1200);
    const facts = Object.fromEntries(scan.codes.map(c => [c, resolveRuleFact(c, answers[c] ?? null, OPTS(scan.byCode[c]))]));
    const v = applyRuleFacts(AI(), { facts: reconcileAccident(facts, scan.byCode) });
    return withRuleTrail(v, prevTrail, { targetDate: YMD, contFromYmd: '2026-10-01' });
  };
  const v3037 = judge(ART_3037, '欣興', { C16a: legalAns() });
  const vNew = judge(ART_NEW, '欣興', { C16a: legalAns({ nd: '是', date: '2026-10-06', quote: '調查局今日搜索欣興總部' }) });
  const vCont = judge(ART_NEW, '欣興', { C16a: legalAns({ nd: '是', date: '2026-10-06', quote: '調查局今日搜索欣興總部' }) }, { C16a: { since: '2026-10-06' } });
  const v2367 = judge(ART_2367, '燿華', { C16a: legalAns({ nd: '是', date: '2026-10-07', quote: '新北地檢署檢察官今日到場相驗罹難員工' }), C17: '是，宜蘭廠工安意外' });
  assert.deepEqual([v3037.label, v3037.ruleFacts.C16a, v3037.ruleClass], ['中性', 'old', undefined]);
  assert.deepEqual([vNew.label, vNew.ruleClass, vNew.ruleCont], ['利空', 'C16a', undefined]);
  assert.deepEqual([vCont.label, vCont.ruleClass, vCont.ruleCont], ['利空', 'C16a', '2026-10-06']);
  assert.deepEqual([v2367.label, v2367.ruleClass, v2367.ruleFacts], ['中性', 'C17', { C16a: 'acc', C17: 'yes' }]);
  const verdicts = { 3037: write(v3037), 2330: write(vNew), 2454: write(vCont), 2367: write(v2367) };
  // 單檔寫入是 JSON：證據欄位都能序列化、沒有 undefined
  assert.deepEqual(JSON.parse(JSON.stringify(verdicts)), verdicts);
  const doc = { date: YMD, targetDate: YMD, updatedAt: at + 1000, lastPass: 'intraday', verdictJson: JSON.stringify(verdicts) };
  const evs = ruleBearEvents(doc, { applicableYmd: YMD, minAtMs });
  assert.deepEqual(evs.map(e => [e.code, e.cls]), [['2330', 'C16a'], ['2367', 'C17']], '舊案、延續不收；工安相驗歸 C17');
  const board = newsBoardFromDoc(doc);
  const ctx = newsCtxOf(board.meta, YMD);
  const e3037 = board.map['3037'];
  assert.deepEqual([e3037.st, e3037.lt, e3037.rc, e3037.pl], ['neutral', true, null, false], '涉訟中：燈照 AI 原判（中性），不是規則利空、不標可能為法律事件');
  assert.equal(majorBearOf(e3037, { scope: 'holding', ctx, minAtMs }), null);
  const view = newsLampView(e3037, ctx);
  assert.deepEqual([view.tone, view.litig], ['flat', true]);
  assert.ok(view.title.includes('涉訟中（舊案）'));
  assert.equal(newsShortText(e3037, ctx), `中性·${LITIGATION_TAG}`);
  // AI 自己因舊案背景判利空：燈照 AI（利空、非規則），不進 Z2、不標可能為法律事件
  const bear = newsBoardFromDoc({ ...doc, verdictJson: JSON.stringify({ 3037: { ...write(v3037), label: '利空', reason: '欣興遭檢調搜索' } }) }).map['3037'];
  assert.deepEqual([bear.st, bear.lt, bear.rc, bear.pl], ['bear', true, null, false]);
  assert.equal(majorBearOf(bear, { scope: 'holding', ctx, minAtMs }), null);
  assert.ok(newsShortText(bear, ctx).endsWith(`·${LITIGATION_TAG}`));
  // 延續：仍是規則利空（燈、Z2 條件），但 Z2 降二級「延續」、B2／短字標延續
  const eCont = board.map['2454'];
  assert.deepEqual([eCont.st, eCont.rc, eCont.rf], ['bear', 'C16a', '2026-10-06']);
  const mb = majorBearOf(eCont, { scope: 'holding', ctx, minAtMs });
  assert.equal(mb.level, 1);
  const step = stepMajorBear(null, [{ code: '2454', entry: eCont, mb }, { code: '2330', entry: board.map['2330'], mb: majorBearOf(board.map['2330'], { scope: 'holding', ctx, minAtMs }) }], { targetDate: YMD });
  assert.deepEqual(step.items.map(i => [i.code, i.level, i.cont]), [['2454', 2, true], ['2330', 1, false]]);
  assert.match(majorBearText('2454', '聯發科', step.items[0]), /規則利空延續（10\/06 首次判定的同一事件/);
  assert.match(newsShortText(eCont, ctx), /延續 10\/06$/);
  assert.equal(board.map['2330'].rf, null);
  // 漏網紀錄的原因：大跌時是舊案 ⇒ legalOngoing、延續 ⇒ continuation（供日後量舊案不改判漏掉幾件）
  const bars = c => [{ date: '2026-10-06', o: 100, h: 100, l: 100, c: 100 }, { date: YMD, o: 92, h: 92, l: 90, c: 90 }].map(b => ({ ...b, code: c }));
  const misses = missShadowRows({ universe: ['3037', '2454'], barsByCode: { 3037: bars('3037'), 2454: bars('2454') }, newsDoc: doc, dateYmd: YMD, applicableYmd: YMD, minAtMs });
  assert.deepEqual(misses.map(m => [m.code, m.reason]), [['2454', 'continuation'], ['3037', 'legalOngoing']]);
});

// ── 2026-10-07 N3／N4／N5（使用者「依建議進行」）：延續期內事件日期較晚的新進展＝新事件 ─────────────────────

const yesOn = (ed, over = {}) => applyRuleFacts(AI(over), { facts: { C16a: { yes: true, sub: null, state: 'yes', ev: ed ? { eventDate: ed } : {} } } });

test('N4 事件日期比較（eventDateLater）：整段晚於才算；相同、更早、區間重疊、讀不到、格式不對 ⇒ 否（算延續）', () => {
  assert.deepEqual(eventDateSpan('2026-10-06~2026-10-07'), { lo: '2026-10-06', hi: '2026-10-07' });
  assert.deepEqual(eventDateSpan('2026-10-07'), { lo: '2026-10-07', hi: '2026-10-07' });
  for (const bad of [null, undefined, '', 'bad', '2026/10/07', '2026-10-07~2026-10-06', 20261007]) assert.equal(eventDateSpan(bad), null, String(bad));
  for (const [a, b] of [['2026-10-07', '2026-10-05'], ['2026-10-06~2026-10-07', '2026-10-05'], ['2026-10-08', '2026-10-05~2026-10-07']]) {
    assert.equal(eventDateLater(a, b), true, `${a} > ${b}`);
  }
  for (const [a, b] of [
    ['2026-10-05', '2026-10-05'], ['2026-10-04', '2026-10-05'], ['2026-10-06~2026-10-07', '2026-10-06'], ['2026-10-07', '2026-10-05~2026-10-07'],
    [null, '2026-10-05'], ['2026-10-07', null], ['2026-10-07', undefined], ['bad', '2026-10-05'], ['2026-10-07', 'bad'],
  ]) assert.equal(eventDateLater(a, b), false, `${a} vs ${b}`);
});

test('N4 搜索→兩天後羈押：延續期內事件日期較晚 ⇒ 新事件（不標延續、可推播、軌跡換成新的 since／eventDate、renewOf 記舊日期）；同一事件重報 ⇒ 延續；有效期從新的 since 重算', () => {
  const d1 = withRuleTrail(yesOn('2026-10-05'), null, { targetDate: '2026-10-05', contFromYmd: '2026-09-29' });
  assert.deepEqual(d1.ruleTrail, { C16a: { since: '2026-10-05', eventDate: '2026-10-05' } });
  // 隔日同一件搜索再被報導（事件日期相同）⇒ 延續
  const d2 = withRuleTrail(yesOn('2026-10-05'), d1.ruleTrail, { targetDate: '2026-10-06', contFromYmd: '2026-09-30' });
  assert.deepEqual([d2.ruleCont, isRuleContinuation(d2), isRuleRenewal(d2)], ['2026-10-05', true, false]);
  // 兩天後羈押（事件日期 10/07 晚於軌跡的 10/05）⇒ 新事件
  const d3 = withRuleTrail(yesOn('2026-10-07'), d2.ruleTrail, { targetDate: '2026-10-07', contFromYmd: '2026-10-01' });
  assert.equal(d3.ruleCont, undefined);
  assert.equal(isRuleContinuation(d3), false, '不是延續：推播（完成訊號利空清單、盤中突發）照列、ruleBearEvents 照收');
  assert.equal(isRuleRenewal(d3), true);
  assert.deepEqual(d3.ruleTrail, { C16a: { since: '2026-10-07', eventDate: '2026-10-07', renewOf: '2026-10-05' } });
  assert.deepEqual([d3.label, d3.ruleClass, d3.reason.startsWith(RULE_LEGAL_PREFIX)], ['利空', 'C16a', true], '照既有 C16a 新進展規則改判利空');
  assert.deepEqual(ruleAuditCounts({}, d3), { renew: { C16a: 1 } });
  // 羈押隔日再被報導（同一事件日期）⇒ 延續（自新的 since 起算）；renewOf 不抄
  const d4 = withRuleTrail(yesOn('2026-10-07'), d3.ruleTrail, { targetDate: '2026-10-08', contFromYmd: '2026-10-02' });
  assert.deepEqual([d4.ruleCont, d4.ruleTrail.C16a, isRuleRenewal(d4)], ['2026-10-07', { since: '2026-10-07', eventDate: '2026-10-07' }, false]);
  assert.deepEqual(ruleAuditCounts({}, d4), { cont: { C16a: 1 } });
  // 事件日期更早（又報舊的搜索）⇒ 延續、軌跡不動
  const back = withRuleTrail(yesOn('2026-10-05'), d4.ruleTrail, { targetDate: '2026-10-09', contFromYmd: '2026-10-05' });
  assert.deepEqual([back.ruleCont, back.ruleTrail.C16a.eventDate], ['2026-10-07', '2026-10-07']);
  // 有效期重新起算：原本 10/05 起算的軌跡在 contFrom＝10/06 時已過期，換新後（since 10/07）仍有效
  const later = withRuleTrail(yesOn('2026-10-07'), d4.ruleTrail, { targetDate: '2026-10-12', contFromYmd: '2026-10-06' });
  assert.equal(later.ruleCont, '2026-10-07');
  // 同一適用日的重判帶較晚日期（晨間判到搜索、盤中又出羈押）⇒ 換新但本來就不是延續
  const sameDay = withRuleTrail(yesOn('2026-10-06'), d1.ruleTrail, { targetDate: '2026-10-05', contFromYmd: '2026-09-29' });
  assert.deepEqual([sameDay.ruleCont, sameDay.ruleTrail.C16a], [undefined, { since: '2026-10-05', eventDate: '2026-10-06', renewOf: '2026-10-05' }]);
  // 區間：與軌跡日期重疊 ⇒ 延續；整段晚於 ⇒ 新事件
  assert.equal(withRuleTrail(yesOn('2026-10-05~2026-10-06'), d1.ruleTrail, { targetDate: '2026-10-06' }).ruleCont, '2026-10-05');
  assert.equal(withRuleTrail(yesOn('2026-10-06~2026-10-07'), d1.ruleTrail, { targetDate: '2026-10-07' }).ruleCont, undefined);
  // 輸入不變
  assert.deepEqual(d1.ruleTrail, { C16a: { since: '2026-10-05', eventDate: '2026-10-05' } });
});

test('N4／N5 讀不到事件日期 ⇒ 仍算延續（這筆沒有 eventDate、非 C16a 類別、日期格式不對）；N5 日期讀不出來本來就不改判（舊案）', () => {
  const t1 = { C16a: { since: '2026-10-05', eventDate: '2026-10-05' } };
  for (const v of [yesOn(null), yesOn('bad'), yesOn('10月7日')]) {
    const out = withRuleTrail(v, t1, { targetDate: '2026-10-07', contFromYmd: '2026-10-01' });
    assert.deepEqual([out.ruleCont, out.ruleTrail.C16a, isRuleRenewal(out)], ['2026-10-05', t1.C16a, false], JSON.stringify(v.ruleEvidence));
  }
  // 非法律類別沒有事件日期：照舊延續
  const c17 = applyRuleFacts(AI({ label: '利空' }), { facts: { C17: { yes: true, sub: null, state: 'yes' } } });
  const e1 = withRuleTrail(c17, null, { targetDate: '2026-10-05' });
  assert.deepEqual(e1.ruleTrail, { C17: { since: '2026-10-05' } });
  assert.equal(withRuleTrail(c17, e1.ruleTrail, { targetDate: '2026-10-07' }).ruleCont, '2026-10-05');
  // N5：AI 說是新進展但日期讀不出來 ⇒ 'old'（dateUnknown）＝涉訟中，不改判、不起算、不換新（維持現行，不改程式）
  const arts = scanOf(ART_NEW, '欣興').byCode.C16a;
  const f = resolveRuleFact('C16a', legalAns({ nd: '是', date: '不確定', quote: '調查局今日搜索欣興總部' }), OPTS(arts));
  assert.deepEqual([f.state, f.ev.why], ['old', 'dateUnknown']);
  const v = withRuleTrail(applyRuleFacts(AI(), { facts: { C16a: f } }), t1, { targetDate: '2026-10-07', contFromYmd: '2026-10-01' });
  assert.deepEqual([v.label, v.ruleClass, v.ruleCont, v.ruleTrail], ['中性', undefined, undefined, t1]);
});

test('N4 相容：舊軌跡沒有 eventDate ⇒ 延續並補上這次的事件日期；之後有更晚日期的新進展才算新事件', () => {
  const legacy = { C16a: { since: '2026-10-05' } };
  const c1 = withRuleTrail(yesOn('2026-10-06'), legacy, { targetDate: '2026-10-06', contFromYmd: '2026-09-30' });
  assert.deepEqual([c1.ruleCont, c1.ruleTrail.C16a, isRuleRenewal(c1)], ['2026-10-05', { since: '2026-10-05', eventDate: '2026-10-06' }, false]);
  const c2 = withRuleTrail(yesOn('2026-10-06'), c1.ruleTrail, { targetDate: '2026-10-07', contFromYmd: '2026-10-01' });
  assert.equal(c2.ruleCont, '2026-10-05', '同一個補上的日期 ⇒ 仍延續');
  const c3 = withRuleTrail(yesOn('2026-10-08'), c2.ruleTrail, { targetDate: '2026-10-08', contFromYmd: '2026-10-02' });
  assert.deepEqual([c3.ruleCont, c3.ruleTrail.C16a], [undefined, { since: '2026-10-08', eventDate: '2026-10-08', renewOf: '2026-10-06' }]);
  // 格式不對的舊 eventDate 當沒有（延續＋補上）；這次也讀不到 ⇒ 延續、不補
  const junk = withRuleTrail(yesOn('2026-10-07'), { C16a: { since: '2026-10-05', eventDate: 'x' } }, { targetDate: '2026-10-07', contFromYmd: '2026-10-01' });
  assert.deepEqual([junk.ruleCont, junk.ruleTrail.C16a], ['2026-10-05', { since: '2026-10-05', eventDate: '2026-10-07' }]);
  const none = withRuleTrail(yesOn(null), legacy, { targetDate: '2026-10-07', contFromYmd: '2026-10-01' });
  assert.deepEqual([none.ruleCont, none.ruleTrail.C16a], ['2026-10-05', { since: '2026-10-05' }]);
});

test('N4 較晚的新進展但沒被當成新事件（挑戰失敗、承接）⇒ 不標延續、軌跡不動；隔日挑戰過 ⇒ 換新（同首次起算的取捨）', () => {
  const t1 = { C16a: { since: '2026-10-05', eventDate: '2026-10-05' } };
  const weak = withRuleTrail(yesOn('2026-10-07', { challenged: false }), t1, { targetDate: '2026-10-07', contFromYmd: '2026-10-01' });
  assert.deepEqual([weak.ruleCont, weak.ruleTrail, isRuleRenewal(weak), isRuleContinuation(weak)], [undefined, t1, false, false]);
  const carried = withRuleTrail({ ...yesOn('2026-10-07'), carriedFrom: '2026-10-06' }, t1, { targetDate: '2026-10-07', contFromYmd: '2026-10-01' });
  assert.deepEqual([carried.ruleCont, carried.ruleTrail], [undefined, t1]);
  const next = withRuleTrail(yesOn('2026-10-07'), weak.ruleTrail, { targetDate: '2026-10-08', contFromYmd: '2026-10-02' });
  assert.deepEqual([next.ruleCont, next.ruleTrail.C16a], [undefined, { since: '2026-10-08', eventDate: '2026-10-07', renewOf: '2026-10-05' }]);
  // 停損帶的事件日期：延續軌跡優先、再看稽核軌跡；都沒有 ⇒ null
  assert.equal(ruleEventDateOf(next, 'C16a'), '2026-10-07');
  assert.equal(ruleEventDateOf(yesOn('2026-10-06'), 'C16a'), '2026-10-06');
  assert.equal(ruleEventDateOf({ ...yesOn('2026-10-06'), ruleTrail: { C16a: { since: '2026-10-05', eventDate: '2026-10-05' } } }, 'C16a'), '2026-10-05');
  assert.equal(ruleEventDateOf(yesOn(null), 'C16a'), null);
  assert.equal(ruleEventDateOf(null, 'C16a'), null);
});

test('N4 端到端（搜索→兩天後羈押）：resolveRuleFact 逐字引用＋視窗內日期 → 新事件：完成訊號與盤中突發照列、停損 ruleBearEvents 收（帶新事件日期）、戰情 Z2 依類別權重一級；重報 ⇒ 延續', async () => {
  const { ruleBearEvents } = await import('./ai-stoploss.mjs');
  const { newsBoardFromDoc, newsCtxOf, majorBearOf, stepMajorBear } = await import('./warroom-news.mjs');
  const SEARCH = { title: '調查局搜索欣興總部', at: AT('2026-10-05'), src: '工商時報', content: '調查局今日搜索欣興總部並約談財務主管，欣興表示將配合調查。' };
  const DETAIN = { title: '欣興前財務長遭羈押', at: AT('2026-10-07'), src: '經濟日報', content: '台北地院今日裁定欣興前財務長羈押禁見，全案持續偵辦中，欣興表示營運正常。' };
  const judge = (art, day, from, ans, prevTrail, contFromYmd) => {
    const scan = scanOf(art, '欣興');
    const facts = { C16a: resolveRuleFact('C16a', ans, { articles: scan.byCode.C16a, window: { from, to: day }, todayYmd: day, day, key: day }) };
    return withRuleTrail(applyRuleFacts(AI(), { facts }), prevTrail, { targetDate: day, contFromYmd });
  };
  const ansS = legalAns({ nd: '是', date: '2026-10-05', quote: '調查局今日搜索欣興總部' });
  const d1 = judge(SEARCH, '2026-10-05', '2026-10-02', ansS, null, '2026-09-29');
  const d2 = judge(SEARCH, '2026-10-06', '2026-10-05', ansS, d1.ruleTrail, '2026-09-30');
  const d3 = judge(DETAIN, '2026-10-07', '2026-10-06', legalAns({ nd: '是', date: '2026-10-07', quote: '台北地院今日裁定欣興前財務長羈押禁見' }), d2.ruleTrail, '2026-10-01');
  assert.deepEqual([d1.ruleClass, d1.ruleCont, d2.ruleCont, d3.ruleCont], ['C16a', undefined, '2026-10-05', undefined]);
  assert.deepEqual(d3.ruleTrail.C16a, { since: '2026-10-07', eventDate: '2026-10-07', renewOf: '2026-10-05' });
  // daemon 推播的兩個篩選式（news-rule-daemon-pin 釘住）：完成訊號利空清單、盤中突發
  const pushable = v => v.label === '利空' && !isRuleContinuation(v);
  assert.deepEqual([pushable(d2), pushable(d3)], [false, true]);
  const YMD = '2026-10-07';
  const at = Date.parse(`${YMD}T10:25:00+08:00`);
  const minAtMs = Date.parse('2026-10-06T13:30:00+08:00');
  const write = v => ({ label: v.label, confidence: v.confidence, strength: v.strength, reason: v.reason, basis: v.basis, n: 2, pass: 'intraday', at, challenged: true, gate: null, quoteVerified: 1, eventType: '法律', ...ruleFieldsOf(v) });
  const doc = { date: YMD, targetDate: YMD, updatedAt: at + 1000, lastPass: 'intraday', verdictJson: JSON.stringify({ 3037: write(d3) }) };
  const evs = ruleBearEvents(doc, { applicableYmd: YMD, minAtMs });
  assert.deepEqual(evs.map(e => [e.code, e.cls, e.tier, e.eventDate]), [['3037', 'C16a', 'strong', '2026-10-07']]);
  const board = newsBoardFromDoc(doc);
  const ctx = newsCtxOf(board.meta, YMD);
  const e = board.map['3037'];
  assert.deepEqual([e.st, e.rc, e.rf], ['bear', 'C16a', null]);
  const mb = majorBearOf(e, { scope: 'holding', ctx, minAtMs });
  const step = stepMajorBear(null, [{ code: '3037', entry: e, mb }], { targetDate: YMD });
  assert.deepEqual(step.items.map(i => [i.level, i.cont]), [[1, false]], 'Z2 依類別權重（C16a 0.90）發一級、不降延續');
  // 同一適用日先以延續發過 Z2 二級（前一晚盤後趟或晨間趟重報搜索，帶 rf），盤中羈押換新 ⇒ 照新事件再發一級（seq 2）。
  //   只看等級上升會漏：延續記的等級本來就是一級的 rank，換新不會再發，隔日軌跡換新後又標延續（2026-10-07 審查）。
  const { majorBearEvents, majorBearText } = await import('./warroom-news.mjs');
  for (const [pass, atPrev] of [['evening', Date.parse('2026-10-06T23:00:00+08:00')], ['morning', Date.parse(`${YMD}T07:30:00+08:00`)]]) {
    const dm = judge(SEARCH, YMD, '2026-10-05', ansS, d2.ruleTrail, '2026-10-01');
    assert.deepEqual([dm.ruleClass, dm.ruleCont], ['C16a', '2026-10-05'], pass);
    const dr = judge(DETAIN, YMD, '2026-10-05', legalAns({ nd: '是', date: '2026-10-07', quote: '台北地院今日裁定欣興前財務長羈押禁見' }), dm.ruleTrail, '2026-10-01');
    assert.deepEqual([dr.ruleCont, dr.ruleTrail.C16a.renewOf], [undefined, '2026-10-05'], pass);
    const entryOf = (v, p, t) => {
      const d = { date: YMD, targetDate: YMD, updatedAt: t + 1000, lastPass: p, verdictJson: JSON.stringify({ 3037: { ...write(v), pass: p, at: t } }) };
      const b = newsBoardFromDoc(d);
      const en = b.map['3037'];
      return { code: '3037', entry: en, mb: majorBearOf(en, { scope: 'holding', ctx: newsCtxOf(b.meta, YMD), minAtMs }) };
    };
    const cm = entryOf(dm, pass, atPrev);
    assert.equal(cm.entry.rf, '2026-10-05', pass);
    const s1 = stepMajorBear(null, [cm], { targetDate: YMD });
    assert.deepEqual(s1.items.map(i => [i.level, i.cont, i.seq]), [[2, true, 1]], `${pass}：延續降二級`);
    const ci = entryOf(dr, 'intraday', at);
    const s2 = stepMajorBear(s1.state, [ci], { targetDate: YMD });
    assert.deepEqual([s2.changed, s2.items.map(i => [i.level, i.cont, i.seq])], [true, [[1, false, 2]]], `${pass}：盤中新進展照新事件再發一級`);
    const [ev] = majorBearEvents(s2.items, new Map([['3037', '欣興']]), YMD);
    assert.deepEqual([ev.kind, ev.id], ['majorNegative', `majorNegative:${YMD}:3037:2`], pass);
    assert.doesNotMatch(majorBearText('3037', '欣興', s2.items[0]), /持續|延續/, pass);
    // 重新整理後（同一份 state、同一筆換新）不再重發；之後再送延續條目也不降回二級
    const s3 = stepMajorBear(s2.state, [ci], { targetDate: YMD });
    assert.deepEqual([s3.changed, s3.items.map(i => [i.level, i.seq])], [false, [[1, 2]]], pass);
    const late = { ...cm, entry: { ...cm.entry, at: at + 60_000 } };
    assert.deepEqual(stepMajorBear(s2.state, [late], { targetDate: YMD }).items.map(i => [i.level, i.cont, i.seq]), [[1, false, 2]], pass);
  }
  // 延續之後再來的仍是延續（rf 照帶）⇒ 不再發、維持二級延續
  const contA = { code: '3037', entry: { ...e, rf: '2026-10-05', at: at - 3_600_000, r: '調查局搜索欣興總部' }, mb };
  const contB = { code: '3037', entry: { ...e, rf: '2026-10-05', at, r: '欣興遭搜索後續' }, mb };
  const c1 = stepMajorBear(null, [contA], { targetDate: YMD });
  const c2 = stepMajorBear(c1.state, [contB], { targetDate: YMD });
  assert.deepEqual([c2.changed, c2.items.map(i => [i.level, i.cont, i.seq])], [false, [[2, true, 1]]]);
});
