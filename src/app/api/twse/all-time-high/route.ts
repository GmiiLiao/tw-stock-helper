import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// 歷史最高價：Yahoo 月線 range=max（上市至今），取所有月最高的最大值。
// 變動極少，快取長一點；.TW 失敗再試 .TWO。
async function fetchMaxHigh(symbol: string): Promise<{ high: number; date: string } | null> {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 6000);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1mo&range=max`;
    const j = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(tm));
    const res = j?.chart?.result?.[0];
    if (!res) return null;
    const ts: number[] = res.timestamp || [];
    const highs: (number | null)[] = res.indicators?.quote?.[0]?.high || [];
    let max = 0, maxTs = 0;
    for (let i = 0; i < highs.length; i++) {
      const h = highs[i];
      if (h != null && h > max) { max = h; maxTs = ts[i]; }
    }
    if (!(max > 0)) return null;
    const d = new Date(maxTs * 1000);
    return { high: +max.toFixed(2), date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` };
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code || !/^\d{4,6}$/.test(code)) {
    return NextResponse.json({ error: 'code required' }, { status: 400 });
  }
  const r = (await fetchMaxHigh(`${code}.TW`)) || (await fetchMaxHigh(`${code}.TWO`));
  if (!r) return NextResponse.json({ code, high: null }, { headers: { 'Cache-Control': 'no-store' } });
  // 歷史高變動少，CDN 快取 6 小時
  return NextResponse.json({ code, high: r.high, date: r.date }, { headers: { 'Cache-Control': 'public, s-maxage=21600' } });
}
