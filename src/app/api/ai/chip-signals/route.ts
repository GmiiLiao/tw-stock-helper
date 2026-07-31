import { NextResponse } from 'next/server';
import { cacheHeader } from '@/lib/api-cache';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson } from '@/lib/gzip-response';
export const runtime = 'nodejs';

// 三大法人籌碼訊號（四準則）。?code=2330 回單檔標籤；否則回全市場四榜。
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const code = new URL(request.url).searchParams.get('code')?.trim();
    const snap = await db.collection('chipSignals').doc('latest').get();
    if (!snap.exists) return NextResponse.json(null, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    const d = snap.data() || {};
    const meta = { dataDate: d.dataDate, marginDate: d.marginDate, counts: d.counts, updatedAt: d.updatedAt };
    if (code) {
      const v = d.byCode?.[code] || null;
      return NextResponse.json({ ...meta, code, signal: v }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    }
    return gzipJson(request, { ...meta, rules: d.rules }, cacheHeader('intraday'));
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
