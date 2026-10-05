// 盤中戰情 v2 聚合路由的伺服器端 Firestore 讀取器（server only）。
//
// 只讀 Firestore（daemon 已寫好的文件），**絕不打任何上游**（MIS／TWSE／TPEx／Yahoo）——
// 這個檔案與 build-* 都不得 import twse-api-server、twse-api、risk-stocks-source 這類含上游網域的模組
// （scripts/audit-routes.mjs 會把整支路由判成「打上游」）。
//
// 每個路徑一份 memoize（@/lib/singleflight）：TTL 依層級、in-flight 合流（同實例 N 個併發只讀 1 次）、
// 失敗負快取 30 秒＋有舊值時降級供應（degraded=true）。
// TTL 為何比 latestDoc 短：latestDoc 對所有非 daily 層一律 60 秒記憶體快取（critique H6），
// 寬度與漲跌停最壞會晚約 150 秒；聚合路由改依層級（tick≈2 秒、quote≈5 秒）。
import { getAdminDb } from '@/lib/firebase-admin';
import { memoizeWithMeta } from '@/lib/singleflight';
import { primeHolidays } from '@/lib/api-cache';
import { readMarketSnapshot, type MarketSnapshot } from '@/lib/market-snapshot-store';

/** 記憶體 TTL 層級：tick（5 秒級文件，如 marketIndex、daytradeAlerts）／quote（30–90 秒級，如 marketPulse、雷達）／
 *  slow（3–25 分級，如族群風向、新聞判別）／daily（一天寫幾次） */
export type ReadTier = 'tick' | 'quote' | 'slow' | 'daily';

export const READ_TTL_MS: Readonly<Record<ReadTier, number>> = {
  tick: 2_000,
  quote: 5_000,
  slow: 20_000,
  daily: 300_000,
};

export type DocData = Record<string, unknown>;

/** ok:true 且 data:null ＝文件不存在（daemon 尚未寫入，正常狀態）；ok:false ＝讀取故障（且無可降級的舊值） */
export type DocRead<T = DocData> =
  | { ok: true; data: T | null; ageMs: number; degraded: boolean }
  | { ok: false; error: string };

export interface WarReader {
  /** 本次請求的「現在」（epoch ms）。build-* 一律用它判時段，不要自己 Date.now()（方便測試、同一回應口徑一致） */
  readonly now: number;
  /** 讀 collection/docId（預設 'latest'）。tier 預設 'quote'。 */
  doc<T = DocData>(collection: string, docId?: string, tier?: ReadTier): Promise<DocRead<T>>;
  /** 全市場快照 marketSnapshot/latest（已疊 5 秒快線 hot；沿用 market-snapshot-store 的 3 秒實例快取）。約 2,100 檔、解析後物件大，只在需要時呼叫。 */
  snapshot(): Promise<DocRead<MarketSnapshot>>;
}

const PATH_RE = /^[A-Za-z0-9_-]{1,80}$/;

async function readDoc<T = DocData>(collection: string, docId = 'latest', tier: ReadTier = 'quote'): Promise<DocRead<T>> {
  if (!PATH_RE.test(collection) || !PATH_RE.test(docId)) return { ok: false, error: '路徑不合法' };
  const ttl = READ_TTL_MS[tier];
  // 包一層 { data } 是刻意的（同 latestDoc）：memoize 失敗時回 null，要與「文件不存在」分得開
  const run = memoizeWithMeta<{ data: DocData | null }>(
    `warroom:${collection}/${docId}:${tier}`,
    ttl,
    async () => {
      const db = getAdminDb();
      if (!db) throw new Error('admin db unavailable');
      const snap = await db.collection(collection).doc(docId).get();
      return { data: snap.exists ? (snap.data() ?? null) : null };
    },
    { maxStaleMs: tier === 'daily' ? 12 * 3_600_000 : undefined },
  );
  const r = await run();
  if (!r) return { ok: false, error: '讀取失敗' };
  return { ok: true, data: r.value.data as T | null, ageMs: r.ageMs, degraded: r.degraded };
}

async function readSnapshot(): Promise<DocRead<MarketSnapshot>> {
  const s = await readMarketSnapshot();
  if (!s) return { ok: false, error: '快照讀取失敗' };
  return { ok: true, data: s, ageMs: 0, degraded: false };
}

/** 每個請求開一個 reader（順便填好伺服器端休市日曆，讓 cacheHeader 與 isTradingDay 認得國定假日） */
export async function openWarReader(now: number = Date.now()): Promise<WarReader> {
  await primeHolidays().catch(() => null);   // fail-open：載不到就只擋週末
  return {
    now,
    doc: <T = DocData>(collection: string, docId?: string, tier?: ReadTier) => readDoc<T>(collection, docId, tier),
    snapshot: readSnapshot,
  };
}
