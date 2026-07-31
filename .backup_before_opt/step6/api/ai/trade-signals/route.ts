import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

// GET /api/ai/trade-signals — daemon-computed insight (reads tradeSignals/latest).
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('tradeSignals').doc('latest').get();
    return NextResponse.json(snap.exists ? snap.data() : null, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  }
}
