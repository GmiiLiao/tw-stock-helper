import test from 'node:test';
import assert from 'node:assert/strict';
import { checkIssue, applyRedactions, RULE_IDS, RULE_META } from './check.mjs';
import { refsOfRaw, renderClaim, claimTier } from './slots.mjs';
import * as K from './constants.mjs';
import { makePack, buildGoodIssue, TODAY, DATES, clone, sha256 } from './test-fixtures.mjs';

// ── 夾具與輔助 ────────────────────────────────────────────────────────────────
// 好 issue 的 claim id：prev c1 c2｜data c3(overview) c4(diff) c5(momentum) c6(news) c7(global)｜next c8(outlook) c9(linkage)｜summary points c10–c12、nextFocus c13、risks c14
function scenario({ pack: packMut, issue: issueMut, opts } = {}) {
  const pack = makePack();
  packMut?.(pack);
  const issue = buildGoodIssue(pack);
  issueMut?.(issue, pack);
  const res = checkIssue(issue, pack, { today: TODAY, ...opts });
  return { pack, issue, res };
}
const allClaims = issue => [...issue.summary.points, ...issue.summary.nextFocus, ...issue.summary.risks, ...issue.cards.flatMap(c => c.sections.flatMap(s => s.claims))];
const byId = (issue, id) => allClaims(issue).find(c => c.id === id);
/** 改寫一則 claim 的原文，並像 W3 組稿一樣重算 refs／text／tier（隔離出單一規則的違規）。 */
function reclaim(issue, pack, id, raw, over = {}) {
  const c = byId(issue, id);
  const kind = over.kind ?? c.kind;
  const refs = refsOfRaw(raw);
  Object.assign(c, { raw, refs, text: renderClaim({ raw, kind }, pack).text, tier: claimTier(refs, pack, kind) }, over);
  return c;
}
const nextStock = (issue, i = 0) => issue.cards.find(c => c.id === 'next').focus.stocks[i];
const failed = res => Object.entries(res.rules).filter(([, v]) => v === 'fail').map(([k]) => k);
/** 該規則失敗，且沒有任何其他規則被連帶弄壞。 */
function expectOnly(res, rule) {
  assert.deepEqual(failed(res), [rule], `應只有 ${rule} 失敗；實際：${JSON.stringify([...res.blockers, ...res.redactions])}`);
}
const hits = (res, rule) => [...res.blockers, ...res.redactions].filter(x => x.rule === rule);
const R = (v, unit, fmt, asOf, tier, source = 'x') => ({ v, unit, fmt, asOf, tier, source });

// ── 好 issue ──────────────────────────────────────────────────────────────────
test('好 issue：零 blocker、零 redaction、零 warning；R25 因未提供 rendered 為 skip，其餘全 pass', () => {
  const { res, issue } = scenario();
  assert.deepEqual(res.blockers, []);
  assert.deepEqual(res.redactions, []);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.pass, true);
  assert.deepEqual(Object.keys(res.rules), RULE_IDS);
  for (const id of RULE_IDS) assert.equal(res.rules[id], id === 'R25' ? 'skip' : 'pass', id);
  assert.ok('redactions' in issue.meta.check, '契約的 meta.check.redactions 鍵含 "action" 子字串，R01 明文豁免');
});

test('checkIssue：純函式（不改輸入、輸出確定）、不因垃圾輸入丟例外', () => {
  const pack = makePack(), issue = buildGoodIssue(pack);
  const a = JSON.stringify(issue), b = JSON.stringify(pack);
  const r1 = checkIssue(issue, pack, { today: TODAY });
  const r2 = checkIssue(issue, pack, { today: TODAY });
  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify(issue), a);
  assert.equal(JSON.stringify(pack), b);
  for (const junk of [null, undefined, 42, 'x', [], {}, { cards: 'x', summary: 5, linkages: {} }, { cards: [null, 1, { sections: 'x', focus: [] }] }]) {
    const r = checkIssue(junk, junk === null ? null : pack);
    assert.equal(r.pass, false);
    assert.ok(r.blockers.length > 0);
  }
  assert.equal(checkIssue(issue, null).pass, false);
});

test('RULE_META 涵蓋 R01–R25，結果鍵名不含禁用樣式', () => {
  assert.deepEqual(Object.keys(RULE_META), RULE_IDS);
  const res = checkIssue(buildGoodIssue(makePack()), makePack());
  for (const k of ['pass', 'blockers', 'redactions', 'warnings', 'rules']) assert.ok(k in res);
  for (const k of Object.keys(res)) if (k !== 'redactions') assert.ok(!K.FORBIDDEN_KEY_RE.test(k), k);
});

// ── R01 ───────────────────────────────────────────────────────────────────────
test('R01：封閉清單、結構、鍵名掃描', () => {
  expectOnly(scenario({ issue: i => { i.cards[0].id = 'yesterday'; } }).res, 'R01');
  expectOnly(scenario({ issue: i => { byId(i, 'c1').kind = 'opinion'; } }).res, 'R01');
  expectOnly(scenario({ issue: i => { byId(i, 'c1').direction = '看多'; } }).res, 'R01');
  assert.equal(scenario({ issue: i => { byId(i, 'c1').tier = '官方推薦'; } }).res.rules.R01, 'fail');
  expectOnly(scenario({ issue: i => { i.linkages[0].mechanism = '因果'; } }).res, 'R01');
  assert.equal(scenario({ issue: i => { i.edition = 'noon'; } }).res.rules.R01, 'fail');
  expectOnly(scenario({ issue: i => { delete i.summary; } }).res, 'R01');
  expectOnly(scenario({ issue: i => { i.cards[2].focus.kind = 'recap'; } }).res, 'R01');
  expectOnly(scenario({ issue: i => { nextStock(i).evidence[0].role = 'hunch'; } }).res, 'R01');
  expectOnly(scenario({ issue: i => { i.linkages[0].authors = ['global']; } }).res, 'R01');
  expectOnly(scenario({ issue: i => { i.summary.points.push(...clone(i.summary.points), ...clone(i.summary.points)); i.summary.points.forEach((p, k) => { p.id = `x${k}`; }); } }).res, 'R01');
});

test('R01：key 掃描——score|signal|buy|sell|rank|target|stop|entry|exit|action|rating|recommend 與新增 At／Date 鍵', () => {
  for (const key of ['targetPrice', 'buyZone', 'rankNo', 'stopLine', 'signalLevel', 'rating', 'recommendList', 'entryPoint', 'exitPoint', 'actionItem', 'scoreX', 'verifiedAt', 'builtDate', 'packBuiltAt']) {
    const { res } = scenario({ issue: i => { i.meta[key] = 1; } });
    assert.equal(res.rules.R01, 'fail', key);
    assert.ok(hits(res, 'R01').some(b => b.msg.includes(key)), key);
  }
  // 合法的四個日期鍵、契約自定義的 redactions 不誤殺；動態鍵（refTable 的 ref id、rules）不掃
  const ok = scenario({ issue: i => { i.meta.generatedAt = 'x'; i.meta.canonicalAt = 'y'; i.meta.updatedAt = 'z'; i.refTable['st.2330.targetx'] = R(1, 'x', 'int', DATES.data, '官方'); } });
  assert.equal(hits(ok.res, 'R01').filter(h => /鍵名/.test(h.msg)).length, 0);
});

test('R01：card title／asOf 必須是程式產生的標題；today 給定時逐字比對', () => {
  expectOnly(scenario({ issue: i => { i.cards[0].title = '昨日股市'; } }).res, 'R01');
  expectOnly(scenario({ issue: i => { i.cards[1].title = '今日盤後（當日 10/03）'; } }).res, 'R01');
  expectOnly(scenario({ issue: i => { i.cards[2].asOf.day = '2026-10-06'; } }).res, 'R01');
  const wrongLead = scenario({ issue: i => { i.cards[1].title = '明日預期（當日 10/02）'; } });
  assert.equal(wrongLead.res.rules.R01, 'fail');
  // 不給 today：只驗格式
  const p = makePack(), i = buildGoodIssue(p);
  assert.equal(checkIssue(i, p, {}).rules.R01, 'pass');
  assert.equal(checkIssue(i, p, { today: '2026-10-09' }).rules.R01, 'fail', '給 today 時標題必須與 cardTitle 逐字相同（資料日早於 today＝前交易日）');
  assert.equal(checkIssue(i, p, { todayISO: TODAY }).rules.R01, 'pass', 'W3 以 todayISO 傳入也接受');
});

