// Note: execFile/curl removed — using native fetch for Cloud Functions compatibility

import { readMarketSnapshot, isSnapshotFresh, type SnapQuote } from './market-snapshot-store';
import { memoize } from './singleflight';

// ============================================================
// Types
// ============================================================

export interface StockDayData {
  Code: string;
  Name: string;
  TradeVolume: string;
  TradeValue: string;
  OpeningPrice: string;
  HighestPrice: string;
  LowestPrice: string;
  ClosingPrice: string;
  Change: string;
  Transaction: string;
  Date?: string;
  _source?: string;
  _changePercent?: string;
  _prevClose?: string;
  _market?: string;   // 'tse' 上市 | 'otc' 上櫃
  _tradeTime?: string;
}

export interface MarketIndexData {
  weighted: number;
  weightedChange: number;
  weightedChangePercent: number;
  high?: number;
  low?: number;
  prevClose?: number;
  source: string;
  tradeTime?: string;
  tradeDate?: string;
  upCount?: number;
  downCount?: number;
  totalStocks?: number;
  avgChange?: number;
  usMarket?: {
    nasdaqPrice: number;
    nasdaqChange: number;
    nasdaqChangePercent: number;
    dowPrice: number;
    dowChange: number;
    dowChangePercent: number;
    sp500Price: number;
    sp500Change: number;
    sp500ChangePercent: number;
    tsmcAdrPrice: number;
    tsmcAdrChange: number;
    tsmcAdrChangePercent: number;
    nasdaqFuturesPrice?: number;
    nasdaqFuturesChange?: number;
    nasdaqFuturesChangePercent?: number;
    msciTaiwanPrice?: number;
    msciTaiwanChange?: number;
    msciTaiwanChangePercent?: number;
  };
  twNight?: {
    price: number;
    change: number;
    changePercent: number;
    tradeTime?: string;
  };
}

export interface NewsItem {
  id: string;
  title: string;
  source: string;
  category: 'announcement' | 'market' | 'education' | 'analysis';
  stockCode: string;
  stockName: string;
  time: string;
  url: string;
}

export interface NewsData {
  news: NewsItem[];
  fetchedAt: string;
  count: number;
}

export interface MisQuote {
  code: string;
  name: string;
  price: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
  changePercent: number;
  volume: number;
  tradeTime: string;
  source: 'mis_realtime' | 'mis_bid' | 'mis_close' | 'stock_day_all';
  dataDate?: string;
}

export interface MisQuoteResponse {
  quotes: MisQuote[];
  isRealtime: boolean;
  marketOpen: boolean;
  source: string;
}

// ============================================================
// Configuration
// ============================================================

const TOP_TSE_CODES = [
  '2330','2317','2454','2308','2382','2303','2412','2882','2881','2886',
  '2884','2885','2890','2892','3711','2002','1303','1301','1326','2207',
  '2105','3008','2357','2379','2408','4938','2395','3034','3231','2376',
  '6505','5880','2891','2883','2887','2888','2609','2615','2618','2610',
  '0050','0051','0052','006208','00878','00919','00929','00934','00940',
  '2344','3037','4904','3045','2353','2049','2409',
  '7722','7749','7788','8021','9910','9921','9914','9904','9907','9941',
  '2823','2836','2838','5876','5871','6005',
  '2327','2337','2347','2352','2356','2360','2368','2371','2376','2377',
  '2383','2385','2397','2404','2406','2410','2413','2420','2423','2426',
  '3005','3006','3017','3019','3022','3023','3025','3026','3029','3033',
  '3481','2603','2324','2301',
];

const TOP_OTC_CODES = [
  '3363','5274','3529','6278','3443','6669','8046','4952','6781','6770',
  '3008','3034','6230','3105','3711','4966','6415','6488','6770',
  '3035','3658','4968','5347','6230','6271','6409','6534',
];

const marketCache = new Map<string, 'tse' | 'otc'>();

// Initialize cache with known top stocks
TOP_TSE_CODES.forEach(c => marketCache.set(c, 'tse'));
TOP_OTC_CODES.forEach(c => marketCache.set(c, 'otc'));

// ============================================================
// Shared Helpers
// ============================================================

/**
 * TWSE market-closed dates (non-trading days), Taipei time, 'YYYY-MM-DD'.
 * Source: official TWSE holiday schedule (twse.com.tw/holidaySchedule).
 * NOTE: this list MUST be updated annually when TWSE publishes the next
 * year's calendar. Weekends are handled separately and need not be listed.
 */
const TW_MARKET_HOLIDAYS = new Set<string>([
  // ── 2026 ──
  '2026-01-01', // 中華民國開國紀念日
  '2026-02-13', // 小年夜（封關後）
  '2026-02-16', // 春節
  '2026-02-17', // 春節
  '2026-02-18', // 春節
  '2026-02-19', // 春節
  '2026-02-20', // 春節彈性放假
  '2026-02-27', // 和平紀念日彈性放假
  '2026-02-28', // 和平紀念日（週六，已含於週末）
  '2026-04-03', // 兒童節彈性放假
  '2026-04-06', // 清明節補假
  '2026-05-01', // 勞動節
  '2026-06-19', // 端午節
  '2026-09-25', // 中秋節
  '2026-09-28', // 教師節
  '2026-10-09', // 國慶日彈性放假
  '2026-10-26', // 臺灣光復暨金門古寧頭大捷紀念日補假
  '2026-12-25', // 行憲紀念日
]);

/** Local Taipei-time helpers (avoid UTC drift). */
function taipeiNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** True if the given Taipei-time date is a TWSE trading day (weekday & not a holiday). */
export function isTradingDay(tw: Date = taipeiNow()): boolean {
  const day = tw.getDay();
  if (day === 0 || day === 6) return false;        // weekend
  if (TW_MARKET_HOLIDAYS.has(ymd(tw))) return false; // national holiday
  return true;
}

/**
 * True only during the continuous TWSE regular session: 09:00–13:30 on a
 * trading day. Taiwan equities trade continuously with NO lunch break.
 * (+1 min tolerance for the closing call auction tail.)
 */
export function isMarketOpen(): boolean {
  const tw = taipeiNow();
  if (!isTradingDay(tw)) return false;
  const t = tw.getHours() * 60 + tw.getMinutes();
  return t >= 9 * 60 && t < 13 * 60 + 31;
}

/** Check if US market is open (Taiwan time ~21:30–04:00 next day, Mon–Fri) */
export function isUsMarketOpen(): boolean {
  const now = new Date();
  const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const t = et.getHours() * 60 + et.getMinutes();
  // US regular hours: 9:30 AM – 4:00 PM ET
  // Include pre-market from 4:00 AM and after-hours to 8:00 PM
  return t >= 4 * 60 && t < 20 * 60;
}

/** Check if any market is active (TW or US) */
export function isAnyMarketActive(): boolean {
  return isMarketOpen() || isUsMarketOpen();
}

