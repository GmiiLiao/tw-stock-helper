import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson } from '@/lib/gzip-response';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 籌碼風向：當日/5日/20日 三大法人淨買賣加權。daemon 每 3 分刷新。
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('chipWind').doc('latest').get();
    return gzipJson(request, snap.exists ? snap.data() : null, 'public, s-maxage=120');
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