// ── R02 ───────────────────────────────────────────────────────────────────────
test('R02：usedForScoring／免責逐字相等／forbidden／nature', () => {
  assert.equal(scenario().res.rules.R02, 'pass');
  expectOnly(scenario({ issue: i => { i.useRules.usedForScoring = true; } }).res, 'R02');
  expectOnly(scenario({ issue: i => { i.useRules.disclaimer += '。'; } }).res, 'R02');
  expectOnly(scenario({ issue: i => { i.useRules.disclaimerShort = '非投資建議'; } }).res, 'R02');
  expectOnly(scenario({ issue: i => { i.useRules.forbidden = ['無']; } }).res, 'R02');
  expectOnly(scenario({ issue: i => { i.useRules.nature = '推薦名單'; } }).res, 'R02');
  expectOnly(scenario({ issue: i => { i.useRules.extra = 1; } }).res, 'R02');
});

// ── R03 數字授權 ───────────────────────────────────────────────────────────────
const r03 = (raw, { opts, extra } = {}) => scenario({
  opts,
  issue: (i, p) => reclaim(i, p, 'c3', raw, extra),
}).res;

test('R03：裸數字一律擋（0.57、0.6、1,144,137、1144137、百分比、5 日、正負號）', () => {
  for (const raw of [
    '上市等權平均 0.57%，指數與等權相差 {{br.gapPp|sg2}}pp。', '成交值約 0.6 億元 [ref:m.val]。', '成交 1,144,137 張 [ref:m.n]。', '成交 1144137 張 [ref:m.n]。',
    '上漲比 61% [ref:m.upRatio]。', '近 5 日 [ref:m.ew] 偏強。', '等權 +2.3% [ref:m.ew]。', '等權 −0.57 [ref:m.ew]。', '約四成個股上漲 [ref:m.upRatio]。',
    '成交值逾十億元 [ref:m.val]。', '兩倍於前日 [ref:m.ew]。', '零點五七 [ref:m.ew]。', '百分之五十 [ref:m.upRatio]。', '近５日 [ref:m.ew] 偏強。', '前三大：台積電、聯發科。 [ref:m.ew]',
  ]) {
    const res = r03(raw);
    assert.equal(res.rules.R03, 'fail', raw);
    assert.ok(hits(res, 'R03').length >= 1, raw);
  }
});

test('R03：槽位內的數字、白名單（日期、代號、前 N 大、序號、5–10、固定名稱）不擋', () => {
  const good = [
    '上市等權平均 {{m.ew|sg2}}%，指數與等權相差 {{br.gapPp|sg2}}pp。',
    '其陽（3564）當日 {{st.3564.ret|sg2}}%。',
    '2026-10-02 的上市等權平均 {{m.ew|sg2}}%。',
    '10/9 為除息日 [ref:cal.exdiv.2330.date]。',
    '10月9日為除息日 [ref:cal.exdiv.2330.date]。',
    '前 3 大：台積電、聯發科、鴻海，等權 {{m.ew|sg2}}%。',
    '前 2 大：台積電與聯發科 {{m.ew|sg2}}%。',
    '前三大：台積電、聯發科、鴻海，等權 {{m.ew|sg2}}%。',
    '（1）等權平均 {{m.ew|sg2}}%。',
    '名單為 5–10 檔，等權 {{m.ew|sg2}}%。',
    '2 奈米與 5G 題材 [ref:m.ew]。',
    '2026 年 Q3 等權 {{m.ew|sg2}}%。',
    '9 月營收 [ref:m.ew]。',
    '00878 與 0050 相關 [ref:m.ew]。',
  ];
  for (const raw of good) assert.notEqual(r03(raw).rules.R03, 'fail', raw);
});

test('R03：代號白名單只認 pack／名單內已知代號；後接單位視為數量；前 N 大必須與列出筆數一致', () => {
  assert.equal(r03('1234 的等權 {{m.ew|sg2}}%。').rules.R03, 'fail', '不在 pack 的 4 位數＝裸數字');
  assert.equal(r03('2330 點 {{m.ew|sg2}}。').rules.R03, 'fail', '代號後接「點」視為數量');
  assert.equal(r03('前 5 大：台積電、聯發科、鴻海，等權 {{m.ew|sg2}}%。').rules.R03, 'fail', 'N=5 但列出 3 檔');
  assert.equal(r03('前 3 大權值股等權 {{m.ew|sg2}}%。').rules.R03, 'fail', '沒列出清單，無法驗證 N');
  assert.equal(r03('前 {{m.n|int}} 大：台積電、聯發科。').rules.R03, 'pass', 'N 走槽位不受限');
  assert.equal(r03('1234 的等權 {{m.ew|sg2}}%。', { opts: { knownCodes: ['1234'] } }).rules.R03, 'pass', 'opts.knownCodes 可擴充');
});

test('R03：寬鬆模式——裸數字與同句引用 ref 在使用者小數位四捨五入後相等才放行（0.57 vs 0.6）', () => {
  const o = { numberMode: 'relaxed' };
  assert.equal(r03('等權約 0.6% [ref:m.ew]。', { opts: o }).rules.R03, 'pass');
  assert.equal(r03('等權 0.57% [ref:m.ew]。', { opts: o }).rules.R03, 'pass');
  assert.equal(r03('等權 0.58% [ref:m.ew]。', { opts: o }).rules.R03, 'fail');
  assert.equal(r03('等權 0.5% [ref:m.ew]。', { opts: o }).rules.R03, 'fail');
  assert.equal(r03('有效個股 1,950 檔 [ref:m.n]。', { opts: o }).rules.R03, 'pass');
  assert.equal(r03('有效個股 1950 檔 [ref:m.n]。', { opts: o }).rules.R03, 'pass');
  assert.equal(r03('有效個股 1,951 檔 [ref:m.n]。', { opts: o }).rules.R03, 'fail');
  assert.equal(r03('上漲比 61% [ref:m.upRatio]。', { opts: o }).rules.R03, 'pass');
  assert.equal(r03('上漲比 62% [ref:m.upRatio]。', { opts: o }).rules.R03, 'fail');
  assert.equal(r03('成交值 4,123.5 億 [ref:m.val]。', { opts: o }).rules.R03, 'pass');
  assert.equal(r03('成交值 4,123.5 萬 [ref:m.val]。', { opts: o }).rules.R03, 'fail', '單位換算不一致（億≠萬）');
  assert.equal(r03('成交 0.6 億 [ref:m.ew]。', { opts: o }).rules.R03, 'fail', '單位不一致（億對 %）');
  assert.equal(r03('等權 0.6% [ref:br.gapPp]。', { opts: o }).rules.R03, 'fail', '不是同句引用的 ref 的值');
});

test('R03：claim.text 被改寫（與 raw 槽位渲染＋等級標記不一致）→ 擋', () => {
  const { res } = scenario({ issue: i => { byId(i, 'c3').text = byId(i, 'c3').text.replace('+0.57', '+0.60'); } });
  expectOnly(res, 'R03');
  const dropMark = scenario({ issue: (i, p) => { reclaim(i, p, 'c9', byId(i, 'c9').raw); byId(i, 'c9').text = byId(i, 'c9').text.replace('（站內整理）', ''); } });
  assert.equal(dropMark.res.rules.R03, 'fail');
});

test('R03：個股 thesis／watchConditions／risks／linkages／headline 同樣受管', () => {
  expectOnly(scenario({ issue: i => { nextStock(i).thesis = '當日漲 3.2%，列入資料觀察名單。'; } }).res, 'R03');
  expectOnly(scenario({ issue: i => { nextStock(i).watchConditions[0].text = '觀察成交值是否維持 8.5 億水準 [ref:st.2330.valM]。'; } }).res, 'R03');
  expectOnly(scenario({ issue: i => { i.summary.headline = '等權平均上漲 0.57%。'; } }).res, 'R03');
  const lk = scenario({ issue: i => { i.linkages[0].text = '費半 2.4% 與半導體業同向變動，相關程度以歷史數據為準。'; } });
  assert.equal(lk.res.rules.R03, 'fail');
});

