import { getAdminDb } from '@/lib/firebase-admin';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 法人籌碼「性格分類」完整總表（盤中戰情「📋 完整總表」分頁）。
// 讀 chipCharacter/latest（daemon 每日由 3 年 chipArchive 計算）。
// 每檔：label(長期核心/炒作型/一般)、spec(炒作活躍度0-100)、core(長抱分0-100)、
//       corr(籌碼領先隔日報酬)、share(法人週轉佔量)、bias(單向長抱↔來回)、
//       f20/t20/d20(外資/投信/自營 20日累計張)、fStreak/tStreak/dStreak(連買+/連賣-日數)。
//       確定性、非投資建議。
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const doc = await db.collection('chipCharacter').doc('latest').get();
    if (!doc.exists) {
      return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'public, s-maxage=120' } });
    }
    const d = doc.data() || {};
    let byCode: Record<string, unknown> = {};
    try { byCode = JSON.parse(d.byCodeJson || '{}'); } catch { byCode = {}; }
    // 轉成陣列，前端再 join 即時價/名稱
    const rows = Object.entries(byCode).map(([code, v]) => ({ code, ...(v as Record<string, unknown>) }));
    return NextResponse.json(
      { found: true, updatedAt: d.at ?? null, window: d.window ?? null, counts: d.counts ?? null, rows },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  } catch {
    return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
