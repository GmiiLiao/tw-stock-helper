import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader } from '@/lib/api-cache';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 漲停預測榜（盤中戰情「🚀 漲停預測」分頁）。讀 limitUpForecast/latest。
// A榜=明日(盤中=今日)漲停預測 Top30；B榜=已漲停者連板持續評估；scoreboard=每日對答案成績。
// 回測實證 Top10 命中 20.5%(7.6x lift)。確定性模型，非投資建議。
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const doc = await db.collection('limitUpForecast').doc('latest').get();
    if (!doc.exists) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    return NextResponse.json({ found: true, ...doc.data() }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
  } catch {
    return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  }
}
