// ─────────────────────────────────────────────────────────────────────────────
// 即時走勢（marketIntraday/latest）壓縮格式——2026-10-02
//   舊版把所有被追蹤個股的分時序列 JSON 放在單一欄位 seriesJson；追蹤檔數多的日子下午就超過 Firestore 單欄位上限
//   （1,048,487 bytes）：09-15 13:03 起失敗 305 次、10-02 12:31 起 257 次，讀取端只檢查日期 ⇒ 即時走勢安靜地停在失敗前。
//   使用者：「不應拆成 1 檔 12k（太小也太花存取），做成壓縮格式，超過 1mb 時用多個壓縮檔案累積與使用」。
//   格式：gzip(JSON)；≤ inlineMax 放在主文件 seriesGz（單一文件、原子寫入）；否則切成 ≤ shardMax 的分片（子集合 shards，
//   以 gen 對齊）。舊欄位 seriesJson 只在「與壓縮欄位合計仍在單一文件預算內」時才寫（相容尚未部署的讀取端）。
// ─────────────────────────────────────────────────────────────────────────────
import { gzipSync, gunzipSync } from 'node:zlib';

/** 單一文件可用預算（Firestore 上限 1,048,576 bytes，留給其他欄位與欄位名的餘裕） */
export const DOC_BUDGET = 1_000_000;
const INLINE_MAX = 900_000, SHARD_MAX = 900_000;

/**
 * @returns {{ json:string, rawBytes:number, gz:Buffer, inline:boolean, shards:Buffer[], legacyOk:boolean }}
 *   inline：壓縮後可直接放主文件；shards：依序切片（inline 時就是一片＝gz）；legacyOk：可同時寫舊 seriesJson
 */
export function encodeIntraday(series, { inlineMax = INLINE_MAX, shardMax = SHARD_MAX } = {}) {
  const json = JSON.stringify(series || {});
  const rawBytes = Buffer.byteLength(json);
  const gz = gzipSync(Buffer.from(json));
  const inline = gz.length <= inlineMax;
  const shards = [];
  for (let i = 0; i < gz.length; i += shardMax) shards.push(gz.subarray(i, i + shardMax));
  if (!shards.length) shards.push(gz);
  const legacyOk = rawBytes + (inline ? gz.length : 0) <= DOC_BUDGET && rawBytes <= DOC_BUDGET;
  return { json, rawBytes, gz, inline, shards, legacyOk };
}

/** 依序合併分片並還原（Firestore Bytes 讀回為 Buffer／Uint8Array） */
export function decodeIntraday(parts) {
  return JSON.parse(gunzipSync(Buffer.concat(parts.map(p => Buffer.from(p)))).toString());
}