// ── R04 ───────────────────────────────────────────────────────────────────────
test('R04：ref 不存在、claim.refs 與抽出不一致、refTable 被改、個股張冠李戴、缺值槽位、已知不可用欄位', () => {
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c3', '等權 {{no.such.ref|sg2}}%。') }).res.rules.R04, 'fail');
  expectOnly(scenario({ issue: i => { byId(i, 'c3').refs = ['m.ew']; } }).res, 'R04');
  expectOnly(scenario({ issue: i => { i.refTable['m.ew'].v = 9.99; } }).res, 'R04');
  expectOnly(scenario({ issue: i => { i.refTable['no.such.x'] = R(1, 'x', 'int', DATES.data, '官方'); } }).res, 'R04');
  const cross = scenario({ issue: i => { nextStock(i).evidence[0].ref = 'st.2317.ret'; } });
  expectOnly(cross.res, 'R04');
  assert.ok(hits(cross.res, 'R04')[0].msg.includes('他檔'));
  const nullSlot = scenario({ pack: p => { p.refs['m.ew'].v = null; }, issue: () => {} });
  assert.equal(nullSlot.res.rules.R04, 'fail');
  assert.ok(hits(nullSlot.res, 'R04').some(h => h.msg.includes('缺值')));
  const forbidden = scenario({ pack: p => { p.refs['ind.半導體業.avgChg'] = R(1, '%', 'sg2', DATES.data, '官方衍生'); }, issue: (i, p) => reclaim(i, p, 'c3', '產業 {{ind.半導體業.avgChg|sg2}}%。') });
  assert.ok(hits(forbidden.res, 'R04').some(h => h.msg.includes('不可用')));
});

test('R04：refTable 缺漏或多餘只警告；claim.refs 順序不同不算不一致', () => {
  const lack = scenario({ issue: i => { delete i.refTable['m.val']; } });
  assert.equal(lack.res.pass, true);
  assert.ok(lack.res.warnings.some(w => w.rule === 'R04'));
  const reorder = scenario({ issue: i => { byId(i, 'c3').refs.reverse(); } });
  assert.equal(reorder.res.rules.R04, 'pass');
});

// ── R05 ───────────────────────────────────────────────────────────────────────
test('R05：頂層日期必須與 pack 一致；文字日期必須在 pack.dates／cal.*；昨日今日明日限卡；星期用語', () => {
  expectOnly(scenario({ issue: i => { i.dataDate = '2026-10-01'; } }).res, 'R05');
  const dates = scenario({ issue: i => { i.dates.next = '2026-10-06'; } });
  assert.equal(dates.res.rules.R05, 'fail');
  expectOnly(scenario({ issue: i => { i.edition = 'morning'; } }).res, 'R05');
  const wrong = ['2026-10-03 等權 {{m.ew|sg2}}%。', '10/7 的等權 {{m.ew|sg2}}%。', '10月8日 等權 {{m.ew|sg2}}%。', '2025-10-02 等權 {{m.ew|sg2}}%。'];
  for (const raw of wrong) assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c3', raw) }).res.rules.R05, 'fail', raw);
  for (const raw of ['2026-10-02 等權 {{m.ew|sg2}}%。', '10/2 等權 {{m.ew|sg2}}%。', '10/05 為下一交易日，等權 {{m.ew|sg2}}%。', '10月1日 等權 {{m.ew|sg2}}%。', '10/9 為除息日 [ref:cal.exdiv.2330.date]，等權 {{m.ew|sg2}}%。']) {
    assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c3', raw) }).res.rules.R05, 'pass', raw);
  }
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c3', '週五的等權 {{m.ew|sg2}}%。') }).res.rules.R05, 'fail');
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c3', '星期五的等權 {{m.ew|sg2}}%。') }).res.rules.R05, 'fail');
});

test('R05：「今日」只准 data 卡、「明日」只准 next 卡、「昨日」只准 prev／data 卡；總結卡不限', () => {
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c1', '今日等權 {{pv.m.ew|sg2}}%。', { direction: '持平' }) }).res.rules.R05, 'fail');
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c3', '明日等權 {{m.ew|sg2}}%。') }).res.rules.R05, 'fail');
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c8', '若費半 {{gl.^SOX.chgPct|sg2}}% 延續，今日量能為觀察重點。', { kind: 'conditional' }) }).res.rules.R05, 'fail');
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c3', '今日等權 {{m.ew|sg2}}%，昨日 {{pv.m.ew|sg2}}%。') }).res.rules.R05, 'pass');
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c10', '今日等權 {{m.ew|sg2}}%，明日觀察重點見明日預期卡。') }).res.rules.R05, 'pass');
});

// ── R06 ───────────────────────────────────────────────────────────────────────
function addSyntheticStock(issue, pack, cardId, code) {
  const card = issue.cards.find(c => c.id === cardId);
  const src = clone(card.focus.stocks[0]);
  const old = src.code;
  const swap = s => s.split(old).join(code);
  const dup = JSON.parse(swap(JSON.stringify(src)));
  dup.name = `測試${code}`;
  card.focus.stocks.push(dup);
  pack.pools[cardId].push({ code, name: dup.name, market: dup.market, industry: dup.industry, from: [] });
  for (const k of Object.keys(pack.refs)) if (k.includes(`.${old}.`)) pack.refs[k.split(old).join(code)] = clone(pack.refs[k]);
  card.focus.poolSize = pack.pools[cardId].length;
  for (const k of Object.keys(pack.refs)) if (k.includes(`.${code}.`)) issue.refTable[k] = pack.refs[k];
}

test('R06：池外個股 Block；名稱／市場／產業與池不符 Block；poolRule／poolSize／excludedCount 不符 Block', () => {
  const out = scenario({ issue: i => { nextStock(i).code = '9999'; } });
  assert.equal(out.res.rules.R06, 'fail');
  assert.ok(out.res.blockers.some(b => b.rule === 'R06' && b.code === '9999'));
  assert.equal(scenario({ issue: i => { nextStock(i).name = '偽名公司'; } }).res.rules.R06, 'fail');
  assert.equal(scenario({ issue: i => { nextStock(i).industry = '航運業'; } }).res.rules.R06, 'fail');
  assert.equal(scenario({ issue: i => { i.cards[2].focus.poolRule = 'pool-v2'; } }).res.rules.R06, 'fail');
  assert.equal(scenario({ issue: i => { i.cards[2].focus.poolSize = 99; } }).res.rules.R06, 'fail');
  assert.equal(scenario({ issue: i => { i.cards[0].focus.excludedCount = 0; } }).res.rules.R06, 'fail');
  assert.equal(scenario({ issue: (i, p) => { delete p.pools.next; } }).res.rules.R06, 'fail');
});

test('R06：同卡重複／超過 10 檔／同一檔出現在 3 張卡 → Redact（程式刪該檔，不重打 LLM）', () => {
  const dup = scenario({ issue: i => { i.cards[2].focus.stocks.push(clone(nextStock(i, 0))); } });
  assert.equal(dup.res.pass, true);
  assert.equal(hits(dup.res, 'R06').length, 1);
  assert.equal(dup.res.redactions[0].code, '2330');
  assert.equal(dup.res.redactions[0].cardId, 'next');

  const over = scenario({ issue: (i, p) => { for (const c of ['9001', '9002', '9003', '9004', '9005', '9006']) addSyntheticStock(i, p, 'next', c); } });
  assert.equal(over.issue.cards[2].focus.stocks.length, 11);
  assert.ok(over.res.redactions.some(r => r.rule === 'R06' && r.code === '9006' && /超額/.test(r.msg)));

  // 2330 已在 prev、next 兩卡；再放進 data 卡（先讓 data 候選池含 2330）＝第 3 張
  const three = scenario({
    pack: p => { p.pools.data.push({ code: '2330', name: '台積電', market: '上市', industry: '半導體業', from: [] }); },
    issue: i => { const s = clone(i.cards.find(c => c.id === 'prev').focus.stocks[0]); s.cardId = 'data'; s.kind = 'recap'; s.asOf = { day: DATES.data, closeRef: 'st.2330.close' }; i.cards[1].focus.stocks.push(s); },
  });
  assert.ok(three.res.redactions.some(r => r.rule === 'R06' && /最多出現/.test(r.msg) && r.cardId === 'next'), JSON.stringify(three.res));
});

