import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson } from '@/lib/gzip-response';
export const runtime = 'nodejs';

// 產業風向偵測：daemon 每 3 分更新，含加權分/資金流向 delta/領漲股
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('sectorWind').doc('latest').get();
    return gzipJson(request, snap.exists ? snap.data() : null, 'public, s-maxage=90');
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
