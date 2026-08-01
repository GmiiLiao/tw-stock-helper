import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { gzipSync } from 'node:zlib';
import { getStockDayAllDataInternal } from '@/lib/twse-api-server';
import {
  parseStock, scoreStock, rateStock, fetchRiskStocks, isRegularStock,
  type StockRating,
} from '@/lib/scoring-server';
import { readHistory } from '@/lib/history-store';
import { readStockAI } from '@/lib/daemon-store';
import { fetchDailyHistory, yearsAgoUnix } from '@/lib/history-fetch';
import { getFundamentalSignals } from '@/lib/fundamentals-server';
import { getStockNews } from '@/lib/news-server';
import { enrichScoredStock } from '@/lib/analysis-enrich';
import type { NewsLite } from '@/lib/news-sentiment';

export const runtime = 'nodejs';

// ============================================================
// /api/rating — single source of truth for stock ratings.
//
//   GET /api/rating            → whole-market compact rating map
//                                { ratings: { [code]: StockRating }, dataDate }
//   GET /api/rating?code=2330  → one stock's full ScoredStock analysis
//
// The Screener consumes the compact map (one request) instead of
// re-implementing the scoring math client-side, so its grades/signals
// always match the AI recommendation page.
// ============================================================

export async function GET(request: NextRequest) {
  // 限流防濫用。2026-08-01 放寬：個股頁 K 線鏈每檔 3~12 連發、會員頁多檔輪詢，
  // 原值連續瀏覽數檔就會 429 圖表空白——限流目標是每分鐘數百次的濫用，不是正常瀏覽
  const limited = await rateLimit(request, 'rating', 240);
  if (limited) return limited;

  const code = request.nextUrl.searchParams.get('code')?.trim();

  try {
    // 評分只用最近一個完整交易日的官方收盤資料（closeOnly）——
    // 盤中不受即時漲跌/未完成量能影響，分數與盤前一致、收盤後才更新一次。
    const [rawData, riskData] = await Promise.all([
      getStockDayAllDataInternal({ closeOnly: true }),
      fetchRiskStocks(),
    ]);
    const dataDate = rawData[0]?.Date ?? 'unknown';

    // ── Single-stock full analysis (Phase 2: enriched with indicators + fundamentals) ──
    if (code) {
      const row = rawData.find(d => d.Code === code);
      if (!row) {
        return NextResponse.json({ error: 'Stock not found', code }, { status: 404 });
      }
      const base = scoreStock(parseStock(row), 'daily', riskData);

      // Gather history (store → live Yahoo), fundamentals and news in parallel; all best-effort.
      // ⚠ 新鮮度閘門（2026-07-31）：stockHistory 曾是**只寫一次**的快取，
      //   1,082 檔沒有一檔更新到當日（最舊落後 5 週），中間還有洞。
      //   而 `price` 來自今日官方收盤 —— 兩者並排就會產出
      //   「玉山金現價 37.7，建議買 32.53、目標 33.23」這種目標低於現價的建議。
      //   dataDate 就在手上，直接比對：對不上就不讓過期指標覆蓋 price-based 買點。
      const officialIso = /^\d{7}$/.test(dataDate)
        ? `${+dataDate.slice(0, 3) + 1911}-${dataDate.slice(3, 5)}-${dataDate.slice(5, 7)}`
        : null;
      const [bars, fund, newsItems] = await Promise.all([
        readHistory(code)
          .then(h => {
            if (!h || h.bars.length < 20) return null;
            if (officialIso && h.lastDate && h.lastDate < officialIso) return null;  // 過期→不用
            return h.bars;
          })
          .then(b => b ?? fetchDailyHistory(code, yearsAgoUnix(3)).then(r => (r.bars.length ? r.bars : null)).catch(() => null))
          .catch(() => null),
        getFundamentalSignals(code).catch(() => null),
        getStockNews(code, row.Name || '').catch(() => null),
      ]);

      // Fallback: if live news is empty (e.g. RSS rate-limited), use the
      // daemon's cached news so the 20% news weight still applies.
      let news: NewsLite[] | null = newsItems;
      if (!news || news.length === 0) {
        const ai = await readStockAI(code).catch(() => null);
        if (ai?.news?.length) news = ai.news;
      }

      const { stock, indicators, fundamentals, swingSignal, newsSentiment, enriched } =
        enrichScoredStock(base, bars, fund, news);
      return NextResponse.json(
        { stock, indicators, fundamentals, swingSignal, newsSentiment, enriched, dataDate, generatedAt: new Date().toISOString() },
        { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' } },
      );
    }

    // ── Whole-market compact map ──
    const ratings: Record<string, StockRating> = {};
    for (const d of rawData) {
      if (!isRegularStock(d)) continue;
      const r = rateStock(parseStock(d), riskData);
      ratings[r.code] = r;
    }

    const payload = { ratings, dataDate, generatedAt: new Date().toISOString(), count: Object.keys(ratings).length };
    const headers: Record<string, string> = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' };
    // 全市場評分包較大且被 Screener/自選/NL 選股高頻取用 → gzip 省 ~80% 流量
    if ((request.headers.get('accept-encoding') || '').includes('gzip')) {
      const gz = gzipSync(Buffer.from(JSON.stringify(payload)));
      return new Response(new Uint8Array(gz), { headers: { ...headers, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } });
    }
    return NextResponse.json(payload, { headers });
  } catch (error) {
    console.error('[api/rating] error:', error);
    return NextResponse.json({ error: 'Failed to compute ratings' }, { status: 500 });
  }
}