// ── R07 ───────────────────────────────────────────────────────────────────────
test('R07：個股證據需有自身證據、至少一筆官方；watch 需帶 ref 的觀察條件；需有風險說明 → Redact 該檔', () => {
  const noOwn = scenario({ issue: i => { nextStock(i).evidence = [{ ref: 'm.ew', role: 'context' }]; } });
  assert.equal(hits(noOwn.res, 'R07').length, 1);
  assert.equal(noOwn.res.redactions[0].code, '2330');
  assert.equal(noOwn.res.blockers.filter(b => b.rule === 'R07').length, 0);
  const noEv = scenario({ issue: i => { nextStock(i).evidence = []; } });
  assert.equal(hits(noEv.res, 'R07').length, 1);
  const noOfficial = scenario({ issue: i => { nextStock(i, 2).evidence = [{ ref: 'nv.3564.label', role: 'news' }]; } });
  assert.ok(hits(noOfficial.res, 'R07').some(h => h.code === '3564' && /官方/.test(h.msg)));
  const noWatch = scenario({ issue: i => { nextStock(i).watchConditions = []; } });
  assert.ok(hits(noWatch.res, 'R07').some(h => /觀察條件/.test(h.msg)));
  const noRefWatch = scenario({ issue: i => { nextStock(i).watchConditions[0].refs = []; nextStock(i).watchConditions[0].text = '觀察成交值是否放大。'; } });
  assert.ok(hits(noRefWatch.res, 'R07').some(h => /觀察條件/.test(h.msg)));
  const noRisk = scenario({ issue: i => { nextStock(i).risks = []; } });
  assert.ok(hits(noRisk.res, 'R07').some(h => /風險/.test(h.msg)));
  // recap 卡不強制 watchConditions
  assert.equal(scenario({ issue: i => { i.cards[0].focus.stocks[0].watchConditions = []; } }).res.rules.R07, 'pass');
});

// ── R08 ───────────────────────────────────────────────────────────────────────
test('R08：risks 必須涵蓋 pack 預算的 adverse（不足 Redact）；adverse 被 LLM 改動 Block', () => {
  const cov = scenario({ issue: i => { const s = nextStock(i, 2); s.risks = [{ text: '成交值集中，須留意追價風險。', refs: [] }]; } });
  assert.equal(cov.res.pass, true);
  assert.equal(hits(cov.res, 'R08').length, 1);
  assert.equal(cov.res.redactions[0].code, '3564');
  const tamper = scenario({ issue: i => { nextStock(i, 2).adverse = []; } });
  assert.equal(tamper.res.pass, false);
  assert.ok(tamper.res.blockers.some(b => b.rule === 'R08'));
  const added = scenario({ issue: i => { nextStock(i, 0).adverse = ['m.ew']; } });
  assert.ok(added.res.blockers.some(b => b.rule === 'R08'));
  // pack 新增反證後，原本沒列的個股必須補列
  const newAdv = scenario({ pack: p => { p.adverse['2330'] = ['nv.2330.label']; }, issue: i => { nextStock(i, 0).adverse = ['nv.2330.label']; } });
  assert.ok(newAdv.res.redactions.some(r => r.rule === 'R08' && r.code === '2330'));
});

// ── R09／R10／R19／R22 詞表 ────────────────────────────────────────────────────
const wordCase = (raw, over) => scenario({ issue: (i, p) => reclaim(i, p, 'c3', raw, over) }).res;

test('R09：買賣語／價格目標／保證；描述性用語（買賣超、外資買超、融資買進、借券賣出、買進成交、追價風險、處置）不誤殺', () => {
  for (const raw of ['建議買進，等權 {{m.ew|sg2}}%。', '目標價 {{m.ew|sg2}}。', '宜逢低布局 [ref:m.ew]。', '設好停損 [ref:m.ew]。', '穩賺不賠 [ref:m.ew]。', '值得買 [ref:m.ew]。']) {
    assert.equal(wordCase(raw).rules.R09, 'fail', raw);
  }
  for (const raw of ['外資買超，等權 {{m.ew|sg2}}%。', '三大法人買賣超合計見 [ref:m.ew]。', '融資買進餘額減少 [ref:m.ew]。', '借券賣出餘額增加 [ref:m.ew]。', '買進成交均價見 [ref:m.ew]。', '當日有追價風險，等權 {{m.ew|sg2}}%。', '處置股不納入 [ref:m.ew]。', '非投資建議，等權 {{m.ew|sg2}}%。']) {
    assert.equal(wordCase(raw).rules.R09, 'pass', raw);
  }
  assert.equal(wordCase('外資買超，建議買進 [ref:m.ew]。').rules.R09, 'fail', '同句夾帶真的建議仍擋');
});

test('R10：預測句型；未來時態句只准出現在 conditional 或 next 卡 outlook／linkage，且須含條件詞與 cond', () => {
  for (const raw of ['等權將上漲 [ref:m.ew]。', '指數可望續強 [ref:m.ew]。', '看多電子股 [ref:m.ew]。', '預期明日大漲 [ref:m.ew]。', '挑戰 22000 點 [ref:m.ew]。', '明日開高機率大 [ref:m.ew]。']) {
    assert.equal(wordCase(raw).rules.R10, 'fail', raw);
  }
  // 非 conditional 的未來句
  assert.equal(wordCase('等權可能下跌 [ref:m.ew]。').rules.R10, 'fail');
  // conditional：缺 cond
  assert.equal(scenario({ issue: i => { delete byId(i, 'c8').cond; } }).res.rules.R10, 'fail');
  // conditional 且含條件詞 → 過
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c8', '若費半 {{gl.^SOX.chgPct|sg2}}% 回落，開盤後觀察權值股是否轉弱。', { kind: 'conditional' }) }).res.rules.R10, 'pass');
  // conditional 但未來句沒有條件詞
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c8', '費半 {{gl.^SOX.chgPct|sg2}}% 使權值股可能轉弱。', { kind: 'conditional' }) }).res.rules.R10, 'fail');
  // 同一句放在 data 卡 fact → 擋
  assert.equal(wordCase('若費半 {{gl.^SOX.chgPct|sg2}}% 回落，開盤後觀察權值股是否轉弱。', { kind: 'fact' }).rules.R10, 'pass', '有「若…是否」且不含未來動詞（轉弱前無 將／會）→ 不算未來句');
  // 預計於…召開、將於…公告：排程事實不擋
  assert.equal(wordCase('公司預計於 10/9 召開法說會 [ref:cal.exdiv.2330.date]。').rules.R10, 'pass');
});

test('R19：score／signal／評分／評級／訊號／排名第 N／推薦榜 等站內模型名詞', () => {
  for (const raw of ['技術評分偏高 [ref:m.ew]。', '訊號轉強 [ref:m.ew]。', '排名第 {{m.n|int}} [ref:m.ew]。', 'signal 轉強 [ref:m.ew]。', '入選推薦榜 [ref:m.ew]。']) {
    assert.equal(wordCase(raw).rules.R19, 'fail', raw);
  }
  assert.equal(wordCase('熱度名次居前，等權 {{m.ew|sg2}}%。').rules.R19, 'pass');
  assert.equal(wordCase('這不是買賣訊號，等權 {{m.ew|sg2}}%。').rules.R19, 'pass');
});

