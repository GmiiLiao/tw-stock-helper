import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

// GET /api/ai/sector-rotation — latest sector-rotation snapshot (daemon-computed).
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json({ sectors: [] }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('sectorRotation').doc('latest').get();
    const d = snap.exists ? snap.data() : null;
    return NextResponse.json(d ?? { sectors: [] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ sectors: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
