import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson } from '@/lib/gzip-response';
export const runtime = 'nodejs';

// 盤中雷達（盤中戰情頁）：daemon 每 60 秒更新，strategy 欄位供未來策略切換
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('intradayRadar').doc('latest').get();
    return gzipJson(request, snap.exists ? snap.data() : null, 'public, s-maxage=25');
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
