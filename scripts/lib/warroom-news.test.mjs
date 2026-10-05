// 盤中戰情 v2·新聞判別（權重沿用 rankMediaVerdicts）單元測試：node --test scripts/lib/warroom-news.test.mjs
// 對照 news-weight.md §3.11 必測案例 1–10，以及 tw-news-impact-analyst §0／§1.1／1.4／1.5／1.6／§2／§6.2 的程式強制。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankMediaVerdicts } from './after-market-news.mjs';
import {
  newsBoardFromDoc, verdictState, isAiRead, isRuleLegal, newsTier, newsCtxOf, isCurrentEntry, isNewsUniverse,
  newsLampView, newsShortText, newsWeightText, newsKpi, majorBearOf, stepMajorBear, parseMajorBearState, initialMajorBearState,
  majorBearEvents, majorBearText, b2MarketNewsEvents, activeNewsCodes, mineNewsEvents, premarketNewsRows, newsHealthOf,
  newsTimeTag, quoteHash, NEWS_WEIGHT_NOTE, WEIGHT_GATE_LEVEL, RULE_LEGAL_PREFIX, GATE_D, GATE_E,
  isPossibleLegalBear, isUnchallengedEntry, UNCHALLENGED_TAG, UNCHALLENGED_NOTE, POSSIBLE_LEGAL_NOTE,
} from './warroom-news.mjs';

