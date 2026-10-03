// 除權息係數合併 單元測試：node --test scripts/lib/exright-source.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFactorItems, exFactorLookup } from './exright-source.mjs';

test('mergeFactorItems：同檔同日以官方除權息為準（不重複乘）、priceEvents 無係數者略過', () => {
  const ex = [['2026-07-01', '2330', 0.99]];
  const pe = [{ date: '2026-07-01', code: '2330', factor: 0.98 }, { date: '2026-09-21', code: '2321', factor: 1.83 }, { date: '2026-09-01', code: '1111', factor: null }];
  const m = mergeFactorItems(ex, pe);
  assert.deepEqual(m, [{ date: '2026-07-01', code: '2330', factor: 0.99 }, { date: '2026-09-21', code: '2321', factor: 1.83 }]);
  assert.deepEqual(mergeFactorItems([], undefined), []);
});

test('exFactorLookup：區間內有事件回係數、沒事件回 null、區間外回 undefined；priceEvents 已還原的同檔同日略過', () => {
  const f = exFactorLookup([['2026-09-25', '2330', 0.98], ['2026-09-26', '1101', 0.5]], { 1101: [{ date: '2026-09-26', factor: 0.5 }] }, { from: '2026-09-12', to: '2026-10-02' });
  assert.equal(f('2026-09-25', '2330'), 0.98);
  assert.equal(f('2026-09-26', '1101'), null, '已在日線上還原過，不重複乘');
  assert.equal(f('2026-09-30', '2330'), null);
  assert.equal(f('2026-09-01', '2330'), undefined, '區間外＝不知道');
});
