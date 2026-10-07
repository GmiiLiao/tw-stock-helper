// 規則類利空事件類別與類別權重 單元測試：node --test scripts/lib/news-rule-classes.test.mjs
// 釘住：類別權重＝新聞技能 §4.1 baseWeight（逐列讀技能原文比對）、類別判定只認程式規則覆寫留下的欄位、法律前綴不被其他類別誤用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RULE_BEAR_CLASSES, RULE_CLASS_BY_CODE, RULE_CLASS_BY_KEY, RULE_CLASS_CODES, RULE_LEGAL_PREFIX, ruleClassOf, ruleSubOf, ruleClassesHit,
  classWeightOf, ruleReasonPrefix, ruleFactQuestion, parseRuleFactAnswer, ruleTriggerScan, ruleOverrideReason, VETO_SPAN,
  CLASS_WEIGHT_CUTS, classWeightBand, ruleClassText, applyRuleFacts,
  RULE_VERDICT_FIELDS, ruleFieldsOf, ruleFactAnswered, LABEL_OVERRIDE_CLASS, factStateOf,
} from './news-rule-classes.mjs';
import { isRuleLegal, RULE_LEGAL_PREFIX as WARROOM_PREFIX } from './warroom-news.mjs';
import { STOP_PARAMS } from './ai-stoploss-base.mjs';

// pre-commit 只把 index 的 src/、scripts/ 匯出到暫存目錄（沒有 .claude/）⇒ 技能原文讀不到時只略過「逐列比對技能」這兩例；
// 工作樹（check-test-count、node --test）照常比對。
const SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'skills', 'tw-news-impact-analyst', 'SKILL.md');
const SKILL = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, 'utf8') : null;
const NO_SKILL = SKILL == null ? '讀不到新聞技能原文（pre-commit staged 快照不含 .claude/）' : false;

test('類別權重逐列＝新聞技能 §4.1 的 baseWeight，方向欄標「規則」（技能改了這裡就紅）', { skip: NO_SKILL }, () => {
  for (const c of RULE_BEAR_CLASSES) {
    const row = SKILL.split('\n').find(l => l.startsWith(`| ${c.code} |`));
    assert.ok(row, `技能 §4.1 找不到 ${c.code}`);
    const cols = row.split('|').map(s => s.trim());
    assert.match(cols[4], /規則/, `${c.code} 方向欄不是規則：${cols[4]}`);
    const w = Number(String(cols[5]).split('／')[0]);
    assert.equal(c.weight, w, `${c.code} 類別權重 ${c.weight} ≠ 技能 ${cols[5]}`);
  }
  assert.ok(/贈與或信託轉讓權重降到 0\.05/.test(SKILL));
  assert.equal(classWeightOf('C15a', 'giftOrTrust').weight, 0.05);
  assert.match(classWeightOf('C16a').source, /新聞技能 §4\.1 C16a·先驗·未回測/);
  assert.equal(classWeightOf('C99'), null);
});

test('C23 交易限制：新聞技能明定「排除或加警示，不當成訊號」⇒ tightenEligible＝false；其他規則類利空可收緊', { skip: NO_SKILL }, () => {
  assert.match(SKILL, /\| C23 \|.*不當成訊號/);
  assert.equal(RULE_CLASS_BY_CODE.C23.tightenEligible, false);
  for (const c of RULE_BEAR_CLASSES.filter(x => x.code !== 'C23')) assert.equal(c.tightenEligible, true, c.code);
  assert.equal(RULE_CLASS_BY_KEY['legal-event'].code, 'C16a');
});


