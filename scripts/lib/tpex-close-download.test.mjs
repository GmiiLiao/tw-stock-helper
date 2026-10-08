// node --test scripts/lib/tpex-close-download.test.mjs
// 串流下載器：慢但在傳不中止、停住才中止、等不到標頭、中途斷線、Content-Length 不符、總上限、304、Range 續傳。
// 全部注入 fetch，不打網路；時間參數縮成毫秒級。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadStream } from './tpex-close-download.mjs';
import { mockFetch } from './tpex-close.fixture.mjs';


const FAST = { ttfbMs: 200, stallMs: 120, capMs: 3000, tickMs: 10 };
const chunksOf = (s, n, delay) => { const out = []; const step = Math.ceil(s.length / n); for (let i = 0; i < s.length; i += step) out.push({ delay, data: s.slice(i, i + step) }); return out; };
const BODY = 'x'.repeat(1000);

test('慢但在傳：總時間遠超過停滯門檻仍完整收完（不以固定總逾時誤殺）', async () => {
  const f = mockFetch(() => ({ status: 200, headers: { 'content-length': '1000', etag: '"e1"', 'accept-ranges': 'bytes' }, chunks: chunksOf(BODY, 10, 60) }));
  const t0 = Date.now();
  const r = await downloadStream('u', { fetchImpl: f, ...FAST });
  assert.equal(r.ok, true, r.reason); assert.equal(r.buf.toString(), BODY); assert.equal(r.etag, '"e1"');
  assert.ok(Date.now() - t0 > FAST.stallMs * 3, '總時間 > 3 倍停滯門檻');
});

test('停滯：收到一部分後沒有新位元組超過門檻 ⇒ stall，回已收的部分', async () => {
  const f = mockFetch(() => ({ status: 200, headers: { 'content-length': '1000', etag: '"e1"', 'accept-ranges': 'bytes' }, chunks: chunksOf(BODY.slice(0, 400), 4, 5), hangAfter: true }));
  const r = await downloadStream('u', { fetchImpl: f, ...FAST });
  assert.equal(r.ok, false); assert.equal(r.reason, 'stall');
  assert.equal(r.partial.length, 400); assert.equal(r.total, 1000); assert.equal(r.resumable, true);
});

test('等不到回應標頭 ⇒ ttfb', async () => {
  const f = mockFetch(() => ({ status: 200, ttfb: 1000, chunks: [] }));
  const r = await downloadStream('u', { fetchImpl: f, ...FAST });
  assert.equal(r.ok, false); assert.equal(r.reason, 'ttfb');
});

test('中途斷線（ECONNRESET／terminated）⇒ reset，回已收的部分', async () => {
  const f = mockFetch(() => ({ status: 200, headers: { 'content-length': '1000', etag: '"e1"', 'accept-ranges': 'bytes' }, chunks: chunksOf(BODY.slice(0, 700), 7, 2), reset: true }));
  const r = await downloadStream('u', { fetchImpl: f, ...FAST });
  assert.equal(r.ok, false); assert.equal(r.reason, 'reset'); assert.equal(r.partial.length, 700);
});

test('Content-Length 不符（伺服器提早正常關閉）⇒ length', async () => {
  const f = mockFetch(() => ({ status: 200, headers: { 'content-length': '1000' }, chunks: chunksOf(BODY.slice(0, 900), 3, 1) }));
  const r = await downloadStream('u', { fetchImpl: f, ...FAST });
  assert.equal(r.ok, false); assert.equal(r.reason, 'length'); assert.equal(r.bytes, 900);
});

test('壓縮傳輸（content-encoding）不比 Content-Length（解壓後長度本來就不同）', async () => {
  const f = mockFetch(() => ({ status: 200, headers: { 'content-length': '10', 'content-encoding': 'gzip' }, chunks: chunksOf(BODY, 2, 1) }));
  const r = await downloadStream('u', { fetchImpl: f, ...FAST });
  assert.equal(r.ok, true); assert.equal(r.bytes, 1000); assert.equal(r.total, null);
});

test('總上限：一直在傳但超過上限 ⇒ cap', async () => {
  const f = mockFetch(() => ({ status: 200, headers: { 'content-length': '1000' }, chunks: chunksOf(BODY, 50, 30) }));
  const r = await downloadStream('u', { fetchImpl: f, ...FAST, capMs: 300 });
  assert.equal(r.ok, false); assert.equal(r.reason, 'cap');
});