// ── 直打 MIS 的總開關 ────────────────────────────────────────
// 這些路徑**沒有 memoize、沒有 in-flight 合流**：使用者多一個，打給 MIS 就多一次。
// 過去在 us-central1 是「安全地壞著」—— 美國 IP 被 mis.twse.com.tw 封鎖，
// 每次都失敗快速落到 Firestore 快照，所以沒人發現它違反了唯一不變式。
//
// ⚠ 一旦把 region 移到 asia-east1（台灣），這些路徑會**開始成功** ——
//   1000 個使用者就是 1000 次直打，而 MIS 限制是每 5 秒 3 個 request，
//   後果是伺服器 IP 被 TWSE 封鎖，且封鎖時長無人證實。
//
// 所以預設關閉。即時報價的唯一合法來源是常駐 daemon（台灣 IP、有 pacing）
// 寫進 Firestore 的 marketSnapshot。真要在本機除錯才設 ALLOW_DIRECT_MIS=1。
const ALLOW_DIRECT_MIS = process.env.ALLOW_DIRECT_MIS === '1';

async function callMIS(exCh: string): Promise<Record<string, {
  name: string; price: number; open: number; high: number; low: number;
  change: number; changePercent: number; prevClose: number; tradeTime: string;
  volume: number;
}>> {
  if (!ALLOW_DIRECT_MIS) return {};   // 等同過去「必然失敗」的行為，但不浪費一次往返
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
      },
      cache: 'no-store',
    });

    clearTimeout(timeoutId);

    if (!res.ok) return {};
    const text = await res.text();
    if (!text?.trim().startsWith('{')) return {};
    const data = JSON.parse(text);
    const result: Record<string, {
      name: string; price: number; open: number; high: number; low: number;
      change: number; changePercent: number; prevClose: number; tradeTime: string;
      volume: number;
    }> = {};

    for (const item of (data?.msgArray ?? [])) {
      if (!item.c || !item.n) continue;
      
      let price = item.z && item.z !== '-' ? parseFloat(item.z) : 0;
      if (price <= 0) {
        // Try trial match price (pz) first
        if (item.pz && item.pz !== '-') {
          price = parseFloat(item.pz);
        }
      }
      if (price <= 0) {
        // Parse bid/ask — search ALL 5 levels, not just the first
        // During closing auction or limit-up/down, bid[0] is often 0 but deeper levels have valid prices
        const bidLevels = item.b ? item.b.split('_').filter((s: string) => s && s !== '-') : [];
        const askLevels = item.a ? item.a.split('_').filter((s: string) => s && s !== '-') : [];
        const bestBid = bidLevels.map((s: string) => parseFloat(s)).find((v: number) => v > 0) ?? 0;
        const bestAsk = askLevels.map((s: string) => parseFloat(s)).find((v: number) => v > 0) ?? 0;
        if (bestBid > 0 && bestAsk > 0) {
          price = parseFloat(((bestBid + bestAsk) / 2).toFixed(2));
        } else if (bestBid > 0) {
          price = bestBid;
        } else if (bestAsk > 0) {
          price = bestAsk;
        }
      }
      if (price <= 0) {
        // Use today's high price if the stock has traded today (volume > 0)
        const todayHigh = parseFloat(item.h ?? '0');
        const todayVolume = parseInt(item.v ?? '0', 10);
        if (todayHigh > 0 && todayVolume > 0) {
          price = todayHigh;
        }
      }
      const prevClose = parseFloat(item.y ?? '0');
      if (price <= 0) {
        price = prevClose;
      }
      
      const high      = parseFloat(item.h ?? '0');
      const low       = parseFloat(item.l ?? '0');
      const open      = parseFloat(item.o ?? '0') || prevClose;
      const change    = price > 0 && prevClose > 0 ? parseFloat((price - prevClose).toFixed(2)) : 0;
      const changePercent = price > 0 && prevClose > 0 ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0;
      const volume    = parseInt(item.v ?? '0', 10) * 1000;
      if (price <= 0) continue;
      result[item.c] = {
        name: item.n,
        price,
        open,
        high,
        low,
        change,
        changePercent,
        prevClose,
        tradeTime: item.t ?? '',
        volume
      };
    }
    return result;
  } catch (error) {
    console.warn('[twse-api-server] callMIS error:', error);
    return {};
  }
}

function parseROCDateTime(dateStr: string, timeStr: string): string {
  if (!dateStr || dateStr.length < 7) return new Date().toISOString();
  try {
    const year = parseInt(dateStr.slice(0, 3)) + 1911;
    const month = dateStr.slice(3, 5);
    const day = dateStr.slice(5, 7);
    const time = timeStr ? timeStr.replace(/:/g, '').padStart(6, '0') : '000000';
    const h = time.slice(0, 2);
    const mi = time.slice(2, 4);
    const s = time.slice(4, 6) || '00';
    return new Date(`${year}-${month}-${day}T${h}:${mi}:${s}+08:00`).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ============================================================
// Core Server APIs (no loopback HTTP calls)
// ============================================================

// Memory cache for raw stock lists to bypass rate limiting & geoblocks
let cachedRawTse: any[] | null = null;
let cachedRawOtc: any[] | null = null;
let lastRawFetchTime = 0;
const RAW_CACHE_TTL = 10 * 60 * 1000; // 10 minutes cache TTL
// ── cache stampede 防護 (2026-07-30) ──────────────────────────────
// 原本從 cacheValid 檢查到 lastRawFetchTime 更新之間有 1~3 秒空窗，
// 這段時間內所有併發 request 各自發起一整組上游 fetch。
let rawFetchInflight: Promise<void> | null = null;
let resolveRawFetch: (() => void) | null = null;
// 原本 lastRawFetchTime 只在成功時更新 → 上游一掛就變成每個 request 立刻重打，
// 流量不降反升。這個冷卻讓失敗也被「快取」。
let lastRawFailAt = 0;
const RAW_FAIL_COOLDOWN = 30 * 1000;

/**
 * Maps alternative TWSE JSON response array format into OpenAPI StockDayData objects
 */
// Parse the www.twse.com.tw after-trading STOCK_DAY_ALL CSV into openapi-shaped
// objects. This endpoint updates right after the 13:30 close, whereas the
// openapi.twse.com.tw mirror can lag up to a full day. Columns:
// 日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數
function parseStockDayAllCsv(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/"([^"]*)"/g);
    if (!m || m.length < 9) continue;          // skip header / blank lines
    const f = m.map(s => s.slice(1, -1));
    const code = (f[1] || '').trim();
    if (!code) continue;
    const clean = (v: string) => (v || '0').replace(/,/g, '').trim();
    out.push({
      Date:         f[0],
      Code:         code,
      Name:         (f[2] || '').trim(),
      TradeVolume:  clean(f[3]),
      TradeValue:   clean(f[4]),
      OpeningPrice: clean(f[5]),
      HighestPrice: clean(f[6]),
      LowestPrice:  clean(f[7]),
      ClosingPrice: clean(f[8]),
      Change:       clean(f[9]).replace('+', ''),
      Transaction:  clean(f[10]),
    });
  }
  return out;
}

/**
 * 1. Fetch & Merge all stock day data
 */