test('ruleClassOf：不看 label（2026-10-06 R1）——ruleClass 而且該類事實題答「是」；舊資料 C16a 認 ruleOverride／「【規則】」前綴（須 label 利空）；AI 的 eventType 不算', () => {
  const yes = c => ({ [c]: 'yes' });
  // 新資料：ruleClass＋ruleFacts[ruleClass]==='yes'——非法律類別 daemon 不改 label，所以 label 是 AI 原判（中性／利多／利空／資訊不足）都算
  for (const label of ['利空', '中性', '利多', '資訊不足', undefined]) {
    assert.equal(ruleClassOf({ label, ruleClass: 'C22', ruleFacts: yes('C22') }), 'C22', String(label));
    assert.equal(ruleClassOf({ label, ruleClass: 'C17', ruleOverride: 'accident', ruleFacts: { C17: 'yes', C16b: 'no' } }), 'C17', String(label));
  }
  assert.equal(ruleClassOf({ label: '利空', ruleClass: 'C16a', ruleOverride: 'legal-event', ruleFacts: yes('C16a') }), 'C16a');
  // 沒有該類「是」的 ruleClass 一律不算（事實沒答、答否、答的是別類）
  assert.equal(ruleClassOf({ label: '中性', ruleClass: 'C22' }), null);
  assert.equal(ruleClassOf({ label: '中性', ruleClass: 'C22', ruleFacts: { C22: 'no' } }), null);
  assert.equal(ruleClassOf({ label: '中性', ruleClass: 'C22', ruleFacts: { C22: 'none' } }), null);
  assert.equal(ruleClassOf({ label: '中性', ruleClass: 'C22', ruleFacts: { C17: 'yes' } }), null);
  assert.equal(ruleClassOf({ label: '利空', ruleClass: 'C99', ruleFacts: { C99: 'yes' } }), null);
  // 非法律類別只有 ruleOverride key（沒有 ruleClass＋事實「是」）不算——2026-10-05 前不存在這種資料
  assert.equal(ruleClassOf({ label: '利空', ruleOverride: 'accident' }), null);
  // 舊資料 C16a（2026-08-29 版法律覆寫，當時一定同時把 label 改成利空）：前綴或 legal-event，而且 label 利空
  assert.equal(ruleClassOf({ label: '利空', reason: `${RULE_LEGAL_PREFIX}涉檢調搜索，法律判定前視為利空` }), 'C16a');
  assert.equal(ruleClassOf({ label: '利空', ruleOverride: 'legal-event' }), 'C16a');
  assert.equal(ruleClassOf({ label: '中性', ruleOverride: 'legal-event' }), null, '舊資料的 key 與 label 對不上不認');
  assert.equal(ruleClassOf({ label: '中性', reason: `${RULE_LEGAL_PREFIX}涉檢調搜索` }), null);
  assert.equal(ruleClassOf({ label: '利空', reason: '【規則·財務危機】涉財務危機事件' }), null, '非法律前綴不是舊資料的法律覆寫');
  assert.equal(ruleClassOf({ label: '利空', eventType: '法律', reason: '公司遭搜索' }), null);
  assert.equal(ruleClassOf(null), null);
  assert.equal(ruleSubOf({ label: '中性', ruleClass: 'C15a', ruleSub: 'giftOrTrust', ruleFacts: yes('C15a') }), 'giftOrTrust');
  assert.equal(ruleSubOf({ label: '利空', ruleClass: 'C16a', ruleSub: 'giftOrTrust', ruleFacts: yes('C16a') }), null);
  assert.equal(ruleSubOf({ label: '中性', ruleClass: 'C15a', ruleSub: 'giftOrTrust' }), null, '事實沒答「是」⇒ 沒有類別、也沒有子類別');
});

test('理由前綴：法律沿用「【規則】」；其他類別「【規則·類別名】」，戰情 isRuleLegal 不會把它們當成法律', () => {
  assert.equal(RULE_LEGAL_PREFIX, WARROOM_PREFIX);
  assert.equal(ruleReasonPrefix('C16a'), '【規則】');
  for (const c of RULE_BEAR_CLASSES.filter(x => x.code !== 'C16a')) {
    const p = ruleReasonPrefix(c.code);
    assert.equal(p, `【規則·${c.label}】`);
    assert.equal(isRuleLegal({ label: '利空', reason: `${p}事實說明` }), false, c.code);
    assert.equal(ruleClassOf({ label: '中性', reason: `${p}事實說明`, ruleClass: c.code, ruleFacts: { [c.code]: 'yes' } }), c.code);
  }
  assert.equal(ruleReasonPrefix('nope'), '');
});


