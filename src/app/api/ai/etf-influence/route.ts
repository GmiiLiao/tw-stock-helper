import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson } from '@/lib/gzip-response';
export const runtime = 'nodejs';

// 第四法人：ETF 被動買賣盤影響。?code= 回單檔(市值排名/ETF權重/邊緣)；否則回全景。
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const code = new URL(request.url).searchParams.get('code')?.trim();
    const snap = await db.collection('etfInfluence').doc('latest').get();
    if (!snap.exists) return NextResponse.json(null, { headers: { 'Cache-Control': 'public, s-maxage=600' } });
    const d = snap.data() || {};
    if (code) {
      const meta = { date: d.date, review: d.review, note: d.note };
      return NextResponse.json({ ...meta, code, info: d.byCode?.[code] || null }, { headers: { 'Cache-Control': 'public, s-maxage=600' } });
    }
    const { byCode, ...rest } = d;
    void byCode;
    return gzipJson(request, rest, 'public, s-maxage=600');
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
