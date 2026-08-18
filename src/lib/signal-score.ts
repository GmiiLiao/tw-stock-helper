// ============================================================
// Swing signal score (PURE, client-safe).
//
// Methodology adapted from the open-source skill
//   chjm-ai/stock-daily-analysis-skill (github.com/chjm-ai/stock-daily-analysis-skill)
// ported from its Python/akshare A-share engine to TypeScript over our
// Taiwan daily-bar history. A 100-point weighted model that emphasises
// swing-entry DISCIPLINE — the key win-rate lever:
//   • 乖離率 (bias from MA5): reward pullback-to-MA entries, penalise chasing
//     extended stocks (bias > 5% → 嚴禁追高).
//   • 量價配合 (volume status): reward healthy low-volume pullbacks.
//   • MACD 零軸上金叉, MA support, RSI zones, trend stage.
//
// Components (total 100): trend 30 + bias 20 + volume 15 + MA 10 + MACD 15 + RSI 10.
// Output is a second, history-based opinion that complements the intraday
// momentum score in scoring.ts.
// ============================================================

import { calculateSMA, calculateMACD, calculateRSI } from './twse-api';
import type { DailyBar } from './history-store';

export type SwingAction = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'WAIT' | 'SELL' | 'STRONG_SELL';
export type TrendStage = '強勢多頭' | '多頭' | '弱多' | '盤整' | '弱空' | '空頭' | '強勢空頭';

export interface SwingSignal {
  score: number;            // 0-100
  action: SwingAction;
  actionLabel: string;
  trend: TrendStage;
  biasPct: number;          // 乖離率 vs MA5 (%)
  components: { trend: number; bias: number; volume: number; ma: number; macd: number; rsi: number };
  reasons: string[];
  risks: string[];
  chase: boolean;           // true = 追高風險（bias > 5%）
}

const ACTION_LABEL: Record<SwingAction, string> = {
  STRONG_BUY: '強力買進', BUY: '買進', HOLD: '持有', WAIT: '觀望', SELL: '賣出', STRONG_SELL: '強力賣出',
};

const lastNum = (a: (number | null)[]): number | null => {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i] as number;
  return null;
};

/** Compute the swing signal from a daily-bar history (needs ≥ 20 bars). */
/**
 * @param livePrice 盤中即時價（2026-08-18 使用者指正「開盤後應用今日分析」）：
 * 均線/RSI/MACD 仍以**已收盤K**計（未收盤K盤中會變臉），但「現價 vs 結構」的
 * 判定（趨勢位置/乖離/追高禁令）改用即時價——否則跳空日整天沿用昨收判定。
 * 不傳＝行為與舊版完全相同（回測 PIT 安全）。
 */
