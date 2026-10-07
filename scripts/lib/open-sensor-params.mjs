// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1（影子）：凍結參數、basis、時間與交易日小工具（純函式；不打網路、不讀時鐘、不碰 Firestore）
//   規格：scratchpad warroom/opensensor/design-v2.1.md（2026-10-07 凍結；使用者 10/05 S1–S8、10/07「如建議進行」O1–O8）。
//   改任何門檻、估計式、狀態集合或時點都要升 basis（§1），並在 openSensor/{date}.basis 反映。
//   〔先驗〕的數字只是事前設定、未校準；本模組只描述盤勢事實與判讀規則，非投資建議。
// ─────────────────────────────────────────────────────────────────────────

export const BASIS = 'openSensor-v2.1';
export const MODE = 'shadow';
/** 影子期標章（§0-1；前端固定顯示） */
export const SHADOW_BADGE = '影子·只記錄·先驗未校準';
export const SUB_BASIS = Object.freeze({
  struct: 'struct-v2.1',
  vol: 'volRatio-v1',
  rho: 'rhoRatio-v1',
  h: 'H-SEG60-v1',
  eOpen: 'effOpen0902-v2.1',
  pattern: 'pattern3-v2.1',
  ring: 'openSensorIndexRing-v1',
  universe: 'openSensorUniverse-v1',
  marks: 'openSensorMarks-v1',
});

/** 檢查點鍵（HHMM）：首判 09:02（備援 09:03、09:04）＋每 10 分鐘複判到 10:00（§5.1） */
export const FIRST_KEYS = Object.freeze(['0902', '0903', '0904']);
export const RECHECK_KEYS = Object.freeze(['0910', '0920', '0930', '0940', '0950', '1000']);
export const ALL_KEYS = Object.freeze([...FIRST_KEYS, ...RECHECK_KEYS]);
export const PATTERN_KEYS = Object.freeze(['0920', '0930']);

/** 凍結參數（§13）；單位寫在名字或註解 */
export const P = Object.freeze({
  flatPct: 0.15,          // 個股 ±0.15% 內算平（§3.2）
  wFlat: 0.5,             // |W| < 0.50% ⇒ 權值平（O4）
  restConfirm: 15,        // 其餘 29 檔至少 15 檔同向（O6）
  gUp: 0.2, bUp: 0.6, bDown: 0.4,   // 一般股方向 G ±0.20%、B 0.60／0.40〔先驗〕
  sDom: 1.0, kappa: 0.67, // 主導群：|S| ≥ 1.00、κ＝0.67〔先驗；樣本內 7/29、7/31、7/28〕
  okRet: 10.5,            // 個股漲跌幅絕對值 > 10.5% 視為髒值（漲跌停 10% 加檔位誤差）
  bufMs: 120_000,         // 擷取緩衝 [T−120 秒, T]
  pxWins: Object.freeze([30, 60, 120]),   // 價格樣本對齊窗（秒），依序放寬（§4.2）
  gvW30: 20, gvVolFrac: 0.25,             // GV：含 2330、W30 ≥ 20 檔、Σv ≥ 0.25×Q×1000 股〔先驗〕
  rho0: 0.53, rhoLiveMin: 5, rhoWin: 20,  // ρ 先驗與 live 切換（§4.1）
  cBaseDays: 20, cBaseMin: 5,             // c(T) 基準窗與最少有效日數（§4.5）
  g1W30: 27, g1CapPct: 95, g2Frac: 0.6, g3LagMs: 45_000, g10Days: 20,   // 資料閘門（§5.6）
  distortPp: 0.30, eMovePp: 0.10, eFinalCapPct: 0.5, gapDayPct: 1.0,     // 有效開盤（§5.5）、大跳空日（§4.3）
  oStarCovPct: 95,                        // O*（個股開盤合成）只在 B_0902 上市市值覆蓋 ≥ 95% 時合成；不足 ⇒ O*／失真寫 null（2026-10-07 審查；比照 G1 的 95%）
  liquidMinLots: 300,                     // 流動宇宙：昨量 ≥ 300 張
  recheckWinMs: 4 * 60_000,               // 每個檢查點的判讀窗 [T, T＋4 分]
  ringGapMs: 90_000,                      // t00 環內插：前後兩拍相距超過 90 秒視為缺段（不內插）
});