test('R22：linkage／outlook 禁「導致／因此將／必然」（block），「帶動／造成」僅警告；非傳導段落不受限', () => {
  const link = raw => scenario({ issue: (i, p) => reclaim(i, p, 'c9', raw, { kind: 'linkage' }) }).res;
  assert.equal(link('費半 {{gl.^SOX.chgPct|sg2}}% 導致半導體業 {{ind.半導體業.ew|sg2}}% 走勢變動。').rules.R22, 'fail');
  assert.equal(link('費半 {{gl.^SOX.chgPct|sg2}}% 必然影響半導體業 {{ind.半導體業.ew|sg2}}%。').rules.R22, 'fail');
  const soft = link('費半 {{gl.^SOX.chgPct|sg2}}% 帶動半導體業 {{ind.半導體業.ew|sg2}}%。');
  assert.equal(soft.rules.R22, 'pass');
  assert.ok(soft.warnings.some(w => w.rule === 'R22'));
  assert.equal(link('費半 {{gl.^SOX.chgPct|sg2}}% 與半導體業 {{ind.半導體業.ew|sg2}}% 同向變動，屬可能影響。').rules.R22, 'pass');
  assert.equal(wordCase('權值股導致指數下跌，等權 {{m.ew|sg2}}%。').rules.R22, 'pass', '一般描述段不查 R22');
  const linkage = scenario({ issue: i => { i.linkages[0].text = '費半 {{gl.^SOX.chgPct|sg2}}% 因此將拉升半導體業 {{ind.半導體業.ew|sg2}}%。'; } });
  assert.equal(linkage.res.rules.R22, 'fail');
});

// ── R11 ───────────────────────────────────────────────────────────────────────
test('R11：利多／利空只能對應 M 的 nv.*.label 或 O 規則方向；不一致、缺方向、法律事件、標題級判別一律擋', () => {
  const news = (raw, over, packMut) => scenario({ pack: packMut, issue: (i, p) => reclaim(i, p, 'c6', raw, over) }).res;
  assert.equal(news('其陽（3564）的媒體判別為 {{nv.3564.label|txt}}。', { direction: '利多' }).rules.R11, 'fail', 'label 是利空卻寫利多');
  assert.equal(news('其陽（3564）的媒體判別為 {{nv.3564.label|txt}}。', { direction: '利空' }).rules.R11, 'pass');
  assert.equal(news('其陽（3564）當日 {{st.3564.ret|sg2}}%。', { direction: '利空' }).rules.R11, 'fail', '利空不是 M／O 引用');
  assert.equal(news('聯發科（2454）公告 [ref:mo.2454.C23.dir]。', { direction: '利多' }).rules.R11, 'pass', 'O 規則方向＝利多');
  assert.equal(news('聯發科（2454）公告 [ref:mo.2454.C23.dir]。', { direction: '利空' }).rules.R11, 'fail');
  assert.equal(news('聯發科（2454）公告 [ref:mo.2454.C23.dir]。', { direction: '需讀內文' }).rules.R11, 'pass');
  assert.equal(news('聯發科（2454）公告 [ref:mo.2454.C23.dir]。', { direction: '利多' }, p => { p.refs['mo.2454.C23.dir'].v = null; }).rules.R11, 'fail', 'O 無規則方向只准寫需讀內文');
  assert.equal(news('其陽（3564）的媒體判別為 {{nv.3564.label|txt}}，屬利空。', { direction: '利空' }).rules.R11, 'pass');
  assert.equal(news('其陽（3564）的媒體判別為 {{nv.3564.label|txt}}，屬利多。', { direction: '利空' }).rules.R11, 'fail', '文字寫利多但 direction 利空');
  assert.equal(news('其陽（3564）媒體判別 [ref:nv.3564.label]，利多與利空並陳。', { direction: '利空' }).rules.R11, 'fail');
  assert.equal(news('其陽（3564）的媒體判別為 {{nv.3564.label|txt}}。', { direction: '利空' }, p => { p.refs['nv.3564.label'].v = '資訊不足'; }).rules.R11, 'fail', '資訊不足不可寫成方向');
  assert.equal(news('其陽（3564）媒體判別 [ref:nv.3564.label] [ref:nv.3564.eventType]。', { direction: '利空' }, p => { p.refs['nv.3564.eventType'].v = '法律事件'; }).rules.R11, 'pass', '法律事件＋利空');
  assert.equal(news('其陽（3564）媒體判別 [ref:nv.3564.label] [ref:nv.3564.eventType]。', { direction: '持平' }, p => { p.refs['nv.3564.eventType'].v = '法律事件'; }).rules.R11, 'fail', '涉法律事件必為利空');
  assert.equal(news('其陽（3564）媒體判別 [ref:nv.3564.label] [ref:nv.3564.basis]。', { direction: '利空' }, p => { p.refs['nv.3564.basis'] = R('title', '文字', 'txt', DATES.data, '媒體'); }).rules.R11, 'fail', '只憑標題不得判方向');
  assert.equal(news('其陽（3564）媒體判別 [ref:nv.3564.label]，尚未反映 [ref:nv.3564.priced]。', { direction: '利空' }, p => { p.refs['nv.3564.priced'] = R('否', '文字', 'txt', DATES.data, '媒體'); }).rules.R11, 'fail', 'priced 不是尚未反映的證據');
});

test('R11：方向詞／漲跌字樣與引用數值的正負號一致', () => {
  const sign = (raw, over, packMut) => scenario({ pack: packMut, issue: (i, p) => reclaim(i, p, 'c3', raw, over) }).res;
  assert.equal(sign('上市等權平均 {{m.ew|sg2}}%。', { direction: '偏弱' }).rules.R11, 'fail');
  assert.equal(sign('上市等權平均 {{m.ew|sg2}}%。', { direction: '偏強' }).rules.R11, 'pass');
  assert.equal(sign('上市等權平均 {{m.ew|sg2}}%。', { direction: '偏強' }, p => { p.refs['m.ew'].v = -0.3; }).rules.R11, 'fail');
  assert.equal(sign('上市等權下跌 {{m.ew|sg2}}%。', { direction: '無' }).rules.R11, 'fail', '文字寫下跌但數值為正');
  assert.equal(sign('上市等權上漲 {{m.ew|sg2}}%。', { direction: '無' }).rules.R11, 'pass');
  const neg = p => { p.refs['ix.pts'].v = -12.34; };
  assert.equal(sign('權值股拖累 {{ix.pts|pts1}} 點。', { direction: '拖累' }, neg).rules.R11, 'pass', 'ix.pts 為負、拖累一致');
  assert.equal(sign('權值股拉抬 {{ix.pts|pts1}} 點。', { direction: '拉抬' }, neg).rules.R11, 'fail');
  assert.equal(sign('權值股拖累 {{ix.pts|pts1}} 點。', { direction: '拖累' }).rules.R11, 'fail', 'ix.pts 為正卻寫拖累');
  assert.equal(sign('指數 {{m.ew|sg2}}%，等權 {{br.gapPp|sg2}}pp，上漲但落後。', { direction: '無' }).rules.R11, 'pass', '正負號混合的比較句不做單向判定');
});

// ── R12 ───────────────────────────────────────────────────────────────────────
test('R12：傳聞 ref 的句子必含「傳聞」或「媒體報導」，不得進 headline／points，不得為個股唯一證據', () => {
  const rumor = (packMut, issueMut) => scenario({ pack: p => { p.refs['nv.3564.certainty'].v = '傳聞'; packMut?.(p); }, issue: (i, p) => issueMut(i, p) }).res;
  assert.equal(rumor(null, (i, p) => reclaim(i, p, 'c6', '其陽（3564）的媒體判別為 {{nv.3564.label|txt}} [ref:nv.3564.certainty]。', { direction: '利空', authors: ['industry'] })).rules.R12, 'fail');
  assert.equal(rumor(null, (i, p) => reclaim(i, p, 'c6', '傳聞指其陽（3564）的媒體判別為 {{nv.3564.label|txt}} [ref:nv.3564.certainty]。', { direction: '利空', authors: ['industry'] })).rules.R12, 'pass');
  assert.equal(rumor(null, (i, p) => reclaim(i, p, 'c6', '媒體報導其陽（3564）判別為 {{nv.3564.label|txt}} [ref:nv.3564.certainty]。', { direction: '利空', authors: ['industry'] })).rules.R12, 'pass');
  // tier 傳聞
  const tier = scenario({ pack: p => { p.refs['gl.^SOX.chgPct'].tier = '傳聞'; } });
  assert.equal(tier.res.rules.R12, 'fail');
  // 總結 point 不得引用傳聞，即使有「傳聞」字樣
  const pt = scenario({ pack: p => { p.refs['m.val'].tier = '傳聞'; }, issue: (i, p) => reclaim(i, p, 'c12', '傳聞指兩市成交值 {{m.val|bn1}} 億元。', {}) });
  assert.ok(hits(pt.res, 'R12').some(h => /summary/.test(h.msg)));
  // 個股證據全是傳聞
  const ev = scenario({ pack: p => { for (const k of Object.keys(p.refs)) if (k.startsWith('st.2330.')) p.refs[k].tier = '傳聞'; } });
  assert.ok(ev.res.blockers.some(b => b.rule === 'R12' && b.code === '2330'));
});

