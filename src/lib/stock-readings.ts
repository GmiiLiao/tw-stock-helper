// ============================================================
// 個股判讀（寫死值改真實判讀）——純函式、零 import
//
// 2026-10-08 使用者裁定：「不使用原來的寫死值，使用判讀結果真實表示」「依判讀方向給出正確提示」
// 「給值也給正確的文字提示」。規格：hardcoded-to-real-spec（定稿）§1、F1–F14。
//
// ⚠ 本檔**不得有任何 import**、只用可剝除的型別語法（無 enum／namespace／參數屬性）：
//   scripts/lib/stock-readings.test.mjs 以 Node 25 內建型別剝除直接載入；用戶端（個股頁）也 import 這支，
//   所以不能碰 server 依賴。需要檔位表的函式（漲跌停判定、明日漲跌停價）一律由呼叫端注入檔位函式
//   （股票用 twse-api 的 tickSize、ETF 用本檔的 etfTickSize），本檔不另抄股票檔位表。
// ⚠ 命名：新鍵一律 …Ymd（YYYY-MM-DD 字串）／…Ms（epoch ms），只有已登記的 dataDate 例外
//   （check-field-conventions 會掃 …Date: 與 …At:）。
// ⚠ 公開頁文字規則：不得出現「你核可」、內部模型代號、Firestore 集合名、「看好」。
// 非投資建議。
// ============================================================

// ─── 型別 ────────────────────────────────────────────────────

export type ReadingState = 'up' | 'down' | 'neutral' | 'mixed' | 'none' | 'research'
  | 'outside' | 'disposition' | 'thin' | 'unavailable';
export type ReadingKey = 'instFlow' | 'model20' | 'dist20' | 'horizonShort' | 'horizonMid' | 'horizonLong'
  | 'newsDir' | 'hitHigh' | 'hitLow' | 'openRange' | 'nextDayDir' | 'closePos';
export type ReadingPalette = 'market' | 'rate';

export interface Reading {
  key: ReadingKey;
  state: ReadingState;
  label: string;           // 欄名（可隨狀態切換）
  value: string | null;    // 主值文字；無值狀態為 null，畫面改顯示 stateText
  stateText: string;       // 方向字或狀態字
  hint: string;            // 這個值是什麼＋為何是這個方向（第二行起可有明細，以 \n 分行）
  basis: string | null;    // 依據：來源／n／期間／資料日
  dataDate: string | null; // YYYY-MM-DD
  stale: boolean;
  palette: ReadingPalette;
  caveat: string | null;   // 必附揭露
}

export type QuotePhase = 'intraday' | 'close' | 'quote';
export type LimitKind = 'up' | 'down' | null;

// ─── 事前寫死的常數（2026-10-08，不得看結果再調）────────────────

export const INST_UP_P = 80;
export const INST_DOWN_P = 20;
export const INST_MIN_N = 1500;
/** 收盤位置分段：≥85 貼近日高｜70–84 偏高｜50–69 中段偏高｜30–49 中段偏低｜<30 日線下半段（與五因子稽核分組一致） */
export const CLOSE_POS_EDGES: readonly number[] = [0.85, 0.70, 0.50, 0.30];
/** 今日走勢分段（%）：大漲／上漲／小漲 的門檻；下跌側對稱。F9、F12、F26 共用 */
export const TODAY_MOVE_EDGES: readonly number[] = [5, 2, 0.5];
export const GAP_EDGE_PCT = 1;
export const MIN_RANGE_PCT = 1.5;
/** 進場前參考停損（tw-ai-stoploss §2：不改算法）：昨收 × 0.95；今日漲幅 ≥5% 時 × 0.93 */
export const STOP_MULT: Readonly<{ normal: number; strong: number; strongChgPct: number }> = { normal: 0.95, strong: 0.93, strongChgPct: 5 };
/** 落後 ≥2 個交易日視為過期（盤後資料在下一交易日盤中 lag=1 屬正常） */
export const STALE_LAG = 2;
/**
 * 本站五因子稽核的母體（scripts/lib/bt-core.mjs buildSamples＋screen-five-factors.mjs 的 tradable 濾網，2026-10-08 查證）：
 * 四碼、非 00 開頭、成交量 ≥300 張、當日漲幅 ≤8.5%（跌停在母體內）。不在母體內的股票不套稽核方向，只描述位置。
 */
export const AUDIT_MAX_CHG_PCT = 8.5;
export const AUDIT_MIN_VOL_LOTS = 300;
/** 開盤參考區間（公式）的「近似漲停」分段門檻（舊式近似，公式照算不改；文字要寫明是近似） */
export const OPEN_RANGE_LIMIT_APPROX_PCT = 9.9;

const DAY_MS = 86_400_000;
const TPE_OFFSET_MS = 8 * 3600_000;
const MAX_LAG_SCAN_DAYS = 400;
const NEXT_TRADING_SCAN_DAYS = 40;
const SESSION_OPEN_TPE_HOUR = 9;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const INST_EXCLUDED_PREFIX = /^(00|01|91)/;

// ─── 文案常數（同一欄的 none／research／unavailable 文案只有一份，server 與 client 共用）──

const AUDIT_BASIS = '本站五因子稽核（2026-08-05）：主窗 480 個交易日約 42.3 萬筆＋獨立窗 240 個交易日約 22.0 萬筆，各再分前後半窗；'
  + `口徑：今收進場、隔日開盤出場；母體：上市櫃四碼普通股、當日漲幅 ≤${AUDIT_MAX_CHG_PCT}%、成交量 ≥${AUDIT_MIN_VOL_LOTS} 張（跌停在母體內）。`
  + '只引方向不列數字——稽核數字是扣手續費與稅後的淨勝率，與本站「比對不扣成本」口徑不同。';

const INST_CAVEAT = '本站驗證（技術評分 v3；訓練 2022-10～2025-09、樣本外 2025-11～2026-09；可交易宇宙平均約 590 檔；未扣成本）：'
  + '同口徑的 5 日版籌碼因子（外資＋投信 5 日買賣超 ÷ 20 日均量），對 5 日報酬 IC 訓練 −0.012、樣本外 +0.002，對 20 日報酬 −0.007／+0.014，'
  + '皆不顯著——法人買賣超對 5～20 日報酬無預測力。隔日期限另由研究中的隔日模型處理，本欄不使用。';

