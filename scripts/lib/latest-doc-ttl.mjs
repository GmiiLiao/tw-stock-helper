// latestDoc（src/lib/api-cache.ts）的行程內記憶體快取時間，依 api-cache 的 Tier 分層（critique H6·2026-10-05）。
//
// 為什麼要分層：舊版除了 daily／static（300 秒）以外一律 60 秒，tick 層的 market-pulse、limit-queue
// CDN 只快取 3 秒，記憶體卻壓 60 秒——寬度與漲跌停最壞會晚約 150 秒（30 秒節流＋主迴圈＋60 秒＋CDN）。
// 規則：記憶體 TTL 不得長於該層 CDN s-maxage（兩層疊加的最壞延遲 ≤ 2×s-maxage）；盤中層取 s-maxage 的一半上下。
//   hot   s-maxage=2   → 2 秒（目前沒有 latestDoc 呼叫端）
//   tick  s-maxage=3   → 2 秒（market-pulse、limit-queue）
//   quote s-maxage=10  → 5 秒（index-intraday）
//   intraday／daily／static／private 維持原值（60／300／300／60 秒）
// Firestore 讀取量仍是常數：memoize 的 in-flight 合流＋TTL 讓每個實例每份文件每 TTL 最多讀 1 次，與線上人數無關
// （tick 層一個實例最多每分鐘 30 次；實際受 CDN s-maxage 擋，回源才會讀）。測試見 latest-doc-ttl.test.mjs。

/** 各 Tier 的記憶體 TTL（毫秒）。鍵必須涵蓋 api-cache.ts 的 Tier 全部成員（api-cache 以型別檢查保證）。 */
export const LATEST_DOC_TTL_MS = Object.freeze({
  hot: 2_000,
  tick: 2_000,
  quote: 5_000,
  intraday: 60_000,
  daily: 300_000,
  static: 300_000,
  private: 60_000,
});
