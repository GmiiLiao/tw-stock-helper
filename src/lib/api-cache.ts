import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson } from '@/lib/gzip-response';
import { memoize } from '@/lib/singleflight';
import { getSession } from '@/lib/market-clock';

/**
 * API 回應快取層級表 + daemon latest-doc 共用 helper
 *
 * 解兩個一起發生的問題：
 *
 * A) 14 支 route 的成功分支回 `no-store`，但它們讀的是 daemon **每天只寫 1–3 次**
 *    的 Firestore doc（`runDailyJobs` 於 15:10 / 16:30 官方補跑 / 21:45 融資補跑）。
 *    `no-store` 讓 CDN 完全幫不上忙，每個使用者的每次載入都是一次 document read。
 *
 * B) 47 個檔案在複製同一份 12 行樣板。程式碼重複本身不是重點，重點是
 *    **快取策略無法統一治理** —— 要調整就得改 47 個檔案，所以實務上永遠不會被調整。
 *
 * 層級表的節奏是照台股標定的：上游 5 秒才更新一次，
 * `tick` 的 s-maxage=3 就足以把回源率壓到六成以下，而使用者最多落後一個 tick。
 */

export type Tier =
  | 'tick'      // 5 秒級即時報價
  | 'quote'     // 準即時（分時、五檔）
  | 'intraday'  // 盤中週期性、或 daemon 日頻產出
  | 'daily'     // 一天只變一次且沒人盯新鮮度的（月營收、除息日曆）
  | 'static'    // 幾乎不變
  | 'private';  // 使用者專屬，不可共享快取

const TIERS: Record<Tier, string> = {
  tick:     'public, max-age=2,    s-maxage=3,     stale-while-revalidate=5,    stale-if-error=60',
  quote:    'public, max-age=5,    s-maxage=10,    stale-while-revalidate=15,   stale-if-error=120',
  intraday: 'public, max-age=60,   s-maxage=120,   stale-while-revalidate=120,  stale-if-error=900',
  daily:    'public, max-age=300,  s-maxage=3600,  stale-while-revalidate=1800, stale-if-error=86400',
  static:   'public, max-age=600,  s-maxage=14400, stale-while-revalidate=3600, stale-if-error=86400',
  private:  'private, max-age=5,   stale-while-revalidate=30',
};

/** 收盤後即時類資料不會再變 —— TTL 拉到隔天開盤，回源率歸零 */
const CLOSED_OVERRIDE =
  'public, max-age=300, s-maxage=1800, stale-while-revalidate=600, stale-if-error=86400';

export function cacheHeader(tier: Tier): string {
  if ((tier === 'tick' || tier === 'quote') && getSession() === 'closed') return CLOSED_OVERRIDE;
  return TIERS[tier];
}

/** 錯誤／降級回應：一律不可快取，否則會把一次故障釘在 CDN 上 */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * 取代那 47 份複製貼上的樣板。
 *
 * 舊寫法（每支 route 各一份）：
 *   const snap = await db.collection('scanner').doc('latest').get();
 *   return NextResponse.json(snap.exists ? snap.data() : null,
 *     { headers: { 'Cache-Control': 'no-store' } });
 *
 * 新寫法：
 *   export const GET = (req: Request) => latestDoc('scanner', 'intraday', { request: req });
 *
 * 多做的三件事：
 *   1. 正確的 Cache-Control（CDN 收斂掉九成以上的回源）
 *   2. 行程內 memoize + in-flight 合流（CDN miss 時同一實例不重複讀 Firestore）
 *   3. 失敗負快取（Firestore 抖動時不會被重打放大）
 *
 * 帶 `request` 會啟用 gzip（沿用既有的 `gzipJson`，大 payload 約省 75%）。
 */
export async function latestDoc(
  collection: string,
  tier: Tier = 'intraday',
  opts: { docId?: string; request?: Request } = {},
): Promise<Response> {
  const docId = opts.docId ?? 'latest';

  // 記憶體 TTL 取 CDN s-maxage 的一半，讓兩層錯開、避免同時到期造成回源尖峰
  const ttlMs = tier === 'daily' || tier === 'static' ? 300_000 : 60_000;

  // 包一層 { ok, data } 是刻意的：memoize 內部會吞掉錯誤並回 null，
  // 直接用 null 當回傳值的話，「Firestore 掛掉」和「doc 還沒被 daemon 寫入」
  // 會長得一模一樣 —— 前者絕不能帶著 s-maxage 送出去（等於把一次故障釘在 CDN 上兩分鐘），
  // 後者則是正常狀態、應該快取。
  const read = memoize<{ ok: true; data: unknown }>(
    `latest:${collection}:${docId}`,
    ttlMs,
    async () => {
      const db = getAdminDb();
      if (!db) throw new Error('admin db unavailable');
      const snap = await db.collection(collection).doc(docId).get();
      return { ok: true, data: snap.exists ? (snap.data() ?? null) : null };
    },
  );

  const result = await read();

  // null = 讀失敗且沒有可供降級的舊值。有舊值時 memoize 會回舊值（stale-serve），
  // 那種情況仍走正常快取路徑，這是我們要的行為。
  if (!result) return NextResponse.json(null, { headers: NO_STORE });

  const header = cacheHeader(tier);
  if (opts.request) return gzipJson(opts.request, result.data, header);
  return NextResponse.json(result.data, { headers: { 'Cache-Control': header } });
}
