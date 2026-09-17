import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { memoize } from '@/lib/singleflight';
import { cacheHeader } from '@/lib/api-cache';

export const runtime = 'nodejs';

// ── 前一個交易日的分時（2026-09-17 使用者：即時走勢要能疊「昨日盤勢」做對比）──
//
// 定義：回傳「目前圖上顯示的那個交易日」的**前一個**交易日。盤中或收盤後＝昨天；
//   盤前（今天還沒有分時）或休市日＝圖上顯示的是最近交易日，那就回它的前一日。
//   兩種情況一律取 Yahoo 5d/1m 序列裡「最後一個交易日」之前的那一日，與圖同步。
// 來源：Yahoo v8 chart interval=1m range=5d（與 stock-intraday 同一個上游、同一組 header）。
//   自家 intradayArchive 只有 15 分取樣（19 點），畫出來會像折線不是分時，故不用它當主來源；
//   Yahoo 失敗就回 404 明說「取不到」，不拿粗資料冒充。
// 唯一不變式：昨天的分時一天只變一次 ⇒ memoize 6 小時（每檔一份、in-flight 合流）＋ CDN daily 層；
//   1,000 個使用者看同一檔，上游仍是每 6 小時 2 次（.TW／.TWO 各試一次）。
async function fetchYahoo5d(symbol: string) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=5d&includePrePost=false`, {
      signal: ctl.signal, cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'application/json', Referer: 'https://finance.yahoo.com/' },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.chart?.result?.[0] ?? null;
  } catch { return null; } finally { clearTimeout(tm); }
}

const taipeiParts = (tsSec: number) => {
  const d = new Date(new Date(tsSec * 1000).toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, hm: d.getHours() * 60 + d.getMinutes(), timeStr: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` };
};

interface PrevDay { code: string; date: string; open: number; high: number; low: number; close: number; ticks: { timeStr: string; close: number; volume: number }[] }

async function buildPrevDay(code: string): Promise<PrevDay | null> {
  const result = (await fetchYahoo5d(`${code}.TW`)) || (await fetchYahoo5d(`${code}.TWO`));
  if (!result) return null;
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const closes: (number | null)[] = q.close ?? []; const vols: (number | null)[] = q.volume ?? [];
  const groups: Record<string, { timeStr: string; close: number; volume: number }[]> = {};
  ts.forEach((t, i) => {
    const c = closes[i]; if (c == null) return;
    const p = taipeiParts(t); if (p.hm < 9 * 60 || p.hm > 13 * 60 + 30) return;   // 只留正規時段
    (groups[p.date] ||= []).push({ timeStr: p.timeStr, close: c, volume: vols[i] ?? 0 });
  });
  const dates = Object.keys(groups).sort();
  if (dates.length < 2) return null;
  const date = dates[dates.length - 2];              // 圖上顯示日（最後一日）的前一日
  const ticks = groups[date];
  const px = ticks.map(t => t.close);
  return { code, date, open: px[0], high: Math.max(...px), low: Math.min(...px), close: px[px.length - 1], ticks };
}

export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, 'stock-intraday-prev', 120);
  if (limited) return limited;
  const code = request.nextUrl.searchParams.get('code');
  if (!code || !/^\d{4,6}$/.test(code)) return NextResponse.json({ error: 'code required' }, { status: 400 });
  try {
    const data = await memoize(`intraday-prev:${code}`, 6 * 3600_000, () => buildPrevDay(code));
    if (!data) return NextResponse.json({ error: 'No previous-day intraday' }, { status: 404 });
    return NextResponse.json(data, { headers: { 'Cache-Control': cacheHeader('daily'), 'Access-Control-Allow-Origin': '*' } });
  } catch (error) {
    console.error(`stock-intraday-prev error for ${code}:`, error);
    return NextResponse.json({ error: 'Failed to fetch previous-day intraday' }, { status: 500 });
  }
}
