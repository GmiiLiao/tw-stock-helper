import { NextRequest, NextResponse } from 'next/server';
import { readStockAI } from '@/lib/daemon-store';

export const runtime = 'nodejs';

// ============================================================
// GET /api/ai/stock-eval?code=2330
// Returns ONLY the resident daemon's grounded AI swing analysis for a
// stock (波段操作分析). Deterministic classification (強力買進 等) and
// price levels come from /api/rating; news links from /api/twse/stock-news.
// Returns { swing: null } when the daemon hasn't analysed it yet.
// ============================================================

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')?.trim();
  if (!code || !/^\d{4,6}$/.test(code)) {
    return NextResponse.json({ error: 'Missing or invalid code' }, { status: 400 });
  }
  const ai = await readStockAI(code);
  if (!ai) {
    return NextResponse.json({ code, swing: null }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(
    { code, swing: ai.swing, signal: ai.signal, signalLabel: ai.signalLabel, model: ai.model, generatedAt: ai.generatedAt },
    { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60' } },
  );
}
