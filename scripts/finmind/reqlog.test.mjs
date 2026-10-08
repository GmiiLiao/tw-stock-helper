// 請求記錄 單元測試：node --test scripts/finmind/reqlog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRecord, createRequestLog } from './reqlog.mjs';

const TOKEN = 'eyFAKEtokenvaluexxxxxxxxxxxxxxxxxxxxxxxxxxxxTAIL9876';

test('formatRecord：[tag] 台北時間 JSON，整行再遮罩（msg 裡回聲的 token／末 8 碼也抹掉）', () => {
  const line = formatRecord({ url: '/data?dataset=X', msg: `bad ${TOKEN} tail ${TOKEN.slice(-8)}` }, { now: () => Date.UTC(2026, 9, 8, 13, 0), secrets: [TOKEN] });
  assert.match(line, /^\[backfill\] 2026-10-08T21:00:00\+08:00 \{/);
  assert.ok(!line.includes(TOKEN) && !line.includes(TOKEN.slice(-8)));
});

test('createRequestLog：滿一批才寫；flush 寫剩下的；寫檔失敗不丟出', () => {
  const writes = [];
  const log = createRequestLog('/x/requests.log', { batch: 2, append: (p, s) => writes.push(s), mkdir: () => {}, now: () => 0, secrets: [TOKEN] });
  log.write({ a: 1 }); assert.equal(writes.length, 0);
  log.write({ a: 2 }); assert.equal(writes.length, 1); assert.equal(writes[0].trim().split('\n').length, 2);
  log.write({ a: 3 }); log.flush(); assert.equal(writes.length, 2);
  const bad = createRequestLog('/x/r.log', { batch: 1, mkdir: () => {}, append: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
  assert.doesNotThrow(() => bad.write({ a: 1 }));
});
