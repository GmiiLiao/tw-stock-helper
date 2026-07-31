// ============================================================
// Scoring primitives — PURE, client-safe (no fetch, no node APIs).
// Single source of truth for grade thresholds, target-price markup,
// and the lightweight per-stock rating used for synchronous, live
// client-side display (e.g. WatchlistTracker target price that tracks
// the intraday quote).
//
// The richer server scorer (lib/scoring-server.ts, with risk overlay,
// patterns and buy/sell zones) builds on these same primitives so the
// math never diverges between client and server.
// ============================================================

export type Grade = 'A+' | 'A' | 'B+' | 'B' | 'C';
export type Signal = 'STRONG_BUY' | 'BUY' | 'WATCH' | 'NEUTRAL';

/** Minimal shape needed to rate a stock (a superset of the live quote). */
export interface RatableStock {
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  value?: number;
  open: number;
  high: number;
  low: number;
  transactions?: number;
}

export function gradeFromScore(score: number): Grade {
  if (score >= 85) return 'A+';
  if (score >= 75) return 'A';
  if (score >= 65) return 'B+';
  if (score >= 55) return 'B';
  return 'C';
}

export function targetPriceFromGrade(grade: Grade, price: number): number {
  let markup = 1.05;
  if (grade === 'A+') markup = 1.12;
  else if (grade === 'A') markup = 1.08;
  else if (grade === 'B+') markup = 1.05;
  else if (grade === 'B') markup = 1.03;
  else markup = 1.01;
  return parseFloat((price * markup).toFixed(2));
}

/**
 * Lightweight 5-factor rating (no risk overlay) — score/grade/signal.
 * Mirrors the factor math in scoreStock(); used for synchronous client
 * display where an API round-trip per row is undesirable.
 */
export function getAiRating(s: RatableStock): { score: number; grade: Grade; signal: Signal } {
  const chg = s.changePercent;
  const val = s.value || (s.price * s.volume);

  // Factor 1: Momentum (20)
  let momentumScore = 0;
  if (chg > 7) momentumScore = 20;
  else if (chg > 4) momentumScore = 17;
  else if (chg > 2) momentumScore = 14;
  else if (chg > 0) momentumScore = 10;
  else if (chg === 0) momentumScore = 6;
  else if (chg > -2) momentumScore = 4;
  else momentumScore = 0;

  // Factor 2: Volume (20)
  let volumeScore = 0;
  if (val > 5_000_000_000) volumeScore = 20;
  else if (val > 1_000_000_000) volumeScore = 17;
  else if (val > 500_000_000) volumeScore = 14;
  else if (val > 100_000_000) volumeScore = 10;
  else if (val > 50_000_000) volumeScore = 6;
  else volumeScore = 2;

  if (chg > 1 && val > 500_000_000) {
    volumeScore = Math.min(volumeScore + 3, 20);
  }

  // Factor 3: Intraday Position (20)
  let trendScore = 0;
  const range = s.high - s.low;
  const cp = range > 0 ? (s.price - s.low) / range : 0.5;
  if (cp >= 0.85) trendScore = 20;
  else if (cp >= 0.70) trendScore = 16;
  else if (cp >= 0.50) trendScore = 12;
  else if (cp >= 0.30) trendScore = 7;
  else trendScore = 3;

  if (s.open > (s.price - s.change) * 1.005 && chg > 1) {
    trendScore = Math.min(trendScore + 2, 20);
  }

  // Factor 4: Stability (20)
  let stabilityScore = 0;
  if (s.price >= 500) stabilityScore = 18;
  else if (s.price >= 100) stabilityScore = 16;
  else if (s.price >= 30) stabilityScore = 14;
  else if (s.price >= 10) stabilityScore = 10;
  else stabilityScore = 6;

  if ((s.transactions ?? 0) > 50000) {
    stabilityScore = Math.min(stabilityScore + 2, 20);
  }

  // Factor 5: Value/Pattern (20)
  let valueScore = 12;
  const isLimitUp   = chg >= 9.9;
  const isNearLimit = chg >= 7 && chg < 9.9;
  const isLimitDown = chg <= -9.9;

  if (isLimitUp) valueScore = 15;
  else if (isNearLimit) valueScore = 18;
  else if (isLimitDown) valueScore = 0;
  else if (chg > 0 && chg < 5) valueScore = 15;

  const score = momentumScore + volumeScore + trendScore + stabilityScore + valueScore;
  const grade = gradeFromScore(score);

  let signal: Signal = 'NEUTRAL';
  if (score >= 80 && chg > 0) signal = 'STRONG_BUY';
  else if (score >= 65 && chg > 0) signal = 'BUY';
  else if (score >= 55) signal = 'WATCH';

  return { score, grade, signal };
}

/** Grade-based target price from the lightweight rating. */
export function getTargetPrice(s: RatableStock): number {
  return targetPriceFromGrade(getAiRating(s).grade, s.price);
}
