import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader } from '@/lib/api-cache';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 個股資券借券快照＋實證訊號 setup（個股分析頁訊號條用）。
// 讀 marginSnap/latest（daemon computeChipPicks 每日寫）。
// byCode: [融資餘,融資增減,融券餘,融券增減,借券餘,借券增減,前20日高,昨量張]
export async function GET(req: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const code = new URL(req.url).searchParams.get('code') || '';
    const doc = (await db.collection('marginSnap').doc('latest').get()).data();
    if (!doc?.byCodeJson) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    const all = JSON.parse(doc.byCodeJson as string) as Record<string, (number | null)[]>;
    if (code) {
      const row = all[code] ?? null;
      return NextResponse.json({ found: !!row, dataDate: doc.dataDate, row },
        { headers: { 'Cache-Control': cacheHeader('intraday') } });
    }
    return NextResponse.json({ found: true, dataDate: doc.dataDate, n: doc.n },
      { headers: { 'Cache-Control': cacheHeader('intraday') } });
  } catch {
    return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
