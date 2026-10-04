import { NextResponse } from 'next/server';
import { getMarketNewsDataInternal } from '@/lib/twse-api-server';
import { rateLimit } from '@/lib/rate-limit';

export async function GET(request: Request) {
  // 專屬限流（G1-23）：快取未命中時打外部新聞來源；前端 5 分鐘輪詢一次 ⇒ 60/分鐘很寬，只擋濫用。
  const limited = await rateLimit(request, 'market-news', 60);
  if (limited) return limited;
  try {
    const data = await getMarketNewsDataInternal();
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=180, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    console.error('Market news proxy error:', error);
    return NextResponse.json({ news: [], fetchedAt: new Date().toISOString(), count: 0 });
  }
}
