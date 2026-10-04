/**
 * 請求合流 + TTL 記憶體快取 + 負快取
 *
 * 導入原因（2026-07-30 架構檢視）：本專案原本對此零實作
 * （grep inflight / Map<string,Promise> / coalesce 全部 0 筆），造成三個放大效應：
 *
 *  1. cache stampede —— 快取檢查到寫回之間的空窗內，所有併發 request
 *     各自發起一整組上游 fetch。加長 TTL 救不了：TTL 到期的瞬間
 *     依然是 N 個併發同時 miss。
 *
 *  2. 失敗放大 —— 只有成功才更新快取時間戳，上游一掛就變成
 *     「每個 request 都立刻重打」，故障時流量不降反升。
 *
 *  3. 冷啟動裸奔 —— 記憶體快取是 per-instance，實例一換就全部 miss。
 *
 * 用法（取代手寫的 `let cached; let cachedAt;` 模式）：
 *
 *   const getFoo = memoize('foo', 600_000, async () => { ... });
 *   const data = await getFoo();
 */

type Entry<T> = { value: T; at: number };

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const negative = new Map<string, number>();

/** 上游失敗後的冷卻期。這是「失敗放大」的解藥：失敗也要被快取。 */
const NEGATIVE_TTL_MS = 30_000;
/** 防止使用者可控的 key 讓 Map 無上限成長（會 OOM 掉 1GiB 實例） */
const MAX_KEYS = 2_000;

export interface MemoizeOptions {
  negativeTtlMs?: number;
  /** 判斷回傳值是否為降級/空內容，是的話走負快取而非正快取 */
  isDegraded?: (v: unknown) => boolean;
  /** fetcher 硬逾時，避免上游 hang 住佔用 worker 直到 function timeout */
  timeoutMs?: number;
  /**
   * 降級時（上游失敗／isDegraded／冷卻期內）最多肯回多舊的舊值（自寫入起算）。
   * 超過就回 null，讓呼叫端走「資料不可用」路徑，而不是把幾小時前的值當成現值供應
   * （WM-SCAN G2-09／F4，2026-10-04）。預設 max(ttl×10, 10 分鐘)。Infinity＝不設上限（舊行為）。
   */
  maxStaleMs?: number;
}

/** memoizeWithMeta 的回傳：讓呼叫端分得出「新鮮值」與「降級供應的舊值」。 */
export interface MemoResult<T> {
  value: T;
  /** true＝本次上游失敗或被判降級，回的是上一份好值（stale-if-error） */
  degraded: boolean;
  /** 這份值自寫入快取起的年齡（ms） */
  ageMs: number;
}

const MIN_DEFAULT_MAX_STALE_MS = 10 * 60_000;
const staleWarnAt = new Map<string, number>();
const defaultMaxStale = (ttlMs: number) => Math.max(ttlMs * 10, MIN_DEFAULT_MAX_STALE_MS);

/**
 * 同 memoize，但回傳附帶降級標記與年齡（G2-09：降級值要可被呼叫端辨識）。
 * 不想改既有呼叫端時用 memoize（簽章不變，只拿 value）。
 */
export function memoizeWithMeta<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts: MemoizeOptions = {},
): () => Promise<MemoResult<T> | null> {
  const { negativeTtlMs = NEGATIVE_TTL_MS, isDegraded, timeoutMs = 8_000 } = opts;
  const maxStaleMs = opts.maxStaleMs ?? defaultMaxStale(ttlMs);

  // 降級供應：有舊值且未超過年齡上限才給，否則 null
  const staleOrNull = (hit: Entry<T> | undefined): MemoResult<T> | null => {
    if (!hit) return null;
    const ageMs = Date.now() - hit.at;
    if (ageMs > maxStaleMs) {
      if (Date.now() - (staleWarnAt.get(key) ?? 0) > 60_000) { staleWarnAt.set(key, Date.now()); console.warn(`[singleflight] ${key} 舊值已 ${Math.round(ageMs / 1000)}s，超過降級上限 ${Math.round(maxStaleMs / 1000)}s，不再供應`); }   // 每 key 每分鐘最多一則
      return null;
    }
    return { value: hit.value, degraded: true, ageMs };
  };

  return async (): Promise<MemoResult<T> | null> => {
    const now = Date.now();

    const hit = store.get(key) as Entry<T> | undefined;
    if (hit && now - hit.at < ttlMs) return { value: hit.value, degraded: false, ageMs: now - hit.at };

    const negUntil = negative.get(key);
    if (negUntil && now < negUntil) {
      // 冷卻期內有舊值就給舊值（stale-if-error），沒有就給 null。
      // 關鍵是不打上游 —— 上游正在壞的時候，重打只會讓它更壞。
      return staleOrNull(hit);
    }

    const existing = inflight.get(key) as Promise<MemoResult<T> | null> | undefined;
    if (existing) return existing;

    const task = (async (): Promise<MemoResult<T> | null> => {
      try {
        const value = await withTimeout(fetcher(), timeoutMs, key);
        if (isDegraded?.(value)) {
          negative.set(key, Date.now() + negativeTtlMs);
          return staleOrNull(hit);
        }
        evictIfNeeded();
        store.set(key, { value, at: Date.now() });
        negative.delete(key);
        return { value, degraded: false, ageMs: 0 };
      } catch (err) {
        negative.set(key, Date.now() + negativeTtlMs);
        console.warn(`[singleflight] ${key} failed, cooling down ${negativeTtlMs}ms:`, String(err));
        return staleOrNull(hit);   // 有（夠新的）舊值就降級供應，不要回空白
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, task);
    return task;
  };
}

export function memoize<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts: MemoizeOptions = {},
): () => Promise<T | null> {
  const run = memoizeWithMeta(key, ttlMs, fetcher, opts);
  return async (): Promise<T | null> => {
    const r = await run();
    return r ? r.value : null;
  };
}

function evictIfNeeded() {
  if (store.size <= MAX_KEYS) return;
  const overflow = store.size - MAX_KEYS;
  let i = 0;
  for (const k of store.keys()) {
    store.delete(k);
    negative.delete(k);
    if (++i >= overflow) break;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** 診斷用，可掛在健康度端點上觀察合流是否生效 */
export function singleflightStats() {
  const now = Date.now();
  return {
    cached: store.size,
    inflight: inflight.size,
    cooling: [...negative.values()].filter((until) => now < until).length,
  };
}