export async function getStockDayAllDataInternal(opts?: { closeOnly?: boolean }): Promise<StockDayData[]> {
  const closeOnly = !!opts?.closeOnly;
  const now = Date.now();
  let rawTse: any[] = [];
  let rawOtc: any[] = [];

  // 若已有另一個請求正在抓，等它抓完再吃快取，不要自己也去打上游。
  // 8 秒上限是保險：萬一持有者中途拋錯沒 resolve，也不會把大家卡死。
  if (!(cachedRawTse && cachedRawOtc && (now - lastRawFetchTime < RAW_CACHE_TTL)) && rawFetchInflight) {
    await Promise.race([
      rawFetchInflight.catch(() => undefined),
      new Promise<void>(r => setTimeout(r, 8000)),
    ]);
  }
  const inFailCooldown = Date.now() - lastRawFailAt < RAW_FAIL_COOLDOWN;
  const cacheValid = !!(cachedRawTse && cachedRawOtc &&
    (Date.now() - lastRawFetchTime < RAW_CACHE_TTL || inFailCooldown));

  if (cacheValid) {
    console.log('[twse-api-server] Using raw stock data cache. Age:', Math.round((now - lastRawFetchTime)/1000), 's');
    rawTse = cachedRawTse!;
    rawOtc = cachedRawOtc!;
  } else {
    console.log('[twse-api-server] Cache expired or empty. Fetching fresh lists...');
    // 宣告「我正在抓」，讓同時進來的其他請求等待而不是各自打上游
    rawFetchInflight = new Promise<void>(r => { resolveRawFetch = r; });
    
    // Fetch both lists concurrently
    const [resTse, resOtc] = await Promise.allSettled([
      // TSE day data. PRIMARY = www.twse.com.tw after-trading CSV (updates right
      // after the 13:30 close); FALLBACK = openapi.twse.com.tw JSON (can lag a
      // full day, so only used when the fresh CSV is unavailable).
      (async () => {
        try {
          const res = await fetch('https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/csv,application/json,*/*' },
            cache: 'no-store',
            signal: AbortSignal.timeout(8000), // 無 timeout 時上游 hang 會佔住 worker 到 120 秒
          });
          if (res.ok) {
            const rows = parseStockDayAllCsv(await res.text());
            if (rows.length > 0) {
              console.log('[twse-api-server] STOCK_DAY_ALL via www.twse CSV. Count:', rows.length, 'Date:', rows[0]?.Date);
              return rows;
            }
          }
        } catch (e: any) { console.warn('[twse-api-server] www.twse CSV failed, trying openapi:', e?.message); }
        try {
          const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)', 'Accept': 'application/json' },
            cache: 'no-store',
            signal: AbortSignal.timeout(8000), // 無 timeout 時上游 hang 會佔住 worker 到 120 秒
          });
          if (!r.ok) throw new Error(`OpenAPI status ${r.status}`);
          const data = await r.json();
          if (Array.isArray(data) && data.length > 0) {
            console.warn('[twse-api-server] STOCK_DAY_ALL via openapi fallback (may lag). Count:', data.length);
            return data;
          }
        } catch (e: any) { console.error('[twse-api-server] openapi STOCK_DAY_ALL fallback failed:', e?.message); }
        return [];
      })(),

      // Fetch TPEx day data
      fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)',
          'Accept': 'application/json',
        },
        cache: 'no-store',
      }).then(async r => {
        if (!r.ok) throw new Error(`TPEx API error status: ${r.status}`);
        const data = await r.json();
        if (!Array.isArray(data) || data.length === 0) throw new Error('TPEx returned empty data');
        return data;
      }).catch(err => {
        console.error('[twse-api-server] TPEx fetch failed:', err.message);
        return [];
      })
    ]);

    const freshTse = resTse.status === 'fulfilled' ? resTse.value : [];
    const freshOtc = resOtc.status === 'fulfilled' ? resOtc.value : [];

    // Stale-if-error: if we got empty data but have old cache, reuse it!
    if (freshTse.length > 0) {
      rawTse = freshTse;
      cachedRawTse = freshTse;
    } else if (cachedRawTse) {
      console.warn('[twse-api-server] Fetch failed for TSE, reusing stale cache');
      rawTse = cachedRawTse;
    }

    if (freshOtc.length > 0) {
      rawOtc = freshOtc;
      cachedRawOtc = freshOtc;
    } else if (cachedRawOtc) {
      console.warn('[twse-api-server] Fetch failed for TPEx, reusing stale cache');
      rawOtc = cachedRawOtc;
    }

    if (rawTse.length > 0 || rawOtc.length > 0) {
      lastRawFetchTime = Date.now();
      lastRawFailAt = 0;
    } else {
      // 整組失敗 → 記下失敗時間，30 秒內不再重打上游
      lastRawFailAt = Date.now();
    }
    resolveRawFetch?.();
    rawFetchInflight = null;
    resolveRawFetch = null;
  }

  // Map TPEx data structure to match TWSE STOCK_DAY_ALL
  const mappedOtc = rawOtc.map(item => ({
    _market:      'otc',
    Date:         item.Date ?? '',
    Code:         item.SecuritiesCompanyCode ?? '',
    Name:         item.CompanyName ?? '',
    TradeVolume:  item.TradingShares ?? '0',
    TradeValue:   item.TransactionAmount ?? '0',
    OpeningPrice: item.Open ?? '0',
    HighestPrice: item.High ?? '0',
    LowestPrice:  item.Low ?? '0',
    ClosingPrice: item.Close ?? '0',
    Change:       item.Change?.trim() || '0',
    Transaction:  item.TransactionNumber ?? '0',
  }));

  const raw = [...rawTse, ...mappedOtc];

  // Overlay the second brain's FULL-MARKET realtime snapshot (maintained by
  // the resident daemon's continuous MIS sweep). Replaces the old top-100
  // hard-coded MIS merge: every stock now carries real TWSE quotes when the
  // snapshot is fresh; otherwise we return honest STOCK_DAY_ALL close data.
  // closeOnly：AI 評分等分析用途需要「最近一個完整交易日」的穩定收盤資料——
  // 盤中若用即時快照，漲幅分秒在變、成交值只累積半天，五大因子會失真，
  // 造成推薦分數與盤前不一致。closeOnly 時跳過即時快照覆蓋。
  let snap = null as Awaited<ReturnType<typeof readMarketSnapshot>>;
  if (!closeOnly) { try { snap = await readMarketSnapshot(); } catch { /* none */ } }

  // 上櫃後備：TPEx openapi 自美國 IP 常間歇失敗，且 stale 快取是每個 serverless
  // 實例各自一份（冷啟動=沒有）——會造成「搜尋常常找不到上櫃股（如台燿）」。
  // 若 raw 的上櫃列 <100 檔，改用第二大腦快照（即使非即時，收盤價足供搜尋/導航）
  // 合成缺少的上櫃列，保證清單完整。
  if (mappedOtc.length < 100 && snap?.quotes) {
    const have = new Set(raw.map(it => it.Code));
    let added = 0;
    for (const q of Object.values(snap.quotes)) {
      // SnapQuote 型別無 market 欄，但 daemon 寫入的 JSON 帶有；缺欄時視為 otc
      //（此後備只在 TPEx 失敗時觸發，快照中不在 raw 的碼幾乎全是上櫃）。
      const mkt = (q as SnapQuote & { market?: string }).market ?? 'otc';
      if (mkt !== 'otc' || !(q.price > 0) || have.has(q.code)) continue;
      raw.push({
        _market: 'otc', Date: '', Code: q.code, Name: q.name || q.code,
        TradeVolume: String(q.volume ?? 0), TradeValue: '0',
        OpeningPrice: String(q.open ?? q.price), HighestPrice: String(q.high ?? q.price),
        LowestPrice: String(q.low ?? q.price), ClosingPrice: String(q.price),
        Change: String(q.change ?? 0), Transaction: '0',
      } as unknown as StockDayData);
      added++;
    }
    if (added > 0) console.warn(`[twse-api-server] TPEx 缺失，以第二大腦快照補上櫃 ${added} 檔（搜尋完整性後備）`);
  }

  // When the second brain snapshot is fresh, BUILD the whole market from it
  // (full ~1976 stocks with real TWSE quotes) rather than from the incomplete
  // raw source. Supplement 筆數 from raw where available.
  if (!closeOnly && isSnapshotFresh(snap)) {
    const rawByCode: Record<string, StockDayData> = {};
    for (const it of raw) rawByCode[it.Code] = it as StockDayData;
    const date = raw[0]?.Date ?? '';
    // Per-quote honesty: a stock is 即時 ONLY when the daemon got a live MIS
    // tick for it this cycle (q.live). Everything else is the latest TWSE close
    // and is labelled stock_day_all — never dressed up as realtime.
    const data: StockDayData[] = Object.values(snap!.quotes)
      .filter(q => q.price > 0)
      .map(q => {
        // 開高低：盤中用即時報價的當日極值；非即時(收盤後/未追蹤)改用 STOCK_DAY_ALL
        // 的真實當日 OHLC，別再回退成收盤價(會讓開=高=低=收，如漲停鎖死誤判)。
        const rq = rawByCode[q.code];
        const rawOpen = parseFloat(rq?.OpeningPrice ?? '') || 0;
        const rawHigh = parseFloat(rq?.HighestPrice ?? '') || 0;
        const rawLow  = parseFloat(rq?.LowestPrice ?? '') || 0;
        return {
        Date:         rq?.Date ?? date,
        Code:         q.code,
        Name:         q.name || rq?.Name || q.code,
        TradeVolume:  (q.volume ?? 0).toString(),
        TradeValue:   (q.value ?? 0).toString(),
        OpeningPrice: ((q.live && q.open ? q.open : rawOpen) || q.price).toString(),
        HighestPrice: ((q.live && q.high ? q.high : rawHigh) || q.price).toString(),
        LowestPrice:  ((q.live && q.low ? q.low : rawLow) || q.price).toString(),
        ClosingPrice: q.price.toString(),
        Change:       q.change.toString(),
        Transaction:  rawByCode[q.code]?.Transaction ?? '0',
        _source:      q.live ? 'mis_live' : 'stock_day_all',
        _changePercent: q.changePercent.toString(),
        _prevClose:   (q.price - q.change).toString(),
        _market:      (q as { market?: string }).market ?? undefined,
      };
      });
    if (data.length > 0) return data;
  }

  // Fallback: honest STOCK_DAY_ALL close data (no fake partial realtime).
  return raw.map(item => ({
    _market:      (item as { _market?: string })._market ?? 'tse',
    Date:         item.Date,
    Code:         item.Code,
    Name:         item.Name,
    TradeVolume:  item.TradeVolume,
    TradeValue:   item.TradeValue,
    OpeningPrice: item.OpeningPrice,
    HighestPrice: item.HighestPrice,
    LowestPrice:  item.LowestPrice,
    ClosingPrice: item.ClosingPrice,
    Change:       item.Change,
    Transaction:  item.Transaction,
    _source:      'stock_day_all',
  }));
}

