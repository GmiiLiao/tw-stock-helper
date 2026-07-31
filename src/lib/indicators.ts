// ============================================================
// Technical indicators over a daily-bar history (PURE, client-safe).
// Builds on the primitives in twse-api.ts (SMA/EMA/RSI/MACD/KD/Bollinger)
// and adds the higher-level snapshot the scoring engine needs:
// Taiwan moving averages, support/resistance levels, 52-week range,
// trend classification, and MA-support-based buy zones.
//
// Consumes DailyBar[] from the history store, so it works the same on
// the server (scoring / after-close analysis) and the client.
// ============================================================

import {
  calculateSMA, calculateRSI, calculateMACD, calculateKD, calculateBollingerBands,
} from './twse-api';
import type { DailyBar } from './history-store';

/** Taiwan moving-average conventions (trading days). */
export const MA_PERIODS = { ma5: 5, ma10: 10, ma20: 20, ma60: 60, ma120: 120, ma240: 240 } as const;
export type MaKey = keyof typeof MA_PERIODS;

export interface TechnicalSnapshot {
  price: number;
  ma: Record<MaKey, number | null>;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  k: number | null;
  d: number | null;
  boll: { upper: number | null; mid: number | null; lower: number | null };
  /** Support prices below the current price, nearest first. */
  support: number[];
  /** Resistance prices above the current price, nearest first. */
  resistance: number[];
  week52High: number;
  week52Low: number;
  /** % distance from the 52-week high (negative = below high). */
  distFromHigh: number;
  /** % distance from the 52-week low (positive = above low). */
  distFromLow: number;
  /** Long-term trend from MA alignment. */
  trend: 'up' | 'down' | 'side';
  bars: number; // sample size used
}

const last = <T>(arr: T[]): T | undefined => arr[arr.length - 1];
const round2 = (n: number) => parseFloat(n.toFixed(2));

/** Find local swing lows/highs over a ±window neighbourhood. */
function swingLevels(values: number[], window = 5): { lows: number[]; highs: number[] } {
  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = window; i < values.length - window; i++) {
    const seg = values.slice(i - window, i + window + 1);
    if (values[i] === Math.min(...seg)) lows.push(values[i]);
    if (values[i] === Math.max(...seg)) highs.push(values[i]);
  }
  return { lows, highs };
}

/**
 * Compute the full technical snapshot from a daily-bar history.
 * Returns null if there are too few bars to be meaningful (< 20).
 */
export function computeIndicators(bars: DailyBar[]): TechnicalSnapshot | null {
  if (!bars || bars.length < 20) return null;

  const closes = bars.map(b => b.c);
  const highs = bars.map(b => b.h);
  const lows = bars.map(b => b.l);
  const price = closes[closes.length - 1];

  const ma = {} as Record<MaKey, number | null>;
  for (const key of Object.keys(MA_PERIODS) as MaKey[]) {
    const v = last(calculateSMA(closes, MA_PERIODS[key]));
    ma[key] = v == null ? null : round2(v);
  }

  const rsi = last(calculateRSI(closes)) ?? null;
  const { macd, signal, histogram } = calculateMACD(closes);
  const { k, d } = calculateKD(highs, lows, closes);
  const boll = calculateBollingerBands(closes);

  // 52-week (≈ last 240 trading days) range
  const windowBars = bars.slice(-240);
  const week52High = Math.max(...windowBars.map(b => b.h));
  const week52Low = Math.min(...windowBars.map(b => b.l));

  // Support/resistance: MA levels + recent swing levels (last ~120 bars), 52w extremes
  const recent = closes.slice(-120);
  const { lows: swingLows, highs: swingHighs } = swingLevels(recent);
  const maValues = (Object.values(ma).filter(v => v != null) as number[]);

  const supportCandidates = [...maValues, ...swingLows, week52Low].filter(v => v < price);
  const resistanceCandidates = [...maValues, ...swingHighs, week52High].filter(v => v > price);

  const dedupeNear = (arr: number[], desc: boolean) => {
    const sorted = [...new Set(arr.map(round2))].sort((a, b) => (desc ? b - a : a - b));
    const out: number[] = [];
    for (const v of sorted) {
      if (out.every(o => Math.abs(o - v) / price > 0.015)) out.push(v); // ≥1.5% apart
      if (out.length >= 4) break;
    }
    return out;
  };

  const support = dedupeNear(supportCandidates, true);     // nearest below first
  const resistance = dedupeNear(resistanceCandidates, false); // nearest above first

  // Trend from MA alignment (bullish stack vs bearish stack)
  let trend: TechnicalSnapshot['trend'] = 'side';
  const { ma20, ma60, ma120 } = ma;
  if (ma20 != null && ma60 != null && ma120 != null) {
    if (price > ma20 && ma20 > ma60 && ma60 > ma120) trend = 'up';
    else if (price < ma20 && ma20 < ma60 && ma60 < ma120) trend = 'down';
  }

  return {
    price: round2(price),
    ma,
    rsi,
    macd: last(macd) ?? null,
    macdSignal: last(signal) ?? null,
    macdHist: last(histogram) ?? null,
    k: last(k) ?? null,
    d: last(d) ?? null,
    boll: { upper: last(boll.upper) ?? null, mid: last(boll.middle) ?? null, lower: last(boll.lower) ?? null },
    support,
    resistance,
    week52High: round2(week52High),
    week52Low: round2(week52Low),
    distFromHigh: round2(((price - week52High) / week52High) * 100),
    distFromLow: round2(((price - week52Low) / week52Low) * 100),
    trend,
    bars: bars.length,
  };
}

