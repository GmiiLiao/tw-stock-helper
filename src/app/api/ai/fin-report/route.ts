import { getAdminDb } from '@/lib/firebase-admin';
import { NextResponse } from 'next/server';
import { toSingles, finQuality, type FinQuarter } from '@/lib/fin-server';
import { unavailable } from '@/lib/api-cache';
export const runtime = 'nodejs';

// 個股財務體檢（近2年8季·MOPS官方）。?code=2330&price=1000（price 供 PE/PB/評價分）。
// 回傳：原始季度(累計制)、單季化、體質分解構。確定性計算，非投資建議。
export async function GET(request: Request) {
  const db = getAdminDb();
  const url = new URL(request.url);
  const code = url.searchParams.get('code')?.trim();
  const price = parseFloat(url.searchParams.get('price') || '0') || 0;
  if (!db) return unavailable('fin-report');
  if (!code) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });   // 參數缺≠故障
  try {
    const doc = (await db.collection('finReports').doc(code).get()).data();
    if (!doc) return NextResponse.json({ code, found: false }, { headers: { 'Cache-Control': 'public, s-maxage=3600' } });
    const quarters = JSON.parse((doc.quartersJson as string) || '[]') as FinQuarter[];
    const singles = toSingles(quarters);
    const quality = finQuality(quarters, price);
    return NextResponse.json(
      { code, found: true, name: doc.name, market: doc.market, updatedAt: doc.updatedAt, quarters, singles, quality },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } },
    );
  } catch { return unavailable('fin-report'); }
}
