import { NextResponse } from 'next/server';
import { getMarketIndexDataInternal, isAnyMarketActive } from '@/lib/twse-api-server';

export const runtime = 'nodejs';

export async function GET() {
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
    const cacheHeader = active
      ? 'public, max-age=2, s-maxage=3, stale-while-revalidate=5, stale-if-error=60'
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
