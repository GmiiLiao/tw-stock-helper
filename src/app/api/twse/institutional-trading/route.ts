import { NextResponse } from 'next/server';
import { getInstitutionalTradingDataInternal } from '@/lib/twse-api-server';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // 專屬限流（G1-23）：快取未命中時打 TWSE 法人端點；前端偶發讀取 ⇒ 120/分鐘很寬，只擋濫用。
  const limited = await rateLimit(request, 'institutional-trading', 120);
  if (limited) return limited;
  try {
    const data = await getInstitutionalTradingDataInternal();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  } catch (error) {
    console.error('[institutional-trading] API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch institutional trading data', foreignBuy: [], foreignSell: [], instBuy: [], instSell: [], dataDate: '', source: 'error' },
      { status: 500 }
    );
  }
}
