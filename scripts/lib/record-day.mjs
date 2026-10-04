// ─────────────────────────────────────────────────────────────────────────────
// 記錄日（資料日）口徑（WM-SCAN G2-32／G2-33·2026-10-04）
//
//   硬規定（使用者 2026-10-04）：在非交易日進行的修改資料或新建資料，都以「最後一個交易日」
//   為使用或記錄時間——不用日曆日。舊寫法 `isoDate(taipei())` 在週末／休市日開機時會寫出
//   sectorSpot/{週六}、dataGapEvents/latest.dataDate＝週六，稽核報 DATE_DRIFT。
//   交易日當天（含開盤前）＝當天本身，與舊行為相同。
//   全程 UTC 整數日運算（與 daemon nextTradingDay／prevTradingIsos 同一套），與機器時區脫鉤。
// ─────────────────────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
/** 最多往回找幾個日曆日（春節最長連假約 9–10 天，留餘裕） */
export const MAX_LOOKBACK_DAYS = 20;

const isoOfUtc = (ms) => {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

/**
 * 含當日往回的最後一個交易日（週一～五且不在休市表）。
 * @param {string} todayIso YYYY-MM-DD（台北日曆日）
 * @param {{ has(iso: string): boolean }} holidays 休市日集合（daemon TW_HOLIDAYS）
 * @returns {string} 找不到（不合理輸入或回溯超過上限）時回 todayIso——寧可沿用舊口徑，也不丟例外中斷寫入
 */
export function recordDayOf(todayIso, holidays) {
  if (!ISO_DAY.test(todayIso ?? '')) return todayIso;
  const [y, m, d] = todayIso.split('-').map(Number);
  let ms = Date.UTC(y, m - 1, d);
  for (let i = 0; i < MAX_LOOKBACK_DAYS; i++, ms -= DAY_MS) {
    const iso = isoOfUtc(ms);
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays?.has?.(iso)) return iso;
  }
  return todayIso;
}
