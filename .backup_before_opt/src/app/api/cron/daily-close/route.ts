import { NextRequest, NextResponse } from 'next/server';
import { getStockDayAllDataInternal, isTradingDay } from '@/lib/twse-api-server';
import { parseStock, scoreStock, fetchRiskStocks, isRegularStock } from '@/lib/scoring-server';
import {
  getValuationMap, getMarginMap, getInstitutionalMap, deriveFundamentalSignals,
  type Valuation, type Margin, type Institutional,
} from '@/lib/fundamentals-server';
import { enrichScoredStock } from '@/lib/analysis-enrich';
import { appendTodayBars, readHistories, type DailyBar } from '@/lib/history-store';
import { writeMarketReport, type MarketReport, type ReportPick } from '@/lib/report-store';

export const runtime = 'nodejs';
export const maxDuration = 120; // heavy batch job; see firebase.json timeoutSeconds

// ============================================================
// POST /api/cron/daily-close  — after-close batch job (Phase 3)
//
// 1. Guards: CRON_SECRET + trading-day (override with ?force=1).
// 2. Incremental history append: today's bar → each stored stock.
// 3. Whole-market base scoring + market breadth.
// 4. Enrich the top-N candidates (MA zones + fundamentals + vol sells).
// 5. Persist a 盤勢分析 report (marketReports/{date} + /latest).
//
// Schedule via Cloud Scheduler → POST with `x-cron-secret` header on
// trading days after 14:00 Taipei. Idempotent (safe to re-run).
// ============================================================