test('觸發字只觸發提問（不決定方向）：命中回類別、依表內順序', () => {
  assert.deepEqual(ruleClassesHit('檢調今日搜索公司總部'), ['C16a']);
  assert.ok(ruleClassesHit('廠區昨晚發生火災，部分產線停工').includes('C17'));
  assert.ok(ruleClassesHit('會計師出具保留意見').includes('C22'));
  assert.ok(ruleClassesHit('遭金管會裁罰新台幣 300 萬元').includes('C16b'));
  assert.ok(ruleClassesHit('中華信評將其評等展望調降為負向').includes('C20b'));
  assert.ok(ruleClassesHit('惠譽調降其信用評等至 BBB').includes('C20b'));
  assert.ok(ruleClassesHit('公司向法院聲請重整').includes('C22'));
  assert.ok(ruleClassesHit('金管會介入調查內線交易').includes('C16a'));
  assert.ok(ruleClassesHit('調查局約談董事長').includes('C16a'));
  assert.ok(ruleClassesHit('新竹廠發生爆炸，產線停工').includes('C17'));
  assert.deepEqual(ruleClassesHit('營收創新高'), []);
});

test('觸發字反例（2026-10-05 審查）：市調、組織重整、歲修、產品停產、比喻用語、券商評等與目標價都不觸發', () => {
  for (const t of [
    '根據 TrendForce 調查，南亞科第三季 DRAM 營收季增 20%', '研調機構調查顯示', '問卷調查結果出爐', '搜索引擎廣告營收成長',
    '公司進行組織重整', '重整旗鼓再出發', '會計師出具無保留意見',
    '台塑化麥寮廠進行年度歲修停機', '美光宣布 DDR4 停產，南亞科受惠', 'AI 需求爆炸性成長',
    '摩根士丹利調降台積電評等至中立', '高盛將聯發科評等降至中立', '外資下調目標價與評等', '券商調降目標價',
    'S&P 500 指數下調', '標普 500 下調成分股權重',
  ]) assert.deepEqual(ruleClassesHit(t), [], t);
  // veto 只看命中處附近：同篇另一處真的有信評調降仍觸發
  const far = `外資調降目標價${'。'.repeat(VETO_SPAN + 5)}惠譽調降其信用評等至 BBB`;
  assert.ok(ruleClassesHit(far).includes('C20b'));
});

test('ruleTriggerScan：只收與本檔同時出現、命中該類別的報導；只看內文前 maxChars 字；依表內順序', () => {
  const arts = [
    { title: '鴻海廠區火災', content: '鴻海今日廠區起火，部分產線停工' },
    { title: '同業新聞', content: '某公司遭檢調搜索' },              // 沒提到本檔 ⇒ 不收
    { title: '鴻海訴訟', content: `${'x'.repeat(50)}鴻海遭控侵權，為被告` },
    { title: '鴻海', content: `${'y'.repeat(60)}遭檢調搜索` },        // 法律字樣在 maxChars 之外 ⇒ 不收
  ];
  const r = ruleTriggerScan(arts, t => t.includes('鴻海'), 55);
  assert.deepEqual(r.codes, ['C17', 'C16b']);
  assert.deepEqual(r.byCode.C17.map(a => a.title), ['鴻海廠區火災']);
  assert.ok(r.byCode.C16b[0].content.length <= 55);
  assert.deepEqual(ruleTriggerScan(null, () => true), { codes: [], byCode: {} });
});

