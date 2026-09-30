// ============================================================
// Single-stock analysis enrichment (server-only) — Phase 2 steps 2-4.
// Takes the base technical ScoredStock and layers on:
//   2) MA-support buy zones (objective, vs arbitrary intraday %)
//   4) volatility-based sell-target probabilities
//   3) valuation / chips bonus, reasons and risk flags
// Returns the enriched ScoredStock plus the raw snapshot/fundamentals
// so the UI can show the underpinning data.
// ============================================================

import type { ScoredStock, BuyZone } from './scoring-server';
import { gradeFromScore } from './scoring';
import type { DailyBar } from './history-store';
import {
  computeIndicators, maSupportBuyZones, dailyVolatilityPct, targetTouchProbability, calculateAtrStop,
  type TechnicalSnapshot,
} from './indicators';
import { computeSwingSignal, type SwingSignal } from './signal-score';
import { analyzeNews, type NewsLite, type NewsSentiment } from './news-sentiment';
import type { FundamentalSignals } from './fundamentals-server';

const PULLBACK_HORIZON_DAYS = 20; // window for buy-zone pullback probability

/** 把買進訊號壓成 WATCH（追高、走勢轉空、強利空時用；其他訊號不動） */
const capBuy = (s: ScoredStock['signal']): ScoredStock['signal'] => (s === 'STRONG_BUY' || s === 'BUY' ? 'WATCH' : s);

function holdDaysToNumber(holdDays: string): number {
  // crude parse of "3~7 個交易日" / "2~4 週" / "1~3 個月" → mid trading days
  if (holdDays.includes('月')) return 45;
  if (holdDays.includes('週')) return 18;
  const m = holdDays.match(/(\d+)\s*~\s*(\d+)/);
  if (m) return Math.round((+m[1] + +m[2]) / 2);
  return 7;
}

/** Convert MA-support zones into the ScoredStock BuyZone shape with touch probabilities. */
function maZonesToBuyZones(snap: TechnicalSnapshot, vol: number): BuyZone[] {
  const price = snap.price;
  return maSupportBuyZones(snap).map(z => {
    const dropPct = ((price - z.price) / price) * 100; // how far below current price
    const probability = dropPct <= 0 ? 85 : targetTouchProbability(dropPct, vol, PULLBACK_HORIZON_DAYS);
    return {
      label: z.label,
      price: z.price,
      priceRange: [parseFloat((z.price * 0.99).toFixed(2)), parseFloat((z.price * 1.01).toFixed(2))],
      rationale: `${z.basis}；自現價回測約 ${dropPct.toFixed(1)}%，為客觀技術支撐區`,
      pattern: '均線支撐',
      probability,
      riskReward: z.type === 'standard' ? 2.0 : z.type === 'conservative' ? 2.8 : 4.0,
      type: z.type,
    };
  });
}

export interface EnrichedAnalysis {
  stock: ScoredStock;
  indicators: TechnicalSnapshot | null;
  fundamentals: FundamentalSignals | null;
  /** Swing signal (chjm-ai methodology) — history-based discipline score. */
  swingSignal: SwingSignal | null;
  /** News sentiment (20% weight) — bullish/bearish + validity, deduped. */
  newsSentiment: NewsSentiment | null;
  enriched: { buyZones: boolean; sellProb: boolean; fundamentals: boolean; swing: boolean; news: boolean };
}

/**
 * Enrich a base ScoredStock with history-derived and fundamentals-derived
 * signals. All inputs optional — missing data degrades gracefully so the
 * base technical analysis still returns.
 */
