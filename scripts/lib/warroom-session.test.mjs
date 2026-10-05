// 盤中戰情 v2 時段切分 單元測試：node --test scripts/lib/warroom-session.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  warSegmentAt, warClockAt, nextNodeAt, countdownText, fmtCountdown, shouldPollWarRoomAt,
  msUntilPollWindow, phaseIndexOf, taipeiMinuteOfDay, taipeiYmd, taipeiDayStart, PHASE_LABELS,
} from './warroom-session.mjs';

// 2026-10-05（週一）台北時間 hh:mm:ss → epoch ms（以 UTC 建構，與執行環境時區無關）
const T = (h, m, s = 0) => Date.UTC(2026, 9, 5, h - 8, m, s);

test('時段邊界：08:30／08:55／09:00／09:30／12:45／13:25／13:30／13:45 依左閉右開切換', () => {
  const cases = [
    [T(8, 29, 59), 'after'], [T(8, 30), 'pre'], [T(8, 54, 59), 'pre'], [T(8, 55), 'preclear'],
    [T(8, 59, 59), 'preclear'], [T(9, 0), 'open'], [T(9, 29, 59), 'open'], [T(9, 30), 'mid'],
    [T(12, 44, 59), 'mid'], [T(12, 45), 'tail'], [T(13, 24, 59), 'tail'], [T(13, 25), 'auction'],
    [T(13, 29, 59), 'auction'], [T(13, 30), 'closing'], [T(13, 44, 59), 'closing'], [T(13, 45), 'after'],
    [T(23, 59), 'after'],
  ];
  for (const [ms, want] of cases) assert.equal(warSegmentAt(ms, true), want, new Date(ms).toISOString());
});

test('非交易日一律 nontrading，沒有下一節點、不輪詢', () => {
  assert.equal(warSegmentAt(T(10, 0), false), 'nontrading');
  assert.equal(nextNodeAt(T(10, 0), false), null);
  assert.equal(shouldPollWarRoomAt(T(10, 0), false), false);
  assert.equal(msUntilPollWindow(T(7, 0), false), null);
  const c = warClockAt(T(10, 0), false);
  assert.equal(c.phaseIndex, -1);
  assert.equal(c.countdown, '');
  assert.equal(c.beforeOpen, false);
});

test('倒數文字對齊預覽頁：盤前／開盤段／盤中段／尾盤（13:20 前後）／收盤競價／定價窗', () => {
  assert.equal(warClockAt(T(8, 42), true).countdown, '距開盤 18 分');
  assert.equal(warClockAt(T(8, 57), true).countdown, '距開盤 3 分');
  assert.equal(warClockAt(T(9, 12), true).countdown, '距盤中段 18 分');
  assert.equal(warClockAt(T(10, 42), true).countdown, '距尾盤 2:03');
  assert.equal(warClockAt(T(13, 5), true).countdown, '距 13:20 當沖平倉 15 分');
  assert.equal(warClockAt(T(13, 22), true).countdown, '距收盤競價 3 分');
  assert.equal(warClockAt(T(13, 27), true).countdown, '距收盤 3 分');
  assert.equal(warClockAt(T(13, 40), true).countdown, '距定價結束 5 分');
  assert.equal(warClockAt(T(13, 45), true).countdown, '');
  assert.equal(warClockAt(T(14, 10), true).next, null);
});

test('交易日 08:30 前：segment 為 after 但 beforeOpen=true，倒數指向 08:30 盤前試撮', () => {
  const c = warClockAt(T(8, 0), true);
  assert.equal(c.segment, 'after');
  assert.equal(c.beforeOpen, true);
  assert.equal(c.countdown, '距盤前試撮 30 分');
  assert.equal(warClockAt(T(14, 0), true).beforeOpen, false);
});

test('nextNodeAt 的 at／msLeft 是絕對時刻（台北）', () => {
  const n = nextNodeAt(T(10, 42, 30), true);
  assert.equal(n.label, '尾盤');
  assert.equal(n.at, T(12, 45));
  assert.equal(n.msLeft, T(12, 45) - T(10, 42, 30));
});

test('fmtCountdown：未滿 1 小時寫分（無條件進位）、滿 1 小時寫 h:mm', () => {
  assert.equal(fmtCountdown(0), '0 分');
  assert.equal(fmtCountdown(1), '1 分');
  assert.equal(fmtCountdown(59 * 60_000), '59 分');
  assert.equal(fmtCountdown(60 * 60_000), '1:00');
  assert.equal(fmtCountdown(123 * 60_000), '2:03');
  assert.equal(countdownText(null), '');
});

test('輪詢閘門：08:30–13:45 才 true；14:00–14:31（market-clock post-close）仍為 false（critique L10）', () => {
  assert.equal(shouldPollWarRoomAt(T(8, 29, 59), true), false);
  assert.equal(shouldPollWarRoomAt(T(8, 30), true), true);
  assert.equal(shouldPollWarRoomAt(T(13, 44, 59), true), true);
  assert.equal(shouldPollWarRoomAt(T(13, 45), true), false);
  assert.equal(shouldPollWarRoomAt(T(14, 10), true), false);
  assert.equal(shouldPollWarRoomAt(T(10, 0), true, true), false, '背景分頁不輪詢');
});

test('msUntilPollWindow：08:30 前回剩餘 ms，之後回 null', () => {
  assert.equal(msUntilPollWindow(T(8, 0), true), 30 * 60_000);
  assert.equal(msUntilPollWindow(T(8, 30), true), null);
  assert.equal(msUntilPollWindow(T(15, 0), true), null);
});

test('phaseIndex 對應 PHASE_LABELS（清空窗歸盤前）', () => {
  assert.equal(PHASE_LABELS[phaseIndexOf('pre')], '盤前');
  assert.equal(PHASE_LABELS[phaseIndexOf('preclear')], '盤前');
  assert.equal(PHASE_LABELS[phaseIndexOf('auction')], '收盤競價');
  assert.equal(PHASE_LABELS[phaseIndexOf('closing')], '定價');
  assert.equal(PHASE_LABELS[phaseIndexOf('after')], '盤後');
  assert.equal(phaseIndexOf('nontrading'), -1);
});

test('台北時間換算與執行環境時區無關（跨 UTC 午夜）', () => {
  // 台北 07:30＝UTC 前一日 23:30
  const ms = Date.UTC(2026, 9, 4, 23, 30);
  assert.equal(taipeiMinuteOfDay(ms), 7 * 60 + 30);
  assert.equal(taipeiYmd(ms), '2026-10-05');
  assert.equal(taipeiDayStart(ms), Date.UTC(2026, 9, 4, 16, 0));
});