test('事實提問：代入公司名、內文截 maxChars（預設 400）；寫明不算的情形與「不確定」', () => {
  const q = ruleFactQuestion('C17', { code: '2317', name: '鴻海' }, [{ title: '廠區火災', content: 'x'.repeat(1300) }]);
  assert.ok(q.includes('鴻海') && q.includes('只回：「是」或「否」') && q.includes('不確定'));
  assert.ok(!q.includes('{name}'));
  assert.ok(q.includes('x'.repeat(400)) && !q.includes('x'.repeat(401)));
  const q2 = ruleFactQuestion('C17', { code: '2317', name: '鴻海' }, [{ title: '廠區火災', content: 'x'.repeat(1300) }], { maxChars: 1200 });
  assert.ok(q2.includes('x'.repeat(1200)) && !q2.includes('x'.repeat(1201)));
  assert.ok(RULE_CLASS_BY_CODE.C16a.fact.includes('市調'));
  assert.ok(RULE_CLASS_BY_CODE.C22.fact.includes('組織調整'));
  assert.ok(RULE_CLASS_BY_CODE.C17.fact.includes('計畫性歲修') && RULE_CLASS_BY_CODE.C17.fact.includes('爆炸性成長'));
  assert.ok(RULE_CLASS_BY_CODE.C20b.fact.includes('券商或外資調降投資評等'));
  assert.equal(ruleFactQuestion('C99', { code: '1', name: 'x' }, []), '');
});

test('事實回答解析：只看開頭的是／否；「是否…」「是不是」、不確定、空白 ⇒ null（未答，不猜）；粗體與引號先去掉；C15a 子類別', () => {
  const Y = { yes: true, sub: null };
  const N = { yes: false, sub: null };
  for (const a of ['是', '是。', '是，火災發生在本公司廠區', '是的，對象為本公司', '「是」', '**是**，對象為董事長', '是 對象為本公司']) {
    assert.deepEqual(parseRuleFactAnswer('C17', a), Y, a);
  }
  for (const a of ['否', '否，是供應商', '不是', '非']) assert.deepEqual(parseRuleFactAnswer('C17', a), N, a);
  for (const a of ['是否為檢調不確定', '是不是本公司無法判斷', '不確定', '', null, '非常確定', '本公司是被告', '是本公司']) {
    assert.equal(parseRuleFactAnswer('C17', a), null, String(a));
  }
  assert.deepEqual(parseRuleFactAnswer('C15a', '是·贈與信託，董事長贈與子女'), { yes: true, sub: 'giftOrTrust' });
  assert.deepEqual(parseRuleFactAnswer('C15a', '是·一般'), Y);
});

test('類別權重分級：切點與停損 STOP_PARAMS.eventTiers 同值；C16a、C23、C22、C13b、C17 高，C16b、C15a 中，其餘與 C15a 贈與信託低', () => {
  assert.deepEqual([CLASS_WEIGHT_CUTS.high, CLASS_WEIGHT_CUTS.mid], STOP_PARAMS.eventTiers.map(t => t.minWeight));
  const band = Object.fromEntries(RULE_CLASS_CODES.map(c => [c, classWeightBand(c)]));
  assert.deepEqual(band, { C16a: 'high', C23: 'high', C22: 'high', C13b: 'high', C17: 'high', C16b: 'mid', C15a: 'mid', C11a: 'low', C15c: 'low', C20b: 'low' });
  assert.equal(classWeightBand('C15a', 'giftOrTrust'), 'low');
  assert.equal(classWeightBand('C99'), null);
  assert.equal(ruleClassText('C16a'), '法律事件（法律判定前視為利空）');
  assert.equal(ruleClassText('C17'), '工安停工');
  assert.equal(ruleClassText('X'), null);
});


const AI = (over = {}) => ({ label: '中性', bullish: false, confidence: '低', strength: '弱', reason: '公司聲明營運正常。其餘略', basis: 'content', ...over });
const Y = { yes: true, sub: null };
const N = { yes: false, sub: null };

