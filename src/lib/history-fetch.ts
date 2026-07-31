// ============================================================
// History fetcher (server-only) — pulls daily OHLCV bars from Yahoo
// Finance for a single stock, normalized into DailyBar[] for the
// history store. Tries the TSE (.TW) then OTC (.TWO) symbol.
// ============================================================

import type { DailyBar } from './history-store';

const SECONDS_PER_DAY = 86_400;

/** Approx seconds for `years` of history before `now` (ms → s handled inside). */
export function yearsAgoUnix(years: number, nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) - Math.ceil(years * 365.25) * SECONDS_PER_DAY;
}

interface YahooChart {
  timestamp?: number[];
  indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> };
}

async function fetchYahooChart(symbol: string, period1: number, period2: number): Promise<YahooChart | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}&includePrePost=false`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com/',
      },
      cache: 'no-store',
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.chart?.result?.[0] ?? null;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

function chartToBars(result: YahooChart): DailyBar[] {
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const opens = q.open ?? [], highs = q.high ?? [], lows = q.low ?? [], closes = q.close ?? [], vols = q.volume ?? [];
  const bars: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
    if (o == null || h == null || l == null || c == null) continue;
    // ISO date in Taipei timezone
    const tw = new Date(new Date(ts[i] * 1000).toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const d = `${tw.getFullYear()}-${String(tw.getMonth() + 1).padStart(2, '0')}-${String(tw.getDate()).padStart(2, '0')}`;
    bars.push({
      d,
      o: parseFloat(o.toFixed(2)),
      h: parseFloat(h.toFixed(2)),
      l: parseFloat(l.toFixed(2)),
      c: parseFloat(c.toFixed(2)),
      v: Math.round(vols[i] ?? 0),
    });
  }
  return bars;
}

export interface FetchedHistory {
  bars: DailyBar[];
  market: 'tse' | 'otc' | 'unknown';
}

/**
 * Fetch daily bars for a stock between two unix timestamps (seconds).
 * Returns whichever of .TW / .TWO has data, with the inferred market.
 */
export async function fetchDailyHistory(
  code: string,
  period1: number,
  period2 = Math.floor(Date.now() / 1000),
): Promise<FetchedHistory> {
  const [tw, two] = await Promise.all([
    fetchYahooChart(`${code}.TW`, period1, period2),
    fetchYahooChart(`${code}.TWO`, period1, period2),
  ]);
  const twBars = tw ? chartToBars(tw) : [];
  const twoBars = two ? chartToBars(two) : [];
  if (twBars.length >= twoBars.length && twBars.length > 0) return { bars: twBars, market: 'tse' };
  if (twoBars.length > 0) return { bars: twoBars, market: 'otc' };
  return { bars: [], market: 'unknown' };
}
