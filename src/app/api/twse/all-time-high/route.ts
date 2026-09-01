import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

// 歷史最高價。⚠ 不能只信 Yahoo 月線：2026-09-01 實測 3406 玉晶光昨日漲停
// 1005 創歷史新高，但 Yahoo 月線的 2026-08 整根 bar high=null（月線聚合
// 缺最新月，與日 K 漏最新一根同族——漲停股尤甚），meta 明明就有 1005。
// 三層取大，缺一層都會像使用者截圖那樣「創新高卻顯示距高 9.6%」：
//   ① 月線 range=max —— 歷史全期
//   ② 日線 range=3mo —— 補月線尾端洞（實測日線資料完整、月線缺）
//   ③ meta.regularMarketDayHigh —— 盤中即時新高即刻反映，不必等收盤
async function fetchChart(symbol: string, interval: string, range: string): Promise<any | null> {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 6000);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const j = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(tm));
    return j?.chart?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

function maxOf(res: any): { high: number; ts: number } {
  const ts: number[] = res?.timestamp || [];
  const highs: (number | null)[] = res?.indicators?.quote?.[0]?.high || [];
  let max = 0, maxTs = 0;
  for (let i = 0; i < highs.length; i++) {
    const h = highs[i];
    if (h != null && h > max) { max = h; maxTs = ts[i]; }
  }
  return { high: max, ts: maxTs };
}

// ⚠ 要用台北時區換算年月，不能用 server 本地時間：Cloud Run 是 UTC，而 Yahoo
//   月線 bar 的 ts 是「該月第一天 00:00 台北」＝ UTC 前月末 16:00 ⇒ 直接
//   getMonth() 會把月份標早一格（實測 2330 歷史高 6 月被標成 2026-05）。
const ymLabel = (ms: number) => {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

async function fetchMaxHigh(symbol: string): Promise<{ high: number; date: string } | null> {
  const mo = await fetchChart(symbol, '1mo', 'max');
  if (!mo) return null;                       // 月線都拿不到＝代號無效，換後綴重試
  let { high, ts } = maxOf(mo);
  let dateMs = ts * 1000;

  const day = await fetchChart(symbol, '1d', '3mo');
  const dm = maxOf(day);
  if (dm.high > high) { high = dm.high; dateMs = dm.ts * 1000; }

  const metaHigh = Number(mo?.meta?.regularMarketDayHigh || 0);
  if (metaHigh > high) { high = metaHigh; dateMs = Date.now(); }

  if (!(high > 0)) return null;
  return { high: +high.toFixed(2), date: ymLabel(dateMs) };
}

export async function GET(request: NextRequest) {
  // 限流防濫用。2026-08-01 放寬：個股頁 K 線鏈每檔 3~12 連發、會員頁多檔輪詢，
  // 原值連續瀏覽數檔就會 429 圖表空白——限流目標是每分鐘數百次的濫用，不是正常瀏覽
  const limited = await rateLimit(request, 'all-time-high', 60);
  if (limited) return limited;

  const code = request.nextUrl.searchParams.get('code');
  if (!code || !/^\d{4,6}$/.test(code)) {
    return NextResponse.json({ error: 'code required' }, { status: 400 });
  }
  const r = (await fetchMaxHigh(`${code}.TW`)) || (await fetchMaxHigh(`${code}.TWO`));
  if (!r) return NextResponse.json({ code, high: null }, { headers: { 'Cache-Control': 'no-store' } });
  // 快取 30 分鐘（原 6 小時）：正在創新高的股票要在當天內反映，
  // meta 即時日高已納入 ⇒ 30 分鐘刷新的體感等同當日即時。CDN 吸收使用者端。
  return NextResponse.json({ code, high: r.high, date: r.date }, { headers: { 'Cache-Control': 'public, s-maxage=1800' } });
}
