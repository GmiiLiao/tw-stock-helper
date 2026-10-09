// ─────────────────────────────────────────────────────────────────────────────
// 台股（上市／上櫃）漲跌停價——唯一實作（2026-10-03 起草、2026-10-09 使用者裁定統一成交易所口徑）
//
// 交易所規則：參考價 ×1.1（×0.9），不足一升降單位者漲停向下捨去、跌停向上進位，
//   **升降單位取「漲跌停價本身」所在級距**，不是前收的級距。
// 舊 luLimitPrice／backtest-limitup（口徑 v1）用前收的級距，於前收 9.09–10、45.45–50、90.9–100、454.5–500、909–1000 時算高一檔以上
//   （前收 457 → 交易所 502，舊式 502.5；前收 918 → 1005，舊式 1009）。v1 的漲停價恆 ≥ v2，所以改口徑只會「多判漲停」。
//   唯讀實測 2022-07-18～2026-10-02：舊式漏 1,439 次漲停（全部收盤＝最高＝本式漲停價）；
//   兩式不同的 87,694 檔日中，收盤或最高落在舊式漲停價的次數為 0。
// ETF（受益憑證）走另一套升降單位：未滿 50 元 0.01、50 元以上 0.05（CLAUDE.md「拿買賣價中點當現價卻不驗檔位」）。
// 不適用（呼叫端自行處理）：興櫃（無漲跌停）、除權息日（基準是參考價不是前收）、新股前五日與無漲跌幅 ETF
//   （官方以 9995／9999.95 佔位表示，見 isNoLimitPlaceholder）。
// 已是正確口徑、維持各自實作的地方：scripts/lib/daytrade-signals.mjs、scripts/lib/ai-stoploss-base.mjs（roundTick）、
//   scripts/lib/daily-heatmap/compute.mjs、src/lib/twse-api.ts、src/components/StockDetail/QuoteGrid.tsx——
//   本檔測試以整數 oracle 全價位掃描並與上述各實作逐檔比對（tw-limit-price.test.mjs）。
// ─────────────────────────────────────────────────────────────────────────────

/** 口徑版本：1＝以前收的檔位捨去（舊），2＝以漲跌停價本身的檔位（交易所規則） */
export const TW_LIMIT_RULE_VERSION = 2;

/** 普通股升降單位 */
export const stockTick = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);

/** ETF（受益憑證）升降單位 */
export const etfTick = p => (p < 50 ? 0.01 : 0.05);

/** 該價位的升降單位 */
export const tickOf = (p, isEtf = false) => (isEtf ? etfTick(p) : stockTick(p));

/** 漲停價：參考價 ×1.1 向下捨去至「該價位所在級距」的升降單位；參考價無效回 NaN */
export function limitUpPrice(prevClose, isEtf = false) {
  if (!(prevClose > 0)) return NaN;
  const raw = prevClose * 1.1, t = tickOf(raw, isEtf);
  return +(Math.floor(raw / t + 1e-9) * t).toFixed(2);
}

/** 跌停價：參考價 ×0.9 向上進位至「該價位所在級距」的升降單位；參考價無效回 NaN */
export function limitDownPrice(prevClose, isEtf = false) {
  if (!(prevClose > 0)) return NaN;
  const raw = prevClose * 0.9, t = tickOf(raw, isEtf);
  return +(Math.ceil(raw / t - 1e-9) * t).toFixed(2);
}

/** 收盤（或任一成交價）是否在漲停價 */
export const isLimitUpAt = (price, prevClose, isEtf = false) =>
  prevClose > 0 && price > 0 && price >= limitUpPrice(prevClose, isEtf) - 1e-9;

/** 舊口徑 v1（以前收的檔位、無浮點容差）——只供重現舊結果與對照，新程式不得使用 */
export function legacyLimitUpPriceV1(prevClose) {
  if (!(prevClose > 0)) return NaN;
  const t = stockTick(prevClose);
  return +(Math.floor(prevClose * 1.1 / t) * t).toFixed(2);
}

/** 依口徑版本判漲停（回測 --rule 用）：1＝舊式、其餘＝交易所口徑 */
export const isLimitUpByRule = (rule, price, prevClose, isEtf = false) => (rule === 1
  ? prevClose > 0 && price > 0 && price >= legacyLimitUpPriceV1(prevClose) - 1e-9
  : isLimitUpAt(price, prevClose, isEtf));

// ── 官方漲停價的「無漲跌幅」佔位 ──────────────────────────────────────────────
// TWT84U／TPEx 對當日無漲跌幅限制者（新上市首五日、無漲跌幅 ETF 等）以漲停 9995（個股）或 9999.95（ETF）、跌停 0.01 佔位。
// 9995 本身也是 ≥1000 元級距的合法價（前收 9,090 的真漲停價就是 9995），所以有跌停欄時一定要一起看：
//   跌停 0.01 才是佔位；只有漲停欄時才單憑 9995／9999.95 判定（研究端 build.official_limit_masks 同此慣例）。
export const NO_LIMIT_UP_PLACEHOLDERS = Object.freeze([9995, 9999.95]);
const _near = (a, b) => Math.abs(a - b) < 1e-6;

/** 官方漲停價（與可得的跌停價）是否為「當日無漲跌幅」佔位 */
export function isNoLimitPlaceholder(officialUp, officialDown) {
  if (!NO_LIMIT_UP_PLACEHOLDERS.some(v => _near(+officialUp, v))) return false;
  return officialDown == null || _near(+officialDown, 0.01);
}

/**
 * 有官方漲停價就以官方為準、佔位＝無漲跌幅（回 null）、沒有官方值才由參考價推算。
 * 回傳 null＝當日沒有漲停價（任何價格都不算漲停）；NaN＝資料不足。
 */
export function effectiveLimitUp({ prevClose, isEtf = false, officialUp = null, officialDown = null }) {
  if (officialUp != null && +officialUp > 0) return isNoLimitPlaceholder(officialUp, officialDown) ? null : +officialUp;
  return limitUpPrice(prevClose, isEtf);
}