function rocToIso(roc: string): string {
  // "1150618" → "2026-06-18"
  const m = roc?.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (!m) return '';
  return `${parseInt(m[1], 10) + 1911}-${m[2]}-${m[3]}`;
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unset → allow (local/dev). Set it in production.
  const provided = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret');
  return provided === secret;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const force = request.nextUrl.searchParams.get('force') === '1';
  const topN = Math.min(100, Math.max(5, parseInt(request.nextUrl.searchParams.get('top') || '40', 10) || 40));

  if (!isTradingDay() && !force) {
    return NextResponse.json({ skipped: true, reason: 'not a trading day' });
  }

  try {
    // ── 1. Gather raw market data + fundamentals/risk in parallel ──
    const [rawData, riskData, valMap, marginMap, instRes] = await Promise.all([
      getStockDayAllDataInternal({ closeOnly: true }), // 歷史紀錄只存官方收盤，不含盤中快照
      fetchRiskStocks(),
      getValuationMap().catch(() => ({} as Record<string, Valuation>)),
      getMarginMap().catch(() => ({} as Record<string, Margin>)),
      getInstitutionalMap().catch(() => ({ map: {} as Record<string, Institutional>, date: '' })),
    ]);
    const instMap = instRes.map;
    const rocDate = rawData[0]?.Date ?? '';
    const isoDate = rocToIso(rocDate) || new Date().toISOString().slice(0, 10);

    // ── 2. Base-score the whole market + breadth ──
    const regular = rawData.filter(isRegularStock);
    const scored = regular.map(d => scoreStock(parseStock(d), 'daily', riskData));

    let up = 0, down = 0, flat = 0;
    for (const d of regular) {
      const chg = parseFloat(d.Change) || 0;
      if (chg > 0) up++; else if (chg < 0) down++; else flat++;
    }
    const total = regular.length;

    // ── 3. Incremental history append (no-op until backfill seeds docs) ──
    const barEntries = regular
      .map(d => {
        const bar: DailyBar = {
          d: isoDate,
          o: parseFloat(d.OpeningPrice) || 0,
          h: parseFloat(d.HighestPrice) || 0,
          l: parseFloat(d.LowestPrice) || 0,
          c: parseFloat(d.ClosingPrice) || 0,
          v: parseInt((d.TradeVolume || '0').replace(/,/g, ''), 10) || 0,
        };
        return { code: d.Code, name: d.Name, bar };
      })
      .filter(e => e.bar.c > 0);
    const appendResult = await appendTodayBars(barEntries).catch(e => {
      console.warn('[cron] appendTodayBars failed', e);
      return { updated: 0, skipped: barEntries.length };
    });

    // ── 4. Enrich top-N candidates ──
    const candidates = scored
      .filter(s => s.score >= 50 && !s.isDisposition)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    const candidateCodes = candidates.map(s => s.code);
    const histories = await readHistories(candidateCodes);

    const enrichedPicks = candidates.map(base => {
      const bars = histories.get(base.code)?.bars ?? null;
      const fund = deriveFundamentalSignals(
        valMap[base.code] ?? null,
        marginMap[base.code] ?? null,
        instMap[base.code] ?? null,
      );
      return enrichScoredStock(base, bars && bars.length >= 20 ? bars : null, fund);
    });

    // Re-rank by the enriched score and shape into report picks
    const topPicks: ReportPick[] = enrichedPicks
      .sort((a, b) => b.stock.score - a.stock.score)
      .slice(0, Math.min(15, topN))
      .map(({ stock }) => ({
        code: stock.code,
        name: stock.name,
        score: stock.score,
        grade: stock.grade,
        signal: stock.signal,
        price: stock.price,
        changePercent: stock.changePercent,
        buy: stock.buyZones.find(z => z.type === 'standard')?.price ?? stock.buyZones[0]?.price ?? null,
        target: stock.sellTargets.find(t => t.type === 'tp1')?.price ?? null,
        stopLoss: stock.stopLoss ?? null,
        reasons: stock.reasons.slice(0, 4),
      }));

    // ── 5. Risk highlights + summary ──
    const riskHighlights: string[] = [];
    if (riskData.disposition.length) riskHighlights.push(`🔴 處置股票 ${riskData.disposition.length} 檔`);
    if (riskData.attention.length) riskHighlights.push(`🟡 注意股票 ${riskData.attention.length} 檔`);
    const overheated = candidates.filter(s => (marginMap[s.code]?.utilization ?? 0) >= 80).length;
    if (overheated) riskHighlights.push(`🔥 入選股中 ${overheated} 檔融資使用率 ≥80%`);

    const advancePct = total ? parseFloat(((up / total) * 100).toFixed(1)) : 0;
    const tone = advancePct >= 60 ? '偏多' : advancePct <= 40 ? '偏空' : '中性震盪';
    const summary =
      `收盤盤勢${tone}：上漲 ${up} / 下跌 ${down} / 持平 ${flat}（漲家數佔 ${advancePct}%）。` +
      `全市場分析 ${total} 檔，精選 ${topPicks.length} 檔強勢標的。` +
      (enrichedPicks.some(e => e.enriched.buyZones) ? '買賣點已套用均線支撐與波動度模型。' : '（歷史庫尚未回填，買賣點暫用技術面估算。）');

    const report: MarketReport = {
      date: isoDate,
      generatedAt: Date.now(),
      breadth: { up, down, flat, total, advancePct },
      topPicks,
      riskHighlights,
      summary,
      meta: {
        totalAnalyzed: total,
        enriched: enrichedPicks.filter(e => e.enriched.buyZones).length,
        historyCovered: histories.size,
      },
    };

    let persisted = true;
    try {
      await writeMarketReport(report);
    } catch (e) {
      persisted = false;
      console.warn('[cron] writeMarketReport failed (admin creds?)', e);
    }

    return NextResponse.json({
      ok: true,
      date: isoDate,
      persisted,
      historyAppend: appendResult,
      breadth: report.breadth,
      topPicksCount: topPicks.length,
      meta: report.meta,
      report: persisted ? undefined : report, // return inline if not persisted
    });
  } catch (error) {
    console.error('[cron/daily-close] error', error);
    return NextResponse.json({ error: 'daily-close job failed' }, { status: 500 });
  }
}

// Allow manual GET trigger in dev (same logic) for convenience.
export async function GET(request: NextRequest) {
  return POST(request);
}
