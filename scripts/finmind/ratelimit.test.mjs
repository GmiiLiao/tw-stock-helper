// 令牌桶＋滾動一小時上限 單元測試：node --test scripts/finmind/ratelimit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './ratelimit.mjs';

function clock(t0 = 1_000_000) { let t = t0; return { now: () => t, advance: ms => { t += ms; } }; }

test('每秒上限：兩次請求之間至少 1000/perSecond 毫秒', () => {
  const c = clock();
  const rl = createRateLimiter({ now: c.now, capFor: () => 5000, perSecond: 2, burst: 10 });
  assert.equal(rl.waitMs(), 0);
  rl.record();
  assert.equal(rl.waitMs(), 500);
  c.advance(500);
  assert.equal(rl.waitMs(), 0);
});

test('令牌桶：burst 用完後依 cap/3600 秒的速率補（5,000/時 ≈ 每 720ms 一個）', () => {
  const c = clock();
  const rl = createRateLimiter({ now: c.now, capFor: () => 5000, perSecond: 1000, burst: 3 });
  for (let i = 0; i < 3; i++) { assert.equal(rl.waitMs(), i === 0 ? 0 : rl.waitMs()); c.advance(1); rl.record(); }
  const w = rl.waitMs();
  assert.ok(w >= 700 && w <= 720, `等待 ${w}ms`);
});

test('滾動一小時：達上限後要等到最早那筆滿一小時；降速窗（1,500）時已用量超過就暫停', () => {
  const c = clock();
  let cap = 5000;
  const rl = createRateLimiter({ now: c.now, capFor: () => cap, perSecond: 1e6, burst: 1e6 });
  for (let i = 0; i < 2000; i++) { rl.record(); c.advance(1); }
  assert.equal(rl.inLastHour(), 2000);
  cap = 1500;   // 進入平日盤中尖峰
  const w = rl.waitMs();
  // 要讓過去一小時的筆數降到 1,500 以下：第 501 筆（index 500）過期才行
  assert.equal(w, 3600e3 - 2000 + 500);
  c.advance(w);
  assert.ok(rl.inLastHour() < 1500);
});

test('seed：以伺服器 user_count 預先佔用額度（重啟後不會一口氣衝過上限）；視為過去一小時平均送出，逐步釋放而不是整整等一小時', () => {
  const c = clock();
  const rl = createRateLimiter({ now: c.now, capFor: () => 100, perSecond: 1e6, burst: 1e6 });
  rl.seed(100);
  assert.equal(rl.inLastHour(), 100);
  const w = rl.waitMs();
  assert.ok(w > 0 && w < 60e3, `額度已滿 ⇒ 要等，但只等到最舊的一筆過期（${w}ms）`);
  c.advance(30 * 60e3);
  assert.ok(Math.abs(rl.inLastHour() - 50) <= 1, '半小時後約一半過期');
  rl.seed(-5); rl.seed(Number.NaN);   // 非法值忽略
  assert.ok(Math.abs(rl.inLastHour() - 50) <= 1);
});

test('setServerCap：伺服器回報的每小時上限低於本機設定時，取其 90%', () => {
  const c = clock();
  const rl = createRateLimiter({ now: c.now, capFor: () => 5000, perSecond: 1e6, burst: 1e6 });
  rl.setServerCap(6000);
  assert.equal(rl.cap(), 5000);
  rl.setServerCap(1000);
  assert.equal(rl.cap(), 900);
  rl.setServerCap(null);   // 無效值不改
  assert.equal(rl.cap(), 900);
});
