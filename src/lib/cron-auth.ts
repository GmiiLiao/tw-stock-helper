// ============================================================
// Cron / server-to-server 共享密鑰驗證（timing-safe）
//
// 為什麼不用 `a === b`：字串比較會在第一個不同的位元組就回傳，
// 回應時間隨「猜對幾個字元」單調變化。攻擊者可以一個字元一個字元地
// 把密鑰量出來（remote timing attack 對 HTTP 是可行的，只是需要多次取樣）。
// `timingSafeEqual` 的執行時間與內容無關。
//
// 先 SHA-256 再比較，是為了讓兩邊長度一律 32 bytes ——
// `timingSafeEqual` 在長度不同時會直接 throw，那本身就洩漏了長度資訊。
// ============================================================

import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** 兩個字串是否相等，且比較時間不隨內容變化。 */
export function secretEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * 驗證 `x-cron-secret` header。
 *
 * fail-closed：production 沒設 CRON_SECRET 就一律拒絕。
 * （原本 `if (!secret) return true` 是 fail-open —— 忘記設環境變數
 *   等於把 120 秒的批次端點開放給全世界。）
 * 只收 header，不收 query string —— query 會進 access log、Referer 與瀏覽器歷史。
 */
export function hasCronSecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production'; // 本機開發放行
  return secretEquals(req.headers.get('x-cron-secret'), secret);
}
