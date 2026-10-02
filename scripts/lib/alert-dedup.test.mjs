// 通知去重（持久化）單元測試：node --test scripts/lib/alert-dedup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertDedup } from './alert-dedup.mjs';

// 假的持久層：行為同 Firestore（arrayUnion 不重複、load 讀回、可模擬失敗）
const mkStore = () => {
  const docs = new Map(); let failLoad = 0;
  return {
    docs, failNext(n = 1) { failLoad = n; },
    async load(name, scope) { if (failLoad > 0) { failLoad--; throw new Error('unavailable'); } return [...(docs.get(`${name}_${scope}`) || [])]; },
    async add(name, scope, k) { const id = `${name}_${scope}`; const s = docs.get(id) || []; if (!s.includes(k)) s.push(k); docs.set(id, s); },
    async replace(name, scope, keys) { docs.set(`${name}_${scope}`, [...keys]); },
  };
};
const flush = () => new Promise(r => setImmediate(r));

test('重啟後（新的 dedup 物件）讀回當日已發過的鍵，不再重發——2026-10-02 開機重跑重發通知的修正', async () => {
  const store = mkStore();
  const a = createAlertDedup('etf', store);
  await a.ensure('2026-10-02');
  assert.equal(a.add('u1:0050'), true);
  assert.equal(a.add('u1:0050'), false, '同一輪重複呼叫只算一次');
  await flush();
  const b = createAlertDedup('etf', store);   // 模擬 daemon 重啟
  await b.ensure('2026-10-02');
  assert.equal(b.has('u1:0050'), true);
  assert.equal(b.add('u1:0050'), false);
});

test('跨日（換 scope）重新計算：昨天發過的今天照常可發', async () => {
  const store = mkStore();
  const a = createAlertDedup('etf', store);
  await a.ensure('2026-10-02'); a.add('u1:0050'); await flush();
  await a.ensure('2026-10-05');
  assert.equal(a.has('u1:0050'), false);
  assert.equal(a.add('u1:0050'), true);
});

test('讀取失敗：本輪退回記憶體（與舊行為相同、不擋通知），下一次 ensure 會重讀並合併', async () => {
  const store = mkStore();
  await store.add('etf', '2026-10-02', 'u1:0050');
  const a = createAlertDedup('etf', store);
  store.failNext();
  await a.ensure('2026-10-02');
  assert.equal(a.has('u1:0050'), false, '讀不到時無從得知（同舊版記憶體行為）');
  a.add('u2:0056'); await flush();
  await a.ensure('2026-10-02');
  assert.equal(a.has('u1:0050'), true, '重讀成功後補回');
  assert.equal(a.has('u2:0056'), true, '本輪新增的不遺失');
});

test('prune：除權息提醒等「跨日事件」用固定 scope，載入時清掉已過期的鍵並寫回（文件不無限長大）', async () => {
  const store = mkStore();
  await store.replace('exdiv', 'all', ['u1:2330:2026-09-30', 'u1:2317:2026-10-06']);
  const keepFuture = (k, today) => k.slice(k.lastIndexOf(':') + 1) >= today;
  const a = createAlertDedup('exdiv', store, { prune: keepFuture });
  await a.ensure('all', '2026-10-02');
  assert.equal(a.has('u1:2317:2026-10-06'), true);
  assert.equal(a.has('u1:2330:2026-09-30'), false);
  await flush();
  assert.deepEqual(store.docs.get('exdiv_all'), ['u1:2317:2026-10-06']);
});

test('寫入失敗不丟例外（通知照發；最壞情況＝重啟後可能重發一次，同舊行為）', async () => {
  const store = { ...mkStore(), add: async () => { throw new Error('quota'); } };
  const a = createAlertDedup('x', store);
  await a.ensure('d');
  assert.equal(a.add('k'), true);
  await flush();
  assert.equal(a.has('k'), true);
});
