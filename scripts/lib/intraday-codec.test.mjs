// 即時走勢壓縮格式 單元測試：node --test scripts/lib/intraday-codec.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeIntraday, decodeIntraday, DOC_BUDGET } from './intraday-codec.mjs';

// 仿真序列：codes 檔 × 每檔 400 點 [epoch秒, 價, 累積量]（與 recordIntraday 同形）
const mkSeries = (codes, pts = 400) => {
  const s = {}; let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let c = 0; c < codes; c++) {
    const arr = []; let px = 50 + c, vol = 0;
    for (let i = 0; i < pts; i++) { px = +(px * (1 + (rnd() - 0.5) * 0.002)).toFixed(2); vol += Math.round(rnd() * 5000); arr.push([1790900000 + i * 60, px, vol]); }
    s[String(1100 + c)] = { prev: 50 + c, pts: arr };
  }
  return s;
};

test('壓縮後還原內容完全相同', () => {
  const s = mkSeries(20);
  const e = encodeIntraday(s);
  assert.deepEqual(decodeIntraday(e.shards), s);
  assert.deepEqual(decodeIntraday([e.gz]), s);
});

test('2026-10-02 實況（約 1MB 以上的 JSON）：壓縮後可放單一文件（inline）；舊欄位因總量超過預算而不寫', () => {
  const s = mkSeries(120);
  const e = encodeIntraday(s);
  assert.ok(e.rawBytes > 1_048_487, `原始 ${e.rawBytes} bytes 應超過 Firestore 欄位上限（重現當日寫入失敗）`);
  assert.equal(e.inline, true, `壓縮後 ${e.gz.length} bytes 應可放單一文件`);
  assert.equal(e.legacyOk, false, '舊 seriesJson 加上壓縮欄位會超過單一文件上限 ⇒ 不寫');
});

test('小序列：舊欄位與壓縮欄位合計在預算內 ⇒ 兩者都寫（尚未部署的讀取端照常可讀）', () => {
  const e = encodeIntraday(mkSeries(5));
  assert.equal(e.inline, true); assert.equal(e.legacyOk, true);
  assert.ok(e.rawBytes + e.gz.length <= DOC_BUDGET);
});

test('壓縮後仍超過單一文件：切成多個分片，依序合併還原（使用者：超過 1MB 用多個壓縮檔累積）', () => {
  const s = mkSeries(30);
  const e = encodeIntraday(s, { inlineMax: 4000, shardMax: 4000 });   // 以小上限模擬「壓縮後仍 >1MB」
  assert.equal(e.inline, false);
  assert.ok(e.shards.length > 1);
  assert.ok(e.shards.every(b => b.length <= 4000));
  assert.deepEqual(decodeIntraday(e.shards), s);
  assert.equal(e.legacyOk, e.rawBytes <= DOC_BUDGET, '分片放子集合，主文件只剩舊欄位 ⇒ 只看舊欄位本身是否在預算內');
});

test('空序列（盤前）也能編碼還原', () => {
  const e = encodeIntraday({});
  assert.deepEqual(decodeIntraday([e.gz]), {});
  assert.equal(e.inline, true);
});
