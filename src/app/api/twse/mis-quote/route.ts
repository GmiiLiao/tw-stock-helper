import { NextRequest, NextResponse } from 'next/server';
import { getMisQuoteDataInternal, isMarketOpen } from '@/lib/twse-api-server';
import { recordLiveRequests } from '@/lib/live-requests-store';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const codesParam = request.nextUrl.searchParams.get('codes') || '';
  const codes = codesParam.split(',').map(c => c.trim()).filter(c => /^\d{4,6}$/.test(c)).slice(0, 50);

  if (codes.length === 0) {
    return NextResponse.json({ error: 'codes required' }, { status: 400 });
  }

  const marketOpen = isMarketOpen();

  // Tell the daemon which stocks are being actively viewed so it folds them
  // into its real-time priority sweep (throttled, fire-and-forget).
  // nv=1（2026-09-17）：榜單整張 25～60 檔的即時價欄不登記「瀏覽中」——快線 120 檔名額與自選共用，
  // 一展開榜單就把名額塞滿，使用者最後打開的那檔會被擠回 40 秒一輪的主迴圈。展開走勢時 StockTrendChart 自己會登記那一檔。
  if (request.nextUrl.searchParams.get('nv') !== '1') recordLiveRequests(codes);

  try {
    const result = await getMisQuoteDataInternal(codes);
    return NextResponse.json(
      {
        quotes: result.quotes,
        isRealtime: result.isRealtime,
        marketOpen: result.marketOpen,
        source: result.source,
        snapshotAt: result.snapshotAt ?? null,
      },
      {
        headers: {
          // 盤中 no-store 會讓每個 5 秒輪詢都打穿 CDN（CLAUDE.md 最貴教訓）。
          // 2026-09-02 改拍號快取鍵（前端帶 &t=revealTick）：同拍恆 hit、換拍
          // URL 變＝必回源 ⇒ s-maxage 拉滿一拍也不會殘影。SWR 縮成 origin
          // 慢時的容錯，不再是常態路徑（先前 swr=10 讓鎖相請求常吃一兩拍前殘影，
          // 實測平均資料齡 7.9s、僅 1/8 拍 ≤5s）。
          'Cache-Control': marketOpen ? 'public, s-maxage=5, stale-while-revalidate=5' : 'public, max-age=60',
          'Access-Control-Allow-Origin': '*',
          'X-Data-Source': result.source,
        },
      }
    );
  } catch (e) {
    console.error('[mis-quote] API error:', e);
    return NextResponse.json({ error: String(e), quotes: [], isRealtime: false }, { status: 500 });
  }
}
