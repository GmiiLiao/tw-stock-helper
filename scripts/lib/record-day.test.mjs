import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordDayOf } from './record-day.mjs';

const H = new Set(['2026-10-09', '2026-10-10']);   // 國慶連假（示意）

test('交易日當天 → 當天（與舊行為相同）', () => {
  assert.equal(recordDayOf('2026-10-02', H), '2026-10-02');   // 週五
  assert.equal(recordDayOf('2026-10-05', H), '2026-10-05');   // 週一
});

test('週末 → 上週五', () => {
  assert.equal(recordDayOf('2026-10-03', H), '2026-10-02');
  assert.equal(recordDayOf('2026-10-04', H), '2026-10-02');
});

test('休市日接週末 → 休市前最後交易日', () => {
  assert.equal(recordDayOf('2026-10-09', H), '2026-10-08');
  assert.equal(recordDayOf('2026-10-11', H), '2026-10-08');
});

test('跨月跨年', () => {
  assert.equal(recordDayOf('2027-01-01', new Set(['2027-01-01'])), '2026-12-31');
});

test('不合理輸入原樣返回、不丟例外', () => {
  assert.equal(recordDayOf('bad', H), 'bad');
  assert.equal(recordDayOf(undefined, H), undefined);
  assert.equal(recordDayOf('2026-10-03', null), '2026-10-02');
});
