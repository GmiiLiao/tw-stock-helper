// FinMind 回應串流切列 單元測試：node --test scripts/finmind/jsonstream.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRowSplitter, splitAll } from './jsonstream.mjs';

const BODY = JSON.stringify({
  msg: 'success "data":[x] {tricky}', status: 200,
  data: [
    { date: '2026-10-07', stock_id: '2330', note: 'a "quote" \\ back}slash ]', open: 2565.0 },
    { date: '2026-10-07', stock_id: '6129', arr: [1, [2, 3], { k: '}' }], name: '中文名稱' },
    { date: '2026-10-07', stock_id: '00940', open: 13.3 },
  ],
});

function feed(text, sizes) {
  const sp = createRowSplitter();
  const rows = [];
  let i = 0, k = 0;
  while (i < text.length) { const n = sizes[k++ % sizes.length]; rows.push(...sp.push(text.slice(i, i + n))); i += n; }
  return { rows, meta: sp.end() };
}

test('整塊輸入：逐列切出原文、外層 msg／status 正確（字串內的 "data":[ 與括號不誤判）', () => {
  const { rows, meta } = splitAll(BODY);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => JSON.parse(r)), JSON.parse(BODY).data);
  assert.equal(meta.status, 200);
  assert.equal(meta.msg, 'success "data":[x] {tricky}');
  assert.equal(meta.hasData, true);
});

test('任意切塊（1～7 字元）結果與整塊相同——塊邊界落在字串、跳脫字元、巢狀陣列中間都要對', () => {
  const ref = JSON.parse(BODY).data;
  for (const sizes of [[1], [2], [3], [5, 1, 7], [7, 2]]) {
    const { rows, meta } = feed(BODY, sizes);
    assert.deepEqual(rows.map(r => JSON.parse(r)), ref, `sizes=${sizes}`);
    assert.equal(meta.status, 200);
  }
});

test('錯誤回應（沒有 data）：0 列、取得 msg 與 status；token_tail 交由呼叫端抹除', () => {
  const { rows, meta } = splitAll('{"msg":"date parameter is missing.","status":400,"token_tail":"abcdefgh"}');
  assert.equal(rows.length, 0); assert.equal(meta.status, 400); assert.equal(meta.hasData, false);
});

test('空 data 陣列、data 在前 msg 在後、純量元素', () => {
  assert.equal(splitAll('{"msg":"success","status":200,"data":[]}').rows.length, 0);
  const r = splitAll('{"data":[{"a":1} , {"a":2}],"status":200,"msg":"success"}');
  assert.deepEqual(r.rows.map(x => JSON.parse(x)), [{ a: 1 }, { a: 2 }]);
  assert.equal(r.meta.msg, 'success');
  const s = splitAll('{"status":200,"data":["x\\"y", 12, true, null]}');
  assert.deepEqual(s.rows.map(x => JSON.parse(x)), ['x"y', 12, true, null]);
});

test('截斷的回應：end() 丟錯（不可把半份資料當完整）', () => {
  const sp = createRowSplitter();
  sp.push(BODY.slice(0, BODY.length - 10));
  assert.throws(() => sp.end(), /不完整/);
  assert.throws(() => splitAll('not json'), /JSON/);
});
