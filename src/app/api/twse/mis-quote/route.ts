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
  recordLiveRequests(codes);

  try {
    const result = await getMisQuoteDataInternal(codes);
    return NextResponse.json(
      {
        quotes: result.quotes,
        isRealtime: result.isRealtime,
        marketOpen: result.marketOpen,
        source: result.source,
      },
      {
        headers: {
          'Cache-Control': marketOpen ? 'no-store' : 'public, max-age=60',
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
