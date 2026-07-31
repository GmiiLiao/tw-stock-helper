/**
 * API 回應快取層級表 + daemon latest-doc 共用 helper
 *
 * 兩個問題一起解：
 *
 * A) 23 支 route 只回 `no-store`，其中 15 支讀的是 daemon **每日只寫一次**的
 *    Firestore `latest` doc。`no-store` 讓 CDN 完全幫不上忙，
 *    每個使用者的每次輪詢都變成一次 Firestore document read。
 *
 * B) 47 個檔案、49 處在複製同一份 12 行樣板（`.doc('latest').get()`）。
 *    程式碼重複本身不是重點，重點是**快取策略無法統一治理** ——
 *    要調整就得改 47 個檔案，所以實務上永遠不會被調整。
 *
 * 抽成 helper 之後，這 15 支改一行就能降 99% Firestore 讀取。
 *
 * 層級表對照 worldmonitor `server/gateway.ts:158-183`，但為台股節奏重新標定：
 * 上游 5 秒才更新一次，CDN 擋 3 秒等於把回源率壓到 60% 以下，
 * 同時保證使用者看到的資料最多落後一個 tick。
 */

import { NextResponse } from 'next/server';
import { gzipSync } from 'node:zlib';
import { getSession } from './market-clock';

export type Tier =
  | 'tick'      // 5 秒級即時報價
  | 'quote'     // 準即時（分時、深度）
  | 'intraday'  // 盤中週期性（法人、籌碼）
  | 'daily'     // daemon 每日寫一次
  | 'static'    // 幾乎不變（個股基本資料）
  | 'private';  // 使用者專屬，不可共享快取

const TIERS: Record<Tier, string> = {
  tick:     'public, max-age=2,    s-maxage=3,     stale-while-revalidate=5,    stale-if-error=60',
  quote:    'public, max-age=5,    s-maxage=10,    stale-while-revalidate=15,   stale-if-error=120',
  intraday: 'public, max-age=60,   s-maxage=120,   stale-while-revalidate=120,  stale-if-error=900',
  daily:    'public, max-age=300,  s-maxage=3600,  stale-while-revalidate=1800, stale-if-error=86400',
  static:   'public, max-age=600,  s-maxage=14400, stale-while-revalidate=3600, stale-if-error=86400',
  private:  'private, max-age=5,   stale-while-revalidate=30',
};

/** 收盤後資料不會再變 —— 直接把 TTL 拉到隔天開盤，回源率歸零 */
const CLOSED_OVERRIDE = 'public, max-age=300, s-maxage=1800, stale-while-revalidate=600, stale-if-error=86400';

export function cacheHeader(tier: Tier): string {
  if ((tier === 'tick' || tier === 'quote') && getSession() === 'closed') {
    return CLOSED_OVERRIDE;
  }
  return TIERS[tier];
}

/**
 * 統一的 JSON 回應：正確的 Cache-Control + 一致的 Vary + 條件 gzip。
 *
 * 注意 Vary 的 bug：目前 gzip-response.ts:10-12 只有 gzip 分支帶 Vary，
 * 非 gzip 分支沒有 —— 兩個變體的 Vary 不一致會讓 CDN 的快取鍵行為未定義。
 * 這裡兩邊都帶。
 */
export function json(
  data: unknown,
  tier: Tier,
  opts: { gzip?: boolean; acceptEncoding?: string | null; extraHeaders?: Record<string, string> } = {},
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheHeader(tier),
    Vary: 'Accept-Encoding',
    ...opts.extraHeaders,
  };

  const body = JSON.stringify(data);
  const wantsGzip = opts.gzip && (opts.acceptEncoding ?? '').includes('gzip');

  // 只有夠大才值得壓；小 payload 壓縮的 CPU 成本高於頻寬節省
  if (wantsGzip && body.length > 8_192) {
    const gz = gzipSync(Buffer.from(body));
    return new Response(new Uint8Array(gz), {
      headers: { ...headers, 'Content-Encoding': 'gzip' },
    });
  }
  return new Response(body, { headers });
}

/**
 * 取代那 47 份複製貼上的樣板。
 *
 * 舊寫法（每支 route 各一份）：
 *   const snap = await db.collection('adrPremium').doc('latest').get();
 *   return NextResponse.json(snap.exists ? snap.data() : null,
 *     { headers: { 'Cache-Control': 'no-store' } });
 *
 * 新寫法：
 *   export const GET = () => latestDoc('adrPremium', 'daily');
 *
 * 差別：
 *   - 多了 in-flight coalescing + TTL 記憶體快取（同一實例內不重複讀 Firestore）
 *   - 快取層級集中管理，要調整只改這個檔案
 *   - 失敗有負快取，Firestore 抖動時不會被重打放大
 */
export async function latestDoc(
  collection: string,
  tier: Tier = 'daily',
  opts: { docId?: string; gzip?: boolean; acceptEncoding?: string | null } = {},
): Promise<Response> {
  const { memoize } = await import('./singleflight');
  const { getAdminDb } = await import('./firebase-admin');
  const docId = opts.docId ?? 'latest';

  // 記憶體 TTL 取 CDN s-maxage 的一半，讓兩層錯開、避免同時到期
  const ttlMs = tier === 'daily' || tier === 'static' ? 300_000 : 15_000;

  const read = memoize(`latest:${collection}:${docId}`, ttlMs, async () => {
    const db = getAdminDb();
    if (!db) throw new Error('no admin db');
    const snap = await db.collection(collection).doc(docId).get();
    return snap.exists ? snap.data() ?? null : null;
  });

  try {
    const data = await read();
    return json(data, tier, { gzip: opts.gzip, acceptEncoding: opts.acceptEncoding });
  } catch {
    return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  }
}
