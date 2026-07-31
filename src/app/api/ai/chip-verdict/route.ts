import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader } from '@/lib/api-cache';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 籌碼判讀（持倉狀態卡＋個股頁共用）。?codes=2330,2317 取子集；不帶=前50檔。
// 規則全部回測背書：清倉(倒貨≥70%)>優先減碼(外資先轉賣95%領先)>觀望(雙賣=調節)
// >減碼(連賣)>可加碼(S/A/B+ 47-50%·2年實測)>續抱。法人為 t-1 EOD。非投資建議。
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const codesParam = new URL(request.url).searchParams.get('codes');
    const doc = (await db.collection('chipVerdicts').doc('latest').get()).data();
    if (!doc?.byCodeJson) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    const all = JSON.parse(doc.byCodeJson as string) as Record<string, unknown>;
    let byCode: Record<string, unknown>;
    if (codesParam) {
      byCode = {};
      for (const c of codesParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 60)) if (all[c]) byCode[c] = all[c];
    } else {
      byCode = Object.fromEntries(Object.entries(all).slice(0, 50));
    }
    return NextResponse.json(
      { found: true, updatedAt: doc.updatedAt, dataDate: doc.dataDate, byCode },
      { headers: { 'Cache-Control': cacheHeader('intraday') } },
    );
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