export function enrichScoredStock(
  base: ScoredStock,
  bars: DailyBar[] | null,
  fund: FundamentalSignals | null,
  newsItems?: NewsLite[] | null,
  livePrice?: number | null,   // 盤中即時價：只影響 swingSignal 的現價位置判定
): EnrichedAnalysis {
  const stock: ScoredStock = { ...base };
  const snap = bars ? computeIndicators(bars) : null;
  const swingSignal = bars ? computeSwingSignal(bars, livePrice) : null;
  const newsSentiment = newsItems && newsItems.length ? analyzeNews(newsItems) : null;
  const enriched = { buyZones: false, sellProb: false, fundamentals: false, swing: false, news: false };

  // ── Step 2: MA-support buy zones ──
  if (snap) {
    const vol = dailyVolatilityPct(bars!);
    const maZones = maZonesToBuyZones(snap, vol);
    if (maZones.length > 0) {
      stock.buyZones = maZones;
      enriched.buyZones = true;

      // Keep the stop loss coherent with the (now MA-based) entries: place it
      // ~4% below the standard buy zone so 停損 < 買點 always holds.
      const standard = maZones.find(z => z.type === 'standard') ?? maZones[0];
      if (standard) {
        // 波動率停損(ATR)取代固定 -4%：依個股波動自動調整停損距離。
        const atrStop = calculateAtrStop(bars!, stock.price, standard.price);
        if (atrStop) {
          stock.stopLoss = atrStop.price;
          stock.stopLossRationale = atrStop.rationale;
        } else {
          stock.stopLoss = parseFloat((standard.price * 0.96).toFixed(2));
          stock.stopLossRationale = `跌破標準買點（20日均線−2%）約 -4%，視為波段趨勢轉弱的停損點`;
        }

        // 停利目標依「風險報酬比」與停損距離一致校準：以標準買點為進場、
        // 停損距離為 1R，TP1=1.5R / TP2=2.5R / TP3=4R。高波動股停損寬→目標
        // 也按比例放大，盈虧比一致(專業風控)。
        const entry = standard.price;
        const risk = entry - stock.stopLoss; // 每股風險(1R)
        if (risk > 0) {
          const R: Record<string, number> = { tp1: 1.5, tp2: 2.5, tp3: 4 };
          stock.sellTargets = stock.sellTargets.map(t => {
            const mult = R[t.type];
            if (!mult) return t; // trailing 不變
            const price = parseFloat((entry + mult * risk).toFixed(2));
            const gainPercent = parseFloat((((price - entry) / entry) * 100).toFixed(1));
            return { ...t, price, gainPercent, rationale: `風險報酬比 ${mult}:1（停利距離 = ${mult}×停損距離，依 ATR 校準）；目標 ${price}、約 +${gainPercent}%。` };
          });
        }
      }

      // ── Step 3b: 進場計畫自我一致性 ──
      // 均線支撐買點在多頭噴出時會遠低於現價，tp1 跟著落在現價下方。
      // 數字沒錯，錯在沒講前提 —— 這裡把前提標出來給呈現層用。
      {
        const entryPrice = standard.price;
        const tp1 = stock.sellTargets.find(t => t.type === 'tp1');
        const gapPct = stock.price > 0
          ? parseFloat((((stock.price - entryPrice) / stock.price) * 100).toFixed(1))
          : 0;
        stock.entryPlan = {
          gapPct,
          pullbackRequired: gapPct > 1,
          targetBelowPrice: !!tp1 && tp1.price <= stock.price,
        };
      }

      // ── Step 4: volatility-based sell-target probabilities ──
      stock.sellTargets = stock.sellTargets.map(t =>
        t.type === 'trailing'
          ? t
          : { ...t, probability: targetTouchProbability(t.gainPercent, vol, holdDaysToNumber(t.holdDays)) },
      );
      enriched.sellProb = true;
    }
  }

  // ── Step 3: valuation / chips ──
  if (fund && (fund.reasons.length || fund.riskFlags.length || fund.bonus !== 0)) {
    const newScore = Math.max(0, Math.min(100, stock.score + fund.bonus));
    stock.score = newScore;
    stock.grade = gradeFromScore(newScore);
    // Re-derive signal with the same rules as the base scorer.
    const chgUp = stock.changePercent > 0;
    if (stock.isDisposition) stock.signal = 'NEUTRAL';
    else if (newScore >= 80 && chgUp) stock.signal = stock.isAttention ? 'WATCH' : 'STRONG_BUY';
    else if (newScore >= 65 && chgUp) stock.signal = stock.isAttention ? 'WATCH' : 'BUY';
    else if (newScore >= 55) stock.signal = 'WATCH';
    else stock.signal = 'NEUTRAL';
    // 未含風險扣分的評分／訊號同步加上基本面分（否則 baseScore − score 就不再等於處置／注意扣分）
    stock.baseScore = +Math.max(0, Math.min(100, stock.baseScore + fund.bonus)).toFixed(2);
    stock.baseSignal = stock.baseScore >= 80 && chgUp ? 'STRONG_BUY'
      : stock.baseScore >= 65 && chgUp ? 'BUY'
      : stock.baseScore >= 55 ? 'WATCH' : 'NEUTRAL';

    stock.reasons = [...stock.reasons, ...fund.reasons].slice(0, 8);
    stock.risks = [...stock.risks, ...fund.riskFlags].slice(0, 8);
    enriched.fundamentals = true;
  }

  // ── Swing-signal discipline (chjm-ai methodology) — win-rate lever ──
  if (swingSignal) {
    enriched.swing = true;
    // Merge a couple of the swing discipline reasons/risks (deduped).
    const merge = (base: string[], add: string[], cap: number) =>
      [...base, ...add.filter(a => !base.includes(a))].slice(0, cap);
    stock.reasons = merge(stock.reasons, swingSignal.reasons, 9);
    stock.risks = merge(stock.risks, swingSignal.risks, 9);
    // 不追高：never present an extended (bias>5%) stock as BUY/STRONG_BUY.
    if (swingSignal.chase) {
      stock.signal = capBuy(stock.signal);
      stock.baseSignal = capBuy(stock.baseSignal);   // 追高／走勢轉空／強利空的壓制與風險無關 ⇒ 未含風險的訊號同樣套用
    }
    // If swing model is clearly bearish, don't show a buy signal.
    if (swingSignal.action === 'SELL' || swingSignal.action === 'STRONG_SELL') {
      stock.signal = capBuy(stock.signal);
      stock.baseSignal = capBuy(stock.baseSignal);
    }
  }

  // ── News sentiment (20% weight) — applied ONLY when news is actually
  //    obtained. If no news (null) or none de-duped (total 0), the news
  //    weight is excluded entirely — no neutral placeholder, no reserved
  //    proportion — so the score stands purely on technical/fundamentals.
  if (newsSentiment && newsSentiment.total > 0 && newsSentiment.adjustment !== 0) {
    enriched.news = true;
    // ⚠ 2026-09-18 權值稽核 D3：新聞調分**不再改變分數與等級**，只呈現判別與「若計分會是幾分」。
    //   ±20 是評分器最大單一槓桿，但幅度是設計值（EXPERIMENTS.md 待驗證表明寫「不要再調大」），
    //   且 newsVerdictReview 的 c2c 口徑目前為負；幅度要等校準表（NEWS-VERDICT-LEARNING-PLAN 第二段）給。
    //   利空的「壓成 WATCH」保留：那是刪掉爛的（風險提示），不是把好的排前面。
    if (newsSentiment.adjustment > 0) {
      // 把 AI 的判別理由帶出來——只寫「+N 分」等於要使用者盲信分數。
      // 沒有理由時退回原本的措辭，不編造。
      stock.reasons = [
        newsSentiment.verdictReason
          ? `📰 新聞面偏多（AI讀內文：${newsSentiment.verdictReason}）· 未計分（幅度待校準，參考值 +${newsSentiment.adjustment}）`
          : `📰 新聞面偏多（${newsSentiment.bull} 則利多）· 未計分（幅度待校準，參考值 +${newsSentiment.adjustment}）`,
        ...stock.reasons].slice(0, 9);
    } else {
      stock.risks = [
        newsSentiment.verdictReason
          ? `📰 新聞面偏空（AI讀內文：${newsSentiment.verdictReason}）· 未計分（風險提示，參考值 ${newsSentiment.adjustment}）`
          : `📰 新聞面偏空（${newsSentiment.bear} 則利空）· 未計分（風險提示，參考值 ${newsSentiment.adjustment}）`,
        ...stock.risks].slice(0, 9);
      // Strongly negative news caps an over-optimistic buy signal.
      if (newsSentiment.adjustment <= -10) {
        stock.signal = capBuy(stock.signal);
        stock.baseSignal = capBuy(stock.baseSignal);
      }
    }
  }

  return { stock, indicators: snap, fundamentals: fund, swingSignal, newsSentiment, enriched };
}
