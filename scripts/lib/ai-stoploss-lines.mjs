// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1 共用純函式·組成線原料：官方日 K 還原、ATR14、ATR 帶（calculateAtrStop 移植）、持有期最高收盤
// （重算與每日增量）、保本線與追蹤線、係數涵蓋自檢、組成線原料 lineInputsOf、官方日 K 歸檔歸屬（ETF／興櫃，A3 裁定）、
// 前端暫算的組成線 frontLinesOf。
// 對外一律經 scripts/lib/ai-stoploss.mjs（集線器）匯入；型別在 ai-stoploss.d.mts。規範 SKILL §3A、§5、§2、§3.6。
// 規則：純函式——不 import firebase、不碰網路與檔案、不讀時鐘，回傳新物件、不改輸入。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { STOP_PARAMS, ceilTick, floorTick, countTradingDays } from './ai-stoploss-base.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const EPS = 1e-9;
const round2 = n => Math.round(n * 100) / 100;

// ── 官方日 K 歸檔歸屬（SKILL §2、§13.2 A3：使用者 10-05 裁定「另建 ETF 與興櫃官方日 K 歸檔」） ─────────────

/** 歸檔名稱：chipArchive 只收 4 碼（上市／上櫃普通股與 4 碼 ETF）；5～6 碼與英文字尾 ETF、興櫃各自另建歸檔 */
export const BAR_ARCHIVES = Object.freeze({ chip: 'chipArchive', etf: 'etfDailyArchive', emerging: 'emergingDailyArchive' });

/**
 * 代號 → 官方日 K 歸檔種類：'chip'｜'etf'｜'emerging'｜null（權證、ETN 等不在範圍）。
 * market：呼叫端已知的市場別（'emerging'＝興櫃；興櫃也有 4 碼代號，必須由呼叫端告知，不能用代號猜）。
 */
export function barArchiveOf(code, market = null) {
  const c = String(code ?? '');
  if (market === 'emerging') return /^\d{4,6}[A-Z]?$/.test(c) ? 'emerging' : null;
  if (/^\d{4}$/.test(c)) return 'chip';
  if (/^00\d{2,4}[A-Z]?$/.test(c)) return 'etf';
  return null;
}

/**
 * 這個代號現在有沒有「可用的」官方日 K。chipArchive 一律可用；ETF／興櫃歸檔要通過驗證（SKILL §2 A3 驗證閘門）
 * 並由呼叫端把已驗證的歸檔種類放進 verifiedArchives，才算可用——驗證前這類持股沿用現行算法（legacyBranchActive）。
 */
export function hasOfficialBars(code, opts = {}) {
  const a = barArchiveOf(code, opts?.market ?? null);
  if (a === 'chip') return true;
  if (!a) return false;
  const v = opts?.verifiedArchives;
  if (v instanceof Set) return v.has(a);
  return Array.isArray(v) ? v.includes(a) : false;
}

// ── 日 K 整理與還原 ─────────────────────────────────────────────────────────

