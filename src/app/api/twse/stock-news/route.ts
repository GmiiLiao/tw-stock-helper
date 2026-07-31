import { NextRequest, NextResponse } from 'next/server';
import { getStockNews, FREE_SOURCES, POLICY_SOURCES } from '@/lib/news-server';

export const runtime = 'nodejs';

/** GET /api/twse/stock-news?code=2330&name=台積電&industry=半導體 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code') || '';
  const name = searchParams.get('name') || '';
  const industry = searchParams.get('industry') || '';
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });

  const news = await getStockNews(code, name, industry);
  return NextResponse.json(
    {
      news, code, industry,
      sources: [...FREE_SOURCES.map(s => s.label), ...POLICY_SOURCES.map(s => s.label)],
      fetchedAt: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60', 'Access-Control-Allow-Origin': '*' } },
  );
}