// ── R13 ───────────────────────────────────────────────────────────────────────
test('R13：M／O 不加總——同句引用 nv.* 與 mo.* 的數值、跨管線合計字樣、利多件數 vs 利空件數', () => {
  const mix = (raw, packMut) => scenario({ pack: packMut, issue: (i, p) => reclaim(i, p, 'c6', raw, { direction: '無', authors: ['industry'] }) }).res;
  const numeric = p => { p.refs['nv.3564.count'] = R(3, '則', 'int', DATES.data, '媒體'); p.refs['mo.3564.C1.count'] = R(2, '則', 'int', DATES.data, '官方'); };
  assert.equal(mix('媒體 {{nv.3564.count|int}} 則與公告 {{mo.3564.C1.count|int}} 則。', numeric).rules.R13, 'fail');
  assert.equal(mix('媒體 {{nv.3564.count|int}} 則。', numeric).rules.R13, 'pass');
  assert.equal(mix('公告 {{mo.3564.C1.count|int}} 則。', numeric).rules.R13, 'pass');
  assert.equal(mix('官方與媒體消息合計共 {{nv.3564.count|int}} 則。', numeric).rules.R13, 'fail');
  assert.equal(mix('利多 {{nv.3564.count|int}} 件，利空 {{mo.3564.C1.count|int}} 件。', numeric).rules.R13, 'fail');
  assert.equal(mix('其陽的媒體判別 [ref:nv.3564.label]，官方公告 [ref:mo.2454.C23.subject] 另列。').rules.R13, 'pass', '各管線質性並列不算加總（非數值、無合計字樣）');
  assert.equal(mix('媒體與公告共 {{m.n|int}} 則 [ref:nv.3564.label] [ref:mo.2454.C23.subject]。').rules.R13, 'fail');
});

// ── R14 ───────────────────────────────────────────────────────────────────────
test('R14：claim.tier＝refs 最低等級；渲染標記；wk／先驗不得唯一依據；連動最高站內整理', () => {
  assert.equal(scenario({ issue: i => { byId(i, 'c3').tier = '官方'; } }).res.rules.R14, 'fail');
  assert.equal(scenario({ issue: i => { byId(i, 'c9').tier = '官方衍生'; } }).res.rules.R14, 'fail');
  assert.equal(scenario({ issue: i => { i.linkages[0].tier = '媒體'; } }).res.rules.R14, 'fail');
  const wkRaw = '半導體鏈 [ref:wk.2330.chain]。';
  const only = scenario({ issue: (i, p) => reclaim(i, p, 'c5', wkRaw) });
  assert.equal(only.res.rules.R14, 'fail');
  assert.ok(hits(only.res, 'R14').some(h => /唯一依據/.test(h.msg)));
  const mix = scenario({ issue: (i, p) => reclaim(i, p, 'c5', '半導體鏈 [ref:wk.2330.chain]，上市等權 {{m.ew|sg2}}%。') });
  assert.equal(mix.res.rules.R14, 'pass');
  assert.ok(byId(mix.issue, 'c5').text.endsWith('（站內整理）'));
  const prior = scenario({ pack: p => { p.refs['m.val'].tier = '先驗·未驗證'; }, issue: (i, p) => reclaim(i, p, 'c5', '兩市成交值 {{m.val|bn1}} 億元。') });
  assert.ok(hits(prior.res, 'R14').some(h => /唯一依據/.test(h.msg)));
  const noMark = scenario({ issue: (i, p) => { reclaim(i, p, 'c5', '半導體鏈 [ref:wk.2330.chain]，上市等權 {{m.ew|sg2}}%。'); byId(i, 'c5').text = byId(i, 'c5').text.replace('（站內整理）', ''); } });
  assert.ok(hits(noMark.res, 'R14').some(h => /標記/.test(h.msg)));
  const comp = scenario({ opts: { companionRules: [{ when: '^m\\.ew$', needs: 'm.capW' }] } });
  assert.equal(comp.res.rules.R14, 'fail', '伴隨 ref 規則（01 R10 類）');
});

// ── R15 ───────────────────────────────────────────────────────────────────────
test('R15：排除表／風險旗標／鎖死／成交值不足不得入名單', () => {
  assert.equal(scenario({ pack: p => { p.excluded.next.push({ code: '2330', reason: '處置' }); } }).res.rules.R15, 'fail');
  assert.equal(scenario({ pack: p => { p.refs['st.2330.flags'].v = '處置'; } }).res.rules.R15, 'fail');
  assert.equal(scenario({ pack: p => { p.refs['st.2330.flags'].v = ['注意', '全額交割']; } }).res.rules.R15, 'fail');
  assert.equal(scenario({ pack: p => { p.refs['st.2330.flags'].v = '新上市'; } }).res.rules.R15, 'fail');
  assert.equal(scenario({ pack: p => { p.refs['st.2330.lockU'] = R(true, '布林', 'txt', DATES.data, '官方'); } }).res.rules.R15, 'fail', '明日卡不得列已鎖死漲停');
  assert.equal(scenario({ pack: p => { p.refs['st.2330.valM'].v = 0.5; } }).res.rules.R15, 'fail', '成交值 0.5 億 < 暫訂門檻 1 億');
  assert.equal(scenario({ pack: p => { p.refs['st.2330.valM'].v = 0.5; }, opts: { minValueBn: 0.3 } }).res.rules.R15, 'pass');
  assert.equal(scenario({ pack: p => { p.refs['st.2330.valM'].v = 0.5; }, opts: { minValueBn: null } }).res.rules.R15, 'pass');
  assert.equal(scenario({ pack: p => { p.refs['st.2330.valM'] = R(50, '百萬', 'int', DATES.data, '官方'); } }).res.rules.R15, 'fail', '百萬→億：0.5 億');
  assert.equal(scenario({ pack: p => { p.refs['st.2330.flags'].v = '無'; } }).res.rules.R15, 'pass');
});

// ── R16 ───────────────────────────────────────────────────────────────────────
test('R16：槽位 |fmt 與 pack 預設不同、或不在封閉清單 → 擋（LLM 無權選 fmt）', () => {
  assert.equal(wordCase('上市等權平均 {{m.ew|int}}%。').rules.R16, 'fail');
  assert.equal(wordCase('上市等權平均 {{m.ew|pct9}}%。').rules.R16, 'fail');
  assert.equal(wordCase('上市等權平均 {{m.ew}}%。').rules.R16, 'pass', '不寫 fmt＝取 pack 預設');
  assert.equal(wordCase('上市等權平均 {{m.ew|sg2}}%。').rules.R16, 'pass');
});

// ── R17 ───────────────────────────────────────────────────────────────────────
test('R17：prev 卡不得引用 asOf>D−1；data 卡不得 >D；next 卡不得引用下一交易日資料（morning 版僅限白名單命名空間）', () => {
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c1', '等權 {{m.ew|sg2}}%。', { direction: '偏強' }) }).res.rules.R17, 'fail', 'prev 卡引用 D 值');
  assert.equal(scenario({ issue: i => { i.cards[0].focus.stocks[0].evidence[0].ref = 'st.2330.ret'; } }).res.rules.R17, 'fail', 'prev 個股證據用 D 值');
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c3', '等權 {{pv.m.ew|sg2}}%。') }).res.rules.R17, 'pass', 'data 卡可引用較早的值');
  assert.equal(scenario({ pack: p => { p.refs['m.ew'].asOf = '2026-10-03'; } }).res.rules.R17, 'fail');
  const nextDay = (edition, ref) => scenario({
    pack: p => { p.edition = edition; p.refs[ref] = R(1.1, '%', 'sg2', DATES.next, '媒體'); },
    issue: (i, p) => { i.edition = edition; reclaim(i, p, 'c8', `若 [ref:${ref}] 的變動延續，開盤後觀察半導體權值股量能。`, { kind: 'conditional' }); },
  }).res;
  assert.equal(nextDay('evening', 'gl.^N225.chgPct').rules.R17, 'fail', 'evening 版 next 卡不得引用 N 日資料');
  assert.equal(nextDay('morning', 'gl.^N225.chgPct').rules.R17, 'pass', 'morning 版可引用 N 日的全球資料');
  assert.equal(nextDay('morning', 'ind.半導體業.open').rules.R17, 'fail', 'morning 版也只限白名單命名空間');
  assert.equal(scenario({ pack: p => { delete p.refs['m.ew'].asOf; } }).res.rules.R17, 'fail', '缺 asOf 無法驗證時點');
});

