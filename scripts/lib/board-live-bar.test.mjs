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

// ── G2-35 軋空候選的 5 日漲幅／昨日漲幅（2026-10-04）──
import { priceBarIndex, lookbackChanges } from './board-live-bar.mjs';
const cm = [100, 101, 102, 103, 104, 105, 110].map(c => ({ X: [c, 1000] }));   // 舊→新，L=6

test('非盤中（現價＝歸檔 L 收盤）：ret5 滿 5 日、prevChg 非 0——舊寫法週末 4 日／恆 0', () => {
  const L = cm.length - 1;
  const idx = priceBarIndex({ liveDay: false, live: false, lastIdx: L });
  assert.equal(idx, L);
  const r = lookbackChanges({ closeMaps: cm, code: 'X', idx, price: 110, prev: 105 });
  assert.equal(r.ret5, +((110 / 101 - 1) * 100).toFixed(1));
  assert.equal(r.prevChg, +((105 / 104 - 1) * 100).toFixed(2));
  // 舊寫法（idx=L+1）對照：4 日、0
  const old = lookbackChanges({ closeMaps: cm, code: 'X', idx: L + 1, price: 110, prev: 105 });
  assert.equal(old.ret5, +((110 / 102 - 1) * 100).toFixed(1));
  assert.equal(old.prevChg, 0);
});

test('週末快照仍標 live（現價＝上週五收盤＝歸檔 L）→ idx=L', () => {
  assert.equal(priceBarIndex({ liveDay: false, live: true, lastIdx: 6 }), 6);
});

test('盤中即時（今日未歸檔）→ 虛擬 L+1：ret5 以 L-4 為基、prevChg＝L 對 L-1', () => {
  const L = cm.length - 1;
  const idx = priceBarIndex({ liveDay: true, live: true, lastIdx: L });
  assert.equal(idx, L + 1);
  const r = lookbackChanges({ closeMaps: cm, code: 'X', idx, price: 121, prev: 110 });
  assert.equal(r.ret5, +((121 / 102 - 1) * 100).toFixed(1));
  assert.equal(r.prevChg, +((110 / 105 - 1) * 100).toFixed(2));
});

test('盤中但該檔無即時報價（現價退回歸檔 L）→ idx=L', () => {
  assert.equal(priceBarIndex({ liveDay: true, live: false, lastIdx: 6 }), 6);
});

test('序列太短或缺價 → null', () => {
  const r = lookbackChanges({ closeMaps: cm.slice(0, 3), code: 'X', idx: 2, price: 102, prev: 101 });
  assert.equal(r.ret5, null);
  assert.equal(lookbackChanges({ closeMaps: cm, code: 'Y', idx: 6, price: 1, prev: 1 }).prevChg, null);
});
