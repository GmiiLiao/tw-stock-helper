import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson } from '@/lib/gzip-response';
export const runtime = 'nodejs';

// 風向 2.0：強勢股統計→題材供應鏈→驅動力歸因。daemon 盤中每 3 分更新、收盤定案。
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('marketWind').doc('latest').get();
    return gzipJson(request, snap.exists ? snap.data() : null, 'public, s-maxage=90');
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
