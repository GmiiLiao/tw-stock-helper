import { NextResponse } from 'next/server';
import { getMarketIndexDataInternal, isAnyMarketActive } from '@/lib/twse-api-server';
import { isTradingDay } from '@/lib/market-clock';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  // 專屬限流（G1-23）：快取未命中時打 Yahoo（美股 6 檔）＋daemon 指數；memoize 15 秒已讓上游次數為常數。
  // 前端 Header／跑馬燈每 5 秒輪詢、同一 IP 多分頁或 NAT 下多人 ⇒ 額度刻意給到 600/分鐘，只擋濫用。
  const limited = await rateLimit(request, 'market-index', 600);
  if (limited) return limited;
  try {
    // 台股加權指數的「daemon 優先、比 tradeDate 取新」邏輯已移進
    // `getMarketIndexDataInternal`（見 twse-api-server.ts `readDaemonIndex`），
    // 因為 ai-analysis / news-agent 也直接呼叫同一支 —— 修在 route 只治一處。
    // 那裡有 15 秒 memoize，1000 個使用者不會變成 1000 次 Firestore read。
    const data = await getMarketIndexDataInternal();

    // 盤中以 3 秒 CDN 快取取代 no-store：上游本來就 5 秒才更新一次，
    // s-maxage=3 讓 CDN 擋掉九成以上回源，使用者最多落後一個 tick。
    // stale-if-error 讓上游掛掉時供應舊價而不是空白。
    // 收盤後資料不再變動，直接把 TTL 拉到隔天開盤。
    const active = isAnyMarketActive();
    // ⚠ 開盤交界投毒（2026-08-17 實案）：08:58 快取的「休市版」帶 s-maxage=1800，
    // 開盤後活到 09:28——左上加權指數 28 分鐘停在上週五收盤。交易日 08:00 起
    // 即使未開盤也只發短快取；長 TTL 只留給「距開盤夠遠」的時段（半夜/假日），
    // 08:00 前快取的條目（1800+swr600）最晚 08:40 到期，碰不到 09:00。
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const nearOpen = isTradingDay(now) && now.getHours() >= 8;
    const cacheHeader = active
      ? 'public, max-age=2, s-maxage=5, stale-while-revalidate=5, stale-if-error=60'   // 拍號快取鍵後 s-maxage 拉滿一拍（前端帶 ?t=revealTick）
      : nearOpen
        ? 'public, max-age=15, s-maxage=30, stale-while-revalidate=30, stale-if-error=600'
        : 'public, max-age=300, s-maxage=1800, stale-while-revalidate=600, stale-if-error=86400';

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': cacheHeader,
      },
    });
  } catch (error) {
    console.error('Market index proxy error:', error);
    return NextResponse.json({ weighted: 0, weightedChange: 0, weightedChangePercent: 0 });
  }
}
