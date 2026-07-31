import { NextRequest, NextResponse } from 'next/server';
import { readHistory, type DailyBar } from '@/lib/history-store';
import { fetchDailyHistory, yearsAgoUnix } from '@/lib/history-fetch';
import { computeIndicators, maSupportBuyZones } from '@/lib/indicators';

export const runtime = 'nodejs';

// ============================================================
// /api/indicators?code=2330
//
// Returns the full technical snapshot (MAs, RSI/MACD/KD, support /
// resistance, 52-week range, trend) plus MA-support buy zones, computed
// from the stored 3y history (falling back to a live Yahoo pull on a
// cache miss). Powers Phase 2 scoring and the individual-stock view.
// ============================================================

const HISTORY_YEARS = 3;

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')?.trim();
  if (!code || !/^\d{4,6}$/.test(code)) {
    return NextResponse.json({ error: 'Missing or invalid code' }, { status: 400 });
  }

  try {
    let bars: DailyBar[] = [];
    let source: 'store' | 'yahoo' = 'store';

    const stored = await readHistory(code);
    if (stored && stored.bars.length >= 20) {
      bars = stored.bars;
    } else {
      source = 'yahoo';
      bars = (await fetchDailyHistory(code, yearsAgoUnix(HISTORY_YEARS))).bars;
    }

    const snapshot = computeIndicators(bars);
    if (!snapshot) {
      return NextResponse.json({ error: 'Insufficient history', code, bars: bars.length }, { status: 422 });
    }

    return NextResponse.json(
      { code, source, snapshot, buyZones: maSupportBuyZones(snapshot) },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' } },
    );
  } catch (error) {
    console.error('[api/indicators] error', code, error);
    return NextResponse.json({ error: 'Failed to compute indicators' }, { status: 500 });
  }
}
