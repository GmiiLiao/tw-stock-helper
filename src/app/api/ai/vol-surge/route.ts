import { getAdminDb } from '@/lib/firebase-admin';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 盤中爆量榜（量能異常·非三大法人）。讀 volSurge/latest（盤中即時）。
// 誠實界定：即時 feed 只有累計量、無交易人身分，此為單位時間量能暴增，非法人買賣。
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const doc = await db.collection('volSurge').doc('latest').get();
    if (!doc.exists) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'public, s-maxage=30' } });
    return NextResponse.json({ found: true, ...doc.data() }, { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } });
  } catch {
    return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  }
}
