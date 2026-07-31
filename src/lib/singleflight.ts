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
}

export function memoize<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts: MemoizeOptions = {},
): () => Promise<T | null> {
  const { negativeTtlMs = NEGATIVE_TTL_MS, isDegraded, timeoutMs = 8_000 } = opts;

  return async (): Promise<T | null> => {
    const now = Date.now();

    const hit = store.get(key) as Entry<T> | undefined;
    if (hit && now - hit.at < ttlMs) return hit.value;

    const negUntil = negative.get(key);
    if (negUntil && now < negUntil) {
      // 冷卻期內有舊值就給舊值（stale-if-error），沒有就給 null。
      // 關鍵是不打上游 —— 上游正在壞的時候，重打只會讓它更壞。
      return hit ? hit.value : null;
    }

    const existing = inflight.get(key) as Promise<T | null> | undefined;
    if (existing) return existing;

    const task = (async (): Promise<T | null> => {
      try {
        const value = await withTimeout(fetcher(), timeoutMs, key);
        if (isDegraded?.(value)) {
          negative.set(key, Date.now() + negativeTtlMs);
          return hit ? hit.value : null;
        }
        evictIfNeeded();
        store.set(key, { value, at: Date.now() });
        negative.delete(key);
        return value;
      } catch (err) {
        negative.set(key, Date.now() + negativeTtlMs);
        console.warn(`[singleflight] ${key} failed, cooling down ${negativeTtlMs}ms:`, String(err));
        return hit ? hit.value : null;   // 有舊值就降級供應，不要回空白
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, task);
    return task;
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
