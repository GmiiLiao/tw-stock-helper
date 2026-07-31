import { NextRequest, NextResponse } from 'next/server';
import { listStoredCodes, readHistories } from '@/lib/history-store';
import { computeSwingSignal } from '@/lib/signal-score';
import { getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 120;

// ============================================================
// 回測勝率統計 — walks each stored stock's daily-bar history, and at every
// historical point recomputes the REAL swing signal (signal-score.ts) on the
// bars available up to that day. For each BUY / STRONG_BUY signal it measures
// the forward return over 5/10/20 trading days → aggregate win rate + avg
// return (overall and per signal grade). Writes backtest/latest.
//
// CRON_SECRET-guarded; triggered by the resident daemon (direct Cloud Run URL).
// ============================================================

const HOLDS = [5, 10, 20];

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'admin unavailable' }, { status: 500 });

  const sample = Math.min(parseInt(new URL(req.url).searchParams.get('sample') || '80', 10), 300);
  // Only evaluate the most recent ~window bars per stock (recent regime, bounds runtime).
  const WINDOW = 260;

  const codes = await listStoredCodes(sample);
  const hist = await readHistories(codes);

  type Agg = { signals: number; wins: number; retSum: number; byAction: Record<string, { signals: number; wins: number }> };
  const stats: Record<number, Agg> = {};
  for (const h of HOLDS) stats[h] = { signals: 0, wins: 0, retSum: 0, byAction: {} };
  let evaluated = 0;

  // 多策略對照（固定 10 日持有）：波段BUY / 創新高突破 / 均線黃金交叉。
  const STRAT_HOLD = 10;
  const strat: Record<string, { signals: number; wins: number; retSum: number }> = {
    swing: { signals: 0, wins: 0, retSum: 0 }, breakout: { signals: 0, wins: 0, retSum: 0 }, goldenCross: { signals: 0, wins: 0, retSum: 0 },
  };
  const sma = (a: number[], n: number, end: number) => (end + 1 >= n ? a.slice(end + 1 - n, end + 1).reduce((s, x) => s + x, 0) / n : null);
  const tally = (k: string, entry: number, fwd: number) => { const ret = ((fwd - entry) / entry) * 100; strat[k].signals++; if (ret > 0) strat[k].wins++; strat[k].retSum += ret; };

  for (const [, doc] of hist) {
    const bars = doc.bars;
    if (!bars || bars.length < 80) continue;
    const closes = bars.map(b => b.c);
    const highs = bars.map(b => b.h);
    const start = Math.max(60, bars.length - WINDOW);
    for (let i = start; i < bars.length - (HOLDS[HOLDS.length - 1] + 1); i++) {
      const entry = bars[i].c;
      if (!(entry > 0)) continue;
      const sig = computeSwingSignal(bars.slice(0, i + 1));
      const isSwingBuy = sig && (sig.action === 'BUY' || sig.action === 'STRONG_BUY');
      if (isSwingBuy) {
        evaluated++;
        for (const h of HOLDS) {
          const fwd = bars[i + h]; if (!fwd || !(fwd.c > 0)) continue;
          const ret = ((fwd.c - entry) / entry) * 100;
          const s = stats[h]; s.signals++; if (ret > 0) s.wins++; s.retSum += ret;
          const ba = (s.byAction[sig.action] ??= { signals: 0, wins: 0 }); ba.signals++; if (ret > 0) ba.wins++;
        }
      }
      // 多策略對照（10 日）
      const fwd10 = bars[i + STRAT_HOLD]; if (!fwd10 || !(fwd10.c > 0)) continue;
      if (isSwingBuy) tally('swing', entry, fwd10.c);
      const prior60High = Math.max(...highs.slice(Math.max(0, i - 60), i));
      if (highs[i] >= prior60High && entry > closes[i - 1]) tally('breakout', entry, fwd10.c);
      const ma5 = sma(closes, 5, i), ma20 = sma(closes, 20, i), pma5 = sma(closes, 5, i - 1), pma20 = sma(closes, 20, i - 1);
      if (ma5 && ma20 && pma5 && pma20 && pma5 <= pma20 && ma5 > ma20) tally('goldenCross', entry, fwd10.c);
    }
  }
  const strategies = Object.fromEntries(Object.entries(strat).map(([k, v]) => [k, {
    signals: v.signals, winRate: v.signals ? +((v.wins / v.signals) * 100).toFixed(1) : 0, avgReturnPct: v.signals ? +(v.retSum / v.signals).toFixed(2) : 0,
  }]));

  const holdingPeriods: Record<string, unknown> = {};
  for (const h of HOLDS) {
    const s = stats[h];
    holdingPeriods[h] = {
      signals: s.signals,
      winRate: s.signals ? +((s.wins / s.signals) * 100).toFixed(1) : 0,
      avgReturnPct: s.signals ? +(s.retSum / s.signals).toFixed(2) : 0,
      byAction: Object.fromEntries(Object.entries(s.byAction).map(([k, v]) => [k, {
        signals: v.signals, winRate: v.signals ? +((v.wins / v.signals) * 100).toFixed(1) : 0,
      }])),
    };
  }

  const result = {
    generatedAt: Date.now(),
    model: 'swing-signal (signal-score.ts)',
    sampleStocks: hist.size,
    evaluatedSignals: evaluated,
    windowBars: WINDOW,
    note: 'BUY/STRONG_BUY 訊號的未來 N 交易日報酬；win = 報酬 > 0。歷史回測，不代表未來績效。',
    holdingPeriods,
    strategies, // 多策略對照（固定持有 10 日）：swing / breakout(創新高) / goldenCross
  };
  await db.collection('backtest').doc('latest').set(result);
  return NextResponse.json(result);
}
