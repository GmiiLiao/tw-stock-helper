import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson, gzipJsonAuto } from '@/lib/gzip-response';
import { memoize } from '@/lib/singleflight';
import { getSession, setHolidays, isTradingDay } from '@/lib/market-clock';

/**
 * API 回應快取層級表 + daemon latest-doc 共用 helper
 *
 * 解兩個一起發生的問題：
 *
 * A) 14 支 route 的成功分支回 `no-store`，但它們讀的是 daemon **每天只寫 1–3 次**
 *    的 Firestore doc（`runDailyJobs` 於 15:10 / 16:30 官方補跑 / 21:45 融資補跑）。
 *    `no-store` 讓 CDN 完全幫不上忙，每個使用者的每次載入都是一次 document read。
 *
 * B) 47 個檔案在複製同一份 12 行樣板。程式碼重複本身不是重點，重點是
 *    **快取策略無法統一治理** —— 要調整就得改 47 個檔案，所以實務上永遠不會被調整。
 *
 * 層級表的節奏是照台股標定的：上游 5 秒才更新一次，
 * `tick` 的 s-maxage=3 就足以把回源率壓到六成以下，而使用者最多落後一個 tick。
 */

export type Tier =
  | 'hot'       // 盤中被每 5 秒輪詢的大 payload（stock-day-all 646KB、stock-intraday）
  | 'tick'      // 5 秒級即時報價
  | 'quote'     // 準即時（分時、五檔）
  | 'intraday'  // 盤中週期性、或 daemon 日頻產出
  | 'daily'     // 一天只變一次且沒人盯新鮮度的（月營收、除息日曆）
  | 'static'    // 幾乎不變
  | 'private';  // 使用者專屬，不可共享快取

const TIERS: Record<Tier, string> = {
  // hot：s-maxage=2 是使用者指定的保守值（2026-08-12，原提案 5 秒）。
  // 不設 max-age——輪詢端自己就是 5 秒一次，瀏覽器快取只會疊加落後。
  hot:      'public, s-maxage=2,    stale-while-revalidate=20,   stale-if-error=60',
  tick:     'public, max-age=2,    s-maxage=3,     stale-while-revalidate=5,    stale-if-error=60',
  quote:    'public, max-age=5,    s-maxage=10,    stale-while-revalidate=15,   stale-if-error=120',
  intraday: 'public, max-age=60,   s-maxage=120,   stale-while-revalidate=120,  stale-if-error=900',
  daily:    'public, max-age=300,  s-maxage=3600,  stale-while-revalidate=1800, stale-if-error=86400',
  static:   'public, max-age=600,  s-maxage=14400, stale-while-revalidate=3600, stale-if-error=86400',
  private:  'private, max-age=5,   stale-while-revalidate=30',
};

/** 收盤後即時類資料不會再變 —— TTL 拉到隔天開盤，回源率歸零 */
const CLOSED_OVERRIDE =
  'public, max-age=300, s-maxage=1800, stale-while-revalidate=600, stale-if-error=86400';

// 開盤交界投毒防護（2026-08-17 實案）：交易日早上 08:58 被快取的「休市版」回應
// 帶 s-maxage=1800，開盤後一路活到 09:28——左上加權指數整整 28 分鐘顯示上週五收盤。
// 規則：交易日 08:00 以後即使 session 仍是 'closed'（getSession 08:30 前回 closed），
// 也不得再發長 TTL——08:00 前快取的長 TTL 條目（1800+swr600）最晚 08:40 到期，碰不到 09:00。
function longTtlSafe(): boolean {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  if (!isTradingDay(now)) return true;
  return now.getHours() < 8;
}

export function cacheHeader(tier: Tier): string {
  // hot/tick/quote 收盤即凍結。注意 getSession 在 14:00–14:31 回 'post-close'
  // （官方結算價逐步落地的窗），不觸發長 TTL —— 結算修正不會被釘住 30 分鐘。
  if ((tier === 'hot' || tier === 'tick' || tier === 'quote') && getSession() === 'closed' && longTtlSafe()) return CLOSED_OVERRIDE;
  return TIERS[tier];
}

/** 錯誤／降級回應：一律不可快取，否則會把一次故障釘在 CDN 上 */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * 取代那 47 份複製貼上的樣板。
 *
 * 舊寫法（每支 route 各一份）：
 *   const snap = await db.collection('scanner').doc('latest').get();
 *   return NextResponse.json(snap.exists ? snap.data() : null,
 *     { headers: { 'Cache-Control': 'no-store' } });
 *
 * 新寫法：
 *   export const GET = (req: Request) => latestDoc('scanner', 'intraday', { request: req });
 *
 * 多做的三件事：
 *   1. 正確的 Cache-Control（CDN 收斂掉九成以上的回源）
 *   2. 行程內 memoize + in-flight 合流（CDN miss 時同一實例不重複讀 Firestore）
 *   3. 失敗負快取（Firestore 抖動時不會被重打放大）
 *
 * 帶 `request` 會啟用 gzip（沿用既有的 `gzipJson`，大 payload 約省 75%）。
 */