// ── R18 ───────────────────────────────────────────────────────────────────────
test('R18：總結 refs ⊆ 各卡 refs；point 必須在卡內有共用 ref 的 claim', () => {
  const novel = scenario({ issue: (i, p) => reclaim(i, p, 'c12', '市值加權 {{m.capW|sg2}}%。') });
  assert.equal(novel.res.rules.R18, 'fail');
  assert.ok(hits(novel.res, 'R18').some(h => /未用/.test(h.msg)));
  // 個股名單內用過、但沒有任何 claim 引用的 ref：不算「有對應的 claim」
  const unsupported = scenario({ issue: (i, p) => reclaim(i, p, 'c12', '2330 的成交值 {{st.2330.valM|bn1}} 億元。') });
  assert.equal(unsupported.res.rules.R18, 'fail');
  assert.ok(hits(unsupported.res, 'R18').some(h => /共用 ref/.test(h.msg)));
  // 卡內有人用就算有依據
  const supported = scenario({ issue: (i, p) => { reclaim(i, p, 'c12', '指數貢獻 {{ix.pts|pts1}} 點。', { direction: '拖累' }); reclaim(i, p, 'c5', '指數貢獻 {{ix.pts|pts1}} 點。', { direction: '拖累' }); } });
  assert.equal(supported.res.rules.R18, 'pass');
  assert.equal(scenario({ issue: (i, p) => reclaim(i, p, 'c12', '來源未提供的欄位不推測。') }).res.rules.R18, 'fail', '無 ref 的 point（非 caveat）');
  assert.equal(scenario({ issue: i => { i.summary.headline = '市值加權 {{m.capW|sg2}}%。'; } }).res.rules.R18, 'fail', 'headline 也不得引入新 ref');
});

// ── R20 ───────────────────────────────────────────────────────────────────────
test('R20：簡體、Markdown、emoji、外部連結、單句長度（≤90）、標題長度（≤40）', () => {
  const cases = { 簡體: '这是上市等权平均 {{m.ew|sg2}}%。', 粗體: '**上市**等權平均 {{m.ew|sg2}}%。', 標題: '### 上市等權平均 {{m.ew|sg2}}%。', emoji: '📈 上市等權平均 {{m.ew|sg2}}%。', 連結: '見 https://example.com 等權 {{m.ew|sg2}}%。', 清單: '- 上市等權平均 {{m.ew|sg2}}%。', 豎線: '上市 | 等權平均 {{m.ew|sg2}}%。' };
  for (const [name, raw] of Object.entries(cases)) assert.equal(wordCase(raw).rules.R20, 'fail', name);
  assert.equal(wordCase(`${'測'.repeat(88)}{{m.ew|sg2}}。`).rules.R20, 'fail', '渲染後超過 90 字');
  assert.equal(wordCase(`${'測'.repeat(80)}{{m.ew|sg2}}。`).rules.R20, 'pass');
  assert.equal(scenario({ issue: i => { i.summary.headline = `${'標'.repeat(41)}。`; } }).res.rules.R20, 'fail');
  const multi = wordCase('上市等權平均 {{m.ew|sg2}}%。指數與等權相差 {{br.gapPp|sg2}}pp。');
  assert.equal(multi.rules.R20, 'pass');
  assert.ok(multi.warnings.some(w => w.rule === 'R20' && /一句一檢/.test(w.msg)));
  assert.equal(wordCase('上市等權平均 {{m.ew|sg2}}%，→ 持平。（AI 整理）').rules.R20, 'pass', '箭頭與全形括號不算 emoji');
});

// ── R21 ───────────────────────────────────────────────────────────────────────
test('R21：pack.absent／degraded 的來源不得描述；缺值引用須明寫「來源未提供」；meta 必須揭露降級', () => {
  const absent = (raw, honest) => scenario({ pack: p => { p.absent = ['adrPremium']; }, issue: (i, p) => reclaim(i, p, 'c7', raw, { direction: '無', authors: ['global'] }) }).res;
  assert.equal(absent('台積電 ADR 溢價偏高 [ref:gl.^SOX.chgPct]。').rules.R21, 'fail');
  assert.equal(absent('ADR 溢價資料來源未提供 [ref:gl.^SOX.chgPct]。').rules.R21, 'pass');
  assert.equal(absent('費半 {{gl.^SOX.chgPct|sg2}}%。').rules.R21, 'pass');
  const overnight = (raw, withMeta = true) => scenario({
    pack: p => { p.degraded = ['global:overnight-not-updated']; },
    issue: (i, p) => { reclaim(i, p, 'c7', raw, { direction: '無', authors: ['global'] }); if (!withMeta) i.meta.degraded = []; },
  }).res;
  assert.equal(overnight('隔夜費半 [ref:gl.^SOX.chgPct]。').rules.R21, 'fail');
  assert.equal(overnight('隔夜資料來源未更新 [ref:gl.^SOX.chgPct]。').rules.R21, 'pass');
  assert.equal(overnight('費半 [ref:gl.^SOX.chgPct]。', false).rules.R21, 'fail', 'meta.degraded 未揭露 pack 降級項');
  const chip = scenario({ pack: p => { p.degraded = ['chip:partial']; }, issue: (i, p) => reclaim(i, p, 'c5', '外資買超，成交值 {{m.val|bn1}} 億元。') });
  assert.equal(chip.res.rules.R21, 'fail');
  const media = scenario({ pack: p => { p.degraded = ['news:media-partial']; }, issue: (i, p) => reclaim(i, p, 'c6', '消息面偏多 [ref:nv.3564.label]。', { direction: '無', authors: ['industry'] }) });
  assert.equal(media.res.rules.R21, 'pass');
  assert.ok(media.res.warnings.some(w => w.rule === 'R21'));
  // 缺值引用
  const nullCite = (raw) => scenario({ pack: p => { p.refs['nv.3564.certainty'].v = null; }, issue: (i, p) => reclaim(i, p, 'c6', raw, { direction: '無', authors: ['industry'] }) }).res;
  assert.equal(nullCite('其陽的媒體確定性 [ref:nv.3564.certainty]。').rules.R21, 'fail');
  assert.equal(nullCite('其陽的媒體確定性來源未提供 [ref:nv.3564.certainty]。').rules.R21, 'pass');
  assert.equal(scenario({ issue: i => { i.meta.pack.absent = []; } }).res.rules.R21, 'fail', 'meta.pack.absent 必須與 pack 一致');
});

// ── R23 ───────────────────────────────────────────────────────────────────────
test('R23：同產業 >4 檔 Redact；不足 5 檔無 note 警告；單一提名者過半警告', () => {
  const same = scenario({
    pack: p => { for (const e of p.pools.next) e.industry = '半導體業'; },
    issue: i => { for (const s of i.cards[2].focus.stocks) s.industry = '半導體業'; },
  });
  assert.equal(same.res.pass, true);
  assert.deepEqual(same.res.redactions.filter(r => r.rule === 'R23').map(r => r.code), ['6488'], '第 5 檔超過同產業 4 檔上限');
  const few = scenario({ issue: i => { i.cards[2].focus.stocks = i.cards[2].focus.stocks.slice(0, 3); } });
  assert.ok(few.res.warnings.some(w => w.rule === 'R23' && /<5/.test(w.msg)));
  const withNote = scenario({ issue: i => { i.cards[2].focus.stocks = i.cards[2].focus.stocks.slice(0, 3); i.cards[2].focus.note = '通過查核的候選不足 5 檔，未降低門檻湊數。'; } });
  assert.ok(!withNote.res.warnings.some(w => w.rule === 'R23'));
  const sponsor = scenario({ issue: i => { for (const s of i.cards[2].focus.stocks) s.sponsors = ['momentum']; } });
  assert.ok(sponsor.res.warnings.some(w => w.rule === 'R23' && /momentum/.test(w.msg)));
});

