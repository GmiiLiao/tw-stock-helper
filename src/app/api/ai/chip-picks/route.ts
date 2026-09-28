import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader, unavailable } from '@/lib/api-cache';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 法人籌碼推選榜（盤中戰情「法人籌碼推選股」分頁）。讀 chipPicks/latest。
// 4 榜：分級排行(可入場)/累計總籌碼/法人分別(外·投·自)/布局。確定性，非投資建議。
export async function GET() {
  const db = getAdminDb();
  if (!db) return unavailable('chip-picks');
  try {
    const doc = await db.collection('chipPicks').doc('latest').get();
    if (!doc.exists) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    return NextResponse.json({ found: true, ...doc.data() }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
  } catch {
    return unavailable('chip-picks');
  }
}