test('條件請求：帶 If-None-Match，304 ⇒ notModified、0 bytes', async () => {
  const f = mockFetch(() => ({ status: 304, headers: { etag: '"e1"' } }));
  const r = await downloadStream('u', { fetchImpl: f, ...FAST, conditional: { etag: '"e1"', lastModified: 'Thu, 08 Oct 2026 10:00:06 GMT' } });
  assert.equal(r.ok, true); assert.equal(r.notModified, true); assert.equal(r.bytes, 0);
  assert.equal(f.calls[0].headers['If-None-Match'], '"e1"');
  assert.equal(f.calls[0].headers['If-Modified-Since'], 'Thu, 08 Oct 2026 10:00:06 GMT');
});

test('Range 續傳：送 Range＋If-Range，206 起點吻合 ⇒ 接上前段＝完整檔', async () => {
  const f = mockFetch(() => ({ status: 206, headers: { 'content-range': 'bytes 400-999/1000', 'content-length': '600', etag: '"e1"' }, chunks: chunksOf(BODY.slice(400), 3, 2) }));
  const r = await downloadStream('u', { fetchImpl: f, ...FAST, resume: { offset: 400, etag: '"e1"', prefix: Buffer.from(BODY.slice(0, 400)) } });
  assert.equal(r.ok, true, r.reason); assert.equal(r.resumed, true); assert.equal(r.buf.toString(), BODY); assert.equal(r.total, 1000);
  assert.equal(f.calls[0].headers.Range, 'bytes=400-'); assert.equal(f.calls[0].headers['If-Range'], '"e1"');
});

test('Range 續傳：伺服器回 200（檔案已改版）⇒ 丟棄前段、整檔重收', async () => {
  const NEW = 'y'.repeat(800);
  const f = mockFetch(() => ({ status: 200, headers: { 'content-length': '800', etag: '"e2"' }, chunks: chunksOf(NEW, 2, 1) }));
  const r = await downloadStream('u', { fetchImpl: f, ...FAST, resume: { offset: 400, etag: '"e1"', prefix: Buffer.from(BODY.slice(0, 400)) } });
  assert.equal(r.ok, true); assert.equal(r.resumed, false); assert.equal(r.buf.toString(), NEW); assert.equal(r.etag, '"e2"');
});

test('Range 續傳：206 起點不吻合或 416 ⇒ range（呼叫端丟棄部分檔重來）', async () => {
  const bad = mockFetch(() => ({ status: 206, headers: { 'content-range': 'bytes 0-999/1000' }, chunks: chunksOf(BODY, 1, 1) }));
  assert.equal((await downloadStream('u', { fetchImpl: bad, ...FAST, resume: { offset: 400, etag: '"e1"', prefix: Buffer.alloc(400) } })).reason, 'range');
  const r416 = mockFetch(() => ({ status: 416 }));
  assert.equal((await downloadStream('u', { fetchImpl: r416, ...FAST, resume: { offset: 400, etag: '"e1"', prefix: Buffer.alloc(400) } })).reason, 'range');
});

test('onHeaders 可依標頭提早中止（例：Last-Modified 早於期望日＝還是舊檔）', async () => {
  const f = mockFetch(() => ({ status: 200, headers: { 'content-length': '1000', 'last-modified': 'Wed, 07 Oct 2026 10:00:00 GMT' }, chunks: chunksOf(BODY, 10, 50) }));
  const r = await downloadStream('u', { fetchImpl: f, ...FAST, onHeaders: h => (h.lastModified ? 'stale' : null) });
  assert.equal(r.ok, false); assert.equal(r.reason, 'stale'); assert.equal(r.bytes, 0);
});

test('HTTP 403／302 ⇒ http（呼叫端判封鎖）', async () => {
  for (const status of [403, 302, 500]) {
    const f = mockFetch(() => ({ status, chunks: [{ data: 'no' }] }));
    const r = await downloadStream('u', { fetchImpl: f, ...FAST });
    assert.equal(r.ok, false); assert.equal(r.reason, 'http'); assert.equal(r.http, status);
  }
});

test('連線失敗（DNS 等，標頭前就丟錯）⇒ connect', async () => {
  const f = async () => { throw new TypeError('fetch failed'); };
  const r = await downloadStream('u', { fetchImpl: f, ...FAST });
  assert.equal(r.ok, false); assert.equal(r.reason, 'connect'); assert.match(r.error, /fetch failed/);
});