async function fetchYahooSymbolServer(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d&includePrePost=true`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

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
    const change    = prev > 0 ? parseFloat((price - prev).toFixed(2)) : 0;
    const changePercent = prev > 0 ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0;

    let tradeTime = '';
    const ts = meta.regularMarketTime ?? 0;
    if (ts > 0) {
      const d  = new Date(ts * 1000);
      const tw = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      tradeTime = `${String(tw.getHours()).padStart(2,'0')}:${String(tw.getMinutes()).padStart(2,'0')}`;
    }

    return { price, change, changePercent, tradeTime };
  } catch {
    return null;
  }
}

// ── 合流快取 (2026-07-30) ─────────────────────────────────────────
// 原本此函式零快取，每次呼叫觸發 7 個外部請求（1 MIS + 6 Yahoo）。
// Header 每 5 秒輪詢，1000 人同時在線約等於每秒 1,631 次對外請求 → Yahoo 必封 IP。
// memoize 提供三件事：15 秒 TTL、in-flight 合流（N 個併發只打 1 次）、失敗負快取。
const _marketIndexMemo = memoize<MarketIndexData>('market-index', 15_000,
  () => getMarketIndexDataInternalUncached());

export async function getMarketIndexDataInternal(): Promise<MarketIndexData> {
  const v = await _marketIndexMemo();
  return v ?? ({ weighted: 0, weightedChange: 0, weightedChangePercent: 0 } as MarketIndexData);
}

/**
 * daemon（台灣 IP、直連 MIS）每分鐘寫入 `marketIndex/latest` —— 架構上的權威來源。
 *
 * 為什麼一定要比日期而不是比「有沒有值」（2026-07-31 事故）：
 * 直抓走的 `openapi MI_INDEX` **會落後一個交易日**，而且照樣回一個 >0 的數字。
 * 舊邏輯是「直抓失敗（weighted=0）才用備援」，於是永遠算成功、權威值永不採用。
 * 實例：7/31 晚間站上顯示 39,933.30(−0.26%)＝7/30 收盤，
 *      官方與 daemon 皆已是 43,119.75(+7.98%) —— 差一天、3,186 點。
 *
 * 兩邊都自報 tradeDate、取新的那個：盤中 daemon 較新；daemon 掛掉時
 * openapi 補上後自然勝出。這也回到 CLAUDE.md 的鐵律：一律走 daemon → Firestore。
 */
async function readDaemonIndex(): Promise<Partial<MarketIndexData> | null> {
  try {
    const { getAdminDb } = await import('./firebase-admin');
    const db = getAdminDb();
    if (!db) return null;
    const d = (await db.collection('marketIndex').doc('latest').get()).data();
    return d && d.weighted > 0 ? (d as Partial<MarketIndexData>) : null;
  } catch { return null; }
}

async function getMarketIndexDataInternalUncached(): Promise<MarketIndexData> {
  try {
    const [raw0, daemonIdx, nasdaq, dow, sp500, tsmcAdr, nasdaqFutures, msciTaiwan] = await Promise.all([
      getMarketIndexDataInternalRaw().catch(() => ({ weighted: 0, weightedChange: 0, weightedChangePercent: 0, source: 'failed' })),
      readDaemonIndex(),
      fetchYahooSymbolServer('^IXIC').catch(() => null),
      fetchYahooSymbolServer('^DJI').catch(() => null),
      fetchYahooSymbolServer('^GSPC').catch(() => null),
      fetchYahooSymbolServer('TSM').catch(() => null),
      fetchYahooSymbolServer('NQ=F').catch(() => null),
      fetchYahooSymbolServer('EWT').catch(() => null),
    ]);

    // 取 tradeDate 較新的那一份當作台股指數的真相
    const useDaemon = !!daemonIdx
      && (!(raw0.weighted > 0) || (daemonIdx.tradeDate || '') > ((raw0 as MarketIndexData).tradeDate || ''));
    const raw = useDaemon
      ? { ...raw0, ...daemonIdx, source: 'daemon_mis' } as MarketIndexData
      : raw0;

    const usMarket = {
      nasdaqPrice: nasdaq ? nasdaq.price : 0,
      nasdaqChange: nasdaq ? nasdaq.change : 0,
      nasdaqChangePercent: nasdaq ? nasdaq.changePercent : 0,
      dowPrice: dow ? dow.price : 0,
      dowChange: dow ? dow.change : 0,
      dowChangePercent: dow ? dow.changePercent : 0,
      sp500Price: sp500 ? sp500.price : 0,
      sp500Change: sp500 ? sp500.change : 0,
      sp500ChangePercent: sp500 ? sp500.changePercent : 0,
      tsmcAdrPrice: tsmcAdr ? tsmcAdr.price : 0,
      tsmcAdrChange: tsmcAdr ? tsmcAdr.change : 0,
      tsmcAdrChangePercent: tsmcAdr ? tsmcAdr.changePercent : 0,
      nasdaqFuturesPrice: nasdaqFutures ? nasdaqFutures.price : 0,
      nasdaqFuturesChange: nasdaqFutures ? nasdaqFutures.change : 0,
      nasdaqFuturesChangePercent: nasdaqFutures ? nasdaqFutures.changePercent : 0,
      msciTaiwanPrice: msciTaiwan ? msciTaiwan.price : 0,
      msciTaiwanChange: msciTaiwan ? msciTaiwan.change : 0,
      msciTaiwanChangePercent: msciTaiwan ? msciTaiwan.changePercent : 0,
    };

    // ⚠ 欄位名 `twNight` 是誤稱（保留以免破壞既有 API 契約）：
    //   來源是 EWT（iShares MSCI Taiwan ETF，美國掛牌·美元計價），
    //   **不是**台指期夜盤。含匯率與 ETF 溢價折價，只能當台股方向的粗略參考。
    //   前端標籤已於 2026-07-31 改為「台股ETF·美盤(EWT)」，別再標成「台股夜盤」。
    const twNight = msciTaiwan ? {
      price: msciTaiwan.price,
      change: msciTaiwan.change,
      changePercent: msciTaiwan.changePercent,
      tradeTime: msciTaiwan.tradeTime,
    } : undefined;

    return {
      ...raw,
      usMarket,
      twNight,
    };
  } catch (err) {
    console.error('[twse-api-server] Wrapper getMarketIndexDataInternal error:', err);
    return { weighted: 0, weightedChange: 0, weightedChangePercent: 0, source: 'failed' };
  }
}

async function getMarketIndexDataInternalRaw(): Promise<MarketIndexData> {
  // Strategy 1: MIS Realtime（同樣受 ALLOW_DIRECT_MIS 管制，理由見 callMIS 上方註解）
  try {
    if (!ALLOW_DIRECT_MIS) throw new Error('direct MIS disabled');
    const misRes = await fetch(
      'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)',
          'Accept': 'application/json',
          'Referer': 'https://mis.twse.com.tw/',
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000), // 無 timeout 時上游 hang 會佔住 worker 到 120 秒
      }
    );

    if (misRes.ok) {
      const misData = await misRes.json();
      const arr = misData?.msgArray;
      if (Array.isArray(arr) && arr.length > 0) {
        const idx = arr[0];
        const current  = parseFloat(idx.z ?? idx.l ?? '0');
        const prevClose = parseFloat(idx.y ?? '0');
        const high      = parseFloat(idx.h ?? '0');
        const low       = parseFloat(idx.l ?? '0');

        if (current > 0 && prevClose > 0) {
          const change        = parseFloat((current - prevClose).toFixed(2));
          const changePercent = parseFloat(((change / prevClose) * 100).toFixed(2));
          return {
            weighted: current,
            weightedChange: change,
            weightedChangePercent: changePercent,
            high,
            low,
            prevClose,
            source: 'mis_realtime',
            tradeTime: idx.t,
            tradeDate: idx.d,
          };
        }
      }
    }
  } catch (err) {
    console.warn('[twse-api-server] MIS Index failed, fallback to OpenAPI:', err);
  }

  // Strategy 2: MI_INDEX
  try {
    const indexRes = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000), // 無 timeout 時上游 hang 會佔住 worker 到 120 秒
    });

    if (indexRes.ok) {
      const data: Array<Record<string, string>> = await indexRes.json();
      const row = data.find(r =>
        r['指數'] === '發行量加權股價指數' ||
        r['Index'] === '發行量加權股價指數'
      );

      if (row) {
        // ⚠ 回音驗證（2026-07-31）：這支 openapi 會落後一個交易日 ——
        //   實測 7/31 21:00 仍回「日期: 1150730、收盤 39933.30」，
        //   而官方 rwd 端點與 daemon 都已有 7/31 的 43119.75(+7.98%)。
        //   原本的程式碼**完全沒讀 `日期` 欄位**，把昨天的指數當今天送出去。
        //   這與上櫃日期位移事件是同一類錯誤：任何「latest」都必須自報日期。
        const rocDate = row['日期'] || '';
        const feedYmd = /^\d{7}$/.test(rocDate) ? `${+rocDate.slice(0, 3) + 1911}${rocDate.slice(3)}` : '';
        const closingStr  = row['收盤指數'] || row['IndexOfTheDay'] || '';
        const changeSign  = row['漲跌'] || '+';
        const changeAbsStr = row['漲跌點數'] || row['Change'] || '0';
        const changePctStr = row['漲跌百分比'] || '0';

        const closing     = parseFloat(closingStr.replace(/,/g, '')) || 0;
        const changeAbs   = parseFloat(changeAbsStr.replace(/,/g, '')) || 0;
        const change      = changeSign === '-' ? -changeAbs : changeAbs;
        const changePct   = parseFloat(changePctStr.replace(/,/g, '')) || 0;
        const pct         = changeSign === '-' ? -Math.abs(changePct) : Math.abs(changePct);

        if (closing > 0) {
          return {
            weighted: closing,
            weightedChange: change,
            weightedChangePercent: pct,
            tradeDate: feedYmd,          // 讓呼叫端能比對新舊，不要盲信
            source: 'mi_index',
          };
        }
      }
    }
  } catch (err) {
    console.warn('[twse-api-server] MI_INDEX failed, fallback to STOCK_DAY_ALL:', err);
  }

  // Strategy 3: Derive from STOCK_DAY_ALL
  try {
    const fallbackRes = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000), // 無 timeout 時上游 hang 會佔住 worker 到 120 秒
    });

    if (fallbackRes.ok) {
      const stocks: Array<Record<string, string>> = await fallbackRes.json();
      const valid = stocks.filter(s => s.ClosingPrice && parseFloat(s.ClosingPrice) > 0);

      if (valid.length > 0) {
        const upCount   = valid.filter(s => parseFloat(s.Change || '0') > 0).length;
        const downCount = valid.filter(s => parseFloat(s.Change || '0') < 0).length;
        const totalChg  = valid.reduce((sum, s) => sum + parseFloat(s.Change || '0'), 0);

        return {
          weighted: 0,
          weightedChange: 0,
          weightedChangePercent: 0,
          upCount,
          downCount,
          totalStocks: valid.length,
          avgChange: parseFloat((totalChg / valid.length).toFixed(2)),
          source: 'stock_day_all_derived',
        };
      }
    }
  } catch (err) {
    console.error('[twse-api-server] Market index fallback error:', err);
  }

  return { weighted: 0, weightedChange: 0, weightedChangePercent: 0, source: 'failed' };
}

/**
 * 3. Fetch Market News & Curate schedule alerts
 */
export async function getMarketNewsDataInternal(): Promise<NewsData> {
  const news: NewsItem[] = [];

  try {
    const [announcementsRes] = await Promise.allSettled([
      fetch('https://openapi.twse.com.tw/v1/opendata/t187ap04_L', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' },
        cache: 'no-store',
      }),
    ]);

    if (announcementsRes.status === 'fulfilled' && announcementsRes.value.ok) {
      const data = await announcementsRes.value.json();
      if (Array.isArray(data)) {
        data.slice(0, 15).forEach((item: Record<string, string>, idx) => {
          const title = item['主旨 '] || item['主旨'] || item.SUBJECT || item.Subject || '公司重大訊息';
          const code = item['公司代號'] || item.CODE || item.Code || '';
          const name = item['公司名稱'] || item.NAME || item.Name || '';
          const date = item['發言日期'] || item.DATE || '';
          const timeVal = item['發言時間'] || item.TIME || '';

          news.push({
            id: `annd-${code}-${idx}`,
            title: title.trim(),
            source: '台灣證交所',
            category: 'announcement',
            stockCode: code,
            stockName: name,
            time: parseROCDateTime(date, timeVal),
            url: `https://mops.twse.com.tw/mops/web/t05st02_1`,
          });
        });
      }
    }
  } catch (e) {
    console.error('[twse-api-server] TWSE announcement fetch error:', e);
  }

  // Curate schedule alerts
  const now = new Date();
  const twTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const h = twTime.getHours();
  const m = twTime.getMinutes();

  const marketNews: NewsItem[] = [];

  if (h >= 8 && h < 9) {
    marketNews.push({
      id: 'pre-market',
      title: '🔔 盤前準備：台股開盤前最後1小時，請確認今日策略',
      source: '市場提醒',
      category: 'market',
      stockCode: '',
      stockName: '',
      time: new Date().toISOString(),
      url: '',
    });
  } else if (h === 9 && m < 5) {
    marketNews.push({
      id: 'open',
      title: '🟥 台股今日正式開盤！成交量與走勢請密切關注',
      source: '市場提醒',
      category: 'market',
      stockCode: '',
      stockName: '',
      time: new Date().toISOString(),
      url: '',
    });
  } else if (h === 13 && m >= 30) {
    marketNews.push({
      id: 'close',
      title: '📊 今日收盤！盤後資料陸續更新中，法人籌碼請待明日公布',
      source: '市場提醒',
      category: 'market',
      stockCode: '',
      stockName: '',
      time: new Date().toISOString(),
      url: '',
    });
  }

  const staticNews: NewsItem[] = [
    {
      id: 'twse-circuit',
      title: '📋 台股熔斷機制說明：單日漲跌幅限制為 ±10%，漲停/跌停保護投資人',
      source: '台灣證交所',
      category: 'education',
      stockCode: '',
      stockName: '',
      time: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      url: 'https://www.twse.com.tw',
    },
    {
      id: 'settlement',
      title: '💡 交割提醒：台股買賣採 T+2 交割制度，請確保交割帳戶有足夠餘額',
      source: '投資知識',
      category: 'education',
      stockCode: '',
      stockName: '',
      time: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      url: '',
    },
    {
      id: 'tax-info',
      title: '📝 證交稅提醒：賣出股票收取 0.3%，ETF 另有優惠稅率，請留意成本計算',
      source: '投資知識',
      category: 'education',
      stockCode: '',
      stockName: '',
      time: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      url: '',
    },
  ];

  const allNews = [...marketNews, ...news.slice(0, 10), ...staticNews];

  return {
    news: allNews,
    fetchedAt: new Date().toISOString(),
    count: allNews.length,
  };
}