test('applyRuleFacts：沒問任何類別 ⇒ 原物件；問了沒有「是」⇒ 只記 ruleFacts；不改輸入', () => {
  const v = AI();
  assert.equal(applyRuleFacts(v, {}), v);
  assert.equal(applyRuleFacts(v), v);
  assert.equal(applyRuleFacts(v, { facts: { C99: Y } }), v, '未知類別不算');
  const r = applyRuleFacts(v, { facts: { C17: N, C16b: null } });
  assert.deepEqual(r, { ...v, ruleFacts: { C17: 'no', C16b: 'none' } });
  assert.deepEqual(v, AI(), '輸入不變');
});

test('applyRuleFacts：C16a「是」、AI 原判不是利空 ⇒ label 由程式覆寫為利空（§10A.2-3；2026-08-29 起的既有行為）', () => {
  for (const label of ['中性', '利多', '資訊不足']) {
    const v = AI({ label, bullish: label === '利多' });
    const r = applyRuleFacts(v, { facts: { C16a: Y } });
    assert.equal(r.label, '利空', label);
    assert.equal(r.bullish, false);
    assert.equal(r.confidence, '中', '信心「低」升「中」（同 2026-08-29 版）');
    assert.ok(r.reason.startsWith(ruleReasonPrefix('C16a')), r.reason);
    assert.ok(r.reason.endsWith(`（AI 原判${label}：公司聲明營運正常）`), r.reason);
    assert.equal(r.ruleClass, 'C16a');
    assert.equal(r.ruleOverride, 'legal-event');
    assert.deepEqual(r.aiOriginal, { label, reason: '公司聲明營運正常' });
    assert.equal(ruleClassOf(r), 'C16a');
    assert.deepEqual(v, AI({ label, bullish: label === '利多' }), '輸入不變');
  }
  assert.equal(LABEL_OVERRIDE_CLASS, 'C16a');
});

test('applyRuleFacts：非法律類別「是」（2026-10-06 R1）⇒ 只記規則欄位，label／bullish／confidence／reason 一律維持 AI 原判', () => {
  for (const label of ['中性', '利多', '利空', '資訊不足']) {
    for (const c of RULE_CLASS_CODES.filter(x => x !== 'C16a')) {
      const v = AI({ label, bullish: label === '利多' });
      const r = applyRuleFacts(v, { facts: { [c]: Y } });
      assert.equal(r.label, label, `${label} ${c}：label 不覆寫（連動推薦排序、個股評分、做空候選、squeeze-train）`);
      assert.equal(r.bullish, label === '利多');
      assert.equal(r.confidence, '低');
      assert.equal(r.reason, v.reason);
      assert.equal(r.ruleClass, c);
      assert.equal(r.ruleOverride, RULE_CLASS_BY_CODE[c].key);
      assert.deepEqual(r.ruleFacts, { [c]: 'yes' });
      assert.deepEqual(r.aiOriginal, { label, reason: '公司聲明營運正常' });
      assert.equal(ruleClassOf(r), c, '停損收緊與戰情仍辨識為規則類利空（讀規則欄位，不看 label）');
      assert.deepEqual(v, AI({ label, bullish: label === '利多' }), '輸入不變');
    }
  }
  assert.equal(applyRuleFacts(AI({ confidence: '高' }), { facts: { C17: Y } }).confidence, '高');
});

test('applyRuleFacts：C16a 覆寫的理由與信心與 2026-08-29 版逐字相同（硬規定「涉法律事件一律利空」）', () => {
  const r = applyRuleFacts(AI(), { facts: { C16a: Y } });
  assert.equal(r.reason, `${RULE_LEGAL_PREFIX}涉檢調搜索，法律判定前視為利空（AI 原判中性：公司聲明營運正常）`);
  assert.equal(r.ruleOverride, 'legal-event');
  assert.equal(isRuleLegal(r), true);
  assert.equal(ruleOverrideReason('C22', AI()), '【規則·財務危機】涉財務危機事件，依規則視為利空（AI 原判中性：公司聲明營運正常）');
  assert.equal(ruleOverrideReason('C99', AI()), '');
  // 引用強制未過（gate E、label 中性）也照覆寫（AI 只認定事實、方向由規則定；戰情 isAiRead 對規則類放行）
  const e = applyRuleFacts(AI({ gate: 'E-引用強制', reason: '引用強制未過：無法從原文逐字引出支撐此判別的句子' }), { facts: { C16a: Y } });
  assert.equal(e.label, '利空');
  assert.equal(e.gate, 'E-引用強制');
});

