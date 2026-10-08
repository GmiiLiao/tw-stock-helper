// ─────────────────────────────────────────────────────────────────────────────
// 新聞判別對答案（daemon computeNewsVerdictReview）：盤中前視列的切分——唯一實作
//
// 依據：jev-score-usage-spec 附錄 B X16、S1 卡；反證 S8；使用者 2026-10-08「其它錯誤依建議修正」。
// 問題：summary 的主口徑「前一交易日收盤→適用日開盤」要求判讀在**開盤前**就存在；但適用日文件裡混有盤中趟（pass=intraday）
//   的判讀——那是開盤後才產生的（還會覆蓋同一檔的盤前判讀），拿它去對「昨收→今開」等於先看到開盤再判方向。
//   2026-10-08 備份量化：27 日 5,229 列中 876 列（16.8%）是盤中趟；利多盤中趟跳空上漲 68.1%，高於盤後 55.6%、晨間 62.1%。
// 做法（新舊板分開，歷史數字不覆蓋）：
//   · 舊板（boardVersion all）照舊口徑算，另加註 lookahead＝這批列裡有多少是開盤後產生的（比例照實寫）；
//   · 新板（boardVersion preOpen）只收適用日台北 09:00 前產出的判讀（判讀時間 at；當日盤中趟按構造一律算開盤後，
//     承接自前一交易日的盤中列依 at 判；沒有時間的不收）。
// 純函式；單元測試 news-verdict-preopen.test.mjs。
// ─────────────────────────────────────────────────────────────────────────────

/** 兩板的版本章（記分板依此分開，不串成同一條線） */
export const REVIEW_BOARD_VERSIONS = Object.freeze({
  all: 'nvr-v1-all-passes',            // 舊板：全部趟次（含盤中前視列）
  preOpen: 'nvr-v2-preopen-0900',      // 新板：只收適用日 09:00 前產出
});

/** 適用日台北 09:00 的 epoch ms（台北 UTC+8，無日光節約）；格式不對回 null */
export function preOpenCutMs(targetDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(targetDate || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 1, 0, 0) : null;
}

/**
 * 一筆判讀相對適用日開盤的時點：'pre'（09:00 前產出）／'post'（開盤後；未承接的盤中趟一律）／'unknown'（沒有判讀時間）
 *   承接列（carriedFrom，daemon 從前一交易日整份承接時保留原 pass 與 at）：前一日盤中趟的列仍帶 pass='intraday'，
 *   但它產生於前一交易日盤中、早於適用日開盤 ⇒ 不可按 pass 一律算前視，改依 at 判（審查 2026-10-08；沒有 at 仍算 unknown）。
 * @param {{ pass?: string, at?: number, carriedFrom?: string }|null} v
 */
export function verdictTiming(v, targetDate) {
  if (!v || typeof v !== 'object') return 'unknown';
  if (v.pass === 'intraday' && !v.carriedFrom) return 'post';
  const cut = preOpenCutMs(targetDate);
  if (cut == null || !Number.isFinite(v.at)) return 'unknown';
  return v.at < cut ? 'pre' : 'post';
}

/** 舊板加註：列數、開盤前／後、無時間、開盤後（前視）比例 % */
export function lookaheadSummary(timings) {
  const n = timings.length;
  const c = k => timings.filter(t => t === k).length;
  const post = c('post');
  return { rows: n, preOpen: c('pre'), postOpen: post, unknownTime: c('unknown'), pct: n ? Math.round(post / n * 1000) / 10 : null };
}
