import test from 'node:test';
import assert from 'node:assert/strict';
import { toIsoDate, parseMiIndex, isCommonStock, num } from './inputs.mjs';
import { limitsFromRef, computeHeatmap, tickOf } from './compute.mjs';
import { computeIndexContribution, residualGrade } from './index-contrib.mjs';
import { groupStats, zscores } from './stats.mjs';
import { evaluateGates } from './gates.mjs';

test('toIsoDate：民國／西元各寫法', () => {
  assert.equal(toIsoDate('115年10月02日 外資及陸資投資持股統計'), '2026-10-02');
  assert.equal(toIsoDate('115/10/02'), '2026-10-02');
  assert.equal(toIsoDate('115.10.01'), '2026-10-01');
  assert.equal(toIsoDate('1151003'), '2026-10-03');
  assert.equal(toIsoDate('20261002'), '2026-10-02');
  assert.equal(toIsoDate('abc'), null);
});

test('isCommonStock／num', () => {
  for (const c of ['2330', '6488', '1101']) assert.ok(isCommonStock(c));
  for (const c of ['0050', '00400A', '2882A', '9101', '020001', '911622']) assert.ok(!isCommonStock(c), c);
  assert.equal(num('1,234.5'), 1234.5);
  assert.equal(num('--'), null);
  assert.equal(num('X'), null);
});

test('limitsFromRef：升降單位與官方一致（TPEx 4806 實例 ref 14.85 → 跌停 13.4）', () => {
  assert.deepEqual(limitsFromRef(100), { up: 110, down: 90 });
  assert.equal(limitsFromRef(14.85).down, 13.4);
  assert.equal(limitsFromRef(1085).up, 1190);
  assert.equal(tickOf(9.99), 0.01);
  assert.equal(tickOf(1000), 5);
  assert.deepEqual(limitsFromRef(null), { up: null, down: null });
});

test('parseMiIndex：指數符號、漲跌百分比為 -- 仍可用點數', () => {
  const entry = { payload: { tables: [
    { title: '115年10月02日 價格指數(臺灣證券交易所)', data: [['發行量加權股價指數', '48,475.74', "<p style ='color:green'>-</p>", '122.25', '--', '']] },
    { title: '115年10月02日 每日收盤行情(全部)', data: [['2330', '台積電', '1', '1', '2,500', '1', '1', '1', '2,500', 'x', '0']] },
  ] } };
  const p = parseMiIndex(entry);
  assert.equal(p.index.change, -122.25);
  assert.equal(p.rows.get('2330').close, 2500);
  assert.equal(p.titleDay, '2026-10-02');
});

const row = (code, close, pa, shares, extra = {}) => ({ code, name: code, close, pa, ref: pa, shares, sharesSrc: 't187', listDays: 999, ...extra });

test('指數貢獻：Σ貢獻＝官方漲跌（理想資料殘差 0）；權重加總 1', () => {
  const rows = [row('1000', 110, 100, 1000), row('2000', 45, 50, 2000), row('3000', 10, 10, 5000)];
  const prevIdx = 10000;
  const totalPrev = 100 * 1000 + 50 * 2000 + 10 * 5000, totalNow = 110 * 1000 + 45 * 2000 + 10 * 5000;
  const change = prevIdx * (totalNow - totalPrev) / totalPrev;
  const r = computeIndexContribution({ rows, index: { close: prevIdx + change, change } });
  assert.ok(Math.abs(r.residualPts) < 0.01);
  assert.equal(r.grade, '綠');
  assert.ok(Math.abs(r.top.reduce((s, x) => s + x.wPrev, 0) - 100) < 0.2);
});

test('指數貢獻：除息日用前收基期（價格指數不調整現金股利），除息機械影響另列', () => {
  // 參考價 90（除息 10），收盤 90：個股「報酬」0，但指數貢獻為 (90-100)×股數
  const rows = [row('1000', 90, 100, 1000, { ref: 90 }), row('2000', 50, 50, 1000)];
  const prevIdx = 1000;
  const change = prevIdx * ((90 - 100) * 1000) / (100 * 1000 + 50 * 1000);
  const r = computeIndexContribution({ rows, index: { close: prevIdx + change, change } });
  assert.ok(Math.abs(r.residualPts) < 0.01, `殘差 ${r.residualPts}`);
  assert.ok(r.exDivMechanicalPts < 0);
  assert.equal(r.exDivFlag, true);
});

test('指數貢獻：分割（參考價/前收差 >10%）改用參考價基期；新上市未滿 25 日、無股數、無基期被排除', () => {
  const rows = [
    row('1000', 26, 78, 3000, { ref: 26 }),            // 3 比 1 分割且股數已更新
    row('2000', 50, 50, 1000),
    row('3000', 100, 100, 1000, { listDays: 3 }),       // 新上市
    row('4000', 10, 10, null),                           // 無股數
    row('5000', 10, null, 1000),                         // 無基期
  ];
  const r = computeIndexContribution({ rows, index: { close: 1000, change: 0 } });
  assert.equal(r.included, 2);
  assert.deepEqual(r.excluded, { noShares: 1, noBase: 1, newListing: 1 });
  assert.ok(Math.abs(r.contributors.find(x => x.code === '1000').pts) < 1e-9);
});

