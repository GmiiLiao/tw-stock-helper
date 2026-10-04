// 年報 PDF 大小上限（G1-29·2026-10-04）：node --test scripts/lib/stock-wiki/annual-report-cap.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBodyCapped, MAX_PDF_BYTES } from './annual-report.mjs';

const streamOf = (chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new Uint8Array(x)); c.close(); } });

test('上限內 → 完整回傳', async () => {
  const r = new Response(streamOf([[0x25, 0x50], [0x44, 0x46]]));
  const buf = await readBodyCapped(r, 10);
  assert.equal(buf.toString(), '%PDF');
});

test('Content-Length 宣告超過上限 → 不讀本體直接拒絕', async () => {
  const r = new Response('x', { headers: { 'content-length': String(MAX_PDF_BYTES + 1) } });
  await assert.rejects(readBodyCapped(r), /宣告/);
});

test('未宣告長度但串流超過上限 → 讀到超過即中止', async () => {
  const r = new Response(streamOf([new Array(6).fill(1), new Array(6).fill(1)]));
  await assert.rejects(readBodyCapped(r, 10), /已讀 12 bytes/);
});

test('沒有串流介面的假回應 → arrayBuffer 後檢查', async () => {
  const fake = { headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(20).buffer };
  await assert.rejects(readBodyCapped(fake, 10), /20 bytes/);
  const ok = { headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(5).buffer };
  assert.equal((await readBodyCapped(ok, 10)).length, 5);
});
