import { NextRequest, NextResponse } from 'next/server';
import { getStockDayAllDataInternal } from '@/lib/twse-api-server';
import { parseStock, scoreStock, fetchRiskStocks, isRegularStock } from '@/lib/scoring-server';
import { getInstWeights } from '@/lib/inst-weight-server';
import { getFinWeights } from '@/lib/fin-server';
import { getRecommendAdj } from '@/lib/recommend-adj-server';

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
    const [rawData, riskData, iw, fw, adj] = await Promise.all([
      getStockDayAllDataInternal({ closeOnly: true }),
      fetchRiskStocks(),
      getInstWeights(), // 四大法人加權（回測驗證·保守，t-1 PIT 安全）
      getFinWeights(),  // 財報體質加權（2事件回測：重罰低分輕獎高分）
      getRecommendAdj(),// 已驗證訊號修正量（daemon 算·見 recommend-adj-server 檔頭）
    ]);
    // memoize 失敗會回 null（負快取）——降級成「只用五大因子」而不是整頁壞掉。
    // Ⓐ 本身兩窗超額也都是正的，降級後仍可用，只是少了避開型訊號。
    const ADJ = adj ?? { map: {} as Record<string, { a: number; w: string[] }>, weight: 3, date: null, bearDay: null, mktChg: null };
    const dataDate = rawData[0]?.Date ?? 'unknown';

    const stocks = rawData.filter(isRegularStock).map(d => parseStock(d));
    // 每檔附 instW/finW（透明呈現）；排序鍵 = 技術評分 + (法人加權+財報加權)×1.5
    const scored = stocks.map(s => {
      const r = scoreStock(s, mode, riskData);
      const f = fw.map[r.code];
      const a = ADJ.map[r.code];
      return { ...r, instW: iw.map[r.code] ?? 0, finW: f?.w ?? 0, finScore: f?.s ?? null, pe: f?.pe ?? null,
        // 已驗證訊號修正量與其理由（透明呈現：使用者看得到為什麼被加/扣）
        adj: a?.a ?? 0, adjWhy: a?.w ?? [] };
    });
    // ── 排序鍵（2026-08-05 依對決結果定版）────────────────────────
    // 五大因子(修正後) + 法人/財報加權 + **已驗證訊號 × 3**。
    // ×3 是實測選出來的：×6 在主窗反而較差（Δ+0.233 vs ×3 的 +0.249）。
    // 對決全表見 recommend-adj-server.ts 檔頭與 model-core。
    const W = ADJ.weight ?? 3;
    const key = (x: { score: number; instW: number; finW: number; adj: number }) =>
      x.score + (x.instW + x.finW) * 1.5 + x.adj * W;
    const rank = (a: Parameters<typeof key>[0], b: Parameters<typeof key>[0]) => key(b) - key(a);


    // ── 可交易宇宙 gate（2026-08-05）──────────────────────────────
    // 推薦當日漲幅 >8.5% 者剔除：**收盤價已在漲停或貼近漲停，買不到**。
    // 實證（backfill-picks-scoreboard.mjs）：舊版 TOP20 的 5 日樣本有
    // 121/327（37%）屬於這一類，是記分板落後同期基準的最大單一來源——
    // 剔除後 5 日超額由 -2.12pp 收斂到 -0.40pp。
    // 這條 gate 與撿尾盤定版濾網、bt-core buildSamples 的 tradable 同口徑。
    const tradable = (r: { changePercent: number }) => r.changePercent <= 8.5;

    // Top 20 overall
    const recommendations = scored
      .filter(r => r.score >= 50 && tradable(r))
      .sort(rank)
      .slice(0, 20);

    // Strategy buckets（同樣套 gate——買不到的標的不該出現在任何一張推薦榜）
    const buyable = scored.filter(tradable);
    const strategies = {
      daily:     buyable.filter(s => s.strategy === 'momentum').sort(rank).slice(0, 20),
      growth:    buyable.filter(s => s.strategy === 'growth').sort(rank).slice(0, 20),
      defensive: buyable.filter(s => s.strategy === 'defensive').sort(rank).slice(0, 20),
    };

    return NextResponse.json({
      recommendations,
      strategies,
      totalAnalyzed: stocks.length,
      excludedLimitUp: scored.length - buyable.length,   // 因漲停買不到而剔除的檔數（誠實揭露）
      adjDate: ADJ.date, adjWeight: ADJ.weight, adjCount: Object.keys(ADJ.map).length,
      bearDay: ADJ.bearDay, mktChg: ADJ.mktChg,
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