/**
 * 4. Fetch MIS real-time quotes or fallback to STOCK_DAY_ALL
 */
export async function getMisQuoteDataInternal(codes: string[]): Promise<MisQuoteResponse> {
  const marketOpen = isMarketOpen();

  // ── Snapshot-first (the only realtime path on Cloud Run) ──
  // The deployed server's US IP is blocked by TWSE MIS, so callMIS below always
  // fails there. The resident daemon (TW IP, safe rate) is the sole MIS client;
  // it writes live ticks into marketSnapshot. Serve from it and label honestly:
  // a code is 即時 only when its snapshot quote carries a live tick (q.live).
  try {
    const snap = await readMarketSnapshot();
    if (isSnapshotFresh(snap)) {
      // 5 秒快線覆蓋已統一在 readMarketSnapshot() 內完成（liveAt 較新者勝）。
      const hit: MisQuote[] = [];
      for (const code of codes) {
        const q = snap!.quotes[code];
        if (!q || !(q.price > 0)) continue;
        const live = !!q.live;
        hit.push({
          code, name: q.name, price: q.price,
          open: (live ? q.open : 0) || q.price,
          high: (live ? q.high : 0) || q.price,
          low:  (live ? q.low : 0) || q.price,
          prevClose: q.price - q.change,
          change: q.change, changePercent: q.changePercent,
          volume: q.volume,
          tradeTime: live && q.liveAt ? new Date(q.liveAt).toISOString() : '',
          source: live ? 'mis_realtime' : 'stock_day_all',
        });
      }
      // Use the snapshot only if it covers every requested code — otherwise fall
      // through so single off-priority codes can still try direct MIS / close.
      if (hit.length === codes.length) {
        const anyLive = hit.some(q => q.source === 'mis_realtime');
        return { quotes: hit, isRealtime: anyLive, marketOpen, source: anyLive ? 'mis_realtime' : 'stock_day_all' };
      }
    }
  } catch { /* snapshot unavailable — fall through to direct MIS / close */ }

  try {
    // Check cache or default to tse
    const tseCodes = codes.filter(c => (marketCache.get(c) ?? 'tse') === 'tse');
    const otcCodes = codes.filter(c => marketCache.get(c) === 'otc');

    let misTse: Record<string, any> = {};
    let misOtc: Record<string, any> = {};

    if (tseCodes.length > 0) {
      misTse = await callMIS(tseCodes.map(c => `tse_${c}.tw`).join('|'));
    }
    if (otcCodes.length > 0) {
      misOtc = await callMIS(otcCodes.map(c => `otc_${c}.tw`).join('|'));
    }

    const merged = { ...misTse, ...misOtc };

    // Find codes not returned (might be classified incorrectly in cache)
    const missing = codes.filter(c => !merged[c]);

    if (missing.length > 0) {
      const tseMissing = missing.filter(c => (marketCache.get(c) ?? 'tse') === 'tse');
      const otcMissing = missing.filter(c => marketCache.get(c) === 'otc');

      let retryOtc: Record<string, any> = {};
      let retryTse: Record<string, any> = {};

      if (tseMissing.length > 0) {
        retryOtc = await callMIS(tseMissing.map(c => `otc_${c}.tw`).join('|'));
        Object.keys(retryOtc).forEach(code => {
          marketCache.set(code, 'otc');
          merged[code] = retryOtc[code];
        });
      }
      if (otcMissing.length > 0) {
        retryTse = await callMIS(otcMissing.map(c => `tse_${c}.tw`).join('|'));
        Object.keys(retryTse).forEach(code => {
          marketCache.set(code, 'tse');
          merged[code] = retryTse[code];
        });
      }
    }

    // Convert merged results to MisQuote format
    const quotes: MisQuote[] = [];
    for (const code of codes) {
      const q = merged[code];
      if (q) {
        const source: MisQuote['source'] = marketOpen ? 'mis_realtime' : 'mis_close';
        quotes.push({
          code,
          name: q.name,
          price: q.price,
          open: q.open,
          high: q.high,
          low: q.low,
          prevClose: q.prevClose,
          change: q.change,
          changePercent: q.changePercent,
          volume: q.volume,
          tradeTime: q.tradeTime,
          source,
        });
      }
    }

    if (quotes.length > 0) {
      return {
        quotes,
        isRealtime: marketOpen,
        marketOpen,
        source: marketOpen ? 'mis_realtime' : 'mis_close',
      };
    }
  } catch (e) {
    console.warn('[twse-api-server] MIS quote fetching failed, falling back to STOCK_DAY_ALL:', e);
  }

  // Fallback: Fetch stock day all and filter by requested codes
  try {
    const allStocks = await getStockDayAllDataInternal();
    const codeSet = new Set(codes);
    const quotes: MisQuote[] = allStocks
      .filter(s => codeSet.has(s.Code))
      .map(s => {
        const price  = parseFloat(s.ClosingPrice  ?? '0');
        const open   = parseFloat(s.OpeningPrice  ?? '0');
        const high   = parseFloat(s.HighestPrice  ?? '0');
        const low    = parseFloat(s.LowestPrice   ?? '0');
        const change = parseFloat(s.Change        ?? '0');
        const prev   = price > 0 && change !== 0 ? price - change : price;
        const pct    = prev > 0 ? parseFloat((change / prev * 100).toFixed(2)) : 0;
        return {
          code:          s.Code,
          name:          s.Name,
          price, open, high, low,
          prevClose:     prev,
          change,
          changePercent: pct,
          volume:        parseInt(s.TradeVolume?.replace(/,/g, '') ?? '0', 10),
          tradeTime:     '',
          dataDate:      s.Date,
          source:        'stock_day_all' as const,
        };
      });

    return {
      quotes,
      isRealtime: false,
      marketOpen,
      source: 'stock_day_all',
    };
  } catch (e) {
    console.error('[twse-api-server] All quote sources failed:', e);
    throw e;
  }
}

