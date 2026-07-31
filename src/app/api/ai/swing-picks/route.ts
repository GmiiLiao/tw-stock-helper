import { getAdminDb } from '@/lib/firebase-admin';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 波段起漲選股（指數·新聞頁「🌊 波段起漲」分頁）。讀 swingPicks/latest。
// ⚠持有 5 個交易日語意，與隔日沖綜合評分口徑分離（本訊號隔日≈0、edge 全在第5日）。
// 三層分級＋空頭日 gate，實證見 payload.evidence。非投資建議。
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const doc = await db.collection('swingPicks').doc('latest').get();
    if (!doc.exists) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'public, s-maxage=60' } });
    return NextResponse.json({ found: true, ...doc.data() }, { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=180' } });
  } catch {
    return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  }
}
