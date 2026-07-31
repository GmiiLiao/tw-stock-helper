import { NextResponse } from 'next/server';
import { readLatestPremarket } from '@/lib/premarket-store';

export const runtime = 'nodejs';

// GET /api/premarket-brief — latest 開盤前 AI 策略快報 (shared picks + strategy).
export async function GET() {
  const brief = await readLatestPremarket();
  if (!brief) {
    return NextResponse.json({ error: 'No brief yet' }, { status: 404 });
  }
  return NextResponse.json(brief, {
    headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60' },
  });
}
