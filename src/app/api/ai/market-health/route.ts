import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
export const runtime = 'nodejs';
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('marketHealth').doc('latest').get();
    // 每日更新 → CDN 快取 5 分，N 個使用者共用一次讀取（原 no-store 每輪詢直讀 Firestore）
    return NextResponse.json(snap.exists ? snap.data() : null, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } });
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
