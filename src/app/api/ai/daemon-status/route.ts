import { NextResponse } from 'next/server';
import { readHeartbeat } from '@/lib/daemon-store';

export const runtime = 'nodejs';

// ============================================================
// GET /api/ai/daemon-status — resident local-AI daemon health.
// Returns { running, lastHeartbeat, ageSeconds, ... } so the app can
// show a 🟢/🔴 status indicator. "running" = heartbeat within 3 min.
// ============================================================

const STALE_MS = 3 * 60 * 1000;

export async function GET() {
  const hb = await readHeartbeat();
  if (!hb) {
    return NextResponse.json(
      { running: false, lastHeartbeat: null, reason: 'no-heartbeat' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const age = Date.now() - (hb.lastHeartbeat || 0);
  return NextResponse.json(
    {
      running: hb.active === true && age < STALE_MS,
      lastHeartbeat: hb.lastHeartbeat,
      ageSeconds: Math.round(age / 1000),
      host: hb.host ?? null,
      model: hb.model ?? null,
      analyzedUsers: hb.analyzedUsers ?? null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
