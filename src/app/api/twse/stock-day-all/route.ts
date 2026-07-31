import { NextRequest, NextResponse } from 'next/server';
import { gzipSync } from 'node:zlib';
import { getStockDayAllDataInternal, isMarketOpen } from '@/lib/twse-api-server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const data = await getStockDayAllDataInternal();
    const misCount = data.filter(d => d._source === 'mis_merged').length;
    console.log(`[stock-day-all] total=${data.length} mis_merged=${misCount} fallback=${data.length - misCount}`);

    const marketOpen = isMarketOpen();
    const cacheHeader = marketOpen
      ? 'no-store, max-age=0, must-revalidate'
      : 'public, s-maxage=120, stale-while-revalidate=60';

    const headers: Record<string, string> = {
      'Cache-Control': cacheHeader,
      'Access-Control-Allow-Origin': '*',
      'X-Data-Date': data[0]?.Date ?? 'unknown',
      'X-MIS-Merged': misCount.toString(),
    };
    // 手動 gzip：此回應 ~650KB、盤中被高頻輪詢，未壓縮是 Hosting 下載量主因(可省 ~85%)。
    if ((request.headers.get('accept-encoding') || '').includes('gzip')) {
      const gz = gzipSync(Buffer.from(JSON.stringify(data)));
      return new Response(new Uint8Array(gz), { headers: { ...headers, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } });
    }
    return NextResponse.json(data, { headers });
  } catch (error) {
    console.error('TWSE stock-day-all proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch from TWSE API' },
      { status: 500 }
    );
  }
}
