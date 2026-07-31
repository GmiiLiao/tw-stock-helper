import { NextResponse } from 'next/server';
import { getMarketIndexDataInternal, isAnyMarketActive } from '@/lib/twse-api-server';
import { getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const data = await getMarketIndexDataInternal();
    // 台股加權指數：Cloud Function 在美國機房、MIS 封鎖美國 IP → 直抓常失敗(weighted=0)。
    // daemon(台灣)寫入 marketIndex/latest 為權威來源；直抓成功時才用直抓。
    if (!(data.weighted > 0)) {
      try {
        const db = getAdminDb();
        const idx = db ? (await db.collection('marketIndex').doc('latest').get()).data() : null;
        if (idx && idx.weighted > 0) {
          data.weighted = idx.weighted;
          data.weightedChange = idx.weightedChange;
          data.weightedChangePercent = idx.weightedChangePercent;
          (data as { high?: number; low?: number; prevClose?: number; tradeDate?: string; source?: string }).high = idx.high;
          (data as { low?: number }).low = idx.low;
          (data as { prevClose?: number }).prevClose = idx.prevClose;
          (data as { tradeDate?: string }).tradeDate = idx.tradeDate;
          (data as { source?: string }).source = 'daemon_mis';
        }
      } catch { /* 保留原 data */ }
    }
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
