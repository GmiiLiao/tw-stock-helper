import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader, unavailable } from '@/lib/api-cache';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 洗盤監測（實測校準版年度風險提醒）。讀 washoutMonitor/latest。
// 階段：正常波動(<5%) / 洗盤區間(5~15%·歷史範圍) / 空頭警戒(>15%·超出全部歷史洗盤)。
export async function GET() {
  const db = getAdminDb();
  if (!db) return unavailable('washout');
  try {
    const doc = await db.collection('washoutMonitor').doc('latest').get();
    if (!doc.exists) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    return NextResponse.json({ found: true, ...doc.data() }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
  } catch { return unavailable('washout'); }
}
