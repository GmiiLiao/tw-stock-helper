import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { gzipJson } from '@/lib/gzip-response';
import { sanitizeOhlcSeries } from '@/lib/ohlc-guard';
import { getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

// 日/週/月 K 線：Yahoo chart，interval=1d/1wk/1mo。
// 日/週抓 range=max(可縮放到上市至今)，月同。回傳 OHLCV 陣列(由舊到新)。
type Interval = '1m' | '5m' | '60m' | '1d' | '1wk' | '1mo';
// 盤中週期的 range 要短：1 分 K 拉太長 Yahoo 會截斷且無意義。
// ⚠ Yahoo 原生沒有 10m/20m，那兩個由 5m 聚合而成（見 aggregate）。
const RANGE: Record<Interval, string> = {
  '1m': '1d', '5m': '5d', '60m': '1mo',
  // ⚠ 日/週/月維持原本的深度，不可因為加盤中週期而縮短既有圖表的歷史
  '1d': '5y', '1wk': 'max', '1mo': 'max',
};

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

// 把 N 根合併成一根。用途：Yahoo 沒有 10m/20m，以 5m 聚合而成。
// ⚠ 以**每根的起始時間**為新根的時間戳，並沿用第一根的開盤、最後一根的收盤，
//   高低取極值、量取總和——這是 K 線聚合的標準口徑，不可自創。
function aggregate(bars: Bar[], n: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i += n) {
    const g = bars.slice(i, i + n);
    if (!g.length) continue;
    out.push({
      t: g[0].t,
      o: g[0].o,
      h: Math.max(...g.map(x => x.h)),
      l: Math.min(...g.map(x => x.l)),
      c: g[g.length - 1].c,
      v: g.reduce((a, x) => a + (x.v || 0), 0),
    });
  }
  return out;
}

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
  // 限流防濫用。2026-08-01 放寬：個股頁 K 線鏈每檔 3~12 連發、會員頁多檔輪詢，
  // 原值連續瀏覽數檔就會 429 圖表空白——限流目標是每分鐘數百次的濫用，不是正常瀏覽
  const limited = await rateLimit(request, 'candles', 120);
  if (limited) return limited;

  const code = request.nextUrl.searchParams.get('code');
  const interval = (request.nextUrl.searchParams.get('interval') || '1d') as Interval | '10m' | '20m';
  const ALLOWED = ['1m', '5m', '10m', '20m', '60m', '1d', '1wk', '1mo'];
  if (!code || !/^\d{4,6}$/.test(code) || !ALLOWED.includes(interval)) {
    return NextResponse.json({ error: 'bad params' }, { status: 400 });
  }
  // 10m/20m 由 5m 聚合（Yahoo 無原生支援）
  const AGG: Record<string, number> = { '10m': 2, '20m': 4 };
  const fetchAs = (AGG[interval] ? '5m' : interval) as Interval;
  let raw = (await fetchCandles(`${code}.TW`, fetchAs)) || (await fetchCandles(`${code}.TWO`, fetchAs));
  // ⚠ Yahoo 分鐘線開盤後常整條缺席（2026-09-01 實測 09:13 全市場 range=1d 回
  //   0 根、regularMarketTime 停在前一日收盤）⇒ 盤中 1~60 分 K 全部不動。
  //   用自家 MIS 分時（marketIntraday/latest，與「即時」分頁同源）聚合補今天
  //   的尾端——與下方 1d 用 chipArchive 補尾端同一個模式。
  //   Yahoo 正常時 lastT 已是最新 bar，這裡幾乎不補、零成本；Yahoo 恢復後自動讓位。
  if (fetchAs === '1m' || fetchAs === '5m' || fetchAs === '60m') {
    try {
      const db = getAdminDb();
      if (db) {
        const doc = (await db.collection('marketIntraday').doc('latest').get()).data();
        const twNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const todayIso = `${twNow.getFullYear()}-${String(twNow.getMonth() + 1).padStart(2, '0')}-${String(twNow.getDate()).padStart(2, '0')}`;
        if (doc && doc.date === todayIso && doc.seriesJson) {
          const s = JSON.parse(doc.seriesJson)[code];
          const pts: [number, number, number][] = s?.pts || [];   // [epoch秒, 價, 累積量(股)]
          if (pts.length) {
            const sec = fetchAs === '1m' ? 60 : fetchAs === '5m' ? 300 : 3600;
            const lastT = raw?.length ? raw[raw.length - 1].t : 0;
            // 依 bucket 聚合：o=首價、h/l=極值、c=末價、v=累積量差分
            const buckets = new Map<number, { o: number; h: number; l: number; c: number; cum: number }>();
            for (const [t, p, cum] of pts) {
              if (!(p > 0)) continue;
              const b = Math.floor(t / sec) * sec;
              const cur = buckets.get(b);
              if (!cur) buckets.set(b, { o: p, h: p, l: p, c: p, cum: cum || 0 });
              else { cur.h = Math.max(cur.h, p); cur.l = Math.min(cur.l, p); cur.c = p; cur.cum = cum || cur.cum; }
            }
            const keys = [...buckets.keys()].sort((a, b) => a - b);
            const add: Bar[] = [];
            let prevCum = 0;
            for (const k of keys) {
              const b = buckets.get(k)!;
              const v = Math.max(0, b.cum - prevCum);
              prevCum = b.cum;
              // ⚠ 不能用「k <= lastT 就不補」：Yahoo 會留一根**停更的進行中 bar**
              //   （實測 60m 停在 09:02），跳過它會讓該 bucket 凍到下一根才動。
              //   改成同 bucket 以自家覆蓋——自家分時 25~32 秒更新一次，恆比停更的新。
              if (k < Math.floor(lastT / sec) * sec) continue;   // 更早的 Yahoo 歷史 bar 不動
              add.push({ t: k, o: +b.o.toFixed(2), h: +b.h.toFixed(2), l: +b.l.toFixed(2), c: +b.c.toFixed(2), v });
            }
            if (add.length) {
              const covered = new Set(add.map(x => x.t));
              raw = [...(raw || []).filter(x => !covered.has(Math.floor(x.t / sec) * sec)), ...add].sort((a, b) => a.t - b.t);
            }
          }
        }
      }
    } catch { /* 補齊失敗＝維持 Yahoo 原樣，不影響既有功能 */ }
  }
  const candles = raw && AGG[interval] ? aggregate(raw, AGG[interval]) : raw;
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
  // 盤中週期變動快，快取要短；但仍由 CDN 吸收 ⇒ 上游請求數與使用者數解耦
  const maxAge = interval === '1m' ? 60
    : ['5m', '10m', '20m'].includes(interval) ? 120
    : interval === '60m' ? 300
    : interval === '1d' ? 300 : 3600;
  return gzipJson(request, { code, interval, candles }, `public, s-maxage=${maxAge}`);
}
