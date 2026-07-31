import { NextRequest, NextResponse } from 'next/server';
import { readHistory, writeHistory, type DailyBar } from '@/lib/history-store';
import { fetchDailyHistory, yearsAgoUnix } from '@/lib/history-fetch';

export const runtime = 'nodejs';

// ============================================================
// /api/history?code=2330[&days=120][&refresh=1]
//
// Reads ~3y of stored daily bars from the Firestore history store
// (the "second brain"). On a cache miss (or ?refresh=1) it pulls the
// history from Yahoo, attempts to persist it, and returns it either way.
// ============================================================

const HISTORY_YEARS = 3;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const code = sp.get('code')?.trim();
  const days = Math.max(0, parseInt(sp.get('days') || '0', 10) || 0);
  const refresh = sp.get('refresh') === '1';

  if (!code || !/^\d{4,6}$/.test(code)) {
    return NextResponse.json({ error: 'Missing or invalid code' }, { status: 400 });
  }

  try {
    let bars: DailyBar[] | null = null;
    let name = '';
    let market: 'tse' | 'otc' | 'unknown' = 'unknown';
    let source: 'store' | 'yahoo' = 'store';

    if (!refresh) {
      const stored = await readHistory(code);
      if (stored && stored.bars.length > 0) {
        bars = stored.bars;
        name = stored.name;
        market = stored.market;
      }
    }

    if (!bars) {
      source = 'yahoo';
      const fetched = await fetchDailyHistory(code, yearsAgoUnix(HISTORY_YEARS));
      bars = fetched.bars;
      market = fetched.market;
      // Best-effort persist; ignore failures (e.g. Firestore write rules).
      if (bars.length > 0) {
        try {
          await writeHistory({ code, name, market, bars });
        } catch (e) {
          console.warn('[api/history] persist skipped', code, e);
        }
      }
    }

    const out = days > 0 ? bars.slice(-days) : bars;
    return NextResponse.json(
      { code, name, market, source, count: out.length, bars: out },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' } },
    );
  } catch (error) {
    console.error('[api/history] error', code, error);
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 });
  }
}
