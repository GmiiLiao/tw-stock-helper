import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Yahoo Finance v8/chart – server-side, no CORS issues
// Returns TODAY's real intraday OHLC (not yesterday's STOCK_DAY_ALL)

interface YahooQuote {
  code: string; name: string; price: number;
  open: number; high: number; low: number;
  prevClose: number; change: number; changePercent: number;
  volume: number; tradeTime: string;
  source: 'yahoo_finance';
}

async function fetchYahooSymbol(code: string, symbol: string): Promise<YahooQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d&includePrePost=false`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
      },
      cache: 'no-store',
    });

    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta ?? {};
    const price  = meta.regularMarketPrice     ?? 0;
    const prev   = meta.chartPreviousClose     ?? meta.previousClose ?? 0;
    const high   = meta.regularMarketDayHigh   ?? price;
    const low    = meta.regularMarketDayLow    ?? price;
    const open   = meta.regularMarketOpen      ?? prev;
    const volume = meta.regularMarketVolume    ?? 0;
    const ts     = meta.regularMarketTime      ?? 0;
    const name   = meta.longName ?? meta.shortName ?? code;

    if (price <= 0) return null;

    const change    = prev > 0 ? parseFloat((price - prev).toFixed(2)) : 0;
    const changePct = prev > 0 ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0;

    let tradeTime = '';
    if (ts > 0) {
      const d  = new Date(ts * 1000);
      const tw = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      tradeTime = `${String(tw.getHours()).padStart(2,'0')}:${String(tw.getMinutes()).padStart(2,'0')}`;
    }

    return { code, name, price, open, high, low, prevClose: prev, change, changePercent: changePct, volume, tradeTime, source: 'yahoo_finance' };
  } catch {
    return null;
  }
}

async function fetchYahoo(code: string): Promise<YahooQuote | null> {
  const [qTw, qTwo] = await Promise.all([
    fetchYahooSymbol(code, `${code}.TW`),
    fetchYahooSymbol(code, `${code}.TWO`),
  ]);
  return qTw || qTwo;
}

export async function GET(request: NextRequest) {
  const codesParam = request.nextUrl.searchParams.get('codes') ?? '';
  const codes = codesParam.split(',').map(c => c.trim()).filter(c => /^\d{4,6}$/.test(c)).slice(0, 50);
  if (codes.length === 0) return NextResponse.json({ error: 'codes required' }, { status: 400 });

  const results = await Promise.allSettled(codes.map(fetchYahoo));
  const quotes: YahooQuote[] = results
    .filter((r): r is PromiseFulfilledResult<YahooQuote> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  const now = new Date();
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = tw.getDay(), t = tw.getHours() * 60 + tw.getMinutes();
  const marketOpen = day > 0 && day < 6 && t >= 9 * 60 && t < 13 * 60 + 31;

  return NextResponse.json(
    { quotes, isRealtime: marketOpen, marketOpen, fetchedAt: now.toISOString() },
    { headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } }
  );
}
