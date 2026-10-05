import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleIssue, dropByIds, runDesk, produceIssue, editorToLoose } from './desk.mjs';
import { extractJson, EngineAuthError } from './engine.mjs';
import { deskChecks } from './desk-checks.mjs';
import { packToText, poolsToText, promptSha } from './prompts.mjs';

const stock = (code, name) => ({ code, name, market: '上市', industry: '半導體業', from: ['board.gainers'] });
const PACK = {
  schema: 1, kind: 'analystPack', dataDate: '2026-10-02', edition: 'evening',
  dates: { prev: '2026-10-01', data: '2026-10-02', next: '2026-10-05' },
  refs: {
    'm.ew': { v: 0.57, unit: '%', fmt: 'sg2', asOf: '2026-10-02', tier: '官方衍生', source: '熱力', label: '上市等權' },
    'st.2330.close': { v: 1800, unit: '元', fmt: 'int', asOf: '2026-10-02', tier: '官方', source: '收盤', label: '台積電收盤' },
    'st.2330.ret': { v: 1.2, unit: '%', fmt: 'sg2', asOf: '2026-10-02', tier: '官方', source: '收盤', label: '台積電漲幅' },
    'nv.2330.label': { v: '利空', unit: '文字', fmt: 'txt', asOf: '2026-10-02', tier: '媒體', source: '判別', label: '媒體判別' },
    'st.2330.prevClose': { v: 1790, unit: '元', fmt: 'txt', asOf: '2026-10-01', tier: '官方', source: '收盤', label: '前一交易日收盤' },
    'st.2330.valM': { v: 39508, unit: '百萬', fmt: 'int', asOf: '2026-10-02', tier: '官方衍生', source: '熱力', label: '成交值（百萬元）' },
    'wk.2330.chain': { v: 'AI 供應鏈', unit: '文字', fmt: 'txt', asOf: '2026-10-02', tier: 'AI待驗', source: 'wiki', label: 'wiki' },
  },
  pools: { prev: [stock('2330', '台積電')], data: [stock('2330', '台積電')], next: [stock('2330', '台積電')] },
  excluded: { prev: [], data: [{ code: '1101', reason: '處置' }], next: [] },
  adverse: { 2330: ['nv.2330.label'] }, absent: ['adrPremium'], degraded: [],
};
const claim = (id, raw, extra = {}) => ({ id, card: 'data', section: 'overview', raw, refs: [], kind: 'fact', direction: '偏強', ...extra });
const EDITOR = {
  summary: { headline: '等權 {{m.ew|sg2}}%', points: [claim('p1', '上市等權平均 {{m.ew|sg2}}%')], nextFocus: [], risks: [] },
  cards: [{ id: 'data', sections: [{ id: 'overview', analyst: 'momentum', claims: [claim('a', '上市等權平均 {{m.ew|sg2}}%'), claim('b', '台積電漲 {{st.2330.ret|sg2}}% [ref:wk.2330.chain]')] }],
    focus: { stocks: [{ code: '2330', thesis: '收盤漲幅 {{st.2330.ret|sg2}}%', evidence: [{ ref: 'st.2330.ret', role: 'price' }], watchConditions: [], risks: [{ text: '媒體判別 [ref:nv.2330.label]', refs: [] }], sponsors: ['momentum'] }], focusNote: '' } }],
  linkages: [],
};
const passCheck = { checkIssue: () => ({ pass: true, blockers: [], redactions: [], warnings: [], rules: { R01: 'pass' } }), applyRedactions: i => i };

function fakeCall(handlers) {
  const calls = [];
  const fn = async o => { calls.push(`${o.role}${o.round ? '.' + o.round : ''}`); const h = handlers[o.role] ?? handlers['*']; const v = typeof h === 'function' ? h(o) : h; if (v instanceof Error) throw v; return { text: JSON.stringify(v), json: v, model: 'fake', usage: { in: 1, out: 1 } }; };
  fn.calls = calls; return fn;
}

test('extractJson 容忍柵欄、前後說明與巢狀字串', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a":{"b":"}"}}\n```'), { a: { b: '}' } });
  assert.deepEqual(extractJson('{"x":1} 以上'), { x: 1 });
  assert.equal(extractJson('沒有 JSON'), null);
  assert.equal(extractJson('{"a":'), null);
});