/** 門檻 H 區段表（H-SEG60-v1，O3；億元；左閉右開） */
export const H_SEGS = Object.freeze([
  Object.freeze({ lo: null, hi: 7250, H: 7650 }),
  Object.freeze({ lo: 7250, hi: 8250, H: 8000 }),
  Object.freeze({ lo: 8250, hi: 9250, H: 8500 }),
  Object.freeze({ lo: 9250, hi: 10250, H: 9000 }),
  Object.freeze({ lo: 10250, hi: null, H: 9350 }),
]);

// ── 時間（台北固定 +08:00，無日光節約） ───────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' + 'HH:MM:SS' → epoch ms（台北） */
export const tpeMs = (iso, hms) => Date.parse(`${iso}T${hms}+08:00`);
/** '0902' → '09:02:00' */
export const keyHms = key => `${key.slice(0, 2)}:${key.slice(2)}:00`;
/** epoch ms → 台北 'YYYY-MM-DD' */
export const tpeIsoOf = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
/** epoch ms → 台北 'HH:MM:SS' */
export const tpeHmsOf = ms => new Date(ms + 8 * 3600e3).toISOString().slice(11, 19);
/** 檢查點在當日的 epoch ms */
export const keyMs = (iso, key) => tpeMs(iso, keyHms(key));

// ── 交易日（週末＋休市日曆；holidays＝Set<'YYYY-MM-DD'>） ─────────────
export const addDaysIso = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function isTradingIso(iso, holidays) {
  const w = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return w >= 1 && w <= 5 && !holidays?.has?.(iso);
}
/** iso 之前（不含）最近的交易日；找不到回 null */
export function prevTradingIso(iso, holidays) {
  for (let d = addDaysIso(iso, -1), g = 0; g < 40; d = addDaysIso(d, -1), g++) if (isTradingIso(d, holidays)) return d;
  return null;
}
/** iso 之後（不含）最近的交易日 */
export function nextTradingIso(iso, holidays) {
  for (let d = addDaysIso(iso, 1), g = 0; g < 40; d = addDaysIso(d, 1), g++) if (isTradingIso(d, holidays)) return d;
  return null;
}
/** iso 之前（不含）的 n 個交易日，由舊到新 */
export function tradingDaysBefore(iso, n, holidays) {
  const out = [];
  for (let d = addDaysIso(iso, -1), g = 0; out.length < n && g < n * 3 + 40; d = addDaysIso(d, -1), g++) if (isTradingIso(d, holidays)) out.push(d);
  return out.reverse();
}
/** (from, to] 之間的交易日數（from 之後、to 含）；from ≥ to 回 0 */
export function tradingDaysBetween(from, to, holidays) {
  if (!from || !to || from >= to) return 0;
  let n = 0;
  for (let d = addDaysIso(from, 1), g = 0; d <= to && g < 800; d = addDaysIso(d, 1), g++) if (isTradingIso(d, holidays)) n++;
  return n;
}

// ── 統計 ─────────────────────────────────────────────────────────────
export function median(arr) {
  const s = arr.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** 線性內插分位數（q∈[0,1]） */
export function quantile(arr, q) {
  const s = arr.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = q * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
/** 四捨五入到 d 位；非有限數回 null */
export const rnd = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(d) : null);
/** 個股漲跌%（p 對參考價 y）；任一缺 ⇒ null */
export const retPct = (p, y) => (p > 0 && y > 0 ? (p / y - 1) * 100 : null);
export { pad2 };
