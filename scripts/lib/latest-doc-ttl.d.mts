// 型別橋接：讓 src/lib/api-cache.ts 能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export type LatestDocTier = 'hot' | 'tick' | 'quote' | 'intraday' | 'daily' | 'static' | 'private';

/** latestDoc 行程內記憶體快取 TTL（毫秒），依 api-cache 的 Tier 分層 */
export declare const LATEST_DOC_TTL_MS: Readonly<Record<LatestDocTier, number>>;