export const READING_TEXT = {
  unavailable: { stateText: '暫時無法取得', hint: '暫時無法取得，請重新整理。' },
  instFlow: {
    label: '法人籌碼動向（描述）',
    up: '偏買超', down: '偏賣超', neutral: '無明顯偏向',
    none: { stateText: '尚無判讀結果', hint: '本站法人買賣超彙整沒有本檔的 20 日資料，或 20 日均量不足 5 個交易日。' },
    degraded: { stateText: '尚無判讀結果', hint: '法人籌碼動向第二批上線：資料已存在，本頁尚未接上。' },
    outside: { hint: 'ETF（00 開頭）、存託憑證（91 開頭）、興櫃與非四碼證券，不與上市櫃普通股一起比較法人買賣超的相對規模。' },
    thin: { hint: '當日可比較的檔數不到 1,500（正常約 1,950），不給百分位。' },
    unavailable: { stateText: '暫時無法取得', hint: '讀取籌碼資料失敗，請稍後重新整理；這不代表沒有資料。' },
  },
  model20: {
    label: '模型評等（20 日）',
    none: {
      stateText: '無模型評等',
      hint: '本站 20 日以上期限目前沒有通過驗證的方向模型，所以不給評等；這不等於「持有」。模型要先通過事前登錄的檢定（可能不通過），並經站方核可後才公開，最早 2027 年第一季。',
    },
  },
  dist20: {
    label: '歷史同條件 20 日報酬分布',
    none: { stateText: '尚無判讀結果', hint: '以 20 日波動度分組的歷史 20 日報酬分布表（官方日 K，上下檔成對）第二批計算後發佈。這一欄不是目標價。' },
  },
  horizonShort: {
    label: '隔日方向',
    research: { stateText: '研究中', hint: '隔日技術評分模型（研究中）還在影子期，要累積足夠的前瞻交易日並經站方核可後才公開，公開頁不給值。' },
  },
  horizonMid: {
    label: '5 日方向',
    research: { stateText: '研究中', hint: '5 日波段模型（研究中）還在影子期，前瞻樣本不足以判斷，公開頁不給值。' },
  },
  horizonLong: {
    label: '20 日以上方向',
    none: { stateText: '尚無判讀結果', hint: '本站 20 日以上期限沒有通過驗證的模型（樣本外檢定不成立）。' },
  },
  newsDir: {
    label: '新聞判讀（利多／利空）',
    none: { stateText: '尚無判讀結果', hint: '本面板尚未接新聞判讀；同一張卡片「📊 因子 & 推薦」分頁有 AI 讀內文的新聞判別（若本檔有）。' },
  },
  hitHigh: {
    label: '歷史觸及率（明日高點參考）',
    none: { stateText: '尚無判讀結果', hint: '同條件（收盤位置×振幅×收盤狀態×市場）的歷史觸及率表尚未發佈。舊版「信心度 72／58」沒有依據，已移除。' },
  },
  hitLow: {
    label: '歷史觸及率（明日低點參考）',
    none: { stateText: '尚無判讀結果', hint: '同條件（收盤位置×振幅×收盤狀態×市場）的歷史觸及率表尚未發佈。舊版「信心度 72／58」沒有依據，已移除。' },
  },
  openRange: {
    label: '歷史落入率',
    none: { stateText: '尚無判讀結果', hint: '隔日開盤落在此區間的歷史比例尚未發佈；這是區間，不是方向。' },
  },
  nextDayDir: {
    label: '明日方向',
    research: { stateText: '研究中', hint: '隔日技術評分模型（研究中）在影子期，未公開；本頁不提供「買進／暫緩」建議。' },
  },
  closePos: {
    labelClose: '收盤位置（描述）',
    labelIntraday: '目前位置（盤中）',
    labelQuote: '日內位置（興櫃）',
    missingClose: '收盤位置資料不足',
    missingOther: '日內位置資料不足',
    missingHint: '來源沒給高低價、高低價與現價不同日，或全日單一價位；不以 50 代替。',
    high: '本站五因子稽核：收在日高附近（≥85%）這組，隔日表現在五組中最差，兩個獨立樣本窗同向；這是位置描述，不是延續訊號。',
    low: '本站五因子稽核：收在日線下半段（<30%）這組，隔日表現在五組中相對最佳；這是位置描述，不是買進訊號。',
    mid: '稽核只有兩端（≥85%、<30%）方向一致，中段沒有結論。',
    limit: '漲跌停收盤不套用本站五因子稽核的收盤位置分組；同條件的歷史觸及率表尚未發佈。',
    intraday: '盤中價位暫定，收盤前會變；稽核方向只適用收盤，盤中不套用。',
    quote: '興櫃無漲跌幅限制；稽核母體不含興櫃，只描述位置。',
    outside: `只描述位置，不套稽核方向（稽核母體：上市櫃四碼普通股、當日漲幅 ≤${AUDIT_MAX_CHG_PCT}%、成交量 ≥${AUDIT_MIN_VOL_LOTS} 張）。`,
    unverified: '母體條件未核對',
    notFound: { stateText: '當日行情查無此代號', hint: '當日行情清單沒有這個代號（可能停牌、下市，或代號有誤）；這不是讀取失敗。' },
  },
} as const;

