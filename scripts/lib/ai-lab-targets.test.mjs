// AI 實驗目標追蹤測試：node --test scripts/lib/ai-lab-targets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowStats, targetBoard, LAB_TARGETS } from './ai-lab-targets.mjs';

const series = totals => totals.map((t, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, total: t }));

test('目標值為使用者訂定：5 日 35%、20 日 70%、60 日 120%', () => {
  assert.deepEqual({ ...LAB_TARGETS }, { 5: 35, 20: 70, 60: 120 });
});

test('歷史不足 N 日：以起始資金為基準、標 partial、不算達標', () => {
  const w = windowStats(series([510000, 520000]), 500000, 5);
  assert.equal(w.partial, true); assert.equal(w.days, 2); assert.equal(w.ret, 4); assert.equal(w.met, false); assert.equal(w.windows, 0);
});

test('完整窗：近 5 日＝最新 ÷ 5 個交易日前；滾動窗獲利率與連續獲利', () => {
  // 7 天：500k→…；窗 [0→5]、[1→6]
  const w = windowStats(series([500000, 480000, 490000, 500000, 510000, 700000, 690000]), 500000, 5);
  assert.equal(w.partial, false);
  assert.equal(w.ret, +((690000 / 480000 - 1) * 100).toFixed(2));   // 43.75%
  assert.equal(w.met, true);
  assert.equal(w.windows, 2); assert.equal(w.positive, 2); assert.equal(w.streak, 2); assert.equal(w.metWindows, 2);
});

test('targetBoard：累計報酬與三個窗', () => {
  const b = targetBoard(series([500000, 550000]), 500000);
  assert.equal(b.cumRetPct, 10); assert.equal(b.windows.length, 3); assert.equal(b.tradingDays, 2);
});
