// 技術評分 v3 單元測試：node --test scripts/lib/scoring-v3.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawFactors, pctRank, crossSection, labelsFor, excess, spearman, compositePct, meanT } from './scoring-v3.mjs';

// 80 日：1111 穩定上漲、2222 持平（成交額足）、3333 低成交額、4444 最後一日漲停
const mk = (n = 80) => Array.from({ length: n }, (_, i) => ({
  date: `d${String(i).padStart(3, '0')}`,
  m: { 1111: [100 + i, 2000, 99 + i, 101 + i, 98 + i], 2222: [50, 5000, 50, 50.5, 49.5], 3333: [20, 10, 20, 20, 20], 4444: [i === n - 1 ? 30 * 1.1 : 30, 5000, 30, 30, 30] },
  inst: { 1111: [100, 50], 2222: [-10, 0] },
}));

test('pctRank：並列取平均名次、null 中性 50', () => {
  assert.deepEqual(pctRank([1, 2, 2, 3]), [0, 50, 50, 100]);
  assert.deepEqual(pctRank([5, null, 1]), [100, 50, 0]);
});

test('spearman：單調正相關＝1、反向＝−1、樣本不足 null', () => {
  const x = Array.from({ length: 30 }, (_, i) => i);
  assert.equal(+spearman(x, x.map(v => v * 2)).toFixed(6), 1);
  assert.equal(+spearman(x, x.map(v => -v)).toFixed(6), -1);
  assert.equal(spearman([1, 2], [1, 2]), null);
});

test('rawFactors：宇宙排除低成交額與收在漲停；只用 ≤t；法人缺 ≥3 日為 null', () => {
  const days = mk(); const t = 79;
  assert.equal(rawFactors(days, t, '3333'), null, '20 日均成交額 < 5,000 萬');
  assert.equal(rawFactors(days, t, '4444'), null, '收在漲停附近');
  const a = rawFactors(days, t, '1111');
  const b = rawFactors([...days.slice(0, 80), { date: 'x', m: { 1111: [1, 1, 1, 1, 1] } }], t, '1111');
  assert.deepEqual(a, b, '加入未來資料不影響');
  assert.equal(a.maAbove, 3); assert.equal(a.brk20, 1); assert.ok(a.r20 > 0 && a.inst5 > 0);
  const noInst = mk().map((d, i) => (i >= 76 ? { ...d, inst: {} } : d));
  assert.equal(rawFactors(noInst, t, '1111').inst5, null);
});

test('crossSection＋labels＋excess：宇宙排除低成交額（4444 在 t=70 未漲停故入選）、因子百分位 0–100；標籤口徑 D+1 開盤買', () => {
  const days = mk(90); const cs = crossSection(days, 70);
  assert.deepEqual([...cs.codes].sort(), ['1111', '2222', '4444']);
  assert.ok(cs.factors.M.every(v => v >= 0 && v <= 100));
  const L = labelsFor(days, 70, '1111');
  assert.equal(L.S, +((170 / 170 - 1) * 100).toFixed(10));   // 開 = 99+71 = 170；前收 = 170
  assert.equal(+L.W5.toFixed(6), +((175 / 170 - 1) * 100).toFixed(6));
  assert.deepEqual(excess([1, 3, null]), [-1, 1, null]);
});

test('compositePct：權重可為負（反向因子）；全 0 權重＝中性', () => {
  const f = { M: [0, 50, 100], T: [0, 50, 100], V: [50, 50, 50], F: [50, 50, 50], R: [100, 50, 0] };
  assert.deepEqual(compositePct(f, { M: 1, T: 1 }), [0, 50, 100]);
  assert.deepEqual(compositePct(f, { R: -1 }), [0, 50, 100], 'R 反向＝與 M 同序');
  assert.deepEqual(compositePct(f, {}), [50, 50, 50]);
  assert.equal(+meanT([1, 1, 1, 1]).mean, 1);
});

test('topN：高→低、同分依代號；shadowBoard：未滿 20 日不提請、CI 下界>0 才提請、兩者皆負時 v3 損失較小亦可', async () => {
  const { topN, shadowBoard } = await import('./scoring-v3.mjs');
  assert.deepEqual(topN(['b', 'a', 'c'], [50, 50, 90], 2).map(x => x.code), ['c', 'a']);
  const mk = (n, v3, v2) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, v3: v3 + (i % 2 ? 0.01 : -0.01), v2 }));
  assert.equal(shadowBoard(mk(19, 0.5, 0)).switchReady, false);
  assert.equal(shadowBoard(mk(20, 0.5, 0)).switchReady, true);
  assert.equal(shadowBoard(mk(20, -0.1, -0.3)).switchReady, true);
  assert.equal(shadowBoard(mk(20, -0.3, -0.1)).switchReady, false);
  assert.equal(shadowBoard([{ v3: 1, v2: null }]).n, 0);
});
