// ─────────────────────────────────────────────────────────────────────────────
// daemon 即時分時序列（marketIntraday/latest）共用讀取——2026-10-02
//   格式見 scripts/lib/intraday-codec.mjs：seriesGz（gzip JSON，單一文件）→ shards/{i}（gen 對齊）→ 舊 seriesJson。
//   舊版兩支 API 各自每個請求讀整份約 1MB 的文件再 JSON.parse，且只檢查日期——序列超過 1MB 寫入失敗時，
//   即時走勢安靜地停在失敗前（09-15、10-02 下午）。這裡統一：3 秒合流快取、盤中新鮮度檢查。
// ─────────────────────────────────────────────────────────────────────────────
import { gunzipSync } from 'node:zlib';
import { getAdminDb } from '@/lib/firebase-admin';
import { memoize } from '@/lib/singleflight';
import { isMarketOpen } from '@/lib/market-clock';

export type IntradayPoint = [number, number, number];   // [epoch 秒, 價, 累積量(股)]
export interface IntradaySeriesEntry { prev?: number; pts: IntradayPoint[] }
export interface DaemonIntraday { date: string; updatedAt: number; series: Record<string, IntradaySeriesEntry> }

/** 盤中超過這個時間沒更新＝daemon 寫入停擺，讀取端退回其他來源，不顯示停住的線 */
export const INTRADAY_STALE_MS = 3 * 60_000;

const decode = (parts: Uint8Array[]) => JSON.parse(gunzipSync(Buffer.concat(parts.map(p => Buffer.from(p)))).toString());

async function readOnce(): Promise<DaemonIntraday | 'mismatch'> {
  const db = getAdminDb();
  if (!db) throw new Error('no admin db');
  const ref = db.collection('marketIntraday').doc('latest');
  const d = (await ref.get()).data();
  if (!d) throw new Error('no marketIntraday doc');
  let series: DaemonIntraday['series'] = {};
  if (d.seriesGz) series = decode([d.seriesGz]);
  else if (Array.isArray(d.shardIds) && d.shardIds.length) {
    // 分片以代命名（{gen}_{i}）；讀主文件後寫入端已換代並刪舊片 ⇒ 不一致，重讀
    const parts = await Promise.all((d.shardIds as string[]).map(id => ref.collection('shards').doc(id).get().then(s => s.data())));
    if (!parts.every(p => p && p.gen === d.gen)) return 'mismatch';
    series = decode(parts.map(p => p!.data));
  } else if (d.seriesJson) series = JSON.parse(d.seriesJson);
  return { date: String(d.date || ''), updatedAt: Number(d.updatedAt) || 0, series };
}

const load = memoize<DaemonIntraday>('daemon-intraday', 3_000, async () => {
  const first = await readOnce();
  if (first !== 'mismatch') return first;
  const second = await readOnce();
  if (second === 'mismatch') throw new Error('intraday shards generation mismatch');
  return second;
}, { negativeTtlMs: 5_000 });   // 失敗只冷卻 5 秒（預設 30 秒太長，盤中走勢會停在舊值）

/**
 * 今日（today＝台北日期 YYYY-MM-DD）且新鮮的 daemon 分時序列；否則 null（呼叫端退回 Yahoo 等來源）。
 * 新鮮度只在盤中檢查——收盤後序列本來就不再更新，當日資料仍有效。
 */
export async function getDaemonIntraday(today: string, now = Date.now()): Promise<DaemonIntraday | null> {
  const v = await load();
  if (!v || v.date !== today) return null;
  if (isMarketOpen(new Date(now)) && now - v.updatedAt > INTRADAY_STALE_MS) return null;
  return v;
}