export function computeSwingSignal(bars: DailyBar[], livePrice?: number | null): SwingSignal | null {
  if (!bars || bars.length < 20) return null;
  const closes = bars.map(b => b.c);
  const vols = bars.map(b => b.v);
  const n = closes.length - 1;
  const price = livePrice && livePrice > 0 ? livePrice : closes[n];

  const ma5 = lastNum(calculateSMA(closes, 5)) ?? price;
  const ma10 = lastNum(calculateSMA(closes, 10)) ?? price;
  const ma20 = lastNum(calculateSMA(closes, 20)) ?? price;
  const ma60 = lastNum(calculateSMA(closes, 60)) ?? ma20;

  const reasons: string[] = [];
  const risks: string[] = [];

  // ── Trend stage (30) ──
  let trend: TrendStage;
  let trendPts: number;
  if (price > ma5 && ma5 > ma10 && ma10 > ma20 && ma20 > ma60) { trend = '強勢多頭'; trendPts = 30; }
  else if (price > ma20 && ma5 > ma20) { trend = '多頭'; trendPts = 26; }
  else if (price > ma20) { trend = '弱多'; trendPts = 18; }
  else if (price >= ma20 * 0.98 && price <= ma20 * 1.02) { trend = '盤整'; trendPts = 12; }
  else if (price < ma20 && price > ma60) { trend = '弱空'; trendPts = 8; }
  else if (price < ma5 && ma5 < ma10 && ma10 < ma20 && ma20 < ma60) { trend = '強勢空頭'; trendPts = 0; }
  else { trend = '空頭'; trendPts = 4; }
  if (trendPts >= 26) reasons.push(`📈 均線${trend}排列，多方架構`);
  else if (trendPts <= 4) risks.push(`📉 均線${trend}排列，趨勢偏弱`);

  // ── Bias / 乖離率 vs MA5 (20) — 不追高紀律 ──
  const biasPct = ma5 > 0 ? ((price - ma5) / ma5) * 100 : 0;
  let biasPts: number;
  let chase = false;
  if (biasPct < -5) { biasPts = 8; risks.push(`⚠️ 乖離率 ${biasPct.toFixed(1)}%，偏離過深、籌碼鬆動`); }
  else if (biasPct < -3) { biasPts = 16; reasons.push(`✅ 回踩 MA5（乖離 ${biasPct.toFixed(1)}%），良好買點`); }
  else if (biasPct < 0) { biasPts = 20; reasons.push(`✅ 貼近 MA5（乖離 ${biasPct.toFixed(1)}%），最佳進場區`); }
  else if (biasPct < 2) { biasPts = 18; reasons.push(`✅ 沿 MA5 緩升（乖離 +${biasPct.toFixed(1)}%）`); }
  else if (biasPct < 5) { biasPts = 14; reasons.push(`📊 乖離 +${biasPct.toFixed(1)}%，僅宜小倉`); }
  else { biasPts = 4; chase = true; risks.push(`🚫 乖離 +${biasPct.toFixed(1)}% 過大，嚴禁追高（等回測）`); }

  // ── Volume status (15) — 量價配合 ──
  const volMa5 = vols.slice(-6, -1).reduce((a, b) => a + b, 0) / 5 || vols[n] || 1;
  const todayVol = vols[n];
  const chgUp = closes[n] >= closes[n - 1];
  const heavy = todayVol > volMa5 * 1.5;
  const shrink = todayVol < volMa5 * 0.7;
  let volPts: number;
  if (shrink && !chgUp) { volPts = 15; reasons.push('🔉 量縮回調，賣壓衰竭、健康洗盤'); }
  else if (heavy && chgUp) { volPts = 12; reasons.push('🔊 量增上漲，買盤積極'); }
  else if (shrink && chgUp) { volPts = 6; risks.push('量縮上漲，動能不足'); }
  else if (heavy && !chgUp) { volPts = 0; risks.push('🔻 量增下跌，主力出貨疑慮'); }
  else { volPts = 10; }

  // ── MA support (10) ──
  let maPts = 0;
  if (price >= ma5 && price <= ma5 * 1.02) maPts += 5;
  if (price >= ma10 && price <= ma10 * 1.02) maPts += 5;
  if (maPts >= 5) reasons.push('🧱 站穩均線支撐');

  // ── MACD (15) — 零軸上金叉最強 ──
  const { macd, signal: macdSig } = calculateMACD(closes);
  const m1 = macd[n], s1 = macdSig[n], m0 = macd[n - 1], s0 = macdSig[n - 1];
  let macdPts = 5;
  if (m1 != null && s1 != null && m0 != null && s0 != null) {
    const goldenCross = m0 <= s0 && m1 > s1;
    const deathCross = m0 >= s0 && m1 < s1;
    if (goldenCross && m1 > 0) { macdPts = 15; reasons.push('🟢 MACD 零軸上金叉，強多訊號'); }
    else if (goldenCross) { macdPts = 12; reasons.push('🟢 MACD 金叉'); }
    else if (m1 > s1 && m1 > 0) { macdPts = 10; }
    else if (m1 > s1) { macdPts = 8; }
    else if (deathCross) { macdPts = 0; risks.push('🔴 MACD 死叉，動能轉空'); }
    else { macdPts = 2; }
  }

  // ── RSI (10) ──
  const rsi = lastNum(calculateRSI(closes));
  let rsiPts = 5;
  if (rsi != null) {
    if (rsi < 30) { rsiPts = 10; reasons.push(`💧 RSI ${rsi.toFixed(0)} 超賣，反彈機會`); }
    else if (rsi >= 60 && rsi <= 70) { rsiPts = 8; reasons.push(`💪 RSI ${rsi.toFixed(0)} 強勢`); }
    else if (rsi > 40 && rsi < 60) { rsiPts = 5; }
    else if (rsi >= 30 && rsi <= 40) { rsiPts = 3; }
    else { rsiPts = 0; risks.push(`🔥 RSI ${rsi.toFixed(0)} 超買，過熱`); }
  }

  const score = trendPts + biasPts + volPts + maPts + macdPts + rsiPts;

  // ── Classification ──
  let action: SwingAction;
  if (trend === '強勢空頭') action = 'STRONG_SELL';
  else if (trend === '空頭') action = 'SELL';
  else if (score >= 75 && (trend === '強勢多頭' || trend === '多頭')) action = 'STRONG_BUY';
  else if (score >= 60 && (trend === '強勢多頭' || trend === '多頭' || trend === '弱多')) action = 'BUY';
  else if (score >= 45) action = 'HOLD';
  else if (score >= 30) action = 'WAIT';
  else action = 'SELL';
  // 不追高 override: never STRONG_BUY/BUY a stock extended > 5% above MA5.
  if (chase && (action === 'STRONG_BUY' || action === 'BUY')) action = 'WAIT';

  return {
    score, action, actionLabel: ACTION_LABEL[action], trend,
    biasPct: parseFloat(biasPct.toFixed(2)),
    components: { trend: trendPts, bias: biasPts, volume: volPts, ma: maPts, macd: macdPts, rsi: rsiPts },
    reasons: reasons.slice(0, 6), risks: risks.slice(0, 5), chase,
  };
}
