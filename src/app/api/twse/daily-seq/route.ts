import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { getAdminDb } from '@/lib/firebase-admin';
import { memoize } from '@/lib/singleflight';
import { cacheHeader, unavailable } from '@/lib/api-cache';

export const runtime = 'nodejs';

// ── 近 10 日漲跌×成交量＋三線位置（2026-09-17）──
// 讀 daemon 收盤後寫的 dailySeq/latest（全市場一份，~200KB），只回 ?codes= 要的檔（≤60）。
// 整份文件 memoize 10 分鐘（in-flight 合流），回應走 daily 層 CDN；一天只變一次，
// 1,000 個使用者看自選也只是 Firestore 每 10 分鐘 1 次讀取。找不到回 found:false，不捏造。
const readDoc = memoize('daily-seq-doc', 10 * 60_000, async () => {
  const db = getAdminDb();
  if (!db) return null;
  const snap = await db.collection('dailySeq').doc('latest').get();
  if (!snap.exists) return null;
  const d = snap.data() as { dataDate?: string; updatedAt?: number; byCodeJson?: string };
  return { dataDate: d.dataDate ?? null, updatedAt: d.updatedAt ?? null, map: JSON.parse(d.byCodeJson || '{}') as Record<string, number[]> };
});

export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, 'daily-seq', 240);
  if (limited) return limited;
  const codes = (request.nextUrl.searchParams.get('codes') || '').split(',').map(c => c.trim()).filter(c => /^\d{4,6}$/.test(c)).slice(0, 60);
  if (!codes.length) return NextResponse.json({ error: 'codes required' }, { status: 400 });
  try {
    const doc = await readDoc();
    if (!doc) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    const seq: Record<string, number[]> = {};
    for (const c of codes) if (doc.map[c]) seq[c] = doc.map[c];
    return NextResponse.json({ found: true, dataDate: doc.dataDate, updatedAt: doc.updatedAt, seq }, { headers: { 'Cache-Control': cacheHeader('daily') } });
  } catch {
    return unavailable('daily-seq');
  }
}