// ============================================================
// 5. Institutional Trading Data (三大法人買賣超)
// ============================================================

export interface InstitutionalStock {
  code: string;
  name: string;
  foreignNetShares: number;     // 外陸資買賣超(股) — positive = buy, negative = sell
  trustNetShares: number;       // 投信買賣超(股)
  dealerNetShares: number;      // 自營商買賣超(股)
  totalNetShares: number;       // 三大法人合計買賣超(股)
  foreignNetLots: number;       // 外資(張)
  trustNetLots: number;         // 投信(張)
  dealerNetLots: number;        // 自營商(張)
  totalNetLots: number;         // 三大法人(張)
  // Merged live quote data
  price?: number;
  change?: number;
  changePercent?: number;
  volume?: number;
  tradeTime?: string;
}

export interface InstitutionalTradingResponse {
  foreignBuy: InstitutionalStock[];   // 外資買超 TOP 20
  foreignSell: InstitutionalStock[];  // 外資賣超 TOP 20
  instBuy: InstitutionalStock[];      // 三大法人買超 TOP 20
  instSell: InstitutionalStock[];     // 三大法人賣超 TOP 20
  dataDate: string;                   // 資料日期
  source: string;
}

function parseIntClean(s: string): number {
  return parseInt(s.replace(/,/g, '').trim(), 10) || 0;
}