test('applyRuleFacts：AI 原判已是利空（漏網修正）⇒ 只補欄位，label、理由、信心都不改', () => {
  const v = AI({ label: '利空', reason: '檢調搜索公司總部，營運風險升高', confidence: '高' });
  const r = applyRuleFacts(v, { facts: { C16a: Y } });
  assert.equal(r.label, '利空');
  assert.equal(r.reason, v.reason);
  assert.equal(r.confidence, '高');
  assert.equal(r.ruleClass, 'C16a');
  assert.equal(r.ruleOverride, 'legal-event');
  assert.deepEqual(r.aiOriginal, { label: '利空', reason: '檢調搜索公司總部，營運風險升高' });
  assert.equal(isRuleLegal(r), true);
});

test('applyRuleFacts：「否」、沒答 ⇒ 維持 AI 原判，不猜（label 不動、沒有 ruleClass）', () => {
  for (const label of ['中性', '利多', '利空']) {
    for (const c of RULE_CLASS_CODES) {
      for (const ans of [N, null]) {
        const r = applyRuleFacts(AI({ label }), { facts: { [c]: ans } });
        assert.equal(r.label, label, `${label} ${c} ${JSON.stringify(ans)}`);
        assert.equal(r.ruleClass, undefined);
        assert.equal(r.reason, AI().reason);
      }
    }
  }
});

test('applyRuleFacts：多類「是」取類別權重最高者（同權重依表內順序），其餘記 ruleHits；C15a 子類別權重參與比較', () => {
  const r = applyRuleFacts(AI(), { facts: { C16b: Y, C17: Y, C20b: N } });
  assert.deepEqual([r.ruleClass, r.ruleHits], ['C17', ['C16b']]);
  assert.deepEqual([r.label, r.reason], ['中性', AI().reason], '非法律類別不改 label 與理由（R1）');
  const legal = applyRuleFacts(AI(), { facts: { C17: Y, C16a: Y } });
  assert.deepEqual([legal.ruleClass, legal.ruleHits, legal.label], ['C16a', ['C17'], '利空'], '同時有法律「是」⇒ C16a 為主、照覆寫');
  const tie = applyRuleFacts(AI(), { facts: { C23: Y, C16a: Y } });
  assert.deepEqual([tie.ruleClass, tie.ruleHits], ['C16a', ['C23']]);
  const gift = applyRuleFacts(AI(), { facts: { C15a: { yes: true, sub: 'giftOrTrust' }, C11a: Y } });
  assert.deepEqual([gift.ruleClass, gift.ruleSub, gift.ruleHits], ['C11a', undefined, ['C15a']]);
  const plain = applyRuleFacts(AI(), { facts: { C15a: Y, C11a: Y } });
  assert.deepEqual([plain.ruleClass, plain.ruleHits], ['C15a', ['C11a']]);
  const onlyGift = applyRuleFacts(AI(), { facts: { C15a: { yes: true, sub: 'giftOrTrust' } } });
  assert.deepEqual([onlyGift.ruleClass, onlyGift.ruleSub], ['C15a', 'giftOrTrust']);
  assert.equal(ruleSubOf(onlyGift), 'giftOrTrust');
});

test('ruleFieldsOf：三個寫入端共用，只回有值的規則欄位；不含 undefined（Firestore 不收）', () => {
  const r = applyRuleFacts(AI(), { facts: { C17: Y, C16b: Y } });
  const f = ruleFieldsOf({ ...r, foo: 1, ruleSub: null });
  assert.deepEqual(Object.keys(f).sort(), ['aiOriginal', 'ruleClass', 'ruleFacts', 'ruleHits', 'ruleOverride']);
  assert.ok(Object.keys(f).every(k => RULE_VERDICT_FIELDS.includes(k)));
  assert.ok(Object.values(f).every(x => x !== undefined));
  assert.deepEqual(JSON.parse(JSON.stringify(f)), f);
  assert.deepEqual(ruleFieldsOf(AI()), {});
  assert.deepEqual(ruleFieldsOf(null), {});
});

