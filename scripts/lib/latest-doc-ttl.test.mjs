// latestDoc 記憶體 TTL 分層 單元測試：node --test scripts/lib/latest-doc-ttl.test.mjs
// 不連網、不碰 Firestore：TTL 表＋api-cache.ts 原始碼的層級表比對＋真正的 singleflight 合流行為（假 fetcher）。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LATEST_DOC_TTL_MS } from './latest-doc-ttl.mjs';

// 用 latestDoc 真正用的 src/lib/singleflight.ts（無 import、只有可剝除的型別註記，Node 25 內建型別剝除可直接載入）。
// 以 import.meta.url 組路徑做動態 import：check-imports 只認 .mjs/.js/.json 字面值 specifier；檔案不存在時本測試直接失敗，不會靜默略過。
const { memoizeWithMeta } = await import(new URL('../../src/lib/singleflight.ts', import.meta.url).href);

const API_CACHE_SRC = readFileSync(new URL('../../src/lib/api-cache.ts', import.meta.url), 'utf8');

/** 從 api-cache.ts 取出 TIERS 表：{ tier: 'Cache-Control 字串' } */
function tiersFromSource(src) {
  const block = src.match(/const TIERS: Record<Tier, string> = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'api-cache.ts 找不到 TIERS 表（改名了？請同步本測試）');
  const out = {};
  for (const m of block[1].matchAll(/^\s*(\w+):\s*'([^']+)'/gm)) out[m[1]] = m[2];
  return out;
}

/** 從 api-cache.ts 取出 Tier 聯集成員 */
function tierUnionFromSource(src) {
  const block = src.match(/export type Tier =([\s\S]*?);/);
  assert.ok(block, 'api-cache.ts 找不到 export type Tier');
  return [...block[1].matchAll(/'(\w+)'/g)].map(m => m[1]).sort();
}

const sMaxAgeMs = cc => { const m = cc.match(/s-maxage=(\d+)/); return m ? Number(m[1]) * 1000 : null; };

test('H6：tick≈2 秒、quote≈5 秒；intraday 與 daily 維持原值', () => {
  assert.equal(LATEST_DOC_TTL_MS.tick, 2_000);
  assert.equal(LATEST_DOC_TTL_MS.quote, 5_000);
  assert.equal(LATEST_DOC_TTL_MS.intraday, 60_000);
  assert.equal(LATEST_DOC_TTL_MS.daily, 300_000);
  assert.equal(LATEST_DOC_TTL_MS.static, 300_000);
  assert.ok(Object.isFrozen(LATEST_DOC_TTL_MS));
});

test('TTL 表涵蓋 api-cache.ts 的每個 Tier（不多不少）', () => {
  assert.deepEqual(Object.keys(LATEST_DOC_TTL_MS).sort(), tierUnionFromSource(API_CACHE_SRC));
});

test('記憶體 TTL 不長於該層 CDN s-maxage（兩層疊加最壞 ≤ 2×s-maxage）', () => {
  const tiers = tiersFromSource(API_CACHE_SRC);
  assert.ok(Object.keys(tiers).length >= 7, `TIERS 只解析到 ${Object.keys(tiers).length} 層`);
  for (const [tier, cc] of Object.entries(tiers)) {
    const ttl = LATEST_DOC_TTL_MS[tier];
    assert.equal(typeof ttl, 'number', `${tier} 沒有記憶體 TTL`);
    const cdn = sMaxAgeMs(cc);
    if (cdn == null) continue;   // private 沒有 s-maxage（不可共享快取）
    assert.ok(ttl <= cdn, `${tier}：記憶體 ${ttl}ms > CDN s-maxage ${cdn}ms`);
  }
  // 盤中層的實際數字（防有人把 tick 調回 60 秒）
  assert.ok(sMaxAgeMs(tiers.tick) >= LATEST_DOC_TTL_MS.tick);
  assert.ok(sMaxAgeMs(tiers.quote) >= LATEST_DOC_TTL_MS.quote);
});

test('latestDoc 以表取 TTL（不是寫死的 60 秒三元式）', () => {
  assert.match(API_CACHE_SRC, /const ttlMs = LATEST_DOC_TTL_BY_TIER\[tier\];/);
  assert.doesNotMatch(API_CACHE_SRC, /\? 300_000 : 60_000/);
});

test('Firestore 讀取量是常數：tick 層 1,200 個請求散在 60 秒、每拍 20 個併發 ⇒ 讀取 ≤ 30 次，與請求數無關', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 5, 2, 0, 0) });   // 台北 10:00
  let reads = 0;
  const read = memoizeWithMeta('test:latest-doc-ttl:tick', LATEST_DOC_TTL_MS.tick, async () => { reads++; return { ok: true, data: { n: reads } }; });
  for (let s = 0; s < 60; s++) {
    // 同一秒 20 個併發：in-flight 合流
    const rs = await Promise.all(Array.from({ length: 20 }, () => read()));
    assert.ok(rs.every(r => r && r.value.ok));
    mock.timers.tick(1_000);
  }
  assert.ok(reads <= 30, `讀了 ${reads} 次`);
  assert.ok(reads >= 20, `讀了 ${reads} 次（TTL 沒有過期重讀？）`);

  // 同樣 60 秒、請求量放大 5 倍 ⇒ 讀取次數不變
  let reads2 = 0;
  const read2 = memoizeWithMeta('test:latest-doc-ttl:tick-x5', LATEST_DOC_TTL_MS.tick, async () => { reads2++; return { ok: true, data: null }; });
  for (let s = 0; s < 60; s++) {
    await Promise.all(Array.from({ length: 100 }, () => read2()));
    mock.timers.tick(1_000);
  }
  assert.equal(reads2, reads);
});

test('quote 層 5 秒內重複讀取只打一次；過期後重讀', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 5, 2, 0, 0) });
  let reads = 0;
  const read = memoizeWithMeta('test:latest-doc-ttl:quote', LATEST_DOC_TTL_MS.quote, async () => { reads++; return reads; });
  await read(); mock.timers.tick(4_999); await read();
  assert.equal(reads, 1);
  mock.timers.tick(1); await read();
  assert.equal(reads, 2);
});