export async function getInstitutionalTradingDataInternal(): Promise<InstitutionalTradingResponse> {
  const allStocks: InstitutionalStock[] = [];

  // Determine the date to query — try today first, fallback to yesterday
  const now = new Date();
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const today = fmt(tw);
  // Walk back to the most recent trading day strictly before today —
  // correctly skips weekends AND national holidays (e.g. the trading day
  // before a Monday that follows a long holiday is not simply "Friday").
  const prevTradingDay = new Date(tw.getTime());
  do {
    prevTradingDay.setDate(prevTradingDay.getDate() - 1);
  } while (!isTradingDay(prevTradingDay));
  const fallbackDate = fmt(prevTradingDay);

  let dataDate = today;

  // 1. Fetch TWSE T86 (上市股三大法人個股買賣超)
  try {
    const [resToday, resFallback] = await Promise.allSettled([
      fetch(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${today}&selectType=ALL`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000), // 無 timeout 時上游 hang 會佔住 worker 到 120 秒
      }).then(r => r.ok ? r.json() : null),
      fetch(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${fallbackDate}&selectType=ALL`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000), // 無 timeout 時上游 hang 會佔住 worker 到 120 秒
      }).then(r => r.ok ? r.json() : null),
    ]);

    // 回音驗證（2026-07-31）：原本直接把「請求的日期」當成 dataDate ——
    // 那是**假設**上游照做了。T86 會 echo `date`，實測可靠；假日或無效日期時
    // 回的是別天的資料，不比對就會把別天的法人買賣超標成今天。
    // 一律以來源自報的 `date` 為準，對不上就不採用。
    const pickT86 = (res: PromiseSettledResult<any>, want: string) => {
      if (res.status !== 'fulfilled') return null;
      const v = res.value;
      if (v?.stat !== 'OK' || !(v?.data?.length > 0)) return null;
      const echoed = String(v?.date ?? '');
      if (echoed && echoed !== want) {
        console.warn(`[twse-api-server] T86 回音 ${echoed} ≠ 期望 ${want}，不採用`);
        return null;
      }
      return { data: v, date: echoed || want };
    };
    let tseData: any = null;
    const t86Pick = pickT86(resToday, today) ?? pickT86(resFallback, fallbackDate);
    if (t86Pick) { tseData = t86Pick.data; dataDate = t86Pick.date; }

    if (tseData?.data) {
      for (const row of tseData.data) {
        const code = (row[0] ?? '').trim();
        const name = (row[1] ?? '').trim();
        if (!code || !/^\d{4,6}[A-Z]?$/.test(code)) continue;

        const foreignNet = parseIntClean(row[4]);    // 外陸資買賣超(不含外資自營商)
        const foreignDealerNet = parseIntClean(row[7]); // 外資自營商買賣超
        const trustNet = parseIntClean(row[10]);     // 投信買賣超
        const dealerNet = parseIntClean(row[11]);    // 自營商買賣超(合計)
        const totalNet = parseIntClean(row[18]);     // 三大法人合計

        // Combine foreign + foreign dealer
        const totalForeignNet = foreignNet + foreignDealerNet;

        allStocks.push({
          code, name,
          foreignNetShares: totalForeignNet,
          trustNetShares: trustNet,
          dealerNetShares: dealerNet,
          totalNetShares: totalNet,
          foreignNetLots: Math.round(totalForeignNet / 1000),
          trustNetLots: Math.round(trustNet / 1000),
          dealerNetLots: Math.round(dealerNet / 1000),
          totalNetLots: Math.round(totalNet / 1000),
        });
      }
    }
  } catch (e) {
    console.warn('[twse-api-server] T86 fetch error:', e);
  }

  // 2. Fetch TPEx (上櫃股三大法人買賣超)
  try {
    const otcRes = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000), // 無 timeout 時上游 hang 會佔住 worker 到 120 秒
    });
    if (otcRes.ok) {
      const otcData: Array<Record<string, string>> = await otcRes.json();
      for (const item of otcData) {
        const code = item.SecuritiesCompanyCode ?? '';
        const name = item.CompanyName ?? '';
        if (!code || !/^\d{4,6}[A-Z]?$/.test(code)) continue;

        // Foreign investors (including mainland)
        const foreignBuyKey = Object.keys(item).find(k => k.includes('ForeignInvestorsIncludeMainlandAreaInvestors-TotalBuy'))
          ?? Object.keys(item).find(k => k.includes('ForeignInvestorsInclude') && k.includes('TotalBuy'))
          ?? '';
        const foreignSellKey = Object.keys(item).find(k => k.includes('ForeignInvestorsIncludeMainlandAreaInvestors-TotalSell'))
          ?? Object.keys(item).find(k => k.includes('ForeignInvestorsInclude') && k.includes('TotalSell'))
          ?? '';
        const foreignNetKey = Object.keys(item).find(k => k.includes('ForeignInvestorsInclude') && k.includes('Difference'))
          ?? '';
        
        const foreignNet = foreignNetKey ? parseIntClean(item[foreignNetKey]) : 0;
        const trustNet = parseIntClean(item['SecuritiesInvestmentTrustCompanies-Difference'] ?? '0');
        const dealerNet = parseIntClean(item['Dealers-Difference'] ?? '0');
        const totalNet = parseIntClean(item['TotalDifference'] ?? '0');

        allStocks.push({
          code, name,
          foreignNetShares: foreignNet,
          trustNetShares: trustNet,
          dealerNetShares: dealerNet,
          totalNetShares: totalNet,
          foreignNetLots: Math.round(foreignNet / 1000),
          trustNetLots: Math.round(trustNet / 1000),
          dealerNetLots: Math.round(dealerNet / 1000),
          totalNetLots: Math.round(totalNet / 1000),
        });
      }
    }
  } catch (e) {
    console.warn('[twse-api-server] TPEx institutional fetch error:', e);
  }

  // 3. Merge live MIS quotes for the top stocks
  // Collect the codes of top institutional stocks
  const topBuyCodes = [...allStocks].sort((a, b) => b.totalNetShares - a.totalNetShares).slice(0, 30).map(s => s.code);
  const topSellCodes = [...allStocks].sort((a, b) => a.totalNetShares - b.totalNetShares).slice(0, 30).map(s => s.code);
  const topForeignBuyCodes = [...allStocks].sort((a, b) => b.foreignNetShares - a.foreignNetShares).slice(0, 30).map(s => s.code);
  const topForeignSellCodes = [...allStocks].sort((a, b) => a.foreignNetShares - b.foreignNetShares).slice(0, 30).map(s => s.code);
  const uniqueMisCodes = [...new Set([...topBuyCodes, ...topSellCodes, ...topForeignBuyCodes, ...topForeignSellCodes])];

  // Batch MIS calls
  if (uniqueMisCodes.length > 0) {
    try {
      const tseMisCodes = uniqueMisCodes.filter(c => (marketCache.get(c) ?? 'tse') === 'tse');
      const otcMisCodes = uniqueMisCodes.filter(c => marketCache.get(c) === 'otc');

      const misCalls: Promise<Record<string, any>>[] = [];
      // Split into batches of 50
      for (let i = 0; i < tseMisCodes.length; i += 50) {
        const batch = tseMisCodes.slice(i, i + 50);
        misCalls.push(callMIS(batch.map(c => `tse_${c}.tw`).join('|')));
      }
      for (let i = 0; i < otcMisCodes.length; i += 50) {
        const batch = otcMisCodes.slice(i, i + 50);
        misCalls.push(callMIS(batch.map(c => `otc_${c}.tw`).join('|')));
      }

      const misResults = await Promise.all(misCalls);
      const misMap: Record<string, any> = {};
      for (const r of misResults) Object.assign(misMap, r);

      // Retry missing codes with opposite market
      const missing = uniqueMisCodes.filter(c => !misMap[c]);
      if (missing.length > 0) {
        const retryTse = missing.filter(c => marketCache.get(c) === 'otc');
        const retryOtc = missing.filter(c => (marketCache.get(c) ?? 'tse') === 'tse');
        const retryCalls: Promise<Record<string, any>>[] = [];
        if (retryOtc.length > 0) retryCalls.push(callMIS(retryOtc.map(c => `otc_${c}.tw`).join('|')));
        if (retryTse.length > 0) retryCalls.push(callMIS(retryTse.map(c => `tse_${c}.tw`).join('|')));
        const retryResults = await Promise.all(retryCalls);
        for (const r of retryResults) {
          for (const [code, data] of Object.entries(r)) {
            misMap[code] = data;
            // Update cache
            if (retryOtc.includes(code)) marketCache.set(code, 'otc');
            if (retryTse.includes(code)) marketCache.set(code, 'tse');
          }
        }
      }

      // Merge MIS data into institutional stocks
      for (const stock of allStocks) {
        const mis = misMap[stock.code];
        if (mis) {
          stock.price = mis.price;
          stock.change = mis.change;
          stock.changePercent = mis.changePercent;
          stock.volume = mis.volume;
          stock.tradeTime = mis.tradeTime;
        }
      }
    } catch (e) {
      console.warn('[twse-api-server] MIS merge for institutional failed:', e);
    }
  }

  // 4. Sort and split into categories
  // Filter out non-standard stock codes (keep 4-digit codes only for cleaner display)
  const standardStocks = allStocks.filter(s => /^\d{4}$/.test(s.code));

  const foreignBuy = [...standardStocks]
    .filter(s => s.foreignNetShares > 0)
    .sort((a, b) => b.foreignNetShares - a.foreignNetShares)
    .slice(0, 20);

  const foreignSell = [...standardStocks]
    .filter(s => s.foreignNetShares < 0)
    .sort((a, b) => a.foreignNetShares - b.foreignNetShares)
    .slice(0, 20);

  const instBuy = [...standardStocks]
    .filter(s => s.totalNetShares > 0)
    .sort((a, b) => b.totalNetShares - a.totalNetShares)
    .slice(0, 20);

  const instSell = [...standardStocks]
    .filter(s => s.totalNetShares < 0)
    .sort((a, b) => a.totalNetShares - b.totalNetShares)
    .slice(0, 20);

  console.log(`[institutional] date=${dataDate} total=${allStocks.length} standard=${standardStocks.length} foreignBuy=${foreignBuy.length} foreignSell=${foreignSell.length} instBuy=${instBuy.length} instSell=${instSell.length}`);

  return {
    foreignBuy,
    foreignSell,
    instBuy,
    instSell,
    dataDate,
    source: 'twse_t86_tpex',
  };
}