test('指數貢獻：|指數漲跌|<0.3% 不輸出占比；殘差分級', () => {
  const rows = [row('1000', 100.1, 100, 1000), row('2000', 50, 50, 1000)];
  const r = computeIndexContribution({ rows, index: { close: 10000.4, change: 0.4 } });
  assert.equal(r.splits.every(s => s.shareOfChange === null), true);
  assert.equal(residualGrade(0.5), '綠');
  assert.equal(residualGrade(2), '黃');
  assert.equal(residualGrade(-4), '紅');
});

test('groupStats／zscores', () => {
  const mk = (code, ret, o = {}) => ({ code, ret, val: 1e8, cap: 1e10, lu: false, ld: false, lockU: false, inst: null, close: 10, ...o });
  const g = groupStats([mk('1', 3), mk('2', 1), mk('3', -1), mk('4', 2, { lu: true })], { ew: 0, sigma: 2, cap: 4e10, val: 4e8 });
  assert.equal(g.n, 4); assert.equal(g.up, 3); assert.equal(g.dn, 1); assert.equal(g.luN, 1);
  assert.ok(Math.abs(g.ew - 1.25) < 1e-9);
  assert.equal(g.netInstNtd, null);
  assert.deepEqual(zscores([5, 5, 5]), [0, 0, 0]);
});

function inputs() {
  const mi = (c, close, val = 5e8) => [c, { code: c, name: `N${c}`, close, high: close, low: close, val }];
  const codesT = ['1101', '1102', '1103', '1104', '1105', '1106', '1107', '1108', '1109', '1110'];
  const rowsT = new Map(codesT.map((c, i) => mi(c, 100 + i)));
  const refT = new Map(codesT.map(c => [c, { limitUp: 120, ref: 100, limitDown: 80, prevClose: 100, lastDeal: null }]));
  const tp = (c, close, ref) => [c, { code: c, name: `O${c}`, close, chg: close - ref, chgText: '', open: close, high: close, low: close, vol: 1, val: 5e8, shares: 1e8, nextRef: ref, nextLimitUp: ref * 1.1, nextLimitDown: ref * 0.9 }];
  const codesO = ['6101', '6102', '6103', '6104', '6105', '6106', '6107', '6108', '6109'];
  const tpexRows = new Map(codesO.map((c, i) => tp(c, 50 + i, 50)));
  const tpexPrev = new Map(codesO.map(c => [c, { close: 50, nextRef: 50, nextLimitUp: 55, nextLimitDown: 45 }]));
  const stocks = new Map([...codesT, ...codesO].map(c => [c, { name: c, market: '上市', industry: c.startsWith('11') ? '水泥工業' : '金融業', chains: [], group: null, families: [], upstream: [], downstream: [] }]));
  return {
    date: '2026-10-02', wiki: { generatedAt: 'x', stocks },
    mi: { rows: rowsT, index: { close: 10100, change: 100 }, breadth: null, officialStockValue: null, titleDay: '2026-10-02' },
    ref: { rows: refT, titleDay: '2026-10-02' }, qfiis: { rows: new Map(codesT.map(c => [c, { shares: 1e8 }])), titleDay: '2026-10-02' },
    t187: null, tpex: { rows: tpexRows, titleDay: '2026-10-02' }, tpexPrev: { rows: tpexPrev }, miPrev: null, inst: null,
    tradingDates: ['2026-10-01', '2026-10-02'],
  };
}

test('computeHeatmap：確定性、不含分數類欄位名、金融業併入金融保險業、無 Map 外洩', () => {
  const a = computeHeatmap(inputs()), b = computeHeatmap(inputs());
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const keys = new Set();
  JSON.stringify(a, (k, v) => { if (k) keys.add(k); return v; });
  for (const k of keys) assert.ok(!/score|signal|buy|rank/i.test(k), `禁用欄位名 ${k}`);
  assert.equal(a.useRules.usedForScoring, false);
  assert.ok(a.industries.some(x => x.key === '金融保險業'));
  assert.ok(!a.industries.some(x => x.key === '金融業'));
  // 上櫃 6107～6109 報酬 >10.5%（無漲跌幅限制或異常）不進統計：10 上市 + 6 上櫃
  assert.equal(a.market.n, 16);
  assert.equal(a.universe.unlimited.length, 3);
  assert.ok(a.watch.continue.concat(a.watch.catchup, a.watch.risk).every(w => w.usedForScoring === false));
});

