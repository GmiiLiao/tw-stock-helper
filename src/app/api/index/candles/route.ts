import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { sanitizeOhlcSeries } from '@/lib/ohlc-guard';
import { getAdminDb } from '@/lib/firebase-admin';
export const runtime = 'nodejs';

// 指數日/週/月 K（市場總覽「📈 指數分析」分頁）：白名單符號避免任意轉發。
// 加權/國際指數＝Yahoo chart；櫃買指數＝TPEx 官方（Yahoo ^TWOII 為壞資料——
// 數值與日期皆錯，棄用）：daemon 每日把官方當月 OHLC 併入 indexHistory/otc 累積，
// 此處讀累積＋官方當月即時合併，週/月K由日K聚合。回傳 OHLCV（舊→新）。
const SYMS: Record<string, { sym: string; name: string }> = {
  twii: { sym: '^TWII', name: '加權指數' },
  sox: { sym: '^SOX', name: '費城半導體' },
  ixic: { sym: '^IXIC', name: '那斯達克' },
  gspc: { sym: '^GSPC', name: 'S&P 500' },
  dji: { sym: '^DJI', name: '道瓊工業' },
  n225: { sym: '^N225', name: '日經 225' },
};
type Interval = '1d' | '1wk' | '1mo';
const RANGE: Record<Interval, string> = { '1d': '5y', '1wk': 'max', '1mo': 'max' };
type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

// 日K → 週/月K 聚合（櫃買官方序列用）
function aggregate(bars: Bar[], interval: Interval): Bar[] {
  if (interval === '1d') return bars;
  const groups = new Map<string, Bar[]>();
  for (const b of bars) {
    const d = new Date(b.t * 1000);
    let key: string;
    if (interval === '1mo') key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    else { const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); key = monday.toISOString().slice(0, 10); }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }
  return [...groups.values()].map(g => ({
    t: g[0].t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[g.length - 1].c, v: g.reduce((s, x) => s + x.v, 0),
  })).sort((a, b) => a.t - b.t);
}

async function otcCandles(interval: Interval): Promise<Bar[]> {
  const rows: Record<string, [number, number, number, number]> = {};
  const db = getAdminDb();
  if (db) {
    try {
      const doc = await db.collection('indexHistory').doc('otc').get();
      if (doc.exists) Object.assign(rows, JSON.parse(doc.data()!.rowsJson || '{}'));
    } catch { /* 累積檔可缺 */ }
  }
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_index', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).finally(() => clearTimeout(tm));
    if (r.ok) for (const x of await r.json()) { const d = String(x.Date || ''); if (/^\d{8}$/.test(d) && parseFloat(x.Close) > 0) rows[d] = [parseFloat(x.Open), parseFloat(x.High), parseFloat(x.Low), parseFloat(x.Close)]; }
  } catch { /* 官方當月可缺，仍回累積 */ }
  const daily: Bar[] = Object.keys(rows).sort().map(d => {
    const [o, h, l, c] = rows[d];
    const t = Math.floor(new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T13:30:00+08:00`).getTime() / 1000);
    return { t, o: o || c, h: h || c, l: l || c, c, v: 0 };
  });
  return aggregate(daily, interval);
}

export async function GET(request: NextRequest) {
  // 限流防濫用。2026-08-01 放寬：個股頁 K 線鏈每檔 3~12 連發、會員頁多檔輪詢，
  // 原值連續瀏覽數檔就會 429 圖表空白——限流目標是每分鐘數百次的濫用，不是正常瀏覽
  const limited = await rateLimit(request, 'index-candles', 60);
  if (limited) return limited;

  const id = (request.nextUrl.searchParams.get('sym') || 'twii').toLowerCase();
  const interval = (request.nextUrl.searchParams.get('interval') || '1d') as Interval;
  if ((id !== 'otc' && !SYMS[id]) || !['1d', '1wk', '1mo'].includes(interval)) {
    return NextResponse.json({ error: 'bad params' }, { status: 400 });
  }
  if (id === 'otc') {
    const { bars } = sanitizeOhlcSeries(await otcCandles(interval));
    return NextResponse.json({ sym: id, name: '櫃買指數', candles: bars, note: 'TPEx官方·歷史自2026-07起逐日累積' }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  }
  const def = SYMS[id];
  try {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 8000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(def.sym)}?interval=${interval}&range=${RANGE[interval]}`;
    const j = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(tm));
    const res = j?.chart?.result?.[0];
    if (!res) return NextResponse.json({ sym: id, name: def.name, candles: [] }, { headers: { 'Cache-Control': 'no-store' } });
    const ts: number[] = res.timestamp || [];
    const q = res.indicators?.quote?.[0] || {};
    const out: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (c == null) continue;
      out.push({ t: ts[i], o: +(q.open?.[i] ?? c).toFixed(2), h: +(q.high?.[i] ?? c).toFixed(2), l: +(q.low?.[i] ?? c).toFixed(2), c: +c.toFixed(2), v: q.volume?.[i] ?? 0 });
    }
    const { bars } = sanitizeOhlcSeries(out);
    return NextResponse.json({ sym: id, name: def.name, candles: bars }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  } catch {
    return NextResponse.json({ sym: id, name: def.name, candles: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
