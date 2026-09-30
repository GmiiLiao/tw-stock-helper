// 價格結構事件還原 單元測試：node --test scripts/lib/price-factors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPriceFactors, factorsFromItems } from './price-factors.mjs';

test('事件日之前的價格乘係數、張數不動、事件日（含）之後不動；不改原物件', () => {
  const f = factorsFromItems([{ code: '1111', date: '2026-09-02', factor: 0.5 }, { code: 'x', date: '', factor: 2 }]);
  assert.deepEqual(Object.keys(f), ['1111']);
  const days = [{ date: '2026-09-01', m: { 1111: [100, 7, 98, 101, 97], 2222: [50, 1, 50, 50, 50] } }, { date: '2026-09-02', m: { 1111: [51, 8, 50, 52, 49] } }];
  const r = applyPriceFactors(days, f);
  assert.deepEqual(r[0].m['1111'], [50, 7, 49, 50.5, 48.5]);
  assert.deepEqual(r[0].m['2222'], [50, 1, 50, 50, 50]);
  assert.deepEqual(r[1].m['1111'], [51, 8, 50, 52, 49]);
  assert.equal(days[0].m['1111'][0], 100, '原物件不變');
});
