import { NextRequest, NextResponse } from 'next/server';
import { readLatestReport, readReport } from '@/lib/report-store';

export const runtime = 'nodejs';

// ============================================================
// GET /api/market-report[?date=YYYY-MM-DD]
// Returns the latest after-close 盤勢分析 report (or a specific date).
// ============================================================

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get('date')?.trim();
  try {
    const report = date ? await readReport(date) : await readLatestReport();
    if (!report) {
      return NextResponse.json({ error: 'No report available yet' }, { status: 404 });
    }
    return NextResponse.json(report, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
    });
  } catch (error) {
    console.error('[api/market-report] error', error);
    return NextResponse.json({ error: 'Failed to load report' }, { status: 500 });
  }
}
