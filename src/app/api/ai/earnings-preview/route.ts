import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
export const runtime = 'nodejs';

// 法說會質化前瞻（daemon previewEarningsCalls 生成，AI 推測、非數字預測）
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code') || '';
  const db = getAdminDb();
  if (!db || !/^\d{4,6}$/.test(code)) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('earningsCallPreviews').doc(code).get();
    return NextResponse.json(snap.exists ? snap.data() : null, { headers: { 'Cache-Control': 'public, s-maxage=1800' } });
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
