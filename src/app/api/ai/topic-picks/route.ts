import { getAdminDb } from '@/lib/firebase-admin';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 話題×5日線選股（指數·新聞頁「🎯 話題選股」分頁）。讀 topicPicks/latest。
// 實證（screen-ma5.mjs·720日）：超跌(乖離5日線<-5%)×熱門族群=雙regime淨正；
// 「拉回5日線接」回測不成立；跌破5日線/乖離>+8%為風險警示。非投資建議。
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const doc = await db.collection('topicPicks').doc('latest').get();
    if (!doc.exists) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'public, s-maxage=60' } });
    return NextResponse.json({ found: true, ...doc.data() }, { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=180' } });
  } catch {
    return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  }
}
