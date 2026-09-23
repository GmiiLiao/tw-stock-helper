import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader } from '@/lib/api-cache';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// ⚡ 盤中漲停預測（即時漲跌頁·多空同屏，2026-09-22 起）：讀 limitUpForecast/live——盤中每分多鐘用即時價重算，名單會變。
// 盤後定案、凍結一整天的預測名單走 /api/ai/limitup-forecast（latest）。
// ⚠ 回應格式必須與 limitup-forecast 相同（{ found, ...doc }）：LimitUpPanel 以 found 判斷有無資料；
//   2026-09-23 首版改用 latestDoc 回原始文件、少了 found ⇒ 面板一律顯示「尚無資料」（使用者截圖）。
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const doc = await db.collection('limitUpForecast').doc('live').get();
    if (!doc.exists) return gzipJsonAuto({ found: false }, { 'Cache-Control': cacheHeader('intraday') });
    return gzipJsonAuto({ found: true, ...doc.data() }, { 'Cache-Control': cacheHeader('intraday') });
  } catch {
    return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  }
}
