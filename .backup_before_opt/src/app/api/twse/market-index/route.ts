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
    const active = isAnyMarketActive();
    const cacheHeader = active
      ? 'no-store, max-age=0, must-revalidate'
      : 'public, s-maxage=120, stale-while-revalidate=60';

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