test('ruleFactAnswered：讀 ruleFacts（舊資料的 ruleFocused 仍認得）；none、沒問 ⇒ false', () => {
  assert.equal(ruleFactAnswered({ ruleFacts: { C16a: 'no' } }, 'C16a'), true);
  assert.equal(ruleFactAnswered({ ruleFacts: { C16a: 'none' } }, 'C16a'), false);
  assert.equal(ruleFactAnswered({ ruleFacts: { C16a: 'none' }, ruleFocused: 'no' }, 'C16a'), true);
  assert.equal(ruleFactAnswered({ ruleFocused: 'yes' }, 'C17'), false);
  assert.equal(ruleFactAnswered({}, 'C16a'), false);
  assert.equal(ruleFactAnswered(null, 'C16a'), false);
});

test('端到端（2026-10-06 R1）：daemon 判定（AI 判中性、事實 C17 是）→ label 維持中性、只記規則欄位 → 寫入端欄位 → 停損 ruleBearEvents 與戰情同一個類別；C16a 照舊覆寫', async () => {
  const { ruleBearEvents } = await import('./ai-stoploss.mjs');
  const { newsBoardFromDoc, newsCtxOf, majorBearOf, newsLampView } = await import('./warroom-news.mjs');
  const YMD = '2026-10-05';
  const at = Date.parse(`${YMD}T10:25:00+08:00`);
  const minAtMs = Date.parse('2026-10-02T13:30:00+08:00');
  const judged = (label, facts) => applyRuleFacts({ label, bullish: label === '利多', confidence: '中', strength: '中', reason: 'AI 理由', basis: 'content', challenged: true, quoteVerified: 1 }, { facts });
  // 盤中寫入端的形狀（只取它存的欄位＋ruleFieldsOf）
  const write = v => ({
    label: v.label, confidence: v.confidence, strength: v.strength, reason: v.reason, basis: v.basis, n: 3, pass: 'intraday', at,
    challenged: !!v.challenged, gate: v.gate || null, quoteVerified: v.quoteVerified ?? null, ...ruleFieldsOf(v),
  });
  const verdicts = {
    2317: write(judged('中性', { C17: { yes: true, sub: null } })),
    2330: write(judged('利空', { C20b: { yes: true, sub: null } })),
    2454: write(judged('利空', { C16a: { yes: false, sub: null } })),
    2603: write(judged('利多', { C22: { yes: true, sub: null } })),
    3037: write(judged('中性', { C16a: { yes: true, sub: null } })),
  };
  // newsVerdict 的 label（推薦排序、個股評分、做空候選、squeeze-train 讀的欄位）維持 AI 原判；只有法律類覆寫
  assert.deepEqual([verdicts['2317'].label, verdicts['2317'].reason], ['中性', 'AI 理由'], '非法律類別 label 與理由不覆寫（R1）');
  assert.deepEqual([verdicts['2603'].label, verdicts['2603'].ruleClass], ['利多', 'C22']);
  assert.equal(verdicts['3037'].label, '利空', '法律類 C16a 照舊由程式覆寫為利空');
  assert.ok(verdicts['3037'].reason.startsWith(RULE_LEGAL_PREFIX));
  const doc = { date: YMD, targetDate: YMD, updatedAt: at + 1000, lastPass: 'intraday', verdictJson: JSON.stringify(verdicts) };
  const evs = ruleBearEvents(doc, { applicableYmd: YMD, minAtMs });
  assert.deepEqual(evs.map(e => [e.code, e.cls, e.tier, e.weight]), [
    ['2317', 'C17', 'strong', 0.7], ['2330', 'C20b', 'none', 0.15], ['2603', 'C22', 'strong', 0.85], ['3037', 'C16a', 'strong', 0.9],
  ], '停損收緊辨識規則類利空（不看 label）');
  const board = newsBoardFromDoc(doc);
  const ctx = newsCtxOf(board.meta, YMD);
  assert.deepEqual(majorBearOf(board.map['2317'], { scope: 'holding', ctx, minAtMs }), { level: 1, basis: 'rule-class', scope: 'holding', cls: 'C17', band: 'high' });
  assert.deepEqual([board.map['2317'].st, board.map['2317'].rc, board.map['2317'].ra], ['bear', 'C17', '中性'], '戰情燈：規則類利空、AI 原判中性');
  assert.deepEqual([board.map['2603'].st, board.map['2603'].ra, board.map['2603'].w], ['bear', '利多', null], 'AI 原判利多的 w 不顯示在規則利空燈上');
  assert.equal(newsLampView(board.map['2317'], ctx).rule, '工安停工');
  assert.equal(majorBearOf(board.map['3037'], { scope: 'holding', ctx, minAtMs }).basis, 'rule-legal');
  assert.equal(majorBearOf(board.map['2330'], { scope: 'holding', ctx, minAtMs }), null);
  assert.equal(board.map['2454'].rc, null);
  assert.equal(board.map['2454'].pl, false, '法律事實答否 ⇒ 不標「可能為法律事件」');
});