/** 整理成合法日 K：日期正規、收盤 >0；高低缺值以收盤補、確保 低 ≤ 開收 ≤ 高；依日期排序、同日取最後一筆 */
function cleanBars(raw) {
  const by = new Map();
  for (const b of Array.isArray(raw) ? raw : []) {
    if (!isObj(b) || !YMD_RE.test(String(b.date)) || !isPos(b.c)) continue;
    const o = isPos(b.o) ? b.o : null;
    const h = Math.max(isPos(b.h) ? b.h : b.c, b.c, o ?? 0);
    const l = Math.min(isPos(b.l) ? b.l : b.c, b.c, o ?? Infinity);
    by.set(b.date, { date: b.date, o, h, l, c: b.c, v: isNum(b.v) ? b.v : null });
  }
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const evList = ex => (Array.isArray(ex?.events) ? ex.events : []);

/**
 * 官方日 K 還原：每根的開高低收 × 該根之後、最後一根（含）之前各事件係數的連乘（成交量不動）。
 * 只乘到最後一根的日期為止：之後才生效的事件由 resolveStop 依 lines.dataDate 再乘（避免重複）。
 */
export function adjustBars(raw, ex) {
  const bars = cleanBars(raw);
  if (!bars.length) return [];
  const lastDate = bars[bars.length - 1].date;
  const events = evList(ex).filter(([d, f]) => typeof d === 'string' && isPos(f) && d <= lastDate);
  return bars.map(b => {
    const f = events.reduce((acc, [d, k]) => (d > b.date ? acc * k : acc), 1);
    if (Math.abs(f - 1) <= EPS) return b;
    return { ...b, o: b.o != null ? b.o * f : null, h: b.h * f, l: b.l * f, c: b.c * f };
  });
}

// ── ATR14 與 ATR 帶（SKILL §3A.1） ──────────────────────────────────────────

/** ATR14：最近 14 個真實波幅的簡單平均（同 src/lib/indicators.ts calculateATR）；少於 15 根回 null */
export function atr14Of(bars) {
  const b = Array.isArray(bars) ? bars : [];
  if (b.length < STOP_PARAMS.bandMinBars) return null;
  const trs = [];
  for (let i = 1; i < b.length; i++) {
    const h = b[i].h, l = b[i].l, pc = b[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-14);
  const atr = recent.reduce((a, x) => a + x, 0) / recent.length;
  return isPos(atr) ? atr : null;
}

/**
 * ATR 帶（calculateAtrStop 移植，src/lib/indicators.ts:177-201；price＝最後一根收盤、supportHint＝MA20×0.98〔＝/api/rating 標準買點〕）：
 * 支撐＝低於收盤的候選（MA20×0.98、近 10 日最低）中最高者，沒有候選時＝收盤 − ATR；帶＝支撐 − 0.5×ATR，夾在 [收盤×0.85, 收盤×0.97]，
 * **向下取檔**（留在結構外側）。少於 15 根回 null；少於 20 根沒有 MA20 候選（同 /api/rating：沒有標準買點）。
 * bars 必須是官方還原日 K（最後一根＝資料日）。
 */
export function atrBandOf(bars, isEtf = false) {
  const b = Array.isArray(bars) ? bars : [];
  if (b.length < STOP_PARAMS.bandMinBars) return null;
  const last = b[b.length - 1];
  const close = last.c;
  if (!isPos(close)) return null;
  const atr = atr14Of(b);
  if (!isPos(atr)) return null;
  const lows = b.slice(-10).map(x => x.l).filter(isPos);
  const recentLow = lows.length ? Math.min(...lows) : null;
  const ma20 = b.length >= 20 ? b.slice(-20).reduce((a, x) => a + x.c, 0) / 20 : null;
  const supportHint = ma20 != null ? round2(ma20 * 0.98) : null;
  const candidates = [supportHint, recentLow].filter(v => isPos(v) && v < close);
  const support = candidates.length ? Math.max(...candidates) : close - atr;
  const raw = Math.min(Math.max(support - STOP_PARAMS.bandAtrMult * atr, close * STOP_PARAMS.bandClampLo), close * STOP_PARAMS.bandClampHi);
  const price = floorTick(raw, isEtf);
  if (!isPos(price)) return null;
  return { price, dataDate: last.date, close, atr14: atr, support };
}

// ── 持有期最高收盤（SKILL §5.1） ────────────────────────────────────────────

/**
 * 持有期最高收盤：自 firstDate（含買進當日收盤）到最後一根的還原收盤最高值。
 * complete＝false 的情況：firstDate 早於歸檔起點（2023-07-17）、日 K 視窗起點晚於 firstDate、或（有給休市日曆時）中間有缺日。
 * 回 { price, dataDate, complete, from }（from＝計算所依據的持有期起點，持有期起點改變時呼叫端要重算）；買進日之後還沒有收盤回 null。
 */
export function holdHighClose(bars, firstDate, opts = {}) {
  if (!YMD_RE.test(String(firstDate))) return null;
  const b = Array.isArray(bars) ? bars : [];
  const inRange = b.filter(x => x.date >= firstDate && isPos(x.c));
  if (!inRange.length) return null;
  const archiveFrom = typeof opts.archiveFrom === 'string' ? opts.archiveFrom : STOP_PARAMS.archiveFrom;
  const last = inRange[inRange.length - 1];
  let complete = firstDate >= archiveFrom && b.length > 0 && b[0].date <= firstDate;
  if (complete && typeof opts.isTradingDay === 'function') {
    complete = countTradingDays(firstDate, last.date, opts.isTradingDay) === inRange.length;
  }
  return { price: Math.max(...inRange.map(x => x.c)), dataDate: last.date, complete, from: firstDate };
}

/**
 * 每日增量：上一版 × Πf（prev.dataDate < 事件日 ≤ 當日）後與當日收盤取高（bar 是當日官方收盤原始值）。
 * prev 為 null（新部位、持有期起點改變）回 null——呼叫端改用 holdHighClose 重算。同一天或更早的 bar 不重複計入。
 */
export function stepHoldHigh(prev, bar, exEvents) {
  if (!isObj(prev) || !isPos(prev.price) || !YMD_RE.test(String(prev.dataDate))) return null;
  if (!isObj(bar) || !YMD_RE.test(String(bar.date)) || !isPos(bar.c) || bar.date <= prev.dataDate) return prev;
  const f = (Array.isArray(exEvents) ? exEvents : [])
    .filter(([d, k]) => typeof d === 'string' && isPos(k) && d > prev.dataDate && d <= bar.date)
    .reduce((acc, [, k]) => acc * k, 1);
  return { ...prev, price: Math.max(prev.price * f, bar.c), dataDate: bar.date };
}

// ── 保本線與追蹤線（SKILL §5） ──────────────────────────────────────────────

/** 持有期最高收盤 ≥ 還原成本×1.10 ⇒ 保本線 ceilTick(還原成本)；≥ ×1.20 且有 ATR14 ⇒ 追蹤線 ceilTick(最高收盤 − 3×ATR14) */
export function profitLines(adjCost, holdHigh, atr14, isEtf = false) {
  const out = { beLine: null, trailLine: null };
  if (!isPos(adjCost) || !isPos(holdHigh)) return out;
  if (holdHigh >= adjCost * (1 + STOP_PARAMS.beTriggerPct / 100) - EPS) out.beLine = ceilTick(adjCost, isEtf);
  if (holdHigh >= adjCost * (1 + STOP_PARAMS.trailTriggerPct / 100) - EPS && isPos(atr14)) {
    out.trailLine = ceilTick(holdHigh - STOP_PARAMS.trailAtr * atr14, isEtf);
  }
  return out;
}

// ── 係數涵蓋（SKILL §3.4） ──────────────────────────────────────────────────

/**
 * 係數表能不能涵蓋日 K 視窗：ok ⇔ coverFrom ≤ 視窗第一根、coverTo ≥ 資料日。
 * exGapBars＝視窗中落在 [coverFrom, coverTo] 之外的根數（有給 barDates 才逐根數；沒給時不 ok 記 1）。
 */
export function exCoverageOf(ex, barsFrom, dataDate, barDates = null) {
  const from = ex?.coverFrom ?? null, to = ex?.coverTo ?? null;
  const ok = !!from && !!to && (!barsFrom || from <= barsFrom) && (!dataDate || to >= dataDate);
  if (Array.isArray(barDates)) {
    const gap = barDates.filter(d => !from || !to || d < from || d > to).length;
    return { ok: ok && gap === 0, exGapBars: gap };
  }
  return { ok, exGapBars: ok ? 0 : 1 };
}

/** 日 K 結構斷點門檻（分割／反分割候選；與 official-bars.structuralBreaks 預設同值）：停止買賣 ≥1 個交易日後收盤比 <lo 或 >hi */
export const STRUCT_BREAK = Object.freeze({ lo: 0.7, hi: 1.43 });

/**
 * ETF 日 K 視窗裡「沒有係數涵蓋的結構斷點」（SKILL §2A 驗證閘門 ⑦、§7）：回斷點**之前**的根數（那幾根沒還原，不可算 ATR 帶與
 * 持有期最高收盤）；沒有就回 0。斷點＝相鄰兩根之間隔了 ≥1 個交易日沒有成交（停止買賣）、收盤比 <lo 或 >hi，而且係數表在
 * (前一根, 這一根] 沒有任何事件。exCoverageOf 只比日期區間、擋不到缺少的事件，所以另查（2026-10-05 審查：鏡像日 K 有 9 件
 * ETF 停止買賣後的斷點不在 exright-history，例 00631L 2026-03-31、00685L 2026-07-07）。isTradingDay 沒給 ⇒ 無法判斷停止買賣，回 0。
 */
export function uncoveredBreakBars(bars, ex, isTradingDay) {
  if (typeof isTradingDay !== 'function') return 0;
  const raw = cleanBars(bars);
  const evs = evList(ex);
  let cut = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1], b = raw[i];
    const ratio = b.c / a.c;
    if (ratio >= STRUCT_BREAK.lo && ratio <= STRUCT_BREAK.hi) continue;
    if (countTradingDays(a.date, b.date, isTradingDay) - 2 < 1) continue;   // 兩端都含 ⇒ 扣掉兩根本身
    if (evs.some(([d]) => typeof d === 'string' && d > a.date && d <= b.date)) continue;
    cut = i;
  }
  return cut;
}

