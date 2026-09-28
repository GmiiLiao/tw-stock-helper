import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { unavailable } from '@/lib/api-cache';
export const runtime = 'nodejs';

// 盤前晨報：預設回 latest；?date=2026-07-02 回歷史；?list=1 回近 20 日日期清單。
export async function GET(request: NextRequest) {
  const db = getAdminDb();
  if (!db) return unavailable('morning-note');
  const date = request.nextUrl.searchParams.get('date');
  const list = request.nextUrl.searchParams.get('list');
  try {
    if (list) {
      const qs = await db.collection('morningNote').orderBy('date', 'desc').limit(21).get();
      const dates = qs.docs.map(d => d.id).filter(id => id !== 'latest').slice(0, 20);
      return NextResponse.json({ dates }, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
    }
    const snap = await db.collection('morningNote').doc(date || 'latest').get();
    return NextResponse.json(snap.exists ? snap.data() : null, { headers: { 'Cache-Control': 'public, s-maxage=120' } });
  } catch { return unavailable('morning-note'); }
}