/**
 * server 端的休市日曆 primer。
 *
 * `market-clock` 的 holidays 表是模組級變數，client 由 page.tsx 打 /api/market-clock 填上；
 * **server 端沒有人填** —— 於是 `getSession()` 在國定假日會回 'regular'，
 * `cacheHeader` 的 CLOSED_OVERRIDE 就不會生效，假日整天用短 TTL 白白回源。
 * （不是正確性問題，是白花錢；但既然日曆已經有了就該接上。）
 *
 * 每個 instance 只讀一次 Firestore，之後每 6 小時刷新，成本可忽略。
 */
export const primeHolidays = memoize<string[]>('trading-calendar', 6 * 3600_000, async () => {
  const db = getAdminDb();
  if (!db) throw new Error('no db');
  const d = (await db.collection('system').doc('tradingCalendar').get()).data();
  const list: string[] = Array.isArray(d?.holidays) ? d!.holidays : [];
  if (list.length) setHolidays(list);
  return list;
});

/**
 * 讀取故障（Firestore／Admin SDK 不可用、讀取丟錯且無舊值可降級）的統一回應（2026-09-28 WM-SCAN G1-05／G2-08）。
 * 舊版回 200 null，與「daemon 尚未寫入」分不出、也沒有 log。改為 **503＋no-store＋X-Data-Status: unavailable**，
 * body 仍是 null——前端 `r.ok ? r.json() : null` 與直接 `r.json()` 兩種寫法拿到的都還是 null，不會因為換 body 形狀而壞掉。
 * 「文件不存在」仍是 200 null（正常狀態，可快取），只有故障走這裡。
 */
export function unavailable(where: string, err?: unknown): Response {
  console.error(`[unavailable] ${where}`, err instanceof Error ? err.message : err ?? '');
  return NextResponse.json(null, { status: 503, headers: { ...NO_STORE, 'X-Data-Status': 'unavailable' } });
}

export async function latestDoc(
  collection: string,
  tier: Tier = 'intraday',
  opts: { docId?: string; request?: Request; strip?: string[] } = {},
): Promise<Response> {
  await primeHolidays().catch(() => null);   // fail-open：載不到就維持只擋週末
  const docId = opts.docId ?? 'latest';

  // 記憶體 TTL 取 CDN s-maxage 的一半，讓兩層錯開、避免同時到期造成回源尖峰
  const ttlMs = tier === 'daily' || tier === 'static' ? 300_000 : 60_000;

  // 包一層 { ok, data } 是刻意的：memoize 內部會吞掉錯誤並回 null，
  // 直接用 null 當回傳值的話，「Firestore 掛掉」和「doc 還沒被 daemon 寫入」
  // 會長得一模一樣 —— 前者絕不能帶著 s-maxage 送出去（等於把一次故障釘在 CDN 上兩分鐘），
  // 後者則是正常狀態、應該快取。
  const read = memoize<{ ok: true; data: unknown }>(
    `latest:${collection}:${docId}`,
    ttlMs,
    async () => {
      const db = getAdminDb();
      if (!db) throw new Error('admin db unavailable');
      const snap = await db.collection(collection).doc(docId).get();
      let data = snap.exists ? (snap.data() ?? null) : null;
      // strip：daemon 內部欄位（如量能存檔 volJson）不對外——剝除在 memoize 內做，
      // 快取的就是乾淨版本，之後每次命中零成本。
      if (data && opts.strip?.length) {
        data = Object.fromEntries(Object.entries(data).filter(([k]) => !opts.strip!.includes(k)));
      }
      return { ok: true, data };
    },
    // 降級上限依資料節奏（審查 M2）：daily／static 文件一天才寫一次，閒置實例遇單次讀取失敗仍應回舊文件；
    // 盤中層維持預設（TTL×10，至少 10 分鐘）——舊盤中值太久不如誠實 503。
    { maxStaleMs: tier === 'daily' || tier === 'static' ? 12 * 3600_000 : undefined },
  );

  const result = await read();

  // null = 讀失敗且沒有可供降級的舊值。有舊值時 memoize 會回舊值（stale-serve），
  // 那種情況仍走正常快取路徑，這是我們要的行為。
  if (!result) return unavailable(`latestDoc ${collection}/${docId}`);

  const header = cacheHeader(tier);
  if (opts.request) return gzipJson(opts.request, result.data, header);
  return gzipJsonAuto(result.data, header);   // 2026-09-18：不帶 request 的 12 支也要壓（原本原樣送出）
}