// ── Volatility & target-touch probability (Phase 2 step 4) ──

/** Standard deviation of daily % returns over the last `lookback` bars. */
export function dailyVolatilityPct(bars: DailyBar[], lookback = 60): number {
  if (!bars || bars.length < 5) return 0;
  const closes = bars.slice(-(lookback + 1)).map(b => b.c);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * 100; // in %
}

/**
 * ATR — Average True Range (Wilder). 衡量個股「日均真實波幅」(含跳空)，
 * 是設定波動率停損的標準依據。回傳價格單位的 ATR(period)。
 * True Range = max(高−低, |高−昨收|, |低−昨收|)。
 */
export function calculateATR(bars: DailyBar[], period = 14): number {
  if (!bars || bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  if (recent.length === 0) return 0;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

/**
 * 波動率停損 (volatility-adjusted stop) — 比固定百分比更穩健：
 * 把停損放在「最近結構支撐(20MA / 近10日低點)下方 0.5×ATR」，並依風控
 * 限制在 −3%~−15% 之間。高波動股自動給較寬停損(不被雜訊洗出)、低波動股較緊。
 */
export function calculateAtrStop(
  bars: DailyBar[],
  price: number,
  supportHint?: number,
  atrMult = 0.5,
): { price: number; atr: number; lossPct: number; support: number; rationale: string } | null {
  if (!bars || bars.length < 15 || !(price > 0)) return null;
  const atr = calculateATR(bars, 14);
  if (!(atr > 0)) return null;
  const recentLow = Math.min(...bars.slice(-10).map(b => b.l).filter(v => v > 0));
  // 候選結構支撐：低於現價、最接近現價者為主支撐。
  const candidates = [supportHint, recentLow].filter((v): v is number => typeof v === 'number' && v > 0 && v < price);
  const support = candidates.length ? Math.max(...candidates) : price - atr;
  let stop = support - atrMult * atr;            // 跌破支撐 + 半個 ATR 緩衝
  const minStop = price * 0.85, maxStop = price * 0.97; // 風控：−3%~−15%
  stop = Math.min(Math.max(stop, minStop), maxStop);
  const lossPct = ((stop - price) / price) * 100;
  return {
    price: +stop.toFixed(2),
    atr: +atr.toFixed(2),
    lossPct: +lossPct.toFixed(1),
    support: +support.toFixed(2),
    rationale: `波動率停損：ATR(14)=${atr.toFixed(2)}（個股日均波幅）。停損設於支撐 ${support.toFixed(2)} 下方約 ${atrMult}×ATR ≈ ${stop.toFixed(2)}（風險 ${lossPct.toFixed(1)}%）。距離依個股波動自動調整——高波動股停損較寬以免被雜訊洗出。`,
  };
}

/** Standard normal CDF (Abramowitz–Stegun approximation). */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/**
 * Probability that price touches a +gainPct level within `days`, modelled as a
 * driftless geometric random walk:  P(touch) ≈ 2·(1 − Φ(b / (σ√T))),
 * where b = ln(1+gain), σ = daily vol, T = days. Replaces hard-coded TP odds.
 * Returns an integer 1..95.
 */
export function targetTouchProbability(gainPct: number, dailyVolPct: number, days: number): number {
  const sigma = dailyVolPct / 100;
  if (sigma <= 0 || days <= 0) return gainPct <= 0 ? 90 : 30;
  const b = Math.log(1 + gainPct / 100);
  const z = b / (sigma * Math.sqrt(days));
  const p = 2 * (1 - normCdf(z));
  return Math.max(1, Math.min(95, Math.round(p * 100)));
}

export interface MaBuyZone {
  label: string;
  price: number;
  basis: string;       // which MA/level this is anchored to
  type: 'standard' | 'conservative' | 'dip';
}

/**
 * MA-support-based buy zones (Phase 2): anchor entries to objective moving
 * averages rather than an arbitrary % off the intraday close.
 *   standard     = 20MA − 2%
 *   conservative = 60MA (季線) − 3%
 *   dip          = 120MA (半年線) − 5%
 * Falls back gracefully when a given MA isn't available yet.
 */
export function maSupportBuyZones(snap: TechnicalSnapshot): MaBuyZone[] {
  const zones: MaBuyZone[] = [];
  if (snap.ma.ma20 != null) {
    zones.push({ label: '標準買點', price: round2(snap.ma.ma20 * 0.98), basis: '20日均線(月線) −2%', type: 'standard' });
  }
  if (snap.ma.ma60 != null) {
    zones.push({ label: '保守買點', price: round2(snap.ma.ma60 * 0.97), basis: '60日均線(季線) −3%', type: 'conservative' });
  }
  if (snap.ma.ma120 != null) {
    zones.push({ label: '逢低佈局', price: round2(snap.ma.ma120 * 0.95), basis: '120日均線(半年線) −5%', type: 'dip' });
  }
  return zones;
}