// ─── 日期小工具（台北時區，不依賴執行環境時區）──────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0');
const ymdToUtcMs = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const utcMsToYmd = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
/** YYYY-MM-DD → MM-DD */
export const mmdd = (ymd: string): string => ymd.slice(5);
/** epoch ms → 台北 HH:mm */
export function hhmmTpe(ms: number): string {
  const d = new Date(ms + TPE_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
/** epoch ms → 台北 MM-DD HH:mm */
function mmddHhmmTpe(ms: number): string {
  const d = new Date(ms + TPE_OFFSET_MS);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
/** epoch ms → 台北 YYYY-MM-DD（server 用來算「今天」） */
export function ymdTpe(ms: number): string {
  return utcMsToYmd(ms + TPE_OFFSET_MS);
}

/**
 * dataYmd 之後、到 todayYmd（含）為止的交易日數。todayYmd 非交易日時，等於算到最後一個交易日。
 * 例（10 月休市 10-09、10-10）：10-08 的資料在 10-12 lag=1、10-13 lag=2、10-10 lag=0。
 */
export function tradingLag(dataYmd: string, todayYmd: string, isTradingYmd: (ymd: string) => boolean): number {
  if (!YMD_RE.test(dataYmd) || !YMD_RE.test(todayYmd) || todayYmd <= dataYmd) return 0;
  const end = ymdToUtcMs(todayYmd);
  let t = ymdToUtcMs(dataYmd);
  let lag = 0;
  for (let i = 0; i < MAX_LAG_SCAN_DAYS && t < end; i++) {
    t += DAY_MS;
    if (isTradingYmd(utcMsToYmd(t))) lag++;
  }
  return lag;
}

/** ymd 之後（不含）的第一個交易日；40 個日曆日內找不到回 null（不猜）。過期時把「明日」改成明確日期用 */
export function nextTradingYmd(ymd: string, isTradingYmd: (ymd: string) => boolean): string | null {
  if (!YMD_RE.test(ymd)) return null;
  let t = ymdToUtcMs(ymd);
  for (let i = 0; i < NEXT_TRADING_SCAN_DAYS; i++) {
    t += DAY_MS;
    const d = utcMsToYmd(t);
    if (isTradingYmd(d)) return d;
  }
  return null;
}

/**
 * 本交易時段的開始時刻（台北 09:00，epoch ms）；今天不是交易日或還沒到 09:00 ⇒ null。
 * 個股頁用來判斷「trend-analysis 是不是本時段開始前載入的」（例：08:45 開頁、13:30 後仍開著 ⇒ 它的資料日已不是畫面數字的日期）。
 */
export function sessionStartMsOf(nowMs: number, isTradingToday: boolean): number | null {
  if (!isTradingToday) return null;
  const start = ymdToUtcMs(ymdTpe(nowMs)) + SESSION_OPEN_TPE_HOUR * 3600_000 - TPE_OFFSET_MS;
  return nowMs >= start ? start : null;
}

export function staleText(dataYmd: string): string {
  return `⚠ ${mmdd(dataYmd)} 資料，未更新`;
}

export interface StaleCtx {
  todayYmd?: string;
  isTradingYmd?: (ymd: string) => boolean;
}
function lagOf(dataYmd: string | null | undefined, ctx: StaleCtx): number {
  if (!dataYmd || !ctx.todayYmd || !ctx.isTradingYmd) return 0;
  return tradingLag(dataYmd, ctx.todayYmd, ctx.isTradingYmd);
}

// ─── 共用 ────────────────────────────────────────────────────

function textReading(key: ReadingKey, label: string, state: ReadingState, stateText: string, hint: string, palette: ReadingPalette = 'market'): Reading {
  return { key, state, label, value: null, stateText, hint, basis: null, dataDate: null, stale: false, palette, caveat: null };
}

/** 讀取失敗（舊 JSON 沒有 reading、或 server 讀 Firestore 失敗）時的通用 reading */
export function unavailableReading(key: ReadingKey, label: string): Reading {
  return textReading(key, label, 'unavailable', READING_TEXT.unavailable.stateText, READING_TEXT.unavailable.hint);
}

export function anyUnavailable(readings: Record<string, Reading | null | undefined>): boolean {
  return Object.values(readings).some(r => r?.state === 'unavailable');
}

/** 狀態 → 色調（palette 'rate' 用在觸及率／位置這類不是漲跌方向的欄位，不用紅綠） */
export function toneOf(state: ReadingState, palette: ReadingPalette): string {
  if (state === 'up') return palette === 'rate' ? '#60a5fa' : 'var(--color-up)';
  if (state === 'down') return palette === 'rate' ? '#f59e0b' : 'var(--color-down)';
  if (state === 'neutral' || state === 'mixed') return '#94a3b8';
  if (state === 'thin') return '#f59e0b';
  return 'var(--text-muted)';
}

// ─── F1 法人籌碼動向（描述，20 日）──────────────────────────────

export interface InstFlowEntry {
  f20: number;
  t20: number;
  d20: number | null;
  fStreak: number;
  tStreak: number;
  avg20: number;
  r: number;              // (f20 + t20) ÷ avg20（日均量倍數；自營不計入）
}
export interface InstFlowTable {
  n: number;
  sorted: number[];       // 母體比值遞增
  byCode: Record<string, InstFlowEntry>;
  charYmd: string | null;
  charWrittenMs: number | null;
  volYmd: string | null;
  volWrittenMs: number | null;
  dailyYmd: string | null;
}
export interface InstFlowInput {
  charByCode: Record<string, unknown>;
  charYmd: string | null;
  charWrittenMs: number | null;
  avgByCode: Record<string, unknown>;
  volYmd: string | null;
  volWrittenMs: number | null;
  dailyYmd: string | null;
}

const finiteOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** 母體：四碼、不以 00／01／91 開頭（ETF、存託憑證排除），兩份資料都有值且 20 日均量 > 0 */
export function buildInstFlowTable(input: InstFlowInput): InstFlowTable {
  const byCode: Record<string, InstFlowEntry> = {};
  const ratios: number[] = [];
  for (const [code, raw] of Object.entries(input.charByCode || {})) {
    if (!/^\d{4}$/.test(code) || INST_EXCLUDED_PREFIX.test(code)) continue;
    const row = raw as Record<string, unknown> | null;
    const avg20 = input.avgByCode?.[code];
    if (!row || typeof avg20 !== 'number' || !(avg20 > 0)) continue;
    if (typeof row.f20 !== 'number' || !Number.isFinite(row.f20) || typeof row.t20 !== 'number' || !Number.isFinite(row.t20)) continue;
    const r = (row.f20 + row.t20) / avg20;
    byCode[code] = {
      f20: row.f20, t20: row.t20,
      d20: typeof row.d20 === 'number' && Number.isFinite(row.d20) ? row.d20 : null,
      fStreak: finiteOr(row.fStreak, 0), tStreak: finiteOr(row.tStreak, 0),
      avg20, r,
    };
    ratios.push(r);
  }
  ratios.sort((a, b) => a - b);
  return {
    n: ratios.length, sorted: ratios, byCode,
    charYmd: input.charYmd, charWrittenMs: input.charWrittenMs,
    volYmd: input.volYmd, volWrittenMs: input.volWrittenMs,
    dailyYmd: input.dailyYmd,
  };
}

/** 第一個 ≥ x（strict=false）或 > x（strict=true）的位置 */
function bound(sorted: number[], x: number, strict: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? sorted[mid] <= x : sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** P = round(100 × (小於 r 的檔數 + 0.5 × 等於 r 的檔數) ÷ n) */
export function percentileOf(sorted: number[], r: number): number {
  const less = bound(sorted, r, false);
  const equal = bound(sorted, r, true) - less;
  return Math.round((100 * (less + 0.5 * equal)) / sorted.length);
}

function outsideReason(code: string, isEsb: boolean): string | null {
  if (code.startsWith('00')) return 'ETF';
  if (isEsb) return '興櫃';
  if (/^91\d{2}$/.test(code)) return '存託憑證';
  if (!/^\d{4}$/.test(code) || INST_EXCLUDED_PREFIX.test(code)) return '非四碼普通股';
  return null;
}

const fmtSigned = (n: number | null): string => {
  if (n == null) return '—';
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '-'}${Math.abs(n).toLocaleString('en-US')}`;
};
const streakText = (s: number): string => (s > 0 ? `連買 ${s} 日` : s < 0 ? `連賣 ${-s} 日` : '無連續');

export interface InstFlowCtx {
  todayYmd: string;
  isTradingYmd: (ymd: string) => boolean;
  isEsb: boolean;
  degraded?: boolean;
}

export function instFlowReading(table: InstFlowTable | null, code: string, ctx: InstFlowCtx): Reading {
  const T = READING_TEXT.instFlow;
  if (ctx.degraded) return textReading('instFlow', T.label, 'none', T.degraded.stateText, T.degraded.hint);
  const reason = outsideReason(code, ctx.isEsb);
  if (reason) return textReading('instFlow', T.label, 'outside', `不在比較母體（${reason}）`, T.outside.hint);
  if (!table) return textReading('instFlow', T.label, 'unavailable', T.unavailable.stateText, T.unavailable.hint);
  if (table.n < INST_MIN_N) return textReading('instFlow', T.label, 'thin', `比較母體不完整（n=${table.n}）`, T.thin.hint);
  const e = table.byCode[code];
  if (!e) return textReading('instFlow', T.label, 'none', T.none.stateText, T.none.hint);

  const P = percentileOf(table.sorted, e.r);
  const state: ReadingState = P >= INST_UP_P ? 'up' : P <= INST_DOWN_P ? 'down' : 'neutral';
  const dir = state === 'up' ? T.up : state === 'down' ? T.down : T.neutral;
  const absR = Math.abs(e.r).toFixed(2);
  const flow = e.r > 0 ? `淨買 ${absR}` : e.r < 0 ? `淨賣 ${absR}` : '淨買賣相抵，0.00';
  const value = `第 ${P} 百分位（近 20 日${flow} 個日均量）`;

  const head = `近 20 日外資＋投信淨買賣超的相對規模，在同日 ${table.n} 檔中排第 ${P} 百分位`;
  const rank = state === 'up' ? '（≥80 視為偏買超）。'
    : state === 'down' ? '（≤20 視為偏賣超）。'
    : '，介於 21～79，無明顯偏向。';
  const lag = table.charYmd ? tradingLag(table.charYmd, ctx.todayYmd, ctx.isTradingYmd) : 0;
  const dailyAhead = !!(table.dailyYmd && table.charYmd && table.dailyYmd > table.charYmd);
  const staleByLag = lag >= STALE_LAG;
  const detail = `外資 ${fmtSigned(e.f20)} 張｜投信 ${fmtSigned(e.t20)}｜自營 ${fmtSigned(e.d20)}（自營不計入）；外資${streakText(e.fStreak)}、投信${streakText(e.tStreak)}`;
  // 「當日籌碼判讀見頁首」只在個股頁成立（AI 推薦卡的趨勢面板沒有頁首籌碼判讀）⇒ 不放共用 hint，由個股頁以 ReadingRow note 附註
  const hint = `${head}${rank}這是籌碼流向的描述，不是預測：本站驗證法人買賣超對 5～20 日報酬沒有預測力。`
    + (staleByLag ? `資料落後 ${lag} 個交易日。` : '')
    + `\n${detail}`;

  const charAt = table.charWrittenMs != null ? `${mmddHhmmTpe(table.charWrittenMs)} 計算` : '計算時刻未提供';
  const volAt = table.volWrittenMs != null ? `${hhmmTpe(table.volWrittenMs)} 計算` : '計算時刻未提供';
  const dailyChecked = !!(table.dailyYmd && table.charYmd && table.dailyYmd >= table.charYmd);
  const basis = `來源：本站法人買賣超彙整（外資、投信、自營商近 20 個交易日累計，截至 ${table.charYmd ?? '資料日未提供'}，${charAt}）`
    + `÷ 20 日均量（${table.volYmd ?? '資料日未提供'} ${volAt}，取當時已歸檔的最近 20 個交易日）；`
    + `與同日 ${table.n} 檔上市櫃普通股比較（不含 ETF、存託憑證、興櫃）`
    + (dailyChecked ? '' : '；逐日籌碼資料日未能核對');

  let stateText: string = dir;
  if (dailyAhead) stateText = `⚠ 法人 20 日累計截至 ${mmdd(table.charYmd as string)}，逐日籌碼已到 ${mmdd(table.dailyYmd as string)}・${dir}`;
  else if (staleByLag && table.charYmd) stateText = `${staleText(table.charYmd)}・${dir}`;

  return {
    key: 'instFlow', state, label: T.label, value, stateText, hint, basis,
    dataDate: table.charYmd, stale: dailyAhead || staleByLag, palette: 'market', caveat: INST_CAVEAT,
  };
}

// ─── F2–F5、F6、F8、F9：今晚沒有通過驗證或已發佈的來源 ─────────────

export function model20Reading(): Reading {
  const T = READING_TEXT.model20;
  return textReading('model20', T.label, 'none', T.none.stateText, T.none.hint);
}
export function dist20Reading(): Reading {
  const T = READING_TEXT.dist20;
  return textReading('dist20', T.label, 'none', T.none.stateText, T.none.hint);
}
export function horizonReadings(): { horizonShort: Reading; horizonMid: Reading; horizonLong: Reading } {
  const S = READING_TEXT.horizonShort;
  const M = READING_TEXT.horizonMid;
  const L = READING_TEXT.horizonLong;
  return {
    horizonShort: textReading('horizonShort', S.label, 'research', S.research.stateText, S.research.hint),
    horizonMid: textReading('horizonMid', M.label, 'research', M.research.stateText, M.research.hint),
    horizonLong: textReading('horizonLong', L.label, 'none', L.none.stateText, L.none.hint),
  };
}
export function newsDirReading(): Reading {
  const T = READING_TEXT.newsDir;
  return textReading('newsDir', T.label, 'none', T.none.stateText, T.none.hint);
}
export function hitReadings(): { hitHigh: Reading; hitLow: Reading } {
  const H = READING_TEXT.hitHigh;
  const L = READING_TEXT.hitLow;
  return {
    hitHigh: textReading('hitHigh', H.label, 'none', H.none.stateText, H.none.hint, 'rate'),
    hitLow: textReading('hitLow', L.label, 'none', L.none.stateText, L.none.hint, 'rate'),
  };
}
export function openRangeReading(): Reading {
  const T = READING_TEXT.openRange;
  return textReading('openRange', T.label, 'none', T.none.stateText, T.none.hint, 'rate');
}
export function nextDayDirReading(): Reading {
  const T = READING_TEXT.nextDayDir;
  return textReading('nextDayDir', T.label, 'research', T.research.stateText, T.research.hint);
}

// ─── §1.9 資料日與盤中／收盤口徑 ───────────────────────────────

export interface QuoteContextInput {
  snapFresh: boolean;
  snapDataYmd: string | null;
  snapMarketOpen: boolean;
  snapSweepMs: number | null;
  rowYmd: string | null;      // 日行情列自報的資料日（route 先轉成 YYYY-MM-DD）
  rowMarket: string | null | undefined;
}
export interface QuoteContext {
  dataDate: string | null;
  phase: QuotePhase;
  quoteAsOfMs: number | null;
}

export function quoteContextOf(i: QuoteContextInput): QuoteContext {
  if (i.rowMarket === 'esb') return { dataDate: null, phase: 'quote', quoteAsOfMs: null };
  const snapYmd = i.snapDataYmd && YMD_RE.test(i.snapDataYmd) ? i.snapDataYmd : null;
  if (i.snapFresh && i.snapMarketOpen) return { dataDate: snapYmd, phase: 'intraday', quoteAsOfMs: i.snapSweepMs ?? null };
  if (i.snapFresh) return { dataDate: snapYmd, phase: 'close', quoteAsOfMs: i.snapSweepMs ?? null };
  return { dataDate: i.rowYmd && YMD_RE.test(i.rowYmd) ? i.rowYmd : null, phase: 'close', quoteAsOfMs: null };
}

/**
 * 精確漲跌停（漲停價＝昨收×1.1 向下取檔、跌停價＝昨收×0.9 向上取檔；檔位由呼叫端注入：股票 tickSize、ETF etfTickSize）。
 * 用個股檔位判 ETF 會誤報（00632R 昨收 20.13 收 22.10、+9.79%：個股檔位算出漲停 22.10，ETF 實際漲停 22.14）。
 * 收在漲跌停價外側半檔以上＝這檔沒有漲跌幅限制（例：國外成分 ETF），不算漲跌停。
 */
export function limitKindOf(close: number, change: number, tick: (p: number) => number): LimitKind {
  const prev = close - change;
  if (!(prev > 0) || !(close > 0) || change === 0) return null;
  if (change > 0) {
    const raw = prev * 1.1;
    const t = tick(raw);
    const lim = Math.floor(raw / t + 1e-9) * t;
    return close >= lim - 1e-6 && close <= lim + t / 2 ? 'up' : null;
  }
  const raw = prev * 0.9;
  const t = tick(raw);
  const lim = Math.ceil(raw / t - 1e-9) * t;
  return close <= lim + 1e-6 && close >= lim - t / 2 ? 'down' : null;
}

/** 不在本站五因子稽核母體的原因；在母體內回 null（AUDIT_MAX_CHG_PCT、AUDIT_MIN_VOL_LOTS 的出處見常數註解） */
export function auditOutsideOf(code: string, isEsb: boolean, chgPct: number, volumeShares: number): string | null {
  if (isEsb) return '興櫃';
  if (code.startsWith('00')) return 'ETF';
  if (!/^\d{4}$/.test(code)) return '非四碼普通股';
  if (chgPct > AUDIT_MAX_CHG_PCT) return `漲幅逾 ${AUDIT_MAX_CHG_PCT}%`;
  if (!(volumeShares >= AUDIT_MIN_VOL_LOTS * 1000)) return `成交量未達 ${AUDIT_MIN_VOL_LOTS} 張`;
  return null;
}

/** 日行情一列的原始數值（route 由 getStockDayAllDataInternal 的列轉來；缺值給 0，不以收盤價補） */
export interface QuoteRowInput {
  close: number;
  change: number;
  open: number;
  high: number;
  low: number;
  tradeValue: number;     // 元；來源給 0 或缺＝0
  volume: number;         // 股；缺＝0
  rowYmd: string | null;  // 列自報資料日（YYYY-MM-DD；民國／西元字串由 route 先轉）
  source: string | null;  // 'mis_live'｜'stock_day_all'｜'esb'
  market: string | null;  // 'tse'｜'otc'｜'esb'
}

/** 當日行情的數值事實（開高低、成交值已過資料日閘門；位置一律經 closePosOf） */
export interface QuoteFacts {
  close: number;
  change: number;
  prevClose: number;
  chgPct: number;
  open: number;
  high: number;
  low: number;
  isEsb: boolean;
  limit: LimitKind;
  closePos: number | null;
  tradeValue: number | null;   // 元；null＝來源未提供或不是資料日的值
  /** 盤中非即時列：本站尚未取得本檔今日成交（daemon 種子＝前一交易日價格、漲跌已歸零） */
  noTradeToday: boolean;
  /** 不在五因子稽核母體的原因；null＝在母體內 */
  auditOutside: string | null;
}

/**
 * §1.9 資料日閘門（2026-10-08 審查 HIGH）：快照新鮮時，非即時列的價格取自快照、開高低卻取自 STOCK_DAY_ALL CSV／櫃買收盤檔
 * （盤中與收盤後檔案更新前＝前一交易日），Date 也是那份檔案的。列自報資料日（rowYmd）與資料日（qc.dataDate）不同天 ⇒
 * 開高低一律當 0（位置不計、不出跳空句）、成交值當 null（「來源未提供」）。
 * 不受此限：即時列（mis_live，當日 MIS 值）、興櫃最新報價、沒有 Date 的列——twse-api-server 只有「用快照合成的上櫃後備列」
 * 與興櫃列沒有 Date，它們的開高低、成交值和價格出自同一筆報價（2026-10-08 本機實測：tpexClose 尚未寫入時上櫃 882 檔全是這種列）。
 * 成交值 0 一律視為來源沒給（快照合成列在收盤資料後備路徑、興櫃列都是 '0'），不寫「0 萬元」。
 */
export function quoteFactsOf(code: string, row: QuoteRowInput | null, qc: QuoteContext, tick: (p: number) => number): QuoteFacts | null {
  if (!row || !(row.close > 0)) return null;
  const isEsb = row.market === 'esb';
  const isLive = row.source === 'mis_live';
  const noTradeToday = qc.phase === 'intraday' && !isEsb && !isLive;
  // 盤中非即時列一律不用開高低與成交值：那是前一交易日的種子（快照合成的上櫃列沒有 Date，也一樣）
  const sameDay = !noTradeToday && (isEsb || isLive || row.rowYmd == null || row.rowYmd === qc.dataDate);
  const change = noTradeToday ? 0 : row.change;
  const close = row.close;
  const prevClose = close - change;
  const chgPct = prevClose > 0 ? (change / prevClose) * 100 : 0;
  // 興櫃沒有漲跌停（2026-09-01 7930 威世波）
  const limit: LimitKind = isEsb || noTradeToday ? null : limitKindOf(close, change, tick);
  const open = sameDay ? row.open : 0;
  const high = sameDay ? row.high : 0;
  const low = sameDay ? row.low : 0;
  return {
    close, change, prevClose, chgPct, open, high, low, isEsb, limit,
    closePos: closePosOf(close, high, low, prevClose, limit),
    tradeValue: sameDay && row.tradeValue > 0 ? row.tradeValue : null,
    noTradeToday,
    auditOutside: auditOutsideOf(code, isEsb, chgPct, sameDay ? row.volume : 0),
  };
}

/**
 * 收盤（或目前）位置 0..1；資料不可信時回 null（不以 50 代替）：
 * 缺高低／高低顛倒、現價不在 [低, 高]（高低與現價不同日）、全日單一價位但不是精確漲跌停（分不出是一字鎖死還是來源缺值被補）。
 */
export function closePosOf(close: number, high: number, low: number, prevClose: number, limit: LimitKind): number | null {
  void prevClose;   // 保留參數：與舊 closePositionOf 同簽章，方便逐處替換
  if (!(high > 0 && low > 0 && high >= low) || !(close > 0)) return null;
  const eps = 1e-6;
  if (close < low - eps || close > high + eps) return null;
  if (Math.abs(high - low) < eps) {
    if (limit === 'up') return 1;
    if (limit === 'down') return 0;
    return null;
  }
  return Math.min(1, Math.max(0, (close - low) / (high - low)));
}

function closeSegment(pos: number): string {
  if (pos >= CLOSE_POS_EDGES[0]) return '貼近日高';
  if (pos >= CLOSE_POS_EDGES[1]) return '偏高';
  if (pos >= CLOSE_POS_EDGES[2]) return '中段偏高';
  if (pos >= CLOSE_POS_EDGES[3]) return '中段偏低';
  return '日線下半段';
}

export interface ClosePosOpts extends StaleCtx {
  limit: LimitKind;
  phase: QuotePhase;
  quoteAsOfMs?: number | null;
  dataDate: string | null;
  /**
   * 不在本站五因子稽核母體的原因（auditOutsideOf）；null＝在母體內才套稽核方向。
   * 未給（undefined）＝母體未核對，一樣不套稽核方向——沒有證據的股票不寫「最差／相對最佳」。
   */
  auditOutside?: string | null;
}

export function closePosReading(pos: number | null, o: ClosePosOpts): Reading {
  const T = READING_TEXT.closePos;
  const label = o.phase === 'intraday' ? T.labelIntraday : o.phase === 'quote' ? T.labelQuote : T.labelClose;
  const dataDate = o.dataDate ?? null;
  if (pos == null) {
    const r = textReading('closePos', label, 'none', o.phase === 'close' ? T.missingClose : T.missingOther, T.missingHint, 'rate');
    return { ...r, dataDate };
  }
  const P = Math.round(pos * 100);
  // 分段與稽核兩端都依「畫面上的整數百分比」判定：0.4996 印成「日內 50%」就要寫「中段偏高」，不能寫「中段偏低」
  const posShown = P / 100;
  const dateLabel = dataDate ? mmdd(dataDate) : '資料日未提供';
  let value = `日內 ${P}%`;
  let stateText = closeSegment(posShown);
  let hint: string;
  let basis: string;
  if (o.phase === 'intraday') {
    const hm = o.quoteAsOfMs != null ? hhmmTpe(o.quoteAsOfMs) : null;
    value = `目前日內 ${P}%`;
    stateText = hm ? `盤中位置（${hm}）` : '盤中位置';
    hint = T.intraday;
    basis = `當日盤中${hm ? `（${hm}）` : ''}最高、最低與目前價計算；盤中暫定`;
  } else if (o.phase === 'quote') {
    hint = T.quote;
    basis = '興櫃最新報價的當日最高、最低與成交價計算（資料日未提供）';
  } else if (o.limit === 'up' || o.limit === 'down') {
    stateText = o.limit === 'up' ? '收漲停' : '收跌停';
    hint = T.limit;
    basis = `${dateLabel} 當日最高、最低與收盤價計算；漲跌停依檔位精確判定`;
  } else if (o.auditOutside !== null) {
    hint = `不在本站五因子稽核母體（${o.auditOutside ?? T.unverified}）；${T.outside}`;
    basis = `${dateLabel} 當日最高、最低與收盤價計算`;
  } else if (posShown >= CLOSE_POS_EDGES[0]) {
    hint = T.high;
    basis = AUDIT_BASIS;
  } else if (posShown < CLOSE_POS_EDGES[3]) {
    hint = T.low;
    basis = AUDIT_BASIS;
  } else {
    hint = T.mid;
    basis = `${dateLabel} 當日最高、最低與收盤價計算`;
  }
  const lag = lagOf(dataDate, o);
  const stale = lag >= STALE_LAG;
  if (stale && dataDate) stateText = `${staleText(dataDate)}・${stateText}`;
  return { key: 'closePos', state: 'neutral', label, value, stateText, hint, basis, dataDate, stale, palette: 'rate', caveat: null };
}

/** 代號格式合法、日行情清單讀到了卻查無此檔（停牌、下市…）：none，不是讀取失敗（不觸發 partial 短快取） */
export function closePosNotFoundReading(): Reading {
  const T = READING_TEXT.closePos;
  return textReading('closePos', T.labelClose, 'none', T.notFound.stateText, T.notFound.hint, 'rate');
}

// ─── F9 今日走勢（描述）──────────────────────────────────────

export type TodayMoveKind = 'limit_up' | 'big_up' | 'up' | 'small_up' | 'flat' | 'small_down' | 'down' | 'big_down' | 'limit_down';
export interface TodayMove {
  kind: TodayMoveKind;
  label: string;
  text: string;
  tone: 'up' | 'down' | 'flat';
  dataDate: string | null;
  phase: QuotePhase;
}
export interface TodayMoveOpts {
  limit?: LimitKind;
  phase: QuotePhase;
  tradeValue?: number | null;   // 元；null＝來源未提供
  closePos?: number | null;
  dataDate?: string | null;
  quoteAsOfMs?: number | null;
  stale?: boolean;
  /** 盤中非即時列：本站尚未取得本檔今日成交（價格是前一交易日的、漲跌以 0 計） */
  noTradeToday?: boolean;
  /** 收盤口徑沒有資料日時，句首寫「今日」而不是「資料日未提供：」（個股頁：trend-analysis 是本交易時段開始前載入的） */
  todayHead?: boolean;
}

const MOVE_BASE: Record<TodayMoveKind, string> = {
  limit_up: '漲停', big_up: '大漲', up: '上漲', small_up: '小漲', flat: '平盤',
  small_down: '小跌', down: '下跌', big_down: '大跌', limit_down: '跌停',
};

function moveKindOf(chg: number, limit: LimitKind): TodayMoveKind {
  const [big, mid, small] = TODAY_MOVE_EDGES;
  if (limit === 'up') return 'limit_up';
  if (limit === 'down') return 'limit_down';
  if (chg >= big) return 'big_up';
  if (chg >= mid) return 'up';
  if (chg > small) return 'small_up';
  if (chg >= -small) return 'flat';
  if (chg > -mid) return 'small_down';
  if (chg > -big) return 'down';
  return 'big_down';
}

const pctSigned = (chg: number): string => `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`;
/** 成交值（元）→「N 億元」；不足 1 億寫萬元；null＝來源未提供 */
export function tradeValueText(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v >= 1e8 ? `${(v / 1e8).toFixed(1)} 億元` : `${Math.round(v / 1e4).toLocaleString('en-US')} 萬元`;
}

export function todayMoveOf(chgPct: number, o: TodayMoveOpts): TodayMove {
  const phase = o.phase;
  const dataDate = o.dataDate ?? null;
  const hm = phase === 'intraday' && o.quoteAsOfMs != null ? ` ${hhmmTpe(o.quoteAsOfMs)}` : '';
  if (o.noTradeToday && phase === 'intraday') {
    // 價格本身不能用「收」字描述（§1.9）：寫「前一交易日的價格」
    let text = `盤中${hm}：本站尚未取得本檔今日成交，畫面價格是前一交易日的價格（漲跌以 0 計）。`;
    if (o.stale && dataDate) text = `${staleText(dataDate)}：${text}`;
    return { kind: 'flat', label: '盤中尚無成交', text, tone: 'flat', dataDate, phase };
  }
  const limit: LimitKind = phase === 'quote' ? null : (o.limit ?? null);
  const kind = moveKindOf(chgPct, limit);
  const base = MOVE_BASE[kind];
  const isLimit = kind === 'limit_up' || kind === 'limit_down';
  // 色調跟著文字：|漲跌| ≤0.5% 寫「平盤」就給中性色，不依正負號給紅綠
  const tone: TodayMove['tone'] = kind === 'flat' ? 'flat' : chgPct > 0 ? 'up' : 'down';
  const pct = pctSigned(chgPct);
  const absPct = `${Math.abs(chgPct).toFixed(2)}%`;
  const tv = tradeValueText(o.tradeValue);
  const P = o.closePos == null ? null : Math.round(o.closePos * 100);

  let label: string;
  let text: string;
  if (phase === 'intraday') {
    label = isLimit ? `盤中在${base}價` : `盤中 ${base}`;
    const body = isLimit ? `在${base}價（${pct}）` : kind === 'flat' ? `平盤（${pct}）` : `${chgPct > 0 ? '漲' : '跌'} ${absPct}（${base}）`;
    const val = tv ? `成交值 ${tv}（累計至此）` : '成交值：來源未提供';
    const pos = P == null ? '日內位置資料不足' : `目前位於日內 ${P}%`;
    text = `盤中${hm} 暫定：${body}，${val}，${pos}。`;
  } else if (phase === 'quote') {
    label = `興櫃 ${base}`;
    const body = kind === 'flat' ? `平盤（${pct}）` : `${chgPct > 0 ? '漲' : '跌'} ${absPct}（${base}）`;
    const val = tv ? `成交值 ${tv}` : '成交值：來源未提供';
    const pos = P == null ? '日內位置資料不足' : `位於日內 ${P}%`;
    text = `興櫃最新報價（資料日未提供）：${body}，${val}，${pos}。`;
  } else {
    label = isLimit ? `收${base}` : base;
    const head = dataDate ? `${mmdd(dataDate)} ` : o.todayHead ? '今日' : '資料日未提供：';
    const body = isLimit ? `收${base}（${pct}）` : kind === 'flat' ? `收平盤（${pct}）` : `收${chgPct > 0 ? '漲' : '跌'} ${absPct}（${base}）`;
    const val = tv ? `成交值 ${tv}` : '成交值：來源未提供';
    const pos = P == null ? '收盤位置資料不足' : `收盤位於日內 ${P}%`;
    text = `${head}${body}，${val}，${pos}。`;
  }
  if (o.stale && dataDate) text = `${staleText(dataDate)}：${text}`;
  return { kind, label, text, tone, dataDate, phase };
}

// ─── F12 走勢摘要與事實句 ─────────────────────────────────────

export interface MoveInput {
  chgPct: number;
  limit: LimitKind;
  phase: QuotePhase;
  tradeValue: number | null;
  closePos: number | null;
  dataDate: string | null;
  quoteAsOfMs: number | null;
  stale?: boolean;
  noTradeToday?: boolean;
  /** 不在五因子稽核母體的原因；null＝在母體內；未給＝未核對（不套稽核方向） */
  auditOutside?: string | null;
}

export function summaryText(i: MoveInput & { companyName: string; code: string }): string {
  const who = i.companyName ? `${i.companyName}（${i.code}）` : i.code;
  const m = todayMoveOf(i.chgPct, i);
  return `${who}${m.text}`;
}

export interface TrendReasonOut {
  icon: string;
  title: string;
  detail: string;
  strength: 'strong' | 'moderate' | 'weak';
  category: 'price_action' | 'volume' | 'technical' | 'industry' | 'news';
}

const VALUE_EDGE_BIG = 50e8;
const VALUE_EDGE_MID = 10e8;

/** 事實句（下跌側與上漲側對稱；strength 只當重要度標籤，依 |漲跌幅| 對稱給） */
export function reasonsOf(i: MoveInput & { close: number; open: number; prevClose: number }): TrendReasonOut[] {
  const out: TrendReasonOut[] = [];
  const isIntra = i.phase === 'intraday';
  const isQuote = i.phase === 'quote';
  const limit: LimitKind = isQuote ? null : i.limit;
  const [big, mid] = TODAY_MOVE_EDGES;
  const abs = Math.abs(i.chgPct);
  const up = i.chgPct > 0;
  const pct = pctSigned(i.chgPct);
  const hm = isIntra && i.quoteAsOfMs != null ? ` ${hhmmTpe(i.quoteAsOfMs)}` : '';

  if (limit) {
    const w = limit === 'up' ? '漲停' : '跌停';
    out.push({
      icon: limit === 'up' ? '🔴' : '🟢',
      title: isIntra ? `盤中在${w}價 ${i.close.toFixed(2)}` : `收${w} ${i.close.toFixed(2)}`,
      detail: isIntra ? `盤中${hm}在${w}價 ${i.close.toFixed(2)} 元（${pct}），為暫定價。` : `今日以${w}價 ${i.close.toFixed(2)} 元作收（${pct}）。`,
      strength: 'strong', category: 'price_action',
    });
  } else if (abs >= mid) {
    const w = abs >= big ? (up ? '大漲' : '大跌') : (up ? '上漲' : '下跌');
    const verb = up ? '上漲' : '下跌';
    out.push({
      icon: up ? '📈' : '📉',
      title: `${isIntra ? '盤中' : isQuote ? '興櫃' : ''}${w} ${pct}`,
      detail: isIntra ? `盤中${hm}暫定${verb} ${abs.toFixed(2)}%。`
        : isQuote ? `興櫃最新報價${verb} ${abs.toFixed(2)}%（興櫃無漲跌幅限制）。`
        : `今日${verb} ${abs.toFixed(2)}%。`,
      strength: abs >= big ? 'strong' : 'moderate', category: 'price_action',
    });
  }

  if (i.tradeValue != null && i.tradeValue > VALUE_EDGE_MID) {
    const tv = tradeValueText(i.tradeValue) as string;
    out.push({
      icon: i.tradeValue > VALUE_EDGE_BIG ? '💰' : '📦',
      title: `成交值 ${tv}`,
      detail: isIntra ? `盤中累計至此成交金額 ${tv}。` : `今日成交金額 ${tv}。`,
      strength: 'weak', category: 'volume',
    });
  }

  const posP = i.closePos == null ? null : Math.round(i.closePos * 100);   // 依畫面上的整數百分比分段（同 closePosReading）
  if (posP != null && (posP / 100 >= CLOSE_POS_EDGES[0] || posP / 100 < CLOSE_POS_EDGES[3])) {
    const P = posP;
    const high = P / 100 >= CLOSE_POS_EDGES[0];
    const where = high ? '日內高位' : '日線下半段';
    const title = isIntra ? `目前在${where}（${P}%）` : isQuote ? `位於${where}（${P}%）` : `收在${where}（${P}%）`;
    const detail = isIntra
      ? '盤中暫定位置，會隨成交變動；本站稽核的方向結論不適用於盤中。'
      : closePosReading(i.closePos, { limit, phase: i.phase, quoteAsOfMs: i.quoteAsOfMs, dataDate: i.dataDate, auditOutside: i.auditOutside }).hint;
    out.push({ icon: '📍', title, detail, strength: 'weak', category: 'technical' });
  }

  if (!isQuote && i.open > 0 && i.prevClose > 0) {
    const gap = (i.open / i.prevClose - 1) * 100;
    if (gap > GAP_EDGE_PCT) {
      out.push({ icon: '⬆️', title: `跳空開高 ${gap.toFixed(1)}%`, detail: `今日開盤較昨收高 ${gap.toFixed(2)}%。`, strength: 'weak', category: 'technical' });
    } else if (gap < -GAP_EDGE_PCT) {
      out.push({ icon: '⬇️', title: `跳空開低 ${Math.abs(gap).toFixed(1)}%`, detail: `今日開盤較昨收低 ${Math.abs(gap).toFixed(2)}%。`, strength: 'weak', category: 'technical' });
    }
  }
  return out;
}

// ─── F6 明日高低點參考（公式）的依據文字 ─────────────────────────

/** rangePct＝（今日最高 − 最低）÷ 今收 × 100；null＝高低價未提供或不一致 */
export function basisText(close: number, rangePct: number | null, o: { phase?: QuotePhase; quoteAsOfMs?: number | null } = {}): string {
  const isIntra = o.phase === 'intraday';
  const anchor = isIntra
    ? `目前價（盤中${o.quoteAsOfMs != null ? ` ${hhmmTpe(o.quoteAsOfMs)}` : ''} 暫定）`
    : o.phase === 'quote' ? '最新成交價' : '今收';
  const denom = isIntra ? '目前價' : o.phase === 'quote' ? '最新成交價' : '今收';
  if (rangePct == null) return `${anchor} ${close} 元 ×（1 ± ${MIN_RANGE_PCT}% ÷ 2）；今日高低價未提供，以 ${MIN_RANGE_PCT}% 計`;
  return `${anchor} ${close} 元 ×（1 ± 今日高低差佔${denom} ${rangePct.toFixed(1)}% ÷ 2）；低於 ${MIN_RANGE_PCT}% 時以 ${MIN_RANGE_PCT}% 計`;
}

// ─── F8 開盤參考區間（公式）的依據文字 ─────────────────────────────

export interface OpenRangeBasisOpts {
  anchor: string;               // 今收／目前價／最新價
  chgPct: number;
  limitUpApprox: boolean;       // chgPct ≥ OPEN_RANGE_LIMIT_APPROX_PCT（非興櫃）
  limit: LimitKind;
  phase: QuotePhase;
  quoteAsOfMs: number | null;
}

/**
 * 分段名稱寫明「漲幅 ≥9.9%（近似漲停）」：低價股的真漲停可能只漲 9.5%（昨收 10.45 → 漲停 11.45、+9.57%），
 * 套的是 ≥5% 分段；舊文字寫「漲停 0.99～1.05」與「收漲停」同頁自相矛盾（2026-10-08 審查）。公式本身不改。
 */
export function openRangeBasisText(lo: number, hi: number, o: OpenRangeBasisOpts): string {
  const segs = `漲幅 ≥${OPEN_RANGE_LIMIT_APPROX_PCT}%（近似漲停）0.99～1.05、≥5% 0.985～1.03、≥2% 0.99～1.02、其餘 0.98～1.015`;
  let s = `公式：${o.anchor} × ${lo}～× ${hi}（依今日漲幅分段的固定倍數：${segs}）`;
  if (o.limit === 'up' && !o.limitUpApprox) {
    const w = o.phase === 'intraday' ? '在漲停價' : '收漲停';
    s += `；本檔${w}但漲幅 ${o.chgPct.toFixed(2)}% 未達 ${OPEN_RANGE_LIMIT_APPROX_PCT}%，依漲幅分段試算`;
  }
  if (o.phase === 'intraday') s += `；依盤中${o.quoteAsOfMs != null ? ` ${hhmmTpe(o.quoteAsOfMs)}` : ''} 暫定價試算`;
  return s;
}

// ─── F11 進場前參考停損（tw-ai-stoploss §2：統一標「參考停損（進場前）」，不改算法）──

export interface StopRef {
  price: number | null;
  label: '參考停損（進場前）';
  basis: string;
  note: string | null;
}

const STOP_NOTE_NO_DATA = '資料不足，不提供參考停損';

/** anchor：比較的價位用語（收盤後「今收」、盤中「目前價」、興櫃「最新價」） */
export function stopRefOf(close: number, prevClose: number, anchor = '今收'): StopRef {
  const label = '參考停損（進場前）' as const;
  const basis = `昨收 × ${STOP_MULT.normal}（今日漲幅 ≥${STOP_MULT.strongChgPct}% 時 × ${STOP_MULT.strong}）`;
  if (!(close > 0) || !(prevClose > 0)) return { price: null, label, basis, note: STOP_NOTE_NO_DATA };
  const chg = ((close - prevClose) / prevClose) * 100;
  const mult = chg >= STOP_MULT.strongChgPct ? STOP_MULT.strong : STOP_MULT.normal;
  const price = parseFloat((prevClose * mult).toFixed(2));
  if (price >= close) {
    return { price: null, label, basis, note: `公式不適用：昨收 × ${mult} 高於${anchor}（跌幅 ≥${STOP_MULT.strongChgPct}%），不提供參考停損` };
  }
  return { price, label, basis, note: null };
}

/** 參考停損格子的值：有價就印價；沒有價依 note 分「資料不足」與「公式不適用」；整個 stopRef 不存在（舊 JSON）＝暫時無法取得 */
export function stopRefCellText(s: StopRef | null | undefined): string {
  if (!s) return READING_TEXT.unavailable.stateText;
  if (s.price != null) return s.price.toFixed(2);
  if (s.note == null || s.note.startsWith(STOP_NOTE_NO_DATA.slice(0, 4))) return '資料不足';
  return '公式不適用';
}

// ─── F10 明日漲跌停價（價格參考帶）──────────────────────────────
// 原本是 prevClose × 1.1／0.9 再 toFixed(2)＝**今天的**漲跌停、且不是合法檔位（9929 跌停日顯示 12.29，應 12.30）。
// 改：今收 × 1.1 向下取檔、× 0.9 向上取檔；檔位以 raw 價決定（與 isLimitUp 同法）。
// 檔位表由呼叫端注入（本檔零 import：股票用 twse-api 的 tickSize，ETF 用下面的 ETF 表）；興櫃無漲跌停，呼叫端不列。
// ⚠ ETF 呼叫端也不列（2026-10-08 審查）：國外成分 ETF 沒有漲跌幅限制，本站沒有接入哪些 ETF 無漲跌幅的名單 ⇒ 來源未知時保守不列。
// ⚠ 這是「今收 ×1.1／×0.9」的試算：除權息日參考價會變、新上市初期無漲跌幅限制，畫面要附註（個股頁價格參考帶）。

/** ETF 檔位（<50 元 0.01、≥50 元 0.05；同 scripts/lib/ai-stoploss-base.mjs） */
export const etfTickSize = (p: number): number => (p < 50 ? 0.01 : 0.05);

export function nextLimitPrices(close: number, tick: (p: number) => number): { up: number; down: number } | null {
  if (!(close > 0)) return null;
  const rawUp = close * 1.1;
  const rawDown = close * 0.9;
  const tu = tick(rawUp);
  const td = tick(rawDown);
  const up = Math.floor(rawUp / tu + 1e-9) * tu;
  const down = Math.ceil(rawDown / td - 1e-9) * td;
  return { up: parseFloat(up.toFixed(2)), down: parseFloat(down.toFixed(2)) };
}

// ─── F14 產業別一行（只用 API 已有欄位；99／ETF／ESB 是程式內部代碼，不得稱官方產業代碼）──

export function industryLineOf(
  ind: { code: string; name: string; emoji?: string },
  cp: { dataSource?: string } | null | undefined,
): string {
  if (ind.code === 'ETF') return '📈 ETF（基金，無產業別）';
  if (ind.code === 'ESB') return '🌱 興櫃（官方產業別尚未接入）';
  if (cp && cp.dataSource && cp.dataSource !== 'none' && /^\d{2}$/.test(ind.code) && ind.code !== '99') {
    return `${ind.emoji ? `${ind.emoji} ` : ''}產業別：${ind.name}（官方產業代碼 ${ind.code}）`;
  }
  return '產業別：來源未提供';
}
