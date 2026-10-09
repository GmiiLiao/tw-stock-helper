// 官方鏡像「被擋就再試」共用迴圈（2026-10-09 全站掃描第 1 項）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryWhileBlocked, lockWaitRounds, GATE_RETRY, LOCK_WAIT, LOCK_YIELD_CMDS } from './official-mirror-retry.mjs';

const fakeSleep = () => { const waits = []; return { waits, sleep: async ms => { waits.push(ms); } }; };

test('第一次就成功：不等待、不再試', async () => {
  const s = fakeSleep();
  const r = await retryWhileBlocked({ attempt: async () => true, gapMs: 1000, maxRounds: 3, sleep: s.sleep });
  assert.deepEqual(r, { done: true, attempts: 1, stopped: null });
  assert.equal(s.waits.length, 0);
});

test('被擋兩次後成功：等兩次、beforeRetry 依序收到 1、2', async () => {
  const s = fakeSleep(); const seen = []; let n = 0;
  const r = await retryWhileBlocked({ attempt: async () => ++n >= 3, gapMs: 900000, maxRounds: 3, sleep: s.sleep, beforeRetry: x => seen.push(x) });
  assert.deepEqual(r, { done: true, attempts: 3, stopped: null });
  assert.deepEqual(s.waits, [900000, 900000]);
  assert.deepEqual(seen, [1, 2]);
});

test('一直被擋：最多再試 maxRounds 輪（總共 maxRounds+1 次嘗試）', async () => {
  const s = fakeSleep(); let n = 0;
  const r = await retryWhileBlocked({ attempt: async () => { n++; return false; }, gapMs: 1, maxRounds: 3, sleep: s.sleep });
  assert.deepEqual(r, { done: false, attempts: 4, stopped: 'max' });
  assert.equal(n, 4); assert.equal(s.waits.length, 3);
});

test('maxRounds=0（手動 --date 的 daily）：只試一次、不等待', async () => {
  const s = fakeSleep(); let n = 0;
  const r = await retryWhileBlocked({ attempt: async () => { n++; return false; }, gapMs: 1, maxRounds: 0, sleep: s.sleep });
  assert.deepEqual(r, { done: false, attempts: 1, stopped: 'max' });
  assert.equal(n, 1); assert.equal(s.waits.length, 0);
});

test('等待後進入禁跑窗：停止、不再嘗試', async () => {
  const s = fakeSleep(); let n = 0; let k = 0;
  const r = await retryWhileBlocked({ attempt: async () => { n++; return false; }, gapMs: 1, maxRounds: 9, sleep: s.sleep,
    stopReason: () => (++k >= 2 ? '平日 07:30～15:30 禁跑窗' : null) });
  assert.deepEqual(r, { done: false, attempts: 2, stopped: '平日 07:30～15:30 禁跑窗' });
  assert.equal(n, 2);
});

test('attempt 收到的 round 從 0 起算（等鎖用 round>0 才真的再拿鎖）', async () => {
  const rounds = [];
  await retryWhileBlocked({ attempt: async r => { rounds.push(r); return r === 2; }, gapMs: 0, maxRounds: 5, sleep: async () => {} });
  assert.deepEqual(rounds, [0, 1, 2]);
});

test('參數不合法就丟錯', async () => {
  await assert.rejects(() => retryWhileBlocked({ attempt: async () => true, gapMs: -1, maxRounds: 1 }));
  await assert.rejects(() => retryWhileBlocked({ attempt: async () => true, gapMs: 1, maxRounds: 1.5 }));
});

test('參數表：retry 06:45 起每 15 分鐘×3 輪不超過 07:30；daily 參數與 10-09 上線版相同；等鎖每 5 分鐘', () => {
  assert.equal(GATE_RETRY.retry.gapMs * GATE_RETRY.retry.maxRounds, 45 * 60000);
  assert.deepEqual(GATE_RETRY.daily, { gapMs: 30 * 60000, maxRounds: 5 });
  assert.equal(lockWaitRounds(LOCK_WAIT.retry), 9);
  assert.equal(lockWaitRounds(LOCK_WAIT.daily), 24);
  assert.equal(lockWaitRounds({ gapMs: 10, maxWaitMs: 5 }), 0);
  for (const c of ['backfill', 'ticks']) { assert.ok(LOCK_YIELD_CMDS.includes(c)); assert.equal(LOCK_WAIT[c], undefined); }
});
