import { NextRequest, NextResponse } from 'next/server';
import { getStockDayAllDataInternal } from '@/lib/twse-api-server';
import { parseStock, scoreStock, fetchRiskStocks, isRegularStock } from '@/lib/scoring-server';
import { getInstWeights } from '@/lib/inst-weight-server';
import { getFinWeights } from '@/lib/fin-server';

export const runtime = 'nodejs'; // firebase-admin（法人加權）需 Node runtime

// ============================================================
// AI Stock Recommendation Engine v2
// Thin route — all scoring math lives in lib/scoring-server.ts
// (single source of truth, shared with /api/rating).
// ============================================================

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get('mode') || 'daily';

  try {
    // 評分只用最近一個完整交易日的官方收盤資料（closeOnly）——
    // 盤中即時漲跌/未完成量能會讓五大因子失真，推薦分數與盤前不一致。
    const [rawData, riskData, iw, fw] = await Promise.all([
      getStockDayAllDataInternal({ closeOnly: true }),
      fetchRiskStocks(),
      getInstWeights(), // 四大法人加權（回測驗證·保守，t-1 PIT 安全）
      getFinWeights(),  // 財報體質加權（2事件回測：重罰低分輕獎高分）
    ]);
    const dataDate = rawData[0]?.Date ?? 'unknown';

    const stocks = rawData.filter(isRegularStock).map(d => parseStock(d));
    // 每檔附 instW/finW（透明呈現）；排序鍵 = 技術評分 + (法人加權+財報加權)×1.5
    const scored = stocks.map(s => {
      const r = scoreStock(s, mode, riskData);
      const f = fw.map[r.code];
      return { ...r, instW: iw.map[r.code] ?? 0, finW: f?.w ?? 0, finScore: f?.s ?? null, pe: f?.pe ?? null };
    });
    const rank = (a: { score: number; instW: number; finW: number }, b: { score: number; instW: number; finW: number }) =>
      (b.score + (b.instW + b.finW) * 1.5) - (a.score + (a.instW + a.finW) * 1.5);

    // Top 20 overall
    const recommendations = scored
      .filter(r => r.score >= 50)
      .sort(rank)
      .slice(0, 20);

    // Strategy buckets
    const strategies = {
      daily:     scored.filter(s => s.strategy === 'momentum').sort(rank).slice(0, 20),
      growth:    scored.filter(s => s.strategy === 'growth').sort(rank).slice(0, 20),
      defensive: scored.filter(s => s.strategy === 'defensive').sort(rank).slice(0, 20),
    };

    return NextResponse.json({
      recommendations,
      strategies,
      totalAnalyzed: stocks.length,
      generatedAt: new Date().toISOString(),
      dataDate,
      instDate: iw.date || null, // 法人加權資料日（t-1）
      mode,
      riskSummary: {
        attentionCount: riskData.attention.length,
        dispositionCount: riskData.disposition.length,
        totalRiskStocks: riskData.allCodes.length,
      },
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' },
    });

  } catch (error) {
    console.error('AI recommendation error:', error);
    return NextResponse.json({ error: 'Failed to generate recommendations' }, { status: 500 });
  }
}