test('assembleIssue：LLM 不可寫的欄位由程式重算', () => {
  const evil = { ...EDITOR, useRules: { usedForScoring: true }, cards: [{ ...EDITOR.cards[0], title: '假標題', focus: { stocks: [{ ...EDITOR.cards[0].focus.stocks[0], adverse: [] }, { code: '9999', thesis: '池外' }] } }] };
  const issue = assembleIssue(evil, PACK, { engineTier: 'claude' });
  assert.equal(issue.useRules.usedForScoring, false);
  const d = issue.cards.find(c => c.id === 'data');
  assert.match(d.title, /^今日盤後（/);
  const s = d.focus.stocks[0];
  assert.deepEqual(s.adverse, ['nv.2330.label']);               // adverse 由 pack 帶入，LLM 不能刪
  assert.equal(s.name, '台積電');
  assert.equal(d.focus.stocks[1].name, '');                       // 池外個股名稱留空，交給 R06 擋
  assert.equal(d.focus.kind, 'recap'); assert.equal(issue.cards.find(c => c.id === 'next').focus.kind, 'watch');
  assert.equal(d.focus.excludedCount, 1);
});

test('assembleIssue：claim 的 text／refs／tier 由 raw 重算（含 AI待驗 標記）', () => {
  const issue = assembleIssue(EDITOR, PACK, { engineTier: 'claude' });
  const [a, b] = issue.cards.find(c => c.id === 'data').sections[0].claims;
  assert.equal(a.text, '上市等權平均 +0.57%');
  assert.deepEqual(a.refs, ['m.ew']);
  assert.equal(a.tier, '官方衍生');
  assert.deepEqual(b.refs, ['st.2330.ret', 'wk.2330.chain']);
  assert.equal(b.tier, 'AI待驗');
  assert.match(b.text, /（AI待驗）$/);
  assert.ok(issue.refTable['wk.2330.chain'] && issue.refTable['m.ew']);   // refTable 只含被引用的
  assert.equal(issue.refTable['st.2330.close'].v, 1800);                  // 個股 asOf.closeRef 也要進
});

test('runDesk：R1 三稿＋R2 三審＋總編輯＋紅隊，查核過就不修稿', async () => {
  const call = fakeCall({ momentum: { claims: [claim('x', '{{m.ew|sg2}}')], focusProposals: [] }, industry: { claims: [], focusProposals: [] }, global: { claims: [], focusProposals: [] }, editor: EDITOR, redteam: { findings: [] } });
  const r = await runDesk({ pack: PACK, engine: 'claude-cli', callModel: call, check: passCheck, todayISO: '2026-10-05' });
  assert.equal(r.issue.meta.check.pass, true);
  assert.equal(r.issue.meta.check.repairRounds, 0);
  assert.equal(call.calls.filter(c => c === 'editor').length, 1);
  assert.equal(call.calls.filter(c => c.endsWith('.r2')).length, 3);
  assert.equal(r.issue.meta.analysts.length, 3);
});

test('runDesk：blocker 退回總編輯修稿 ≤2 輪，之後由程式刪稿', async () => {
  const check = { checkIssue: iss => { const bad = iss.cards[1].sections[0]?.claims.find(c => c.id === 'c2'); return bad ? { pass: false, blockers: [{ rule: 'R10', claimId: 'c2', msg: '預測句' }], redactions: [], warnings: [], rules: {} } : { pass: true, blockers: [], redactions: [], warnings: [], rules: {} }; }, applyRedactions: i => i };
  const call = fakeCall({ '*': { claims: [], focusProposals: [], crossNotes: [], linkages: [], vetoes: [], findings: [] }, editor: EDITOR, redteam: { findings: [] } });
  const r = await runDesk({ pack: PACK, engine: 'claude-cli', callModel: call, check, todayISO: '2026-10-05' });
  assert.equal(r.issue.meta.check.repairRounds, 2);
  assert.equal(call.calls.filter(c => c.startsWith('editor')).length, 3);   // 1 初稿＋2 修稿
  assert.equal(r.issue.meta.check.pass, true);                              // 仍違規的 c2 被程式刪掉後通過
  assert.ok(!r.issue.cards[1].sections[0].claims.some(c => c.id === 'c2'));
});

