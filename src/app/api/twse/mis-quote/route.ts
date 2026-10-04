import { NextRequest, NextResponse } from 'next/server';
import { getMisQuoteDataInternal, isMarketOpen } from '@/lib/twse-api-server';
import { recordLiveRequests } from '@/lib/live-requests-store';
import { clientIp, rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

// 專屬限流額度怎麼算（G1-21／G1-23，2026-10-04）：一個分頁同時在輪詢 mis-quote 的元件最多約 6 個
// （useLiveQuotes 各面板、WarRoom、DecisionDesk、自選批次、走勢圖登記），各 5 秒一次 ⇒ ~72 次/分鐘；
// 同一 IP 開 3 個分頁或家用 NAT 多人 ⇒ ~200～300。給 600/分鐘（每實例；maxInstances=5 下全域更寬），
// 正常 5 秒輪詢不會碰到，只擋每秒 10 次以上的灌量。快取未命中時的上游（快照缺時退回收盤資料）由 memoize 收斂。
// 「瀏覽中」登記另有每來源代號配額（live-requests-store），不靠這條。限流器故障 fail-open（2026-09-28 裁定）。
const RATE_LIMIT_PER_MIN = 600;

export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, 'mis-quote', RATE_LIMIT_PER_MIN);
  if (limited) return limited;
  const codesParam = request.nextUrl.searchParams.get('codes') || '';
  const codes = codesParam.split(',').map(c => c.trim()).filter(c => /^\d{4,6}$/.test(c)).slice(0, 50);

  if (codes.length === 0) {
    return NextResponse.json({ error: 'codes required' }, { status: 400 });
  }

  const marketOpen = isMarketOpen();

  const register = request.nextUrl.searchParams.get('nv') !== '1';

  try {
    const result = await getMisQuoteDataInternal(codes);

    // Tell the daemon which stocks are being actively viewed so it folds them
    // into its real-time priority sweep (throttled, fire-and-forget).
    // nv=1（2026-09-17）：榜單整張 25～60 檔的即時價欄不登記「瀏覽中」——快線 120 檔名額與自選共用，
    // 一展開榜單就把名額塞滿，使用者最後打開的那檔會被擠回 40 秒一輪的主迴圈。展開走勢時 StockTrendChart 自己會登記那一檔。
    // G1-21（2026-10-04）：只登記有回報價的「已知代號」，並帶來源鍵做每來源配額（見 live-requests-store）。
    // 濫用面在「登記」副作用：每來源配額擋在那裡，超額只是不登記、報價照回（不回 429）。
    if (register) {
      const known = result.quotes.filter(q => q.price > 0).map(q => q.code);
      if (known.length) recordLiveRequests(known, clientIp(request));
    }
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
          'X-Data-Source': result.source,
        },
      }
    );
  } catch (e) {
    console.error('[mis-quote] API error:', e);
    // G1-13：錯誤細節只進 server log，不回給公開呼叫端。
    return NextResponse.json(
      { error: 'internal error', quotes: [], isRealtime: false },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
