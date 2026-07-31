import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { gzipJson } from '@/lib/gzip-response';
import { sanitizeOhlcSeries } from '@/lib/ohlc-guard';
import { getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

// 日/週/月 K 線：Yahoo chart，interval=1d/1wk/1mo。
// 日/週抓 range=max(可縮放到上市至今)，月同。回傳 OHLCV 陣列(由舊到新)。
type Interval = '1d' | '1wk' | '1mo';
const RANGE: Record<Interval, string> = { '1d': '5y', '1wk': 'max', '1mo': 'max' };

async function fetchCandles(symbol: string, interval: Interval) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 7000);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${RANGE[interval]}`;
    const j = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(tm));
    const res = j?.chart?.result?.[0];
    if (!res) return null;
    const ts: number[] = res.timestamp || [];
    const q = res.indicators?.quote?.[0] || {};
    const out: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (c == null) continue;
      out.push({
        t: ts[i],
        o: +(q.open?.[i] ?? c).toFixed(2),
        h: +(q.high?.[i] ?? c).toFixed(2),
        l: +(q.low?.[i] ?? c).toFixed(2),
        c: +c.toFixed(2),
        v: q.volume?.[i] ?? 0,
      });
    }
    // OHLC 完整性防護：丟棄/夾制資料源偶發的壞 K 棒(high<low、負價、null)
    const { bars } = sanitizeOhlcSeries(out);
    return bars.length ? bars : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  // 扇出上游的端點才限流（CDN 已擋掉重複 GET；這裡防的是繞過快取的濫用）
  const limited = await rateLimit(request, 'candles', 30);
  if (limited) return limited;

  const code = request.nextUrl.searchParams.get('code');
  const interval = (request.nextUrl.searchParams.get('interval') || '1d') as Interval;
  if (!code || !/^\d{4,6}$/.test(code) || !['1d', '1wk', '1mo'].includes(interval)) {
    return NextResponse.json({ error: 'bad params' }, { status: 400 });
  }
  const candles = (await fetchCandles(`${code}.TW`, interval)) || (await fetchCandles(`${code}.TWO`, interval));
  if (!candles) return NextResponse.json({ code, interval, candles: [] }, { headers: { 'Cache-Control': 'no-store' } });
  // ⚠Yahoo 逐檔漏最新日K（2026-07-27 實例：2330 有、2332 的 close 為 null，漲停股尤甚）。
  // 用自家 chipArchive（每日 15:10 官方收盤歸檔·1,900+ 檔齊全）補齊尾端，日線才不會少一根。
  if (interval === '1d') {
    try {
      const db = getAdminDb();
      if (db) {
        const lastT = candles.length ? candles[candles.length - 1].t : 0;
        const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(3).get();
        const add: typeof candles = [];
        for (const doc of snap.docs) {
          const iso = doc.id;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
          const t = Math.floor(new Date(`${iso}T09:00:00+08:00`).getTime() / 1000);   // 與 Yahoo 日K 同對齊（開盤時點）
          if (t <= lastT) continue;
          const raw = doc.data().closeJson;
          if (!raw) continue;
          const r = JSON.parse(raw)[code];                                             // [收, 量張, 開, 高, 低]
          if (!Array.isArray(r) || !(r[0] > 0)) continue;
          add.push({ t, o: +(r[2] || r[0]).toFixed(2), h: +(r[3] || r[0]).toFixed(2), l: +(r[4] || r[0]).toFixed(2), c: +r[0].toFixed(2), v: Math.round((r[1] || 0) * 1000) });
        }
        if (add.length) { candles.push(...add.sort((a, b) => a.t - b.t)); }
      }
    } catch { /* 補齊失敗＝維持 Yahoo 原樣，不影響既有功能 */ }
  }
  // 歷史 K 線變動慢，日線快取 5 分、週/月快取 1 小時；gzip 壓縮(日線 ~77KB→~18KB)
  const maxAge = interval === '1d' ? 300 : 3600;
  return gzipJson(request, { code, interval, candles }, `public, s-maxage=${maxAge}`);
}