test('2026-10-07 N1(b)／N2：ruleFacts 新增 old（C16a 舊案·涉訟中）與 acc（工安事故調查）——都不是「是」、不改 label、但算已回答；新欄位走 ruleFieldsOf', () => {
  assert.equal(factStateOf(null), 'none');
  assert.equal(factStateOf({ yes: true, sub: null }), 'yes');
  assert.equal(factStateOf({ yes: false, sub: null }), 'no');
  assert.equal(factStateOf({ yes: false, sub: null, state: 'old' }), 'old');
  assert.equal(factStateOf({ yes: true, sub: null, state: 'bogus' }), 'yes', '不認得的 state 退回 yes／no');
  for (const st of ['old', 'acc']) {
    const r = applyRuleFacts(AI(), { facts: { C16a: { yes: false, sub: null, state: st, ev: { why: st } }, C17: N } });
    assert.deepEqual([r.label, r.reason, r.ruleClass, r.ruleFacts], ['中性', AI().reason, undefined, { C16a: st, C17: 'no' }], st);
    assert.deepEqual(r.ruleEvidence, { C16a: { why: st } });
    assert.equal(ruleClassOf(r), null);
    assert.equal(ruleFactAnswered(r, 'C16a'), true);
    assert.equal(isRuleLegal(r), false);
  }
  // 只有 state 'yes' 的 C16a 才覆寫（舊格式 { yes:true } 照舊）
  assert.equal(applyRuleFacts(AI(), { facts: { C16a: { yes: true, sub: null, state: 'yes' } } }).label, '利空');
  assert.equal(applyRuleFacts(AI(), { facts: { C16a: { yes: true, sub: null, state: 'old' } } }).label, '中性', 'state 優先於 yes');
  assert.ok(['ruleEvidence', 'ruleTrail', 'ruleCont'].every(k => RULE_VERDICT_FIELDS.includes(k)));
  const f = ruleFieldsOf({ ruleFacts: { C16a: 'old' }, ruleEvidence: { C16a: { why: 'notNew' } }, ruleTrail: { C16a: { since: '2026-10-05' } }, ruleCont: '2026-10-05', other: 1 });
  assert.deepEqual(Object.keys(f).sort(), ['ruleCont', 'ruleEvidence', 'ruleFacts', 'ruleTrail']);
  assert.ok(RULE_CLASS_BY_CODE.C16a.fact.includes('檢察官相驗') && RULE_CLASS_BY_CODE.C16a.fact.includes('業務過失偵查'));
});
