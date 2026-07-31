import { NextResponse } from 'next/server';
import { getInstitutionalTradingDataInternal } from '@/lib/twse-api-server';

export const dynamic = 'force-dynamic';

export async function GET() {
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
