import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader, unavailable } from '@/lib/api-cache';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { memoize } from '@/lib/singleflight';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// 當沖即時警示（daemon 以 5 秒快線取樣組 1 分 K 判訊號，寫 daytradeAlerts/live；規則 scripts/lib/daytrade-signals.mjs）
// 回應格式 { found, ...doc }（與 limitup-live 同一口徑，前端靠 found 判斷有無資料）。
// tick 層（3 秒）：daemon 每收一根 K 才寫，CDN 同拍全球共享，請求數與人數脫鉤。
// G2-12：CDN miss 併發時合流成一次 Firestore 讀（TTL 2 秒 < tick 層 3 秒，不會比 CDN 更舊）。
const ALERTS_TTL_MS = 2_000;
const getLiveAlerts = memoize('daytrade-alerts:live', ALERTS_TTL_MS, async () => {
  const db = getAdminDb();
  if (!db) throw new Error('admin db unavailable');
  const doc = await db.collection('daytradeAlerts').doc('live').get();
  return doc.exists ? { found: true, ...doc.data() } : { found: false };
});

export async function GET() {
  const db = getAdminDb();
  if (!db) return unavailable('daytrade-alerts');
  // memoize 內部已吞錯並記 log；讀失敗且無舊值 ⇒ null（與舊版 catch 分支同樣回 null＋no-store）。
  const payload = await getLiveAlerts();
  if (!payload) return unavailable('daytrade-alerts');
  return gzipJsonAuto(payload, { 'Cache-Control': cacheHeader('tick') });
}
