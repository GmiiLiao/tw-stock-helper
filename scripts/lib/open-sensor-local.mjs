// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1：本機檔讀寫（0 上游請求）
//   · 本機官方鏡像 second-brain/official/<host>/<id>/<YYYY-MM-DD>.json.gz 的最新檔（只讀）
//   · 發行股數正快取 second-brain/market/open-sensor/issued-shares.json（getIssuedShares 成功時 tmp＋rename 寫入；§11.3）
//   名單盤前建置只走這裡與 Firestore，盤中（08:30–10:05）不打網路。
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { sharesFromTsePayload, sharesFromOtcPayload, fullDeliveryFromPayload, splitFromPunishPayload } from './open-sensor-universe.mjs';

export const MIRROR_IDS = Object.freeze({
  sharesTse: ['openapi.twse.com.tw', 'twse_oa_opendata_t187ap03_L'],
  sharesOtc: ['www.tpex.org.tw', 'tpex_oa_mopsfin_t187ap03_O'],
  twt85u: ['openapi.twse.com.tw', 'twse_oa_exchangeReport_TWT85U'],
  punish: ['www.twse.com.tw', 'twse_punish'],
});

/** 鏡像資料集最新檔（檔名日期 ≤ maxIso 者）；沒有回 null。回 { fileIso, payload, meta } */
export function readMirrorLatest(root, host, id, maxIso = null) {
  const dir = join(root, host, id);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f) && (!maxIso || f.slice(0, 10) <= maxIso)).sort();
  if (!files.length) return null;
  const f = files[files.length - 1];
  const j = JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8'));
  return { fileIso: f.slice(0, 10), payload: j?.payload ?? null, meta: j?.meta ?? null };
}

/** 正快取檔：{ feedDate, savedAt, n, map } */
export function readSharesCache(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j && j.map && Object.keys(j.map).length > 500) return j;
  } catch { /* 沒有或壞檔 ⇒ 退回鏡像 */ }
  return null;
}

/** 正快取寫入（tmp＋rename，避免半檔）；回傳是否成功 */
export function writeSharesCache(file, { map, feedDate, savedAt }) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ feedDate: feedDate ?? null, savedAt, n: Object.keys(map).length, map }));
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/**
 * 名單用發行股數（§11.3 順序）：① 記憶體正快取（getIssuedShares 當日成功值）② 落地正快取檔 ③ 本機鏡像 t187ap03_L。
 *   上櫃（E′_otc 用）只讀鏡像 tpex t187ap03_O；沒有就 null（E′_otc 標 uncorrected）。都沒有上市 ⇒ tse:null（G10 不過，不捏造）。
 */
export function loadSharesLocal({ memory = null, cacheFile, mirrorRoot }) {
  let tse = null;
  if (memory?.map && Object.keys(memory.map).length > 500) tse = { map: memory.map, asOf: memory.feedDate ?? null, src: 'cache' };   // 記憶體正快取＝落地檔的同一份
  if (!tse) {
    const c = readSharesCache(cacheFile);
    if (c) tse = { map: c.map, asOf: c.feedDate ?? null, src: 'cache' };
  }
  if (!tse) {
    try {
      const m = readMirrorLatest(mirrorRoot, ...MIRROR_IDS.sharesTse);
      if (m?.payload) { const s = sharesFromTsePayload(m.payload); if (Object.keys(s.map).length > 500) tse = { map: s.map, asOf: s.feedIso ?? m.fileIso, src: 'mirror' }; }
    } catch { /* 鏡像壞檔 ⇒ 沒有 */ }
  }
  let otc = null;
  try {
    const m = readMirrorLatest(mirrorRoot, ...MIRROR_IDS.sharesOtc);
    if (m?.payload) { const s = sharesFromOtcPayload(m.payload); if (Object.keys(s.map).length > 300) otc = { map: s.map, asOf: s.feedIso ?? m.fileIso, src: 'mirror' }; }
  } catch { /* 沒有上櫃股數 ⇒ E′_otc 不修正 */ }
  return { tse, otc };
}

/** 排除名單（全額交割／分盤處置）：鏡像最新檔；讀不到就空集合並在 src 標 null（只影響排除，不擋判讀） */
export function loadExclusionsLocal({ mirrorRoot, date }) {
  const out = { full: new Set(), periodic: new Set(), split: new Set(), src: { twt85u: null, punish: null } };
  try {
    const m = readMirrorLatest(mirrorRoot, ...MIRROR_IDS.twt85u, date);
    if (m?.payload) { const r = fullDeliveryFromPayload(m.payload); out.full = r.full; out.periodic = r.periodic; out.src.twt85u = m.fileIso; }
  } catch { /* 略 */ }
  try {
    const m = readMirrorLatest(mirrorRoot, ...MIRROR_IDS.punish, date);
    if (m?.payload) { out.split = splitFromPunishPayload(m.payload, date); out.src.punish = m.fileIso; }
  } catch { /* 略 */ }
  return out;
}
