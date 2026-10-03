// 榜單「今日快照偽 K」判定 單元測試：node --test scripts/lib/board-live-bar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsLiveBar, SESSION_OPEN_MIN } from './board-live-bar.mjs';

const hm = (h, m = 0) => h * 60 + m;
// 舊判定（2026-10-03 前三個榜單共用）：交易日 ∧ 歸檔末日≠日曆今天——沒有看時刻
const oldLiveDay = ({ tradingDay, today, lastArchiveDay }) => tradingDay && lastArchiveDay !== today;

test('平日 00:00–09:00（日曆已是 D+1、歸檔末日 D）不接偽 K——2026-10-01 00:28 空榜實案', () => {
  const p = { tradingDay: true, minutes: hm(0, 28), today: '2026-10-01', lastArchiveDay: '2026-09-30' };
  assert.equal(oldLiveDay(p), true, '舊判定在此成立＝把 09-30 收盤再接一次當 10-01');
  assert.equal(needsLiveBar(p), false);
  assert.equal(needsLiveBar({ ...p, minutes: hm(8, 59) }), false);
});

test('週一開盤前（歸檔末日是上週五）不接偽 K', () => {
  assert.equal(needsLiveBar({ tradingDay: true, minutes: hm(0, 28), today: '2026-10-05', lastArchiveDay: '2026-10-02' }), false);
  assert.equal(needsLiveBar({ tradingDay: true, minutes: hm(7, 30), today: '2026-10-05', lastArchiveDay: '2026-10-02' }), false);
});

test('08:30–09:00 試撮沒有成交不接；09:00 開盤起才接', () => {
  const p = { tradingDay: true, today: '2026-10-05', lastArchiveDay: '2026-10-02' };
  assert.equal(needsLiveBar({ ...p, minutes: hm(8, 45) }), false);
  assert.equal(needsLiveBar({ ...p, minutes: SESSION_OPEN_MIN - 1 }), false);
  assert.equal(needsLiveBar({ ...p, minutes: SESSION_OPEN_MIN }), true);
});

test('盤中與收盤後歸檔前（今日的價量只在快照裡）照舊接偽 K——行為與舊判定相同', () => {
  for (const minutes of [hm(10), hm(13, 25), hm(14), hm(15, 9), hm(21, 40), hm(23, 59)]) {
    const p = { tradingDay: true, minutes, today: '2026-10-01', lastArchiveDay: '2026-09-30' };
    assert.equal(needsLiveBar(p), true, `minutes=${minutes}`);
    assert.equal(needsLiveBar(p), oldLiveDay(p), `minutes=${minutes} 與舊判定一致`);
  }
});

test('今日已歸檔（約 15:10 後）不接——行為與舊判定相同', () => {
  const p = { tradingDay: true, minutes: hm(15, 30), today: '2026-10-01', lastArchiveDay: '2026-10-01' };
  assert.equal(needsLiveBar(p), false);
  assert.equal(oldLiveDay(p), false);
});

test('非交易日（週末、平日休市）一律不接', () => {
  assert.equal(needsLiveBar({ tradingDay: false, minutes: hm(10), today: '2026-10-03', lastArchiveDay: '2026-10-02' }), false);
  assert.equal(needsLiveBar({ tradingDay: false, minutes: hm(10), today: '2026-10-09', lastArchiveDay: '2026-10-08' }), false);
});

test('歸檔末日缺（空歸檔／讀取失敗）或異常地晚於今天 ⇒ 不接（寧可用歸檔，不捏造今日 K）', () => {
  for (const lastArchiveDay of [undefined, null, '']) {
    assert.equal(needsLiveBar({ tradingDay: true, minutes: hm(10), today: '2026-10-01', lastArchiveDay }), false, String(lastArchiveDay));
  }
  assert.equal(needsLiveBar({ tradingDay: true, minutes: hm(10), today: '2026-10-01', lastArchiveDay: '2026-10-02' }), false);
});
