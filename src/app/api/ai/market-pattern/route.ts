import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson } from '@/lib/gzip-response';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('marketPattern').doc('latest').get();
    // 盤中每分鐘更新，快取壓在 55 秒內；gzip 壓縮(含 tailPicks ~5KB→~1.5KB，60s 輪詢)
    return gzipJson(request, snap.exists ? snap.data() : null, 'public, s-maxage=55');
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
