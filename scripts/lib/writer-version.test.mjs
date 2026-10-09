import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionOf, createWriterRegistry, installWriteRecorder } from './writer-version.mjs';
import { driftHealVerdict, inSafeSlot, DRIFT_SETTLE_MIN, MIN_UPTIME_MIN } from './drift-heal.mjs';

test('collectionOf：取頂層 collection，壞輸入回 null', () => {
  assert.equal(collectionOf('aiSwingMembers/uid123/days/2026-10-09'), 'aiSwingMembers');
  assert.equal(collectionOf('chipArchive/2026-10-08'), 'chipArchive');
  assert.equal(collectionOf(''), null);
  assert.equal(collectionOf(undefined), null);
});

test('registry：記頂層 collection、不記登記文件本身、takeChanges 後清空、restore 放回', () => {
  const r = createWriterRegistry('h1');
  r.record('marketSnapshot/latest', 100);
  r.record('aiSwingMembers/u/days/d', 200);
  r.record('system/writerVersions', 300);
  const ch = r.takeChanges();
  assert.deepEqual(ch, { marketSnapshot: { codeHash: 'h1', lastWriteAt: 100 }, aiSwingMembers: { codeHash: 'h1', lastWriteAt: 200 } });
  assert.equal(r.hasChanges(), false);
  r.restore(ch);
  assert.equal(r.hasChanges(), true);
});

test('installWriteRecorder：記錄路徑、參數與回傳原樣轉交、重複安裝不疊加', () => {
  class DocumentReference { constructor(p) { this.path = p; } set(d, o) { return ['set', d, o]; } update(d) { return ['update', d]; } create(d) { return ['create', d]; } }
  class WriteBatch { set(ref, d) { return ['bset', ref.path, d]; } update(ref, d) { return ['bupd', ref.path, d]; } create(ref, d) { return ['bcre', ref.path, d]; } }
  class Transaction { set(ref, d) { return ['tset', ref.path, d]; } update() { return 'tu'; } create() { return 'tc'; } }
  const seen = [];
  const reg = { record: p => seen.push(p) };
  installWriteRecorder({ DocumentReference, WriteBatch, Transaction }, reg);
  installWriteRecorder({ DocumentReference, WriteBatch, Transaction }, reg);
  const ref = new DocumentReference('a/b');
  assert.deepEqual(ref.set({ x: 1 }, { merge: true }), ['set', { x: 1 }, { merge: true }]);
  assert.deepEqual(new WriteBatch().set(new DocumentReference('c/d'), { y: 2 }), ['bset', 'c/d', { y: 2 }]);
  assert.deepEqual(new Transaction().set(new DocumentReference('e/f'), 3), ['tset', 'e/f', 3]);
  assert.deepEqual(seen, ['a/b', 'c/d', 'e/f']);   // 重複安裝仍只記一次
});

test('installWriteRecorder：記錄器丟例外時寫入照常', () => {
  class DocumentReference { constructor(p) { this.path = p; } set(d) { return d; } }
  installWriteRecorder({ DocumentReference }, { record: () => { throw new Error('boom'); } });
  assert.equal(new DocumentReference('a/b').set(7), 7);
});

const base = {
  runningHash: 'old', diskHash: 'new', driftSinceMs: 0, nowMs: (DRIFT_SETTLE_MIN + MIN_UPTIME_MIN) * 60_000,
  startedAtMs: 0, clean: true, canRestart: true, inflight: 0, mins: 12 * 60 + 30, isTradingDay: false,
};

test('driftHealVerdict：五道條件都成立才換碼', () => {
  assert.equal(driftHealVerdict(base).restart, true);
  assert.equal(driftHealVerdict({ ...base, diskHash: 'old' }).restart, false);
  assert.equal(driftHealVerdict({ ...base, driftSinceMs: base.nowMs - 60_000 }).restart, false);
  assert.equal(driftHealVerdict({ ...base, startedAtMs: base.nowMs - 60_000 }).restart, false);
  assert.equal(driftHealVerdict({ ...base, clean: false }).restart, false);
  assert.equal(driftHealVerdict({ ...base, clean: null }).restart, false);
  assert.equal(driftHealVerdict({ ...base, canRestart: false }).restart, false);
  assert.equal(driftHealVerdict({ ...base, inflight: 1 }).restart, false);
  assert.equal(driftHealVerdict({ ...base, mins: 23 * 60 }).restart, false);
  assert.equal(driftHealVerdict({ ...base, runningHash: null }).restart, false);
});

test('安全時段：交易日避開盤前／開盤感應器／尾盤／收盤歸檔，非交易日只在午後', () => {
  assert.equal(inSafeSlot(9 * 60 + 30, true), false);
  assert.equal(inSafeSlot(10 * 60 + 10, true), true);
  assert.equal(inSafeSlot(13 * 60 + 20, true), false);
  assert.equal(inSafeSlot(14 * 60 + 30, true), true);
  assert.equal(inSafeSlot(15 * 60 + 5, true), false);
  assert.equal(inSafeSlot(2 * 60, false), false);
  assert.equal(inSafeSlot(13 * 60, false), true);
});
