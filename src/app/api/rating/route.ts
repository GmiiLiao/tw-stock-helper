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
import { verdictJsonOf } from '../../../../scripts/lib/news-verdict-codec.mjs';   // newsVerdict 新舊格式（明文／壓縮 verdictGz，2026-10-08）
import { getStockNews } from '@/lib/news-server';
import { getAdminDb } from '@/lib/firebase-admin';
import { enrichScoredStock } from '@/lib/analysis-enrich';
import { readMarketSnapshot } from '@/lib/market-snapshot-store';
import { memoize } from '@/lib/singleflight';
import type { NewsLite } from '@/lib/news-sentiment';

export const runtime = 'nodejs';

/** newsVerdict/latest 每檔一筆中，評分路由會讀的欄位（daemon 三個 newsVerdict 寫入端產出） */
interface LatestVerdictRow {
  label?: string;
  confidence?: string;
  strength?: string;
  at?: number;
  reason?: string;
}

// ── newsVerdict/latest 判別表（X15，2026-10-08）──────────────────────────
//   舊版每個單檔請求都整份讀一次（100～570 KB）再 JSON.parse；改為 60 秒 TTL＋in-flight 合流＋失敗負快取。
//   代價：daemon 寫入新判別後，評分最多晚 60 秒看到（判別一天只更新數趟，遠小於它自身的更新週期）。
//   快取的是解析後的表，呼叫端只讀不改（下方只讀 map[code]，以 news.map 產生新陣列）。
const getNewsVerdictLatest = memoize('newsVerdictLatest', 60_000, async (): Promise<Record<string, LatestVerdictRow> | null> => {
  const db = getAdminDb();
  if (!db) return null;
  const snap = await db.collection('newsVerdict').doc('latest').get();
  const vj = verdictJsonOf(snap.data());
  return vj ? JSON.parse(vj) : null;
});

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

      // ── 掛上 AI 內文判別（使用者 2026-08-29 明令：只有它能影響分數）──
      //   判別由 daemon 的分流管線產出（盤後 23:00 + 晨間 07:00），
      //   網站端只讀 Firestore，不自己打上游（架構不變式）。
      //   查無判別時**什麼都不掛**，下游會據實顯示「未判別」——不捏造中性值。
      if (news && news.length) {
        try {
          const map = await getNewsVerdictLatest();
          const mine = map?.[code];
          if (mine?.label) {
            // ⚠ 判別是**個股層級**（AI 已經讀完多則內文後才給一個結論），
            //   若掛到每一則新聞上，聚合時就會被故事數乘一次
            //   ——4 則故事各帶 +2 ⇒ sum/4 直接夾到上限吃滿 20 分，
            //   等於把剛修掉的「重複計分」從另一道門放回來。
            //   所以只掛在**最新的一則**上，讓它以「一則故事」的身分貢獻一次。
            const newest = news.reduce((a, b) =>
              new Date(b.time || 0).getTime() > new Date(a.time || 0).getTime() ? b : a);
            news = news.map(n => (n === newest ? {
              ...n,
              verdict: mine.label as '利多' | '利空' | '中性',
              verdictBasis: 'content' as const,
              verdictConfidence: mine.confidence as '高' | '中' | '低',
              verdictStrength: mine.strength as '極強' | '強' | '中' | '弱' | undefined,
              // 衰減用判別產出時間，不是這則新聞的時間（見 NewsLite.verdictAt）
              verdictAt: mine.at ? new Date(mine.at).toISOString() : undefined,
              verdictReason: mine.reason || undefined,
            } : n));
          }
        } catch { /* 判別讀不到就維持未判別，不影響評分 */ }
      }

      // 盤中即時價（含 5 秒快線覆蓋）：乖離/追高/趨勢位置判定用今日，
      // 不再整天沿用昨收（2026-08-18 使用者指正）。非 live 時傳 null＝維持舊行為。
      let livePrice: number | null = null;
      try {
        const ms = await readMarketSnapshot();
        const lq = ms?.quotes[code];
        if (lq?.live && lq.price > 0) livePrice = lq.price;
      } catch { /* 快照缺就用昨收 */ }
      const { stock, indicators, fundamentals, swingSignal, newsSentiment, enriched } =
        enrichScoredStock(base, bars, fund, news, livePrice);
      return NextResponse.json(
        { stock, indicators, fundamentals, swingSignal, newsSentiment, enriched, dataDate, generatedAt: new Date().toISOString(), dispositionComplete: riskData.dispositionComplete },
        { headers: { 'Cache-Control': riskData.dispositionComplete ? 'public, s-maxage=60, stale-while-revalidate=30' : 'public, s-maxage=15' } },
      );
    }

    // ── Whole-market compact map ──
    const ratings: Record<string, StockRating> = {};
    for (const d of rawData) {
      if (!isRegularStock(d)) continue;
      const r = rateStock(parseStock(d), riskData);
      ratings[r.code] = r;
    }

    // G2-10：dispositionComplete=false 時 risk:null 不代表確認非處置股（signal 已壓成 WATCH）
    const payload = { ratings, dataDate, generatedAt: new Date().toISOString(), count: Object.keys(ratings).length, dispositionComplete: riskData.dispositionComplete };
    const headers: Record<string, string> = { 'Cache-Control': riskData.dispositionComplete ? 'public, s-maxage=60, stale-while-revalidate=30' : 'public, s-maxage=15' };
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
