// 上游重試與連續失敗警示 單元測試：node --test scripts/lib/fetch-retry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, failStreak, sameLockDay } from './fetch-retry.mjs';

const noSleep = async () => {};

test('withRetry：上游被中斷（terminated）時重新取得，第 2 次成功就回傳——2026-10-02 開機兩次同時失敗的修正', async () => {
  let n = 0;
  const r = await withRetry(async () => { n++; if (n === 1) throw new Error('terminated'); return ['2330']; }, { sleep: noSleep, isOk: v => v.length > 0 });
  assert.deepEqual(r, { ok: true, value: ['2330'], tries: 2 });
});

test('withRetry：回空也算失敗要重試；3 次都失敗回報 ok=false 與最後錯誤，且間隔照設定等待', async () => {
  const waits = [];
  const r = await withRetry(async i => { if (i === 2) throw new Error('timeout'); return []; }, { sleep: async ms => { waits.push(ms); }, isOk: v => v.length > 0, delays: [2000, 5000] });
  assert.equal(r.ok, false); assert.equal(r.tries, 3); assert.match(String(r.error?.message), /timeout/);
  assert.deepEqual(waits, [2000, 5000]);
});

test('failStreak：連續失敗到門檻那一輪才警示一次；成功即歸零', () => {
  let s = 0; const alerts = [];
  for (const ok of [false, false, false, false, true, false]) { const r = failStreak(s, ok, 3); s = r.n; alerts.push(r.alert); }
  assert.deepEqual(alerts, [false, false, true, false, false, false]);
  assert.equal(s, 1);
});

test('sameLockDay：以收盤資料日判斷「同一天重算」——週末開機資料日不變，不可再累加連續天數', () => {
  const prev = { date: '2026-10-02', lockDataDate: '20261002' };
  assert.equal(sameLockDay(prev, '20261002', '2026-10-03'), true, '週六開機：資料仍是週五 ⇒ 同一天');
  assert.equal(sameLockDay(prev, '20261005', '2026-10-05'), false, '週一收盤後：新資料日 ⇒ 累加');
  assert.equal(sameLockDay({ date: '2026-10-02' }, '20261002', '2026-10-02'), true, '舊文件沒有 lockDataDate ⇒ 退回日曆日判斷');
  assert.equal(sameLockDay({ date: '2026-10-02' }, '20261002', '2026-10-03'), false);
  assert.equal(sameLockDay(prev, '', '2026-10-02'), true, '本輪資料日不明 ⇒ 退回日曆日判斷');
  assert.equal(sameLockDay(null, '20261002', '2026-10-02'), false);
});
