import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson } from '@/lib/gzip-response';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 量價背離：法人籌碼 vs 股價方向（吸貨/出貨候選）。daemon 每 3 分刷新。
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('chipDivergence').doc('latest').get();
    return gzipJson(request, snap.exists ? snap.data() : null, 'public, s-maxage=120');
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