test('computeHeatmap：wiki 連動欄位（chains／group／families）不影響核心數字（A9 白名單）', () => {
  const base = computeHeatmap(inputs());
  const inp = inputs();
  for (const [i, w] of [...inp.wiki.stocks.values()].entries()) { w.chains = [{ name: `C${i % 3}`, role: '上游', label: 'x' }]; w.group = `G${i % 2}`; w.families = [`F${i % 4}`]; }
  const alt = computeHeatmap(inp);
  const core = o => JSON.stringify({ market: o.market, industries: o.industries, index: o.index, breadth: o.breadth, universe: o.universe });
  assert.equal(core(alt), core(base));
  assert.ok(alt.layers.chains.length > 0);
  const ind = alt.industries.find(x => x.key === '水泥工業');
  assert.equal(ind.members.length, ind.n);
  assert.ok(ind.members.every((m, i, a) => i === 0 || a[i - 1].ret >= m.ret), '成分股依報酬由高到低');
  assert.ok(ind.members.every(m => m.code && m.name && m.resonance === null));
});

test('evaluateGates：缺輸入、回聲日不符、殘差過大、上櫃殘缺都不定版', () => {
  const inp = inputs();
  const result = computeHeatmap(inp);
  const ds = k => ({ final: true, echo: '2026-10-02', file: k });
  const parsed = { mi: inp.mi, ref: inp.ref, qfiis: inp.qfiis, tpex: inp.tpex };
  const full = { mi: ds('a'), ref: ds('b'), qfiis: ds('c'), tpex: ds('d') };
  const g0 = evaluateGates({ date: '2026-10-02', datasets: full, parsed, result, hasWiki: true });
  assert.ok(g0.hard.some(h => /上市有效個股/.test(h)), '小宇宙應被覆蓋率閘門擋下');
  const g1 = evaluateGates({ date: '2026-10-02', datasets: { ...full, tpex: null }, parsed, result, hasWiki: true });
  assert.ok(g1.hard.includes('缺輸入：tpex'));
  const g2 = evaluateGates({ date: '2026-10-02', datasets: { ...full, mi: { final: true, echo: '2026-10-01', file: 'x' } }, parsed, result, hasWiki: true });
  assert.ok(g2.hard.some(h => /回聲日/.test(h)));
  const bad = { ...result, index: { ...result.index, residualBp: 80 } };
  assert.ok(evaluateGates({ date: '2026-10-02', datasets: full, parsed, result: bad, hasWiki: true }).hard.some(h => /殘差/.test(h)));
});

test('除權息拆分：純配股日指數貢獻為 0；現金＋配股只扣現金；無成交以參考價為收盤；對不上參考價者不採用', async () => {
  const { verifiedExDiv } = await import('./compute.mjs');
  const ref1 = 90.91; // 100/(1+0.1)
  assert.deepEqual(verifiedExDiv({ c: 0, g: 0.1, sub: 0 }, 100, ref1), { c: 0, g: 0.1 });
  assert.equal(verifiedExDiv({ c: 0, g: 0.1, sub: 0 }, 100, 95), null, '對不上官方參考價＝單位或資料錯，不採用');
  assert.equal(verifiedExDiv({ c: 1, g: 0, sub: 0.05 }, 100, 99), null, '有現增認購者不處理');
  const other = row('2000', 50, 50, 1000);
  // 純配股：收盤＝參考價，個股價格指數不該被拖累
  const a = row('1000', ref1, 100, 1000, { ref: ref1, exDivSplit: { c: 0, g: 0.1 } });
  const ra = computeIndexContribution({ rows: [a, other], index: { close: 1000, change: 0 } });
  assert.ok(Math.abs(ra.contributors.concat(ra.draggers).find(x => x.code === '1000').pts) < 0.05, `純配股貢獻應≈0：${JSON.stringify(ra.top[0])}`);
  // 現金 2 元＋配股 5%：只扣現金
  const refB = +(98 / 1.05).toFixed(2);
  const b = row('1000', refB, 100, 1000, { ref: refB, exDivSplit: { c: 2, g: 0.05 } });
  const rb = computeIndexContribution({ rows: [b, other], index: { close: 1000, change: 0 } });
  const expect = 1000 * (1000 * ((refB - refB) * 1.05 - 2)) / (100 * 1000 + 50 * 1000);
  assert.ok(Math.abs(rb.exDivMechanicalPts - expect) < 0.06, `${rb.exDivMechanicalPts} vs ${expect}`);
  assert.equal(rb.exDivSplitN, 1);
  // 無成交：以參考價為收盤（只剩現金股利的機械下跌）
  const c = row('1000', null, 100, 1000, { close: null, ref: refB, exDivSplit: { c: 2, g: 0.05 } });
  const rc = computeIndexContribution({ rows: [c, other], index: { close: 1000, change: 0 } });
  assert.ok(Math.abs(rc.contributors.concat(rc.draggers).find(x => x.code === '1000').pts - expect) < 0.06);
});
