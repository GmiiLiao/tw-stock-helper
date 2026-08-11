import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader } from '@/lib/api-cache';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 波段第 2 套預選機制：PID 斜率曲線分型（選股頁「📋 訊號榜單」·波段模式）。
// 讀 swingCurvePicks/latest（當日分型與各型預選股）＋ /scoreboard（60 日前瞻實記）。
//
// ⚠ 這是**觀察中的實驗**，不是已驗證訊號：歷史三窗無任何曲線通過
//   「淨報酬Δ與勝率Δ皆為正」的門檻，由 60 日實記當裁判（使用者指定的設計）。
//   前端務必保留 latest.note 與 scoreboard.note 的揭露文字。非投資建議。
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const [latest, board] = await Promise.all([
      db.collection('swingCurvePicks').doc('latest').get(),
      db.collection('swingCurvePicks').doc('scoreboard').get(),
    ]);
    if (!latest.exists) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    return NextResponse.json({ found: true, ...latest.data(), scoreboard: board.exists ? board.data() : null },
      { headers: { 'Cache-Control': cacheHeader('intraday') } });
  } catch {
    return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  }
}
