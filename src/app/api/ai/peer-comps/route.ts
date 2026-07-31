import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
export const runtime = 'nodejs';

interface Peer { code: string; name: string; price: number | null; changePct: number | null; pe: number | null; pb: number | null; yield: number | null; revYoY: number; score: number | null; signal: string | null; rs: number | null }

// 同業比較：?code=2330 → 該股所屬產業的同業表 + 產業中位數。
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code') || '';
  const industryQ = request.nextUrl.searchParams.get('industry') || '';
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('peerComps').doc('latest').get();
    if (!snap.exists) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
    const d = snap.data()!;
    const industries: Record<string, Peer[]> = JSON.parse(d.industriesJson || '{}');
    const summary: Record<string, unknown> = JSON.parse(d.summaryJson || '{}');
    if (industryQ) {
      // 產業深頁：?industry=半導體業 → 該產業全表
      const peers = industries[industryQ] || [];
      return NextResponse.json({ updatedAt: d.updatedAt, month: d.month, industry: industryQ, median: summary[industryQ] ?? null, peers }, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
    }
    if (!code) {
      // 無 code → 只回產業清單與中位數摘要
      return NextResponse.json({ updatedAt: d.updatedAt, month: d.month, summary }, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
    }
    for (const ind in industries) {
      const peers = industries[ind];
      if (peers.some(p => p.code === code)) {
        return NextResponse.json(
          { updatedAt: d.updatedAt, month: d.month, industry: ind, median: summary[ind] ?? null, peers },
          { headers: { 'Cache-Control': 'public, s-maxage=300' } },
        );
      }
    }
    return NextResponse.json({ updatedAt: d.updatedAt, month: d.month, industry: null, peers: [] }, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
