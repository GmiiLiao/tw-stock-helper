import { NextResponse } from 'next/server';
import { cacheHeader } from '@/lib/api-cache';
import { getAdminDb } from '@/lib/firebase-admin';
export const runtime = 'nodejs';

// 三大法人累計籌碼：daemon 逐日累加證交所 T86。?code=2330 回傳單檔；否則回傳彙總 meta。
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const code = new URL(request.url).searchParams.get('code')?.trim();
    const snap = await db.collection('chipCumulative').doc('latest').get();
    if (!snap.exists) return NextResponse.json(null, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    const d = snap.data() || {};
    const meta = { startIso: d.startIso, lastIso: d.lastIso, days: d.days, count: d.count, updatedAt: d.updatedAt };
    if (!code) return NextResponse.json(meta, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    const v = d.byCode?.[code];
    if (!v) return NextResponse.json({ ...meta, code, found: false }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    // v = [外資累計, 投信累計, 自營累計]（張）
    const [foreign, trust, dealer] = v;
    return NextResponse.json(
      { ...meta, code, found: true, foreign, trust, dealer, total: foreign + trust + dealer },
      { headers: { 'Cache-Control': cacheHeader('intraday') } },
    );
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
