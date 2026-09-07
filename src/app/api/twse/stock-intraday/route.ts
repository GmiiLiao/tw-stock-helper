import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { getAdminDb } from '@/lib/firebase-admin';
import { isMarketOpen } from '@/lib/twse-api-server';
import { cacheHeader } from '@/lib/api-cache';

export const runtime = 'nodejs';

// ── 成功回應要可被 CDN 共用（2026-08-12，與 stock-day-all 同一輪巡查）──
//
// 這支被 StockTrendChart 以 `setInterval(loadRealtime, 5000)` 每 5 秒輪詢，
// 原本回 `no-store` ⇒ 每個看盤的人、每 5 秒都打穿到 origin。
// 但底層是 daemon 寫進 Firestore 的分時序列，掃描週期實測 25~32 秒才更新一次
// ——no-store 一點新鮮度都換不到，純粹是把「origin 負載」綁死在「線上人數」上，
// 正是本專案唯一不變式要避免的東西。
//
// s-maxage 取 2 秒（與 stock-day-all 同一個保守值）：
// 同一檔股票的多個觀看者會收斂成每 2 秒 1 次 origin 取用，
// 而單一使用者 5 秒一次的輪詢仍然幾乎每次都拿到重新驗證過的資料。
// 快取鍵天然按 ?code= 分開，不會互相污染。
// ⚠ 只套在**成功**回應；400/404/500 一律不帶標頭，錯誤不該被快取。
// 數值收斂到 api-cache 'hot' 層級（s-maxage=2·使用者指定的保守值），
// 這裡不再手寫字串；每個 request 現算是因為收盤後 cacheHeader 會自動切長 TTL。
const okCache = () => ({ 'Cache-Control': cacheHeader('hot'), 'Access-Control-Allow-Origin': '*' });
const taipeiDate = () => {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${tw.getFullYear()}-${String(tw.getMonth() + 1).padStart(2, '0')}-${String(tw.getDate()).padStart(2, '0')}`;
};

// Real-time intraday from the resident daemon's MIS sweep (marketIntraday/latest).
// Independent of Yahoo, which lags ~20min and is often empty at the open.
async function fetchDaemonIntraday(code: string) {
  try {
    const db = getAdminDb();
    if (!db) return null;
    const snap = await db.collection('marketIntraday').doc('latest').get();
    const data = snap.data();
    if (!data || data.date !== taipeiDate()) return null; // only today's series
    const series = JSON.parse(data.seriesJson || '{}');
    const s = series[code];
    if (!s || !Array.isArray(s.pts) || s.pts.length === 0) return null;
    const ticks = s.pts.map((p: [number, number, number]) => {
      const tw = new Date(new Date(p[0] * 1000).toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const timeStr = `${String(tw.getHours()).padStart(2, '0')}:${String(tw.getMinutes()).padStart(2, '0')}`;
      return { time: p[0], timeStr, close: p[1], volume: p[2] ?? 0 };
    });
    return { prevClose: s.prev ?? ticks[0].close, ticks };
  } catch {
    return null;
  }
}

async function fetchIntraday(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d&includePrePost=false`;
  try {
    // 4s 上限：盤中每 5 秒輪詢，避免偶發慢回應拖慢更新(即時尾段仍由 daemon/即時報價補上)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

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
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    return result;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  // 限流防濫用。2026-08-01 放寬：個股頁 K 線鏈每檔 3~12 連發、會員頁多檔輪詢，
  // 原值連續瀏覽數檔就會 429 圖表空白——限流目標是每分鐘數百次的濫用，不是正常瀏覽
  const limited = await rateLimit(request, 'stock-intraday', 240);
  if (limited) return limited;

  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'code required' }, { status: 400 });
  }

  try {
    // 即時走勢需涵蓋完整交易時段 09:00–13:30。daemon 的 MIS 分時序列即時無延遲，
    // 但只記錄被追蹤個股、且被檢視前的早盤靠 daemon 端 Yahoo 回補補齊。
    // 快速路徑：盤中時 daemon 若已從 09:0x 起完整 → 直接回 daemon(免等 Yahoo，維持即時)。
    const daemon = await fetchDaemonIntraday(code);
    // 交易時段一律走 isMarketOpen()（查假日）。原本這裡自己算星期＋分鐘
    // ——CLAUDE.md 記過「舊 codebase 有 6 份互相不一致的實作，其中 5 份不查假日」，
    // 這支就是漏網的那種：颱風假的星期三會被它當成盤中。
    // （語意差異：舊寫法到 13:35，isMarketOpen 到 13:31——13:31~13:35 改走一般路徑，
    //   daemon 尾段仍會接上，資料不變，只是少走快速路徑四分鐘。）
    const marketOpen = isMarketOpen();
    const firstTickMin = daemon?.ticks?.length
      ? (() => { const t = new Date(new Date(daemon.ticks[0].time * 1000).toLocaleString('en-US', { timeZone: 'Asia/Taipei' })); return t.getHours() * 60 + t.getMinutes(); })()
      : 9999;
    // ⚠ 快速路徑還要檢查「尾端夠新」（2026-09-07 台虹實案）：daemon 只記錄快線優先集裡的個股，
    //   使用者 09:00 看過、切走 15 分鐘後它就掉出優先集，序列停在 09:12；早盤回補只補開頭缺口，
    //   不補中段斷洞。只看「第一筆夠早」會把凍住的 13 點當完整序列回一整天。
    //   尾端超過 3 分鐘沒新點就改走一般路徑（Yahoo 主幹＋daemon 尾段），回應形狀不變。
    const lastTickAgeSec = daemon?.ticks?.length ? Date.now() / 1000 - daemon.ticks[daemon.ticks.length - 1].time : Infinity;
    if (marketOpen && daemon && firstTickMin <= 9 * 60 + 10 && lastTickAgeSec <= 180) {
      return NextResponse.json({ code, prevClose: daemon.prevClose, ticks: daemon.ticks, source: 'mis-fast' }, { headers: okCache() });
    }

    // 一般路徑：以 Yahoo 全日為主幹，盤中再把 daemon 更即時的尾段接上，兼顧完整與即時。
    const [resTw, resTwo] = await Promise.all([
      fetchIntraday(`${code}.TW`),
      fetchIntraday(`${code}.TWO`),
    ]);

    const toTimeStr = (ts: number) => {
      const tw = new Date(new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      return `${String(tw.getHours()).padStart(2, '0')}:${String(tw.getMinutes()).padStart(2, '0')}`;
    };

    const result = resTw || resTwo;
    let ticks: { time: number; timeStr: string; close: number; volume: number }[] = [];
    let prevClose = 0;

    if (result) {
      const timestamps: number[] = result.timestamp ?? [];
      const quote = result.indicators?.quote?.[0] ?? {};
      const closes: (number | null)[] = quote.close ?? [];
      const volumes: (number | null)[] = quote.volume ?? [];
      ticks = timestamps.map((ts, idx) => {
        const close = closes[idx];
        if (close === null || close === undefined) return null;
        return { time: ts, timeStr: toTimeStr(ts), close, volume: volumes[idx] ?? 0 };
      }).filter((t): t is { time: number; timeStr: string; close: number; volume: number } => t !== null);
      const meta = result.meta ?? {};
      prevClose = meta.chartPreviousClose ?? meta.previousClose ?? (ticks[0]?.close ?? 0);
    }

    // 盤中：把 daemon 更即時、比 Yahoo 尾端更新的點接上(消除 20 分延遲)
    if (daemon?.ticks?.length) {
      const lastYahoo = ticks.length ? ticks[ticks.length - 1].time : 0;
      const tail = daemon.ticks.filter((t: { time: number }) => t.time > lastYahoo);
      if (ticks.length === 0) { ticks = daemon.ticks; }          // Yahoo 失敗 → 全用 daemon
      else if (tail.length) { ticks = [...ticks, ...tail]; }      // 接上即時尾段
      if (!prevClose) prevClose = daemon.prevClose;
    }

    if (ticks.length === 0) {
      return NextResponse.json({ error: 'No data found' }, { status: 404 });
    }

    return NextResponse.json({ code, prevClose, ticks, source: result ? 'yahoo+mis' : 'mis' }, { headers: okCache() });
  } catch (error) {
    console.error(`Stock intraday proxy error for ${code}:`, error);
    return NextResponse.json({ error: 'Failed to fetch stock intraday data' }, { status: 500 });
  }
}
