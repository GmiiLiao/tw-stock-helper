import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

// GET /api/ai/institutional-streaks — 外資/投信連續買超榜 (daemon-computed from T86).
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json({ foreign: [], trust: [] }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('institutionalStreaks').doc('latest').get();
    const d = snap.exists ? snap.data() : null;
    return NextResponse.json(d ?? { foreign: [], trust: [] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ foreign: [], trust: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
