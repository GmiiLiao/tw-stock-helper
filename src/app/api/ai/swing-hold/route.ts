import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader, unavailable } from '@/lib/api-cache';
import { NextRequest, NextResponse } from 'next/server';
import { gzipJsonAuto } from '@/lib/gzip-response';
export const runtime = 'nodejs';

// 📈 波段持有：近 5／10／20／60 日連續成長榜＋整合榜（選股頁「📈 波段持有」分頁）。
// daemon 每交易日 16:45 定版寫 swingHold/{dataDate} 與 /latest（口徑見 ai-daemon.mjs computeSwingHold）。
//   GET /api/ai/swing-hold              → latest
//   GET /api/ai/swing-hold?date=YYYY-MM-DD → 該資料日的歷史榜（其他功能可引用）
//   GET /api/ai/swing-hold?list=1       → 可用資料日清單（新→舊，最多 90 筆）
// 每日一份、收盤後才變 ⇒ cacheHeader('daily')；找不到回 found:false（不捏造）。非投資建議。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const db = getAdminDb();
  if (!db) return unavailable('swing-hold');
  const sp = req.nextUrl.searchParams;
  try {
    if (sp.get('list') === '1') {
      const snap = await db.collection('swingHold').orderBy('dataDate', 'desc').limit(91).select('dataDate', 'updatedAt').get();
      const dates = snap.docs.filter(d => d.id !== 'latest').map(d => d.data().dataDate as string);
      return gzipJsonAuto({ found: true, dates }, { 'Cache-Control': cacheHeader('daily') });
    }
    const date = sp.get('date');
    const id = date && DATE_RE.test(date) ? date : 'latest';
    const doc = await db.collection('swingHold').doc(id).get();
    if (!doc.exists) return NextResponse.json({ found: false, date: id }, { headers: { 'Cache-Control': cacheHeader('daily') } });
    return gzipJsonAuto({ found: true, ...doc.data() }, { 'Cache-Control': cacheHeader('daily') });   // 2026-09-18：四窗×兩榜含量序，未壓約 100KB → gzip
  } catch {
    return unavailable('swing-hold');
  }
}
