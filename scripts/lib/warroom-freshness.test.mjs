// 盤中戰情 v2 資料章／每列價齡 單元測試：node --test scripts/lib/warroom-freshness.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampOf, rowAgeOf, toEpochMs, hhmmss, hhmm, mmdd, FRESH_THRESHOLDS } from './warroom-freshness.mjs';

const T = (h, m, s = 0, day = 5) => Date.UTC(2026, 9, day, h - 8, m, s);
const NOW = T(10, 42, 30);

test('即時／延遲／過期依 kind 門檻（報價 120／300 秒、榜單 5／10 分、族群 8／15 分）', () => {
  assert.equal(stampOf({ kind: 'quote', asOf: T(10, 42, 15), now: NOW, segment: 'mid' }).text, '● 即時 10:42:15');
  assert.equal(stampOf({ kind: 'quote', asOf: NOW - 121_000, now: NOW, segment: 'mid' }).state, 'delayed');
  const st = stampOf({ kind: 'quote', asOf: NOW - 420_000, now: NOW, segment: 'mid' });
  assert.equal(st.state, 'stale');
  assert.equal(st.text, '▲ 過期 7 分·重試中');
  assert.equal(stampOf({ kind: 'list', asOf: NOW - 4 * 60_000, now: NOW, segment: 'mid' }).state, 'live');
  assert.equal(stampOf({ kind: 'list', asOf: NOW - 6 * 60_000, now: NOW, segment: 'mid' }).text, '◐ 延遲 6 分');
  assert.equal(stampOf({ kind: 'sector', asOf: NOW - 9 * 60_000, now: NOW, segment: 'mid' }).state, 'delayed');
  assert.equal(stampOf({ kind: 'sector', asOf: NOW - 16 * 60_000, now: NOW, segment: 'mid' }).state, 'stale');
  assert.equal(FRESH_THRESHOLDS.index.delayMs, 60_000);
});

test('即時字樣可換（A1 用「揭示」）', () => {
  assert.equal(stampOf({ kind: 'quote', asOf: T(10, 42, 15), now: NOW, segment: 'mid', liveLabel: '揭示' }).text, '● 揭示 10:42:15');
});

test('前交易日資料一律 ◆ 前交易日 mm/dd（非交易日、盤後次晨）', () => {
  const s = stampOf({ kind: 'list', asOf: T(13, 35, 0, 2), now: T(10, 0, 0, 4), segment: 'nontrading' });
  assert.equal(s.state, 'prev');
  assert.equal(s.text, '◆ 前交易日 10/02');
});

test('收盤看資料時間 ≥13:30（不看牆上時鐘）', () => {
  assert.equal(stampOf({ kind: 'quote', asOf: T(13, 30, 5), now: T(13, 31), segment: 'closing' }).text, '■ 收盤 13:30');
  // 13:31 但揭示時間仍在 13:29 ⇒ 還不是收盤
  assert.equal(stampOf({ kind: 'quote', asOf: T(13, 29, 40), now: T(13, 31), segment: 'closing' }).state, 'live');
  // 盤後、資料停在 13:2x ⇒ 標「收盤前資料」不冒充收盤，也不寫重試中
  const s = stampOf({ kind: 'list', asOf: T(13, 20), now: T(15, 0), segment: 'after' });
  assert.equal(s.state, 'closed');
  assert.equal(s.text, '■ 收盤前資料 13:20');
});

test('清空窗全頁「○ 未開盤」；盤前 openOnly 也是；盤前新聞類照實顯示', () => {
  assert.equal(stampOf({ kind: 'news', asOf: T(8, 56), now: T(8, 57), segment: 'preclear' }).text, '○ 未開盤');
  assert.equal(stampOf({ kind: 'list', asOf: T(13, 35, 0, 2), now: T(8, 42), segment: 'pre', openOnly: true }).state, 'preopen');
  assert.equal(stampOf({ kind: 'news', asOf: T(8, 31, 5), now: T(8, 42), segment: 'pre' }).text, '● 即時 08:31:05');
  // 盤前非 openOnly 的昨日資料 ⇒ ◆
  assert.equal(stampOf({ kind: 'index', asOf: T(13, 33, 0, 2), now: T(8, 42), segment: 'pre' }).state, 'prev');
});

test('沒有資料：輪詢時段寫「重試中」，盤後不寫', () => {
  assert.equal(stampOf({ kind: 'list', asOf: null, now: NOW, segment: 'mid' }).text, '▲ 無資料·重試中');
  assert.equal(stampOf({ kind: 'list', asOf: null, now: NOW, segment: 'after' }).text, '▲ 無資料');
  assert.equal(stampOf({ kind: 'list', asOf: null, now: NOW, segment: 'pre', openOnly: true }).state, 'preopen');
  assert.equal(stampOf({ kind: 'quote', asOf: NOW - 420_000, now: NOW, segment: 'after' }).state, 'closed');
});

test('每列價齡：>120 秒 aging、>300 秒 old、無今日真成交 notrade、盤外不標', () => {
  const q = (ageS, extra = {}) => ({ revealAt: NOW - ageS * 1000, source: 'mis_realtime', volume: 100, ...extra });
  assert.equal(rowAgeOf(q(30), NOW, 'mid'), 'fresh');
  assert.equal(rowAgeOf(q(121), NOW, 'mid'), 'aging');
  assert.equal(rowAgeOf(q(301), NOW, 'mid'), 'old');
  assert.equal(rowAgeOf(q(30, { source: 'stock_day_all' }), NOW, 'mid'), 'notrade');
  assert.equal(rowAgeOf(q(30, { revealAt: null }), NOW, 'mid'), 'notrade');
  assert.equal(rowAgeOf(q(30, { volume: 0 }), NOW, 'mid'), 'notrade');
  assert.equal(rowAgeOf(null, NOW, 'mid'), 'notrade');
  assert.equal(rowAgeOf(q(999), NOW, 'pre'), 'none');
  assert.equal(rowAgeOf(q(999), NOW, 'after'), 'none');
});

test('toEpochMs：秒／毫秒／ISO／Firestore Timestamp 形狀；認不得回 null', () => {
  assert.equal(toEpochMs(1_791_000_000), 1_791_000_000_000);
  assert.equal(toEpochMs(1_791_000_000_123), 1_791_000_000_123);
  assert.equal(toEpochMs('2026-10-05T02:42:00.000Z'), Date.UTC(2026, 9, 5, 2, 42));
  assert.equal(toEpochMs({ _seconds: 1_791_000_000, _nanoseconds: 0 }), 1_791_000_000_000);
  assert.equal(toEpochMs({ seconds: 1_791_000_000 }), 1_791_000_000_000);
  assert.equal(toEpochMs({ toMillis: () => 42_000_000_000_000 }), 42_000_000_000_000);
  for (const bad of [null, undefined, 0, -1, NaN, 'x', {}, true]) assert.equal(toEpochMs(bad), null, String(bad));
});

test('時間格式一律台北時間', () => {
  assert.equal(hhmmss(T(9, 5, 7)), '09:05:07');
  assert.equal(hhmm(T(13, 30, 59)), '13:30');
  assert.equal(mmdd(Date.UTC(2026, 9, 4, 23, 30)), '10/05');
});
