// 除權息係數合併 單元測試：node --test scripts/lib/exright-source.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFactorItems } from './exright-source.mjs';

test('mergeFactorItems：同檔同日以官方除權息為準（不重複乘）、priceEvents 無係數者略過', () => {
  const ex = [['2026-07-01', '2330', 0.99]];
  const pe = [{ date: '2026-07-01', code: '2330', factor: 0.98 }, { date: '2026-09-21', code: '2321', factor: 1.83 }, { date: '2026-09-01', code: '1111', factor: null }];
  const m = mergeFactorItems(ex, pe);
  assert.deepEqual(m, [{ date: '2026-07-01', code: '2330', factor: 0.99 }, { date: '2026-09-21', code: '2321', factor: 1.83 }]);
  assert.deepEqual(mergeFactorItems([], undefined), []);
});
