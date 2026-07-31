import { NextResponse } from 'next/server';
import { getMarketNewsDataInternal } from '@/lib/twse-api-server';

export async function GET() {
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
