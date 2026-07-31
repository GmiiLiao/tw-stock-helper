import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
export const runtime = 'nodejs';
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('strategyPicks').doc('latest').get();
    if (!snap.exists) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
    // volJson/prevVolJson 為 daemon 內部用的量能存檔，不需傳給前端
    const { volJson, prevVolJson, prevLock, closesHist, ...pub } = snap.data()!;
    return NextResponse.json(pub, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
