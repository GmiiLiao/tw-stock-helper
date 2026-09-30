// 標靶公式計算核心 單元測試：node --test scripts/lib/swing-formula.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centeredRank, revenueAvailFrom, revenueIndex, buildArrays, adjust, makeFeatureFn, daySection, labelsAt, scoreWith, BASE_P } from './swing-formula.mjs';

// 80 日、1500 檔填充股（價 50、量 5000 張）＋測試股；extra(d) 可覆寫第 d 日的列
function mkRows(n = 80, extra = () => ({})) {
  return Array.from({ length: n }, (_, d) => {
    const m = {}; for (let c = 1000; c < 2500; c++) m[c] = [50 + (c % 7) * 0.1 + d * 0.01 * (c % 3), 5000, 50, 51, 49];
    return { date: `2026-${String(1 + Math.floor(d / 28)).padStart(2, '0')}-${String(1 + (d % 28)).padStart(2, '0')}`, closeJson: JSON.stringify({ ...m, ...extra(d) }) };
  });
}

test('centeredRank：並列取平均、NaN＝中性 0', () => {
  assert.deepEqual([...centeredRank([1, 2, 2, 3])], [-0.5, 0, 0, 0.5]);
  assert.deepEqual([...centeredRank([5, NaN, 1])], [0.5, 0, -0.5]);
});

test('月營收：M 月自 M+1 月 11 日起才可用（跨年正確）', () => {
  assert.equal(revenueAvailFrom('2026-08'), '2026-09-11');
  assert.equal(revenueAvailFrom('2026-12'), '2027-01-11');
  const rows = m => JSON.stringify([{ c: '2330', yoy: m }]);
  const at = revenueIndex([{ month: '2026-05', rowsJson: rows(10) }, { month: '2026-06', rowsJson: rows(20) }, { month: '2026-07', rowsJson: rows(30) }, { month: '2026-08', rowsJson: rows(60) }]);
  assert.deepEqual(at('2026-09-10')('2330'), [30, NaN], '09-10 只能用到 7 月（前三月不足 3 個＝加速缺值）');
  assert.deepEqual(at('2026-09-11')('2330'), [60, 40], '09-11 起用 8 月；加速＝60−平均(10,20,30)');
  assert.equal(at('2026-06-10'), null);
});

test('宇宙門檻看未還原價；特徵只用 ≤t；D+1 開盤漲停＝買不到', () => {
  // 7777：實際 12 元、之後有 ×0.5 的還原事件（還原後約 6 元）⇒ 仍入宇宙；8888：實際 9 元 ⇒ 不入
  const base = mkRows(80, () => ({ 7777: [12, 50000, 12, 12.2, 11.8], 8888: [9, 50000, 9, 9.1, 8.9] }));
  const D = buildArrays(base), adj = adjust(D, [{ date: '2099-01-01', code: '7777', factor: 0.5 }]), fn = makeFeatureFn(D, adj);
  const ci7 = D.codeIdx.get('7777'), ci8 = D.codeIdx.get('8888');
  assert.ok(fn.inUniverse(ci7, 70)); assert.equal(fn.inUniverse(ci8, 70), false);
  const f = fn.feats(ci7, 70, null); assert.equal(f.length, BASE_P);
  const fut = buildArrays(base.map((r, d) => (d > 70 ? { ...r, closeJson: JSON.stringify({ ...JSON.parse(r.closeJson), 7777: [99, 1, 99, 99, 99] }) } : r)));
  assert.deepEqual(makeFeatureFn(fut, adjust(fut, [])).feats(fut.codeIdx.get('7777'), 70, null).slice(0, 20), makeFeatureFn(D, adjust(D, [])).feats(ci7, 70, null).slice(0, 20), '改動 t 之後的資料不影響 t 的特徵');
  // D+1 開盤比 t 收盤高 ≥9.5% ⇒ 標籤 NaN
  const lu = buildArrays(mkRows(80, d => (d === 71 ? { 7777: [13, 50000, 13.2, 13.2, 13.2] } : { 7777: [12, 50000, 12, 12.2, 11.8] })));
  const la = adjust(lu, []), y = labelsAt(lu, la, [lu.codeIdx.get('7777'), lu.codeIdx.get('1000')], 70, 5);
  assert.ok(Number.isNaN(y[0])); assert.ok(Number.isFinite(y[1]));
});

test('daySection：可排除處置股、欄數＝24；scoreWith＝Σ 係數×排名', () => {
  const rows = mkRows(80);
  const D = buildArrays(rows), adj = adjust(D, []), fn = makeFeatureFn(D, adj);
  const all = daySection(D, adj, fn, 70, null, {}), ex = daySection(D, adj, fn, 70, null, {}, new Set(['1000']));
  assert.equal(all.X.length, BASE_P); assert.equal(all.cis.length - ex.cis.length, 1);
  assert.ok(!ex.cis.includes(D.codeIdx.get('1000')));
  assert.deepEqual([...scoreWith([Float64Array.from([0.5, -0.5]), Float64Array.from([0, 0])], [2, 0])], [1, -1]);
});