// ── 組成線原料（16:45 起的資料到齊班車；SKILL §3.1 lines） ─────────────────

/**
 * 官方日 K（原始，最後一根＝資料日）→ resolveStop 的 lines：還原、ATR14、ATR 帶、持有期最高收盤（prevHoldHigh 同一持有期起點時
 * 以 stepHoldHigh 增量，否則 holdHighClose 重算）、係數涵蓋缺口。沒有任何日 K ⇒ noOfficialBars（不是 linesStale，不會隨時間補齊）。
 * ETF：視窗裡有沒有係數涵蓋的結構斷點（uncoveredBreakBars）⇒ 斷點之前的根數記進 exGapBars（fail-closed：當日不採用日 K 算出的值）。
 * opts：{ isEtf, isTradingDay, archiveFrom, dataDate（沒有日 K 時記的資料日） }
 */
export function lineInputsOf(bars, firstDate, prevHoldHigh, ex, opts = {}) {
  const raw = cleanBars(bars);
  if (!raw.length) {
    return {
      dataDate: typeof opts.dataDate === 'string' ? opts.dataDate : null, close: null, atr14: null, barsFrom: null,
      atrBand: null, holdHigh: null, exGapBars: 0, noOfficialBars: true,
    };
  }
  const adj = adjustBars(raw, ex);
  const last = adj[adj.length - 1];
  const cov = exCoverageOf(ex, adj[0].date, last.date, adj.map(b => b.date));
  const breakBars = opts.isEtf ? uncoveredBreakBars(raw, ex, opts.isTradingDay) : 0;
  const band = atrBandOf(adj, !!opts.isEtf);
  let holdHigh = null;
  if (YMD_RE.test(String(firstDate))) {
    const same = isObj(prevHoldHigh) && isPos(prevHoldHigh.price) && prevHoldHigh.from === firstDate && YMD_RE.test(String(prevHoldHigh.dataDate));
    if (same && prevHoldHigh.dataDate === last.date) holdHigh = prevHoldHigh;
    else if (same && prevHoldHigh.dataDate < last.date) {
      holdHigh = prevHoldHigh;
      for (const b of raw) if (b.date > prevHoldHigh.dataDate) holdHigh = stepHoldHigh(holdHigh, b, evList(ex));
      // 上一版比日 K 視窗還舊（daemon 漏了好幾天）：中間的收盤看不到 ⇒ 不完整，不捏造
      if (prevHoldHigh.dataDate < adj[0].date) holdHigh = { ...holdHigh, complete: false };
    } else {
      holdHigh = holdHighClose(adj, firstDate, { archiveFrom: opts.archiveFrom, isTradingDay: opts.isTradingDay });
    }
  }
  return {
    dataDate: last.date, close: last.c, atr14: atr14Of(adj), barsFrom: adj[0].date,
    atrBand: band ? { price: band.price, dataDate: band.dataDate } : null,
    holdHigh, exGapBars: Math.max(cov.exGapBars, breakBars), noOfficialBars: false,
  };
}

/**
 * 前端暫算（停損簿上線前；SKILL §3.6 最後一列）的組成線：ATR 帶＝持股分析 analyses[code].stopLoss（/api/rating 的帶）向下取檔，
 * 資料日一律是「今日之前最後一個交易日」（今天買進的部位因此不套帶），close／barsFrom 為 null（帶值檢查只驗數值與檔位、不檢查涵蓋）。
 * 搭配 resolveStop 時不傳 latestCanonicalYmd（不判 linesStale）、bandRatchet:false。沒有帶或沒有前一交易日回 null（只有成本線）。
 */
export function frontLinesOf({ ratingBand, prevTradingYmd, isEtf = false } = {}) {
  const band = isPos(ratingBand) ? floorTick(ratingBand, isEtf) : null;
  if (!band || !YMD_RE.test(String(prevTradingYmd))) return null;
  return {
    dataDate: prevTradingYmd, close: null, atr14: null, barsFrom: null,
    atrBand: { price: band, dataDate: prevTradingYmd }, holdHigh: null, exGapBars: 0, noOfficialBars: false,
  };
}