test('runDesk：紅隊指到的 claim 會被退回並（修不好時）刪除', async () => {
  const call = fakeCall({ '*': { claims: [], focusProposals: [], crossNotes: [], linkages: [], vetoes: [] }, editor: EDITOR, redteam: { findings: [{ claimId: 'c1', kind: 'advice', msg: '暗示買賣' }] } });
  const r = await runDesk({ pack: PACK, engine: 'claude-cli', callModel: call, check: passCheck, todayISO: '2026-10-05' });
  assert.ok(r.issue.meta.check.repairRounds >= 1);
  assert.equal(r.issue.meta.editor.redTeam.findings, 1);
});

test('runDesk：三位分析師全失敗＝拋錯；單一失敗＝該角色標錯、其他照發', async () => {
  const dead = fakeCall({ '*': new Error('boom'), editor: EDITOR });
  await assert.rejects(runDesk({ pack: PACK, engine: 'claude-cli', callModel: dead, check: passCheck }), /皆無有效稿件/);
  const one = fakeCall({ momentum: new Error('x'), industry: { claims: [], focusProposals: [] }, global: { claims: [], focusProposals: [] }, editor: EDITOR, redteam: { findings: [] } });
  const r = await runDesk({ pack: PACK, engine: 'claude-cli', callModel: one, check: passCheck });
  assert.ok(r.issue.meta.analysts.find(a => a.id === 'momentum').error);
});

test('produceIssue：401 → 退 ollama（忙碌則讓路）→ 模板殼，meta 誠實標示', async () => {
  const auth = fakeCall({ '*': new EngineAuthError('401') });
  const r = await produceIssue({ pack: PACK, engines: ['claude-cli', 'ollama'], callModel: auth, check: passCheck, signalsDir: '/nonexistent-no-signal' });
  assert.equal(r.engineUsed, 'template');
  assert.equal(r.issue.meta.fallback, 'template');
  assert.equal(r.issue.cards.length, 0);
  assert.ok(r.errors.some(e => e.engine === 'claude-cli' && e.auth));
  assert.ok(r.issue.meta.degraded.includes('engine:claude-cli:failed'));
});

test('dropByIds 同時處理 claim 與個股代號', () => {
  const issue = assembleIssue(EDITOR, PACK, { engineTier: 'claude' });
  const out = dropByIds(issue, [issue.summary.points[0].id, '2330']);
  assert.equal(out.cards[1].focus.stocks.length, 0);
  assert.equal(out.summary.points.length, 0);
});

test('prompts：packToText 依前綴過濾、poolsToText 列出 adverse、promptSha 穩定', () => {
  const t = packToText(PACK, ['m']);
  assert.match(t, /^m\.ew \| 0\.57 %/); assert.ok(!t.includes('st.2330'));
  assert.match(poolsToText(PACK), /反向 refs.*2330: nv\.2330\.label/);
  assert.equal(promptSha('a'), promptSha('a'));
});

test('槽位 fmt LLM 無權選：一律改寫成 pack 預設（R16）', () => {
  const ed = { ...EDITOR, cards: [{ id: 'data', sections: [{ id: 'overview', analyst: 'momentum', claims: [claim('a', '收盤 {{st.2330.close|pts1}} 元、成交 {{st.2330.valM|bn1}}')] }], focus: { stocks: [] } }] };
  const c = assembleIssue(ed, PACK, { engineTier: 'claude' }).cards.find(x => x.id === 'data').sections[0].claims[0];
  assert.equal(c.raw, '收盤 {{st.2330.close|int}} 元、成交 {{st.2330.valM|int}}'.replace('close|int', 'close|' + PACK.refs['st.2330.close'].fmt));
  assert.match(c.text, /39,508/);
});

