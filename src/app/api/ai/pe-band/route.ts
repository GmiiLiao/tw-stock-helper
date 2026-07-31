import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code') || '';
  const db = getAdminDb();
  if (!db || !/^\d{4}$/.test(code)) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('stockPeBand').doc(code).get();
    return NextResponse.json(snap.exists ? snap.data() : null, { headers: { 'Cache-Control': 'public, s-maxage=3600' } });
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
