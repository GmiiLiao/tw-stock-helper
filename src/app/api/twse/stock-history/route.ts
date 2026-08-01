import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

async function fetchYahooHistory(symbol: string, period1: number, period2: number) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}&includePrePost=false`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

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
    return data?.chart?.result?.[0] || null;
  } catch {
    return null;
  }
}

// Proxy for TWSE/TPEx stock historical data
// Endpoint: GET /api/twse/stock-history?code=2330&date=20241201
export async function GET(request: NextRequest) {
  // 限流防濫用。2026-08-01 放寬：個股頁 K 線鏈每檔 3~12 連發、會員頁多檔輪詢，
  // 原值連續瀏覽數檔就會 429 圖表空白——限流目標是每分鐘數百次的濫用，不是正常瀏覽
  const limited = await rateLimit(request, 'stock-history', 120);
  if (limited) return limited;

  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const date = searchParams.get('date');

  if (!code || !date) {
    return NextResponse.json({ error: 'Missing code or date parameter' }, { status: 400 });
  }

  try {
    // Parse date (e.g. 20241201) to start/end timestamps
    const year = parseInt(date.slice(0, 4));
    const month = parseInt(date.slice(4, 6));
    
    // Construct ISO strings in Taiwan timezone (+08:00) to ensure exact dates
    const startStr = `${year}-${String(month).padStart(2, '0')}-01T00:00:00+08:00`;
    const start = Math.floor(new Date(startStr).getTime() / 1000);

    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const endStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+08:00`;
    const end = Math.floor(new Date(endStr).getTime() / 1000);

    // ── Try Yahoo Finance First (supports TSE & OTC) ─────────────────────
    const [resTw, resTwo] = await Promise.all([
      fetchYahooHistory(`${code}.TW`, start, end),
      fetchYahooHistory(`${code}.TWO`, start, end),
    ]);
    const result = resTw || resTwo;

    if (result) {
      const timestamps: number[] = result.timestamp ?? [];
      const quote = result.indicators?.quote?.[0] ?? {};
      const opens: (number | null)[] = quote.open ?? [];
      const highs: (number | null)[] = quote.high ?? [];
      const lows: (number | null)[] = quote.low ?? [];
      const closes: (number | null)[] = quote.close ?? [];
      const volumes: (number | null)[] = quote.volume ?? [];

      const fields: string[][] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        const open = opens[i];
        const high = highs[i];
        const low = lows[i];
        const close = closes[i];
        const volume = volumes[i] ?? 0;

        if (open === null || close === null || high === null || low === null) continue;

        // Convert ts to ROC date string e.g. "113/12/02"
        const d = new Date(ts * 1000);
        const tw = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const rocYear = tw.getFullYear() - 1911;
        const mm = String(tw.getMonth() + 1).padStart(2, '0');
        const dd = String(tw.getDate()).padStart(2, '0');
        const dateStr = `${rocYear}/${mm}/${dd}`;

        fields.push([
          dateStr,
          volume.toString(),
          '0',
          open.toString(),
          high.toString(),
          low.toString(),
          close.toString(),
          '0',
          '0',
        ]);
      }

      return NextResponse.json(
        { data: fields },
        { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=300' } }
      );
    }

    // ── Fallback: Original TWSE site scraper ──────────────────────────
    const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${date}&stockNo=${code}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)',
        'Accept': 'application/json',
        'Referer': 'https://www.twse.com.tw/',
      },
      next: { revalidate: 3600 },
    });

    if (!res.ok) throw new Error(`TWSE responded with ${res.status}`);

    const data = await res.json();
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=300',
      },
    });
  } catch (error) {
    console.error(`Stock history proxy error for ${code}:`, error);
    return NextResponse.json({ error: 'Failed to fetch stock history' }, { status: 500 });
  }
}
