import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
export const runtime = 'nodejs';
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('picksScoreboard').doc('latest').get();
    return NextResponse.json(snap.exists ? snap.data() : null, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