// ── R24 ───────────────────────────────────────────────────────────────────────
test('R24：pack 雜湊、manifest 雜湊、refCount、engineTier 與 analysts.engine 一致', () => {
  const pack = makePack();
  const issue = buildGoodIssue(pack);
  const good = sha256(JSON.stringify(pack));
  assert.equal(checkIssue(issue, pack, { today: TODAY, packSha256: good }).rules.R24, 'pass');
  assert.equal(checkIssue(issue, pack, { today: TODAY, packSha256: 'f'.repeat(64) }).rules.R24, 'fail');
  assert.equal(checkIssue(issue, pack, { today: TODAY, issueSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) }).rules.R24, 'fail');
  assert.equal(checkIssue(issue, pack, { today: TODAY, issueSha256: 'a'.repeat(64), manifestSha256: 'a'.repeat(64) }).rules.R24, 'pass');
  expectOnly(scenario({ issue: i => { i.meta.pack.refCount += 1; } }).res, 'R24');
  expectOnly(scenario({ issue: i => { i.meta.analysts[0].engine = 'ollama'; } }).res, 'R24');
  expectOnly(scenario({ issue: i => { i.meta.engineTier = 'ollama'; } }).res, 'R24');
  assert.equal(scenario({ issue: i => { i.meta.engineTier = 'template'; i.meta.analysts = []; i.meta.fallback = null; } }).res.rules.R24, 'fail');
  assert.equal(scenario({ issue: i => { i.meta.engineTier = 'template'; i.meta.analysts = []; i.meta.fallback = 'template'; } }).res.rules.R24, 'pass');
});

// ── R25 ───────────────────────────────────────────────────────────────────────
test('R25：渲染層每張卡底部必須輸出程式常數的免責短版（未提供 rendered＝skip）', () => {
  const D = K.DISCLAIMER_SHORT;
  assert.equal(scenario().res.rules.R25, 'skip');
  assert.equal(scenario({ opts: { rendered: `${D}\n${D}\n${D}` } }).res.rules.R25, 'pass');
  assert.equal(scenario({ opts: { rendered: `${D}\n${D}` } }).res.rules.R25, 'fail');
  assert.equal(scenario({ opts: { rendered: [D, D, D] } }).res.rules.R25, 'pass');
  assert.equal(scenario({ opts: { rendered: [D, '非投資建議', D] } }).res.rules.R25, 'fail');
  assert.equal(scenario({ opts: { rendered: { prev: D, data: D, next: D } } }).res.rules.R25, 'pass');
  assert.equal(scenario({ opts: { rendered: { prev: D, data: D, next: '' } } }).res.rules.R25, 'fail');
  assert.equal(scenario({ opts: { rendered: 42 } }).res.rules.R25, 'fail');
});

// ── applyRedactions ───────────────────────────────────────────────────────────
test('applyRedactions：刪個股／刪 claim（含總結）、補不足原因、記入 meta.check.redactions、不改輸入；套用後再查通過', () => {
  const { issue, pack, res } = scenario({ issue: i => { nextStock(i, 2).risks = [{ text: '須留意追價風險。', refs: [] }]; i.cards[2].focus.stocks.push(clone(nextStock(i, 0))); } });
  assert.equal(res.redactions.length, 2);
  const snapshot = JSON.stringify(issue);
  const out = applyRedactions(issue, res.redactions);
  assert.equal(JSON.stringify(issue), snapshot, '不改輸入');
  const stocks = out.cards[2].focus.stocks;
  assert.deepEqual(stocks.map(s => s.code), ['2330', '2317', '2603', '6488'], '重複的後一檔與 3564（反證未涵蓋）被刪；先出現的 2330 保留');
  assert.ok(out.cards[2].focus.note.includes('未通過程式查核'), '不足 5 檔補固定原因，不補列');
  assert.equal(out.meta.check.redactions.length, 2);
  assert.ok(out.meta.check.redactions.every(r => r.rule && r.code));
  const again = checkIssue(out, pack, { today: TODAY });
  assert.equal(again.pass, true);
  assert.deepEqual(again.redactions, []);

  // claim 型：由 blocker 的 claimId 轉成 redaction 刪除（W3 的「裁掉違規 claim」）
  const bad = scenario({ issue: (i, p) => reclaim(i, p, 'c5', '建議買進，等權 {{m.ew|sg2}}%。') });
  assert.equal(bad.res.pass, false);
  const cut = applyRedactions(bad.issue, bad.res.blockers.filter(b => b.claimId).map(b => ({ rule: b.rule, claimId: b.claimId })));
  assert.ok(!byId(cut, 'c5'));
  assert.equal(checkIssue(cut, bad.pack, { today: TODAY }).pass, true);
  const sum = applyRedactions(bad.issue, [{ rule: 'R09', claimId: 'c12' }]);
  assert.equal(sum.summary.points.length, 2);
  assert.equal(applyRedactions(bad.issue, []).summary.points.length, 3);
  assert.deepEqual(applyRedactions(null, null), {});
});

test('applyRedactions：cardId 限定只刪該卡的個股', () => {
  const { issue } = scenario();
  const out = applyRedactions(issue, [{ rule: 'R06', code: '2330', cardId: 'next' }]);
  assert.equal(out.cards[2].focus.stocks.some(s => s.code === '2330'), false);
  assert.equal(out.cards[0].focus.stocks.some(s => s.code === '2330'), true, 'prev 卡的 2330 不受影響');
});

// ── 壞 issue 彙整：一組壞 fixtures 驗證查核結果 ────────────────────────────────
test('壞 issue fixtures：每一種違規都被對應規則抓到，且好 issue 不受牽連', () => {
  const table = [
    ['R01', i => { byId(i, 'c1').kind = 'opinion'; }],
    ['R02', i => { i.useRules.usedForScoring = true; }],
    ['R03', (i, p) => reclaim(i, p, 'c3', '等權 0.57% [ref:m.ew]。')],
    ['R04', i => { byId(i, 'c3').refs = []; }],
    ['R05', (i, p) => reclaim(i, p, 'c3', '2026-10-03 等權 {{m.ew|sg2}}%。')],
    ['R06', i => { nextStock(i).code = '9999'; }],
    ['R07', i => { nextStock(i).evidence = []; }],
    ['R08', i => { nextStock(i, 2).risks = [{ text: '風險。', refs: [] }]; }],
    ['R09', (i, p) => reclaim(i, p, 'c3', '建議買進 {{m.ew|sg2}}%。')],
    ['R10', (i, p) => reclaim(i, p, 'c3', '等權將上漲 {{m.ew|sg2}}%。')],
    ['R11', i => { byId(i, 'c6').direction = '利多'; }],
    ['R14', i => { byId(i, 'c3').tier = '官方'; }],
    ['R16', (i, p) => reclaim(i, p, 'c3', '等權 {{m.ew|int}}%。')],
    ['R17', (i, p) => reclaim(i, p, 'c1', '等權 {{m.ew|sg2}}%。', { direction: '偏強' })],
    ['R18', (i, p) => reclaim(i, p, 'c12', '市值加權 {{m.capW|sg2}}%。')],
    ['R19', (i, p) => reclaim(i, p, 'c3', '評分偏高 {{m.ew|sg2}}%。')],
    ['R20', (i, p) => reclaim(i, p, 'c3', '这是等权 {{m.ew|sg2}}%。')],
    ['R24', i => { i.meta.pack.refCount = 1; }],
  ];
  for (const [rule, mut] of table) {
    const { res } = scenario({ issue: mut });
    assert.ok(res.rules[rule] === 'fail', `${rule} 應失敗：${JSON.stringify(failed(res))}`);
  }
  assert.equal(scenario().res.pass, true);
});