test('個股：prev 卡只用 D−1 的收盤 ref；next 卡缺觀察條件時由程式補成交值延續（單位百萬元）', () => {
  const bare = { code: '2330', thesis: '事實', evidence: [], watchConditions: [{ text: '看看', refs: [] }], risks: [], sponsors: ['momentum'] };
  const ed = { summary: {}, linkages: [], cards: ['prev', 'next'].map(id => ({ id, sections: [], focus: { stocks: [bare] } })) };
  const issue = assembleIssue(ed, PACK, { engineTier: 'claude' });
  const prev = issue.cards.find(c => c.id === 'prev').focus.stocks[0];
  const next = issue.cards.find(c => c.id === 'next').focus.stocks[0];
  assert.equal(prev.asOf.closeRef, 'st.2330.prevClose');
  assert.equal(prev.evidence[0].ref, 'st.2330.prevClose');
  assert.equal(next.asOf.closeRef, 'st.2330.close');
  assert.match(next.watchConditions.at(-1).text, /成交值是否延續前一交易日水準$/);
  assert.deepEqual(next.watchConditions.at(-1).refs, ['st.2330.valM']);
  assert.ok(next.risks.length >= 1);                       // adverse 或保底風險句
});

test('sponsors 由 R1 提名記錄決定；池內補選者署名 editor', () => {
  const st = code => ({ code, thesis: '事實', evidence: [], watchConditions: [], risks: [], sponsors: ['global'] });
  const ed = { summary: {}, linkages: [], cards: [{ id: 'data', sections: [], focus: { stocks: [st('2330')] } }] };
  const a = assembleIssue(ed, PACK, { engineTier: 'claude', nominated: { 'data:2330': ['industry', 'momentum'] } });
  assert.deepEqual(a.cards.find(c => c.id === 'data').focus.stocks[0].sponsors, ['momentum', 'industry']);
  const b = assembleIssue({ ...ed, cards: [{ id: 'data', sections: [], focus: { stocks: [{ ...st('2330'), sponsors: [] }] } }] }, PACK, { engineTier: 'claude', nominated: {} });
  assert.deepEqual(b.cards.find(c => c.id === 'data').focus.stocks[0].sponsors, ['editor']);
});

test('修稿回送只含含槽位的原文，不含渲染後的數字', () => {
  const issue = assembleIssue(EDITOR, PACK, { engineTier: 'claude' });
  const loose = editorToLoose(issue);
  const blob = JSON.stringify(loose);
  assert.match(blob, /\{\{m\.ew\|sg2\}\}/);
  assert.ok(!/0\.57/.test(blob) && !/\+0\.57/.test(blob));
});

test('linkage 的等級取引用 refs 的最弱者；dropByIds 也能刪連動', () => {
  const ed = { ...EDITOR, linkages: [{ id: 'x', from: { ref: 'wk.2330.chain' }, to: { ref: 'm.ew' }, mechanism: '同業連動', text: '相關 [ref:wk.2330.chain][ref:m.ew]', refs: [], authors: ['global', 'industry'] }] };
  const issue = assembleIssue(ed, PACK, { engineTier: 'claude' });
  assert.equal(issue.linkages[0].tier, 'AI待驗');
  assert.equal(dropByIds(issue, ['l1']).linkages.length, 0);
});

test('D01：引用 df.* 的句子沒有變化語氣＝疑把差值當水準；direction 需讀內文只留給官方公告', () => {
  const pack = { ...PACK, refs: { ...PACK.refs, 'df.ch.tse.foreignBn': { v: -195.6, unit: '億', fmt: 'sg2', asOf: '2026-10-02', tier: '官方', source: '籌碼', label: '外資買賣超（較前一交易日）' } } };
  const ed = { summary: {}, linkages: [], cards: [{ id: 'data', sections: [{ id: 'overview', analyst: 'momentum', claims: [
    claim('a', '外資買賣超 {{df.ch.tse.foreignBn|sg2}} 億', { direction: '需讀內文' }),
    claim('b', '外資買賣超較前一交易日 {{df.ch.tse.foreignBn|sg2}} 億', { direction: '需讀內文' })] }], focus: { stocks: [] } }] };
  const issue = assembleIssue(ed, pack, { engineTier: 'claude' });
  const bad = deskChecks(issue);
  assert.equal(bad.length, 1); assert.equal(bad[0].rule, 'D01');
  assert.equal(issue.cards.find(c => c.id === 'data').sections[0].claims[0].direction, '無');
});
