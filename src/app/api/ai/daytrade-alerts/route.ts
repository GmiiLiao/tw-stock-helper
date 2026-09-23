import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader } from '@/lib/api-cache';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// 當沖即時警示（daemon 以 5 秒快線取樣組 1 分 K 判訊號，寫 daytradeAlerts/live；規則 scripts/lib/daytrade-signals.mjs）
// 回應格式 { found, ...doc }（與 limitup-live 同一口徑，前端靠 found 判斷有無資料）。
// tick 層（3 秒）：daemon 每收一根 K 才寫，CDN 同拍全球共享，請求數與人數脫鉤。
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const doc = await db.collection('daytradeAlerts').doc('live').get();
    if (!doc.exists) return gzipJsonAuto({ found: false }, { 'Cache-Control': cacheHeader('tick') });
    return gzipJsonAuto({ found: true, ...doc.data() }, { 'Cache-Control': cacheHeader('tick') });
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
