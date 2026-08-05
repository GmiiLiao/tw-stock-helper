import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader } from '@/lib/api-cache';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 波段起漲選股（選股頁「📋 訊號榜單」·波段模式）。讀 swingPicks/latest。
// ⚠持有 5 個交易日語意，與隔日沖綜合評分口徑分離（本訊號隔日≈0、edge 全在第5日）。
// 三層分級＋空頭日 gate，實證見 payload.evidence。非投資建議。
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const doc = await db.collection('swingPicks').doc('latest').get();
    if (!doc.exists) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    return NextResponse.json({ found: true, ...doc.data() }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
  } catch {
    return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  }
}