const YMD = '2026-10-05';
const T = (h, m = 0) => Date.parse(`${YMD}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
const PREV_CLOSE = Date.parse('2026-10-02T13:30:00+08:00');   // 上一交易日（週五）13:30
const NOW = T(10, 40);

/** AI 讀完內文、走過挑戰的判別（預設：利空·強·高·已確認·首次·未反映 ⇒ w 0.75） */
const V = (over = {}) => ({
  label: '利空', strength: '強', confidence: '高', certainty: '已確認', novelty: '首次', priced: '否',
  eventType: '訂單', basis: 'content', challenged: true, at: T(10, 25), pass: 'intraday', n: 3,
  reason: '主要客戶抽單，第四季出貨下修', keyQuote: '客戶通知第四季訂單取消三成', quoteVerified: 2, quoteFailed: 0,
  revision: '挑戰後維持利空，金額占營收 6%', ...over,
});
const docOf = (verdicts, extra = {}) => ({
  date: YMD, targetDate: YMD, updatedAt: T(10, 26), lastPass: 'intraday', verdictJson: JSON.stringify(verdicts), ...extra,
});
const board = (verdicts, extra) => newsBoardFromDoc(docOf(verdicts, extra));
const CTX = newsCtxOf({ targetDate: YMD }, YMD);
const OPT = { ctx: CTX, minAtMs: PREV_CLOSE };

test('權重與盤後報告同一支 rankMediaVerdicts（同名同口徑；不另算）', () => {
  const verdicts = {
    2317: V(),
    3231: V({ label: '利多', confidence: '中' }),
    2330: V({ label: '利多', strength: '中', certainty: '預期', novelty: '重複', priced: '不確定' }),
  };
  const b = board(verdicts);
  const ref = Object.fromEntries(rankMediaVerdicts(verdicts, { limit: 99 }).items.map((x) => [x.code, x.weight]));
  for (const code of Object.keys(verdicts)) assert.equal(b.map[code].w, ref[code]);
  assert.equal(b.map['2317'].w, 0.75);
  assert.equal(b.map['3231'].w, 0.525);
  assert.equal(b.meta.targetDate, YMD);
  assert.equal(b.meta.lastPass, 'intraday');
  assert.equal(b.meta.covered, 3);
});

test('案例 1：利空·強·高·已確認·首次·未反映 → w 0.75、強；持股 Z2 條件成立（權重門檻待裁定前級別＝WEIGHT_GATE_LEVEL）', () => {
  const e = board({ 2317: V() }).map['2317'];
  assert.equal(newsTier(e.w), 'strong');
  const v = newsLampView(e, CTX);
  assert.equal(v.tone, 'dn');
  assert.equal(v.tier, 'strong');
  assert.ok(v.title.includes('利空·強') && v.title.includes(NEWS_WEIGHT_NOTE));
  assert.deepEqual(majorBearOf(e, OPT), { level: WEIGHT_GATE_LEVEL, basis: 'weight', scope: 'holding' });
  assert.equal(WEIGHT_GATE_LEVEL, 2);   // §6.5：未校準權重不決定一級名單，待使用者裁定
});

test('案例 2：利空·強·中（0.525）→ 中，不達重大利空', () => {
  const e = board({ 2317: V({ confidence: '中' }) }).map['2317'];
  assert.equal(newsTier(e.w), 'mid');
  assert.equal(majorBearOf(e, OPT), null);
});

test('案例 3：規則法律 w 0.18、走過挑戰 → 一級（不看權重）；沒走挑戰 → 燈仍利空但不進 Z2', () => {
  const legal = V({
    strength: '中', confidence: '低', reason: `${RULE_LEGAL_PREFIX}涉檢調搜索，法律判定前視為利空（AI 原判中性：公司聲明營運正常）`,
    gate: GATE_E, eventType: '法律',
  });
  const e = board({ 3037: legal }).map['3037'];
  assert.equal(e.st, 'bear');
  assert.equal(e.lg, true);
  assert.equal(e.w, 0.18);
  assert.deepEqual(majorBearOf(e, OPT), { level: 1, basis: 'rule-legal', scope: 'holding' });
  const e2 = board({ 3037: { ...legal, challenged: false } }).map['3037'];
  assert.equal(newsLampView(e2, CTX).tone, 'dn');
  assert.equal(majorBearOf(e2, OPT), null);
  // ruleOverride 欄位（軋空／漲停名單的完整 verdict 有存）同樣認得
  assert.equal(isRuleLegal({ label: '利空', ruleOverride: 'legal-event', reason: '' }), true);
});

test('案例 4：eventType=法律 但 AI 判利多（和解金類）→ 燈照 AI 判的利多，不改判', () => {
  const e = board({ 4123: V({ label: '利多', eventType: '法律', reason: '專利訴訟和解取得授權金', keyQuote: '雙方和解，對方支付授權金' }) }).map['4123'];
  assert.equal(e.st, 'bull');
  assert.equal(e.lg, false);
  assert.equal(newsLampView(e, CTX).tone, 'up');
  // eventType=法律 的利空、w≥0.3：屬權重門檻類（legal-type），不是規則覆寫
  const e2 = board({ 4123: V({ eventType: '法律', confidence: '低', strength: '極強' }) }).map['4123'];
  assert.equal(e2.w, 0.4);
  assert.equal(majorBearOf(e2, OPT).basis, 'legal-type');
  assert.equal(majorBearOf(e2, OPT).level, WEIGHT_GATE_LEVEL);
});

test('案例 5（§1.1／1.3／1.8）：D 拒答、只有標題、E 引用未過 → 資訊不足空心、權重 0；中性＋AI 未回應 → 未判別', () => {
  const b = board({
    1101: V({ gate: GATE_D, label: '資訊不足' }),
    1102: V({ basis: 'title' }),
    1103: V({ label: '中性', gate: GATE_E, reason: '引用強制未過：無法從原文逐字引出支撐此判別的句子' }),
    1104: { label: '中性', confidence: '低', reason: 'AI 判別未回應，保守視為中性', basis: 'content', at: T(9, 0) },
    1105: V({ gate: GATE_D }),
  });
  for (const c of ['1101', '1102', '1103', '1105']) {
    assert.equal(b.map[c].st, 'insufficient', c);
    assert.equal(b.map[c].w, null, c);
    assert.equal(newsLampView(b.map[c], CTX).tone, 'none', c);
    assert.equal(majorBearOf(b.map[c], OPT), null, c);
  }
  assert.equal(b.map['1104'].st, 'unjudged');
  assert.equal(newsLampView(b.map['1104'], CTX).label, '未判別');
  assert.equal(isAiRead(V({ basis: 'title' })), false);
  // 沒有條目＝未判別
  assert.equal(newsLampView(undefined, CTX).label, '未判別');
});

test('案例 6（§2 媒體時效 ≤1 交易日）：承接或判別表不是今日適用 → 不列強弱、不進 Z2、資料章 ◆', () => {
  const carried = board({ 2317: V({ carriedFrom: '2026-10-02' }) }).map['2317'];
  const v = newsLampView(carried, CTX);
  assert.equal(v.tone, 'dn');
  assert.equal(v.tier, null);
  assert.equal(v.current, false);
  assert.equal(v.old, '承接 10/02');
  assert.ok(v.title.includes('不列強弱') && v.title.includes('原判權重 0.75'));
  assert.equal(majorBearOf(carried, OPT), null);
  const prevCtx = newsCtxOf({ targetDate: '2026-10-02' }, YMD);
  assert.equal(prevCtx.fresh, 'prev');
  const e = board({ 2317: V() }).map['2317'];
  assert.equal(isCurrentEntry(e, prevCtx), false);
  assert.equal(newsLampView(e, prevCtx).old, '前交易日 10/02 判別');
  assert.equal(majorBearOf(e, { ctx: prevCtx, minAtMs: PREV_CLOSE }), null);
  assert.equal(newsCtxOf({ targetDate: '2026-10-06' }, YMD).fresh, 'next');
  assert.equal(newsCtxOf({ targetDate: null }, YMD).fresh, 'unknown');
  // B 條件的防禦：判讀時間早於上一交易日 13:30 ⇒ 不進 Z2
  const early = board({ 2317: V({ at: PREV_CLOSE - 60_000 }) }).map['2317'];
  assert.equal(majorBearOf(early, OPT), null);
});

test('案例 7：certainty／novelty 缺值取 0.4（保守不補高）', () => {
  const e = board({ 2317: V({ certainty: null, novelty: undefined }) }).map['2317'];
  assert.equal(e.w, 0.12);   // 0.75×1×0.4×0.4×1
  assert.equal(newsTier(e.w), 'weak');
  assert.ok(newsWeightText(e).includes('確定性（—，缺值取 0.4）'));
});

test('案例 8（§2／§6.2 不變式）：只讀 verdictJson——軋空、漲停名單或重複來源不併、不加總', () => {
  const base = board({ 2317: V() });
  const withLists = newsBoardFromDoc({ ...docOf({ 2317: V() }), squeezeJson: JSON.stringify({ 2317: V({ strength: '極強' }) }), extra: [1, 2, 3] });
  assert.deepEqual(withLists.map, base.map);
  // 同一則報導被更多來源轉載：判別仍是一檔一筆（n 變多不改權重）
  const more = board({ 2317: V({ n: 12, articles: 25 }) });
  assert.equal(more.map['2317'].w, base.map['2317'].w);
});

test('案例 9：ETF、權證、6 碼 → 「—」（不做個股新聞識讀），不算未判別', () => {
  assert.equal(isNewsUniverse('0050'), false);
  assert.equal(isNewsUniverse('00878'), false);
  assert.equal(isNewsUniverse('030123'), false);
  assert.equal(isNewsUniverse('2330'), true);
  assert.equal(newsLampView(undefined, CTX, { universe: false }).tone, 'na');
  const k = newsKpi(['2330', '0050', '2317'], board({ 2317: V() }).map, CTX);
  assert.deepEqual(k, { bear: 1, missing: 1, old: 0, na: 1 });
});

test('案例 10：Z2 去重——同日不重發；判讀較新且等級上升才再發；隔日同一關鍵句降二級「持續」', () => {
  const mk = (over) => {
    const e = board({ 2317: V(over) }).map['2317'];
    return [{ code: '2317', entry: e, mb: majorBearOf(e, OPT) }];
  };
  const s1 = stepMajorBear(initialMajorBearState(), mk({}), { targetDate: YMD });
  assert.equal(s1.changed, true);
  assert.equal(s1.items[0].seq, 1);
  assert.equal(s1.items[0].cont, false);
  // 同一份資料再送：不變、同 seq（事件 id 相同，由 events.ts 去重）
  const s2 = stepMajorBear(s1.state, mk({}), { targetDate: YMD });
  assert.equal(s2.changed, false);
  assert.equal(s2.items[0].seq, 1);
  // 判讀較新但等級沒升：不再發
  const s3 = stepMajorBear(s2.state, mk({ at: T(11, 0) }), { targetDate: YMD });
  assert.equal(s3.items[0].seq, 1);
  // 判讀較新且出現法律覆寫：再發（seq 2）
  const s4 = stepMajorBear(s3.state, mk({ at: T(11, 30), reason: `${RULE_LEGAL_PREFIX}涉檢調搜索，法律判定前視為利空（AI 原判利空：…）`, keyQuote: '檢調今日搜索公司' }), { targetDate: YMD });
  assert.equal(s4.items[0].seq, 2);
  assert.equal(s4.items[0].level, 1);
  // 隔日同一關鍵句再判利空 ⇒ 二級持續
  const nextYmd = '2026-10-06';
  const nextCtx = newsCtxOf({ targetDate: nextYmd }, nextYmd);
  const e = newsBoardFromDoc(docOf({ 2317: V({ at: Date.parse('2026-10-05T23:30:00+08:00'), pass: 'evening' }) }, { targetDate: nextYmd })).map['2317'];
  const mb = majorBearOf(e, { ctx: nextCtx, minAtMs: PREV_CLOSE });
  const s5 = stepMajorBear(s4.state, [{ code: '2317', entry: e, mb }], { targetDate: nextYmd });
  assert.equal(s5.items[0].cont, true);
  assert.equal(s5.items[0].level, 2);
  const ev = majorBearEvents(s5.items, new Map([['2317', '鴻海']]), nextYmd)[0];
  assert.equal(ev.kind, 'newsVerdict');
  assert.equal(ev.level, 2);
  assert.ok(ev.text.startsWith('2317 鴻海 利空持續'));
  // 新的（逐字核對過的）引文＝新進展 ⇒ 不是持續
  const e6 = { ...e, vq: '公司公告第二家客戶也抽單' };
  const s6 = stepMajorBear(s4.state, [{ code: '2317', entry: e6, mb }], { targetDate: nextYmd });
  assert.equal(s6.items[0].cont, false);
});

test('Z2 事件：規則法律一級 kind majorNegative、文案只寫事實；權重門檻類二級並註明未校準', () => {
  const legal = board({ 3037: V({ strength: '中', confidence: '低', reason: `${RULE_LEGAL_PREFIX}涉檢調搜索，法律判定前視為利空（AI 原判中性：…）` }) }).map['3037'];
  const w = board({ 2317: V() }).map['2317'];
  const step = stepMajorBear(null, [
    { code: '3037', entry: legal, mb: majorBearOf(legal, OPT) },
    { code: '2317', entry: w, mb: majorBearOf(w, OPT) },
  ], { targetDate: YMD });
  const evs = majorBearEvents(step.items, new Map([['3037', '欣興'], ['2317', '鴻海']]), YMD);
  const l1 = evs.find((e) => e.code === '3037');
  assert.equal(l1.kind, 'majorNegative');
  assert.equal(l1.level, 1);
  assert.equal(l1.id, `majorNegative:${YMD}:3037:1`);
  assert.equal(l1.text, `3037 欣興 AI 讀內文判定利空（法律事件：法律判定前視為利空）·影響權重 0.18（${NEWS_WEIGHT_NOTE}）·盤中 10:25 判讀·引文 2 條已核對`);
  const l2 = evs.find((e) => e.code === '2317');
  assert.equal(l2.level, 2);
  assert.ok(l2.text.includes('權重門檻未經校準，暫列二級'));
  assert.doesNotMatch(evs.map((e) => e.text).join(''), /建議|宜|勿|應該|停損/);
});

test('§1.4 價格描述剔除、§1.6 關注度不判方向；本業事實類與規則法律不受影響', () => {
  const b = board({
    2603: V({ label: '利多', eventType: '其他', keyQuote: '股價拉至漲停，成交量放大', reason: '股價強勢表態' }),
    2609: V({ label: '利多', eventType: '其他', keyQuote: '外資調升目標價至 120 元', reason: '外資調升目標價' }),
    2615: V({ label: '利多', eventType: null, keyQuote: '', reason: '入選 AI 概念股名單' }),
    2618: V({ label: '利多', eventType: '訂單', keyQuote: '接獲大單後股價拉至漲停' }),
    3037: V({ eventType: '其他', keyQuote: '股價重挫跌停', reason: `${RULE_LEGAL_PREFIX}涉檢調搜索，法律判定前視為利空（AI 原判中性：…）` }),
  });
  assert.equal(b.map['2603'].st, 'excluded');
  assert.equal(b.map['2603'].w, null);
  assert.equal(b.map['2603'].ai, '利多');
  assert.equal(newsLampView(b.map['2603'], CTX).tone, 'none');
  assert.equal(b.map['2609'].st, 'attention');
  assert.equal(b.map['2609'].w, null);
  assert.equal(newsLampView(b.map['2609'], CTX).tone, 'flat');
  assert.ok(newsLampView(b.map['2609'], CTX).title.includes('§1.6'));
  assert.equal(b.map['2615'].st, 'attention');
  assert.equal(b.map['2618'].st, 'bull');
  assert.equal(b.map['3037'].st, 'bear');
  assert.equal(b.map['3037'].lg, true);
  assert.equal(verdictState(V({ label: '中性', keyQuote: '股價拉至漲停' })), 'neutral');
});

test('B2 全市場：只收今日盤中趟 AI 讀內文利多／利空，不用權重篩選；文字含強弱與權重', () => {
  const b = board({
    2317: V(),
    2330: V({ label: '利多', strength: '中', confidence: '低', at: T(10, 30) }),   // 弱 w 0.18 也列（不以權重決定名單）
    2382: V({ label: '中性', at: T(10, 31) }),
    2454: V({ pass: 'morning', at: T(7, 40) }),
    2603: V({ basis: 'title', at: T(10, 32) }),
    3037: V({ strength: '中', confidence: '低', at: T(10, 33), reason: `${RULE_LEGAL_PREFIX}涉檢調搜索，法律判定前視為利空（AI 原判中性：…）` }),
    6488: V({ carriedFrom: '2026-10-02' }),
  });
  const evs = b2MarketNewsEvents(b, { todayYmd: YMD });
  assert.deepEqual(evs.map((e) => e.code), ['3037', '2330', '2317']);
  assert.equal(evs[0].text, '利空·法律事件（法律判定前視為利空）·規則覆寫·AI 已讀內文');
  assert.equal(evs[1].text, '利多·弱·權重 0.18·AI 已讀內文');
  assert.equal(evs[1].side, 'long');
  assert.equal(evs[2].text, '利空·強·權重 0.75·AI 已讀內文');
  assert.equal(evs[2].id, `s:newsVerdict:2317:${T(10, 25)}`);
  assert.equal(evs[2].source, 'M');
  assert.deepEqual(b2MarketNewsEvents(b, { todayYmd: '2026-10-06' }), []);
  assert.deepEqual(b2MarketNewsEvents(null, { todayYmd: YMD }), []);
  assert.deepEqual(activeNewsCodes(b, YMD).sort(), ['2317', '2330', '2382', '2454', '3037']);
});

test('B2「我的」：盤中判別（含中性）＋持股盤前利空＋自選達一級條件（二級）；持股達條件的交給 Z2 引擎', () => {
  const b = board({
    2317: V(),                                                         // 持股·達權重門檻 ⇒ Z2 引擎發，這裡略過
    2330: V({ label: '中性', pass: 'intraday', at: T(10, 5) }),         // 自選·盤中中性
    2382: V({ confidence: '中', pass: 'morning', at: T(7, 40) }),       // 持股·晨間利空、未達條件
    2454: V({ pass: 'evening', at: Date.parse('2026-10-04T23:40:00+08:00') }),   // 自選·達條件 ⇒ 二級
    3008: V({ label: '利多', pass: 'morning', at: T(7, 50) }),          // 自選·晨間利多 ⇒ 不列（盤前判別在 A2）
    6669: V({ label: '利多', pass: 'intraday', at: T(10, 10) }),        // 釘選·盤中利多
  });
  const evs = mineNewsEvents(b, {
    holdings: new Set(['2317', '2382']), watch: new Set(['2330', '2454', '3008']), pinned: new Set(['6669']),
    ctx: CTX, minAtMs: PREV_CLOSE, nowMs: NOW,
  });
  assert.deepEqual(evs.map((e) => e.code), ['6669', '2330', '2382', '2454']);
  assert.equal(evs[1].text, '判中性·AI 已讀內文');
  assert.equal(evs[1].side, undefined);
  assert.equal(evs[2].text, '利空·中·權重 0.53·AI 已讀內文（持股）（盤前）');
  assert.equal(evs[3].text, '利空·強·權重 0.75·AI 已讀內文（自選·達一級條件，自選只列二級）（10/04）');
  // 判別表不是今日適用 ⇒ 不發
  assert.deepEqual(mineNewsEvents(b, { holdings: new Set(['2382']), watch: new Set(), pinned: new Set(), ctx: newsCtxOf({ targetDate: '2026-10-02' }, YMD), nowMs: NOW }), []);
});

test('A2 盤前清單：類別＋時間排序（不用權重）；盤中趟不列；未判別／ETF 另計', () => {
  const b = board({
    2317: V({ label: '利多', strength: '極強', pass: 'morning', at: T(7, 10) }),               // w 1.0 但仍排在利空之後
    2382: V({ confidence: '低', strength: '中', pass: 'evening', at: Date.parse('2026-10-04T23:30:00+08:00') }),
    2454: V({ pass: 'night', at: T(3, 0) }),                                                    // 持股·達條件
    3037: V({ strength: '中', confidence: '低', pass: 'morning', at: T(7, 20), reason: `${RULE_LEGAL_PREFIX}涉檢調搜索，法律判定前視為利空（AI 原判中性：…）` }),
    2330: V({ label: '中性', pass: 'morning', at: T(7, 30) }),
    2603: V({ pass: 'intraday', at: T(9, 40) }),
    1101: V({ label: '資訊不足', gate: GATE_D }),
    2609: V({ label: '利多', eventType: '其他', keyQuote: '外資調升目標價', pass: 'morning', at: T(7, 0) }),
    6488: V({ label: '利多', pass: 'morning', carriedFrom: '2026-10-02', at: T(7, 0) - 3 * 86_400_000 }),
  });
  const r = premarketNewsRows(b, {
    holdings: ['2454', '2382', '0050'], watch: ['2317', '3037', '2330', '2603', '1101', '9999', '2609', '6488'], ctx: CTX, minAtMs: PREV_CLOSE,
  });
  assert.deepEqual(r.rows.map((x) => x.code), ['3037', '2454', '2382', '2317', '2330', '2609', '6488']);
  assert.deepEqual(r.rows.map((x) => x.cat), [0, 2, 2, 3, 4, 5, 7]);   // 達重大利空條件與否不分類（權重不決定排序）
  assert.deepEqual(r.missing, ['1101', '9999']);
  assert.deepEqual(r.na, ['0050']);
  assert.equal(newsShortText(r.rows[3].entry, CTX), '利多·強·權重 1.00');
  assert.equal(newsShortText(r.rows[6].entry, CTX), '利多◆承接 10/02');
});

test('KPI：利空只算今日適用非承接；未判別含資訊不足與價格描述；承接另計', () => {
  const b = board({
    2317: V(),
    2382: V({ carriedFrom: '2026-10-02' }),
    2454: V({ label: '資訊不足', gate: GATE_D }),
    2603: V({ label: '利多', eventType: '其他', keyQuote: '股價拉至漲停' }),
    2330: V({ label: '利多' }),
  });
  assert.deepEqual(newsKpi(['2317', '2382', '2454', '2603', '2330', '3008'], b.map, CTX), { bear: 1, missing: 3, old: 1, na: 0 });
  // 判別表是前一交易日的 ⇒ 全部算「非今日」，利空 0
  assert.deepEqual(newsKpi(['2317', '2330'], b.map, newsCtxOf(b.meta, '2026-10-06')), { bear: 0, missing: 0, old: 2, na: 0 });
});

test('資料健康：只看適用日（updatedAt 舊不算故障）；前交易日判別標 ▲', () => {
  const meta = { targetDate: YMD, lastPass: 'intraday', updatedAt: T(9, 5), covered: 208 };
  const ok = newsHealthOf(meta, newsCtxOf(meta, YMD));
  assert.equal(ok.state, 'ok');
  assert.equal(`${ok.glyph} ${ok.text}`, '● 10/05 09:05（盤中）');
  assert.ok(ok.note.includes('無新消息不寫入'));
  const bad = newsHealthOf({ ...meta, targetDate: '2026-10-02' }, newsCtxOf({ targetDate: '2026-10-02' }, YMD));
  assert.equal(bad.state, 'bad');
  assert.equal(`${bad.glyph} ${bad.text}`, '▲ 前交易日 10/02 判別');
  assert.equal(newsHealthOf(null, CTX).state, 'bad');
  assert.equal(newsHealthOf({ ...meta, targetDate: '2026-10-06' }, newsCtxOf({ targetDate: '2026-10-06' }, YMD)).state, 'ok');
});

test('文件不存在或 verdictJson 壞掉回 null（不捏造空表冒充「全部未判別」）；壞代號略過', () => {
  assert.equal(newsBoardFromDoc(null), null);
  assert.equal(newsBoardFromDoc({ updatedAt: NOW }), null);
  assert.equal(newsBoardFromDoc({ verdictJson: '{bad' }), null);
  assert.equal(newsBoardFromDoc({ verdictJson: '[]' }), null);
  const b = newsBoardFromDoc({ verdictJson: JSON.stringify({ abcd: V(), 2317: 'x', 2330: V({ pass: 'constructor' }) }), lastPass: '__proto__' });
  assert.deepEqual(Object.keys(b.map), ['2330']);
  assert.equal(b.meta.targetDate, null);
  assert.equal(b.map['2330'].p, null);   // 趟次只認清單內的值（不吃原型鏈上的鍵）
  assert.equal(b.meta.lastPass, null);
});

test('精簡表欄位：理由只給有方向的、關鍵句只給利空或強的利多、修正說明只給利空（控制 payload）', () => {
  const b = board({
    2317: V(),
    2330: V({ label: '利多', strength: '中', confidence: '低' }),   // 弱
    2454: V({ label: '利多', confidence: '中' }),                    // 中 0.525
    3008: V({ label: '利多' }),                                      // 強 0.75
    2382: V({ label: '中性' }),
  });
  assert.ok(b.map['2317'].kq && b.map['2317'].rv && b.map['2317'].r);
  assert.equal(b.map['2330'].kq, null);
  assert.equal(b.map['2330'].rv, null);
  assert.ok(b.map['2330'].r);
  assert.equal(b.map['2454'].kq, null);
  assert.ok(b.map['3008'].kq);
  assert.equal(b.map['3008'].rv, null);
  assert.equal(b.map['2382'].r, null);
  assert.equal(b.map['2382'].w, null);
});

test('時間標記與 Z2 本機狀態解析（不信任本機資料）', () => {
  assert.equal(newsTimeTag(T(10, 0) - 14 * 3_600_000, NOW), '（10/04）');
  assert.equal(newsTimeTag(T(8, 31), NOW), '（盤前）');
  assert.equal(newsTimeTag(T(10, 25), NOW), '');
  assert.equal(newsTimeTag(Number.NaN, NOW), '');
  const s = parseMajorBearState({ t: YMD, sent: { 2317: { at: 1, rank: 3, seq: 1 }, bad: { at: 1, rank: 1, seq: 1 }, 2330: { at: 'x' } }, q: { 'k': YMD, 'z': 'nope' } });
  assert.deepEqual(s, { t: YMD, sent: { 2317: { at: 1, rank: 3, seq: 1, cont: false } }, q: { k: YMD } });
  assert.deepEqual(parseMajorBearState('garbage'), initialMajorBearState());
  assert.equal(quoteHash('甲乙'), quoteHash('甲乙'));
  assert.notEqual(quoteHash('甲乙'), quoteHash('乙甲'));
  // 文案範例（權重門檻類，自選）
  const e = board({ 2454: V() }).map['2454'];
  const txt = majorBearText('2454', '聯發科', { code: '2454', level: 2, seq: 1, cont: false, mb: majorBearOf(e, { ...OPT, scope: 'watch' }), entry: e });
  assert.ok(txt.startsWith('2454 聯發科 自選 AI 讀內文判定利空·強'));
  assert.ok(txt.includes('自選只列二級'));
});

test('§1.5 AI 自判利空的法律事件（daemon 只在 AI 未判利空時做規則確認）⇒ 標「可能為法律事件（未經規則確認）」、不套 §1.4／§1.6；不升一級（待裁定）', () => {
  const b = board({
    2317: V({ strength: '極強', eventType: '法律', keyQuote: '檢調今日搜索公司總部', reason: '涉檢調搜索，營運恐受影響' }),
    3037: V({ eventType: '其他', keyQuote: '檢調搜索公司，股價重挫跌停', reason: '涉檢調搜索' }),
    2330: V({ label: '利多', eventType: '法律', keyQuote: '雙方和解，對方支付授權金' }),
  });
  const e = b.map['2317'];
  assert.equal(e.lg, false);
  assert.equal(e.pl, true);
  assert.equal(e.w, 1);
  assert.deepEqual(majorBearOf(e, OPT), { level: WEIGHT_GATE_LEVEL, basis: 'weight', scope: 'holding' });
  assert.ok(newsLampView(e, CTX).title.includes(POSSIBLE_LEGAL_NOTE));
  // 依據句同時有檢調搜索與「股價重挫」：不被 §1.4 改判成價格描述
  assert.equal(b.map['3037'].st, 'bear');
  assert.equal(b.map['3037'].pl, true);
  assert.equal(b.map['2330'].pl, false);   // 利多不標
  assert.equal(isPossibleLegalBear(V({ reason: `${RULE_LEGAL_PREFIX}涉檢調搜索…` })), false);   // 已是規則法律
  const evs = mineNewsEvents(board({ 2317: V({ eventType: '法律', strength: '中', confidence: '低', keyQuote: '檢調約談董事長', pass: 'intraday' }) }), {
    holdings: new Set(['2317']), watch: new Set(), pinned: new Set(), ctx: CTX, minAtMs: PREV_CLOSE, nowMs: NOW,
  });
  assert.ok(evs[0].text.includes('可能為法律事件（未經規則確認）'));
});

test('§4.1 C20b 信評機構調降評等或展望＝利空（不是 §1.6 關注度）；券商評等／目標價仍是關注度', () => {
  const b = board({
    2317: V({ eventType: '其他', keyQuote: '中華信評調降該公司長期信用評等至twBBB', reason: '信評調降' }),
    2330: V({ eventType: '其他', keyQuote: '外資調降目標價至 800 元', reason: '外資調降評等' }),
    2454: V({ label: '利多', eventType: '其他', keyQuote: '惠譽調升評等展望至正向' }),
  });
  assert.equal(b.map['2317'].st, 'bear');
  assert.equal(b.map['2330'].st, 'attention');
  assert.equal(b.map['2454'].st, 'attention');   // 調升屬 C20a 同類處理，方向 0
});

test('§1.8 AI 摘句沒有逐字核對：「無」當沒有；精簡表另帶逐字核對過的引文 vq', () => {
  const b = board({
    2317: V({ keyQuote: '無', quotes: ['客戶通知第四季訂單取消三成', '公司預估第四季營收季減一成'] }),
    2330: V({ keyQuote: '客戶通知第四季訂單取消三成' }),
  });
  assert.equal(b.map['2317'].kq, null);
  assert.equal(b.map['2317'].vq, '客戶通知第四季訂單取消三成');
  assert.equal(b.map['2330'].vq, null);
  // 「無」不能拿來當依據句：價格描述／關注度判定退回理由
  assert.equal(verdictState(V({ label: '利多', eventType: '其他', keyQuote: '無', reason: '外資調升目標價' })), 'attention');
  // 去重鍵用逐字核對的引文或理由；都沒有就不判「持續」
  const noKey = { ...b.map['2330'], vq: null, r: null };
  const s1 = stepMajorBear(initialMajorBearState(), [{ code: '2330', entry: noKey, mb: majorBearOf(noKey, OPT) }], { targetDate: YMD });
  assert.deepEqual(s1.state.q, {});
  const nextYmd = '2026-10-06';
  const s2 = stepMajorBear(s1.state, [{ code: '2330', entry: noKey, mb: { level: 2, basis: 'weight', scope: 'holding' } }], { targetDate: nextYmd });
  assert.equal(s2.items[0].cont, false);
});

test('§2 沒走四角色挑戰（可能是 14 日舊聞回退）⇒ ◆、不列強弱、不計入 KPI 利空、不進 B2 我的、A2 落在非今日適用', () => {
  const b = board({
    2317: V({ challenged: false, confidence: '低', eventType: '營收財報' }),
    2330: V(),
    2454: V({ challenged: false, pass: 'morning', at: T(7, 40) }),
  });
  const e = b.map['2317'];
  assert.equal(isUnchallengedEntry(e, CTX), true);
  assert.equal(isCurrentEntry(e, CTX), false);
  const v = newsLampView(e, CTX);
  assert.equal(v.tone, 'dn');
  assert.equal(v.tier, null);
  assert.equal(v.old, UNCHALLENGED_TAG);
  assert.ok(v.title.includes(UNCHALLENGED_NOTE));
  assert.equal(newsShortText(e, CTX), `利空◆${UNCHALLENGED_TAG}`);
  assert.deepEqual(newsKpi(['2317', '2330'], b.map, CTX), { bear: 1, missing: 0, old: 1, na: 0 });
  const evs = mineNewsEvents(b, { holdings: new Set(['2317', '2330', '2454']), watch: new Set(), pinned: new Set(), ctx: CTX, minAtMs: PREV_CLOSE, nowMs: NOW });
  assert.deepEqual(evs.map((x) => x.code), []);   // 2330 達權重門檻交給 Z2 引擎；2317、2454 沒走挑戰
  const r = premarketNewsRows(b, { holdings: ['2454'], watch: [], ctx: CTX, minAtMs: PREV_CLOSE });
  assert.deepEqual(r.rows.map((x) => [x.code, x.cat]), [['2454', 7]]);
});

test('B2「我的」與 A2：權重不決定名單——自選、釘選的盤前利空不看權重全列；承接的盤中趟判別仍列在 A2（◆）', () => {
  const b = board({
    2454: V({ confidence: '低', strength: '中', certainty: '已確認', pass: 'evening', at: Date.parse('2026-10-04T23:40:00+08:00') }),   // 弱
    1102: V({ strength: '極強', pass: 'morning', at: T(7, 30) }),                                                                     // w 1.0
    6669: V({ confidence: '中', pass: 'night', at: T(2, 0) }),
  });
  assert.equal(newsTier(b.map['2454'].w), 'weak');
  const evs = mineNewsEvents(b, { holdings: new Set(), watch: new Set(['2454', '1102']), pinned: new Set(['6669']), ctx: CTX, minAtMs: PREV_CLOSE, nowMs: NOW });
  assert.deepEqual(evs.map((x) => x.code), ['1102', '6669', '2454']);
  assert.ok(evs[0].text.endsWith('（自選·達一級條件，自選只列二級）（盤前）'));
  assert.ok(evs[1].text.includes('（釘選）'));
  assert.ok(evs[2].text.includes('（自選）'));
  // A2：前一交易日盤中趟判出、被承接到今日表 ⇒ 不消失，落在非今日適用
  const carried = board({ 2330: V({ pass: 'intraday', carriedFrom: '2026-10-02', at: Date.parse('2026-10-02T11:00:00+08:00') }), 2317: V({ pass: 'intraday' }) });
  const r = premarketNewsRows(carried, { holdings: ['2330', '2317'], watch: [], ctx: CTX, minAtMs: PREV_CLOSE });
  assert.deepEqual(r.rows.map((x) => [x.code, x.cat]), [['2330', 7]]);
  assert.deepEqual(r.missing, []);
});

test('Z2 同日再發只看警示等級上升（二級→一級），強弱（權重）升級不再發', () => {
  const mk = (over) => {
    const e = board({ 2317: V(over) }).map['2317'];
    return [{ code: '2317', entry: e, mb: majorBearOf(e, OPT) }];
  };
  const s1 = stepMajorBear(initialMajorBearState(), mk({ eventType: '法律', confidence: '中' }), { targetDate: YMD });   // legal-type 0.525
  assert.equal(s1.items[0].mb.basis, 'legal-type');
  const s2 = stepMajorBear(s1.state, mk({ eventType: '法律', strength: '極強', at: T(11, 0) }), { targetDate: YMD });   // 權重升到 1.0，仍二級
  assert.equal(s2.items[0].seq, 1);
  assert.equal(s2.changed, false);
});
