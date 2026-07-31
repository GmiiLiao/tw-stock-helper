import { getAdminDb } from '@/lib/firebase-admin';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 個股五檔委買委賣（盤中即時，僅供當下參考·不歸檔）。
// 讀 bookDepth/latest（daemon marketSnapshotLoop 每一輪優先集掃描後寫入，
// 範圍＝自選/持股/瀏覽中，即候選在工作台展開時已被 recordLiveRequests 記錄）。
// row: { bid: [[價,量張]×5 由優到劣], ask: [[價,量張]×5 由優到劣] }
export async function GET(req: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const code = new URL(req.url).searchParams.get('code') || '';
    const doc = (await db.collection('bookDepth').doc('latest').get()).data();
    if (!doc?.byCodeJson) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store' } });
    const all = JSON.parse(doc.byCodeJson as string) as Record<string, { bid: [number, number][]; ask: [number, number][] }>;
    const row = code ? (all[code] ?? null) : null;
    return NextResponse.json(
      { found: !!row, at: doc.at ?? null, row },
      // 快取修正 (2026-07-30)：前端每 5 秒輪詢這支，原本 no-store
      // 代表每個使用者的每次輪詢都是一次 Firestore document read
      // （500 人開個股頁 ≈ 100 reads/秒，讀的還是同一份 doc）。
      // s-maxage=5 讓 CDN 收斂掉九成以上，使用者最多落後一個 tick。
      { headers: { 'Cache-Control': 'public, max-age=3, s-maxage=5, stale-while-revalidate=10, stale-if-error=60' } },
    );
  } catch {
    return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
