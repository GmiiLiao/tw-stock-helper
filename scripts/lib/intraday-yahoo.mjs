// /api/twse/stock-intraday 的 Yahoo 後備：以代號為鍵的 memoize（critique M2·2026-10-05）。
//
// 舊版一般路徑每次回源都直接打兩次 Yahoo（.TW／.TWO 各一），沒有 memoize；CDN 只快取 2 秒（hot 層），
// 同一檔被 N 個人看、或被多個 CDN 節點回源，Yahoo 請求就隨人數與節點數放大。
// 這裡只做「同一個上游、同一組請求」的收斂，不改資料來源、不新增網域：
//   · TTL 30 秒（Yahoo 1 分 K 本身約落後 20 分鐘，盤中最新尾段仍由 daemon 分時接上，主幹晚 30 秒不影響圖）
//   · in-flight 合流（同實例同代號併發只打一組）
//   · 負快取 30 秒（兩個市場都取不到＝Yahoo 無此檔或故障，冷卻期內不重打）
//   · 降級上限 60 秒（Yahoo 暫時失敗時最多沿用 1 分鐘內的上一份主幹；更舊就照舊版行為只用 daemon 分時）
// 本檔是純邏輯：Yahoo 的實際請求（網域、標頭、逾時）留在 route.ts，由 fetchChart 注入；memoize 也由呼叫端注入
// （route 傳 @/lib/singleflight 的 memoize），測試因此不需要連網。

/** 合法代號：4 碼數字＋最多 2 碼英數（上市櫃股票、00 開頭 ETF、權證 6 碼、特別股 2881A、槓反 00631L）。
 *  同時是 memoize 鍵的白名單——使用者可控的鍵不能讓快取表無限長大。 */
export const INTRADAY_CODE_RE = /^\d{4}[0-9A-Za-z]{0,2}$/;

export const YAHOO_TRUNK_TTL_MS = 30_000;
export const YAHOO_TRUNK_NEGATIVE_TTL_MS = 30_000;
export const YAHOO_TRUNK_MAX_STALE_MS = 60_000;

const TAIPEI_OFFSET_SEC = 8 * 3600;   // 台灣自 1979 年起無日光節約時間
const pad2 = n => String(n).padStart(2, '0');

/** memoize 鍵 */
export const yahooTrunkKey = code => `stock-intraday:yahoo:${code}`;

/** epoch 秒 → 台北 HH:mm（與 route 舊版 toLocaleString 寫法同結果，但不依賴主機時區） */
export function taipeiHHmm(tsSec) {
  const d = new Date((tsSec + TAIPEI_OFFSET_SEC) * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * Yahoo v8 chart 的 result → { prevClose, ticks }（route 舊版內嵌邏輯原樣搬出）
 *   · close 為 null／undefined 的分鐘略過；volume 缺值記 0
 *   · prevClose：meta.chartPreviousClose → meta.previousClose → 第一筆 close → 0
 * 回傳物件與陣列皆凍結（快取共用，呼叫端只能產生新陣列，不能改它）。
 */
export function parseYahooChart(result) {
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const closes = quote.close ?? [];
  const volumes = quote.volume ?? [];
  const ticks = [];
  timestamps.forEach((ts, idx) => {
    const close = closes[idx];
    if (close === null || close === undefined) return;
    ticks.push(Object.freeze({ time: ts, timeStr: taipeiHHmm(ts), close, volume: volumes[idx] ?? 0 }));
  });
  const meta = result?.meta ?? {};
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? (ticks[0]?.close ?? 0);
  return Object.freeze({ prevClose, ticks: Object.freeze(ticks) });
}

/** 兩個市場並行各試一次（上市 .TW 優先、上櫃 .TWO 次之）；都取不到回 null */
export async function fetchYahooTrunk(code, fetchChart) {
  const [tw, two] = await Promise.all([fetchChart(`${code}.TW`), fetchChart(`${code}.TWO`)]);
  const result = tw || two;
  return result ? parseYahooChart(result) : null;
}

/**
 * 建立「代號 → Yahoo 主幹」讀取器。
 * @param deps.memoize   @/lib/singleflight 的 memoize（key, ttlMs, fetcher, opts）=> () => Promise<T|null>
 * @param deps.fetchChart (symbol) => Promise<Yahoo chart result | null>（失敗回 null，不丟錯）
 * 回傳 (code) => Promise<{ prevClose, ticks } | null>；代號不合法直接回 null、不打上游。
 */
export function createYahooTrunkReader({
  memoize,
  fetchChart,
  ttlMs = YAHOO_TRUNK_TTL_MS,
  negativeTtlMs = YAHOO_TRUNK_NEGATIVE_TTL_MS,
  maxStaleMs = YAHOO_TRUNK_MAX_STALE_MS,
}) {
  const opts = { negativeTtlMs, maxStaleMs, isDegraded: v => v == null };
  return code => {
    if (typeof code !== 'string' || !INTRADAY_CODE_RE.test(code)) return Promise.resolve(null);
    return memoize(yahooTrunkKey(code), ttlMs, () => fetchYahooTrunk(code, fetchChart), opts)();
  };
}
