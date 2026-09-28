import { getAdminDb } from '@/lib/firebase-admin';
import { NextRequest, NextResponse } from 'next/server';
import { unavailable } from '@/lib/api-cache';
export const runtime = 'nodejs';

// 每日新聞頁（daemon 07:00 聚合：全球AI產業/全球局勢/美國建廠·NVIDIA供應鏈/台灣產業）。
// ?date=YYYY-MM-DD 讀歷史；?list=1 回近 14 天可選日期。來源為各媒體標題、連結導回原媒體。
export async function GET(request: NextRequest) {
  const db = getAdminDb();
  if (!db) return unavailable('news-digest');
  try {
    if (request.nextUrl.searchParams.get('list')) {
      const snap = await db.collection('newsDigest').orderBy('date', 'desc').limit(15).get();
      const dates = snap.docs.map(d => d.id).filter(id => /^\d{4}-\d{2}-\d{2}$/.test(id));
      return NextResponse.json({ dates }, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
    }
    const date = request.nextUrl.searchParams.get('date');
    const id = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : 'latest';
    const doc = await db.collection('newsDigest').doc(id).get();
    if (!doc.exists) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'public, s-maxage=120' } });
    return NextResponse.json({ found: true, ...doc.data() }, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } });
  } catch {
    return unavailable('news-digest');
  }
}
