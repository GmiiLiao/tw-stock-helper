// 通知去重（持久化）單元測試：node --test scripts/lib/alert-dedup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertDedup } from './alert-dedup.mjs';

// 假的持久層：行為同 Firestore（arrayUnion 不重複、load 讀回、可模擬失敗），並記錄寫入次數
const mkStore = () => {
  const docs = new Map(); let failLoad = 0;
  const st = {
    docs, writes: 0, failNext(n = 1) { failLoad = n; },
    async load(name, scope) { if (failLoad > 0) { failLoad--; throw new Error('unavailable'); } return [...(docs.get(`${name}_${scope}`) || [])]; },
    async addMany(name, scope, keys) { st.writes++; const id = `${name}_${scope}`; const s = docs.get(id) || []; for (const k of keys) if (!s.includes(k)) s.push(k); docs.set(id, s); },
    async replace(name, scope, keys) { st.writes++; docs.set(`${name}_${scope}`, [...keys]); },
  };
  return st;
};
const manual = { autoFlush: false };

test('重啟後（新的 dedup 物件）讀回當日已發過的鍵，不再重發——2026-10-02 開機重跑重發通知的修正', async () => {
  const store = mkStore();
  const a = createAlertDedup('etf', store, manual);
  await a.ensure('2026-10-02');
  assert.equal(a.add('u1:0050'), true);
  assert.equal(a.add('u1:0050'), false, '同一輪重複呼叫只算一次');
  await a.flush();
  const b = createAlertDedup('etf', store, manual);   // 模擬 daemon 重啟
  await b.ensure('2026-10-02');
  assert.equal(b.has('u1:0050'), true);
  assert.equal(b.add('u1:0050'), false);
});

test('批次寫入：同一波多筆只寫一次（審查 M2：熱門文件每秒多次寫入）', async () => {
  const store = mkStore();
  const a = createAlertDedup('chipHold', store, manual);
  await a.ensure('d');
  for (let i = 0; i < 50; i++) a.add(`u${i}:2330:dist`);
  await a.flush();
  assert.equal(store.writes, 1);
  assert.equal(store.docs.get('chipHold_d').length, 50);
});

test('自動寫出：add 後在延遲內合併成一次寫入（計時器可注入）', async () => {
  const store = mkStore(); const fired = [];
  const timers = { setTimeout: fn => { fired.push(fn); return { unref() {} }; }, clearTimeout: () => {} };
  const a = createAlertDedup('etf', store, { timers });
  await a.ensure('d');
  a.add('k1'); a.add('k2');
  assert.equal(fired.length, 1, '同一波只排一次計時器');
  await fired[0]();
  assert.deepEqual(store.docs.get('etf_d'), ['k1', 'k2']);
});

test('送出失敗撤回（審查 M1）：mark/rollback 後該使用者的鍵不寫入、下一輪可重發', async () => {
  const store = mkStore();
  const a = createAlertDedup('alerts', store, manual);
  await a.ensure('d');
  a.add('u1:2330:stop'); await a.flush();
  const tok = a.mark();
  a.add('u2:2317:stop');
  a.rollback(tok);   // u2 的通知文件寫入失敗
  assert.equal(a.has('u2:2317:stop'), false);
  await a.flush();
  assert.deepEqual(store.docs.get('alerts_d'), ['u1:2330:stop']);
});

test('跨日（換 scope）：舊 scope 的暫存先寫出；昨天發過的今天照常可發', async () => {
  const store = mkStore();
  const a = createAlertDedup('etf', store, manual);
  await a.ensure('2026-10-02'); a.add('u1:0050');
  await a.ensure('2026-10-05');
  assert.deepEqual(store.docs.get('etf_2026-10-02'), ['u1:0050'], '換日前的暫存不遺失');
  assert.equal(a.has('u1:0050'), false);
  assert.equal(a.add('u1:0050'), true);
});

test('讀取失敗：本輪退回記憶體（與舊行為相同、不擋通知）並回報錯誤，下一次 ensure 重讀合併', async () => {
  const store = mkStore(); const errs = [];
  await store.addMany('etf', '2026-10-02', ['u1:0050']);
  const a = createAlertDedup('etf', store, { ...manual, onError: (op, e) => errs.push(`${op}:${e.message}`) });
  store.failNext();
  await a.ensure('2026-10-02');
  assert.equal(a.has('u1:0050'), false, '讀不到時無從得知（同舊版記憶體行為）');
  assert.deepEqual(errs, ['load:unavailable']);
  a.add('u2:0056'); await a.flush();
  await a.ensure('2026-10-02');
  assert.equal(a.has('u1:0050'), true, '重讀成功後補回');
  assert.equal(a.has('u2:0056'), true, '本輪新增的不遺失');
});

test('prune：除權息等跨日事件用固定 scope，每天載入／換日時清掉已過期的鍵並寫回', async () => {
  const store = mkStore();
  await store.replace('exdiv', 'all', ['u1:2330:2026-09-30', 'u1:2317:2026-10-06']);
  const keepFuture = (k, today) => k.slice(k.lastIndexOf(':') + 1) >= today;
  const a = createAlertDedup('exdiv', store, { ...manual, prune: keepFuture });
  await a.ensure('all', '2026-10-02');
  assert.equal(a.has('u1:2317:2026-10-06'), true);
  assert.equal(a.has('u1:2330:2026-09-30'), false);
  assert.deepEqual(store.docs.get('exdiv_all'), ['u1:2317:2026-10-06']);
  await a.ensure('all', '2026-10-07');   // 同一程序跨日（審查 LOW：舊版只在首次載入時清）
  assert.equal(a.has('u1:2317:2026-10-06'), false);
  assert.deepEqual(store.docs.get('exdiv_all'), []);
});

test('寫入失敗不丟例外、回報錯誤，並放回暫存：下一次 flush 補寫（審查 LOW：舊版失敗即丟）', async () => {
  const errs = []; const base = mkStore(); let fail = 1;
  const store = { ...base, addMany: async (...a) => { if (fail-- > 0) throw new Error('quota'); return base.addMany(...a); } };
  const a = createAlertDedup('x', store, { ...manual, onError: op => errs.push(op) });
  await a.ensure('d');
  assert.equal(a.add('k'), true);
  await a.flush();
  assert.equal(a.has('k'), true);
  assert.deepEqual(errs, ['add']);
  a.add('k2'); await a.flush();
  assert.deepEqual(base.docs.get('x_d'), ['k', 'k2'], '失敗那筆在下一次寫入時補上');
});

test('keys()：可據以重建每人計數（早盤起漲每人每日 6 則上限，重啟後不歸零）', async () => {
  const store = mkStore();
  await store.addMany('ebSent', 'd', ['u1:2330', 'u1:2317', 'u2:2454']);
  const a = createAlertDedup('ebSent', store, manual);
  await a.ensure('d');
  const cnt = {}; for (const k of a.keys()) { const u = k.slice(0, k.indexOf(':')); cnt[u] = (cnt[u] || 0) + 1; }
  assert.deepEqual(cnt, { u1: 2, u2: 1 });
});
