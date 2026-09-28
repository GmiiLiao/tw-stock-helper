import { NextResponse } from 'next/server';
import { cacheHeader, unavailable } from '@/lib/api-cache';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJson } from '@/lib/gzip-response';
import { memoize } from '@/lib/singleflight';

// 全市場當日法人（chipDaily/latest·[外資,投信,自營]張）。
// 2026-09-03 使用者回報：南亞當日欄全「—」——chipSignals 的 byCode 只收錄
// 中了四準則的股票（設計如此·訊號榜語意），但 UI 拿它當「當日數字」來源，
// 沒中訊號的股票就被誤顯示成「沒有交易」。修法：單檔查詢一律附 day
// （全市場來源），訊號欄位語意不動——避免動 byCode 收錄條件波及其他消費端。
const getChipDayMap = memoize<{ date: string; map: Record<string, number[]> } | null>('chip-daily-map', 15_000, async () => {
  const db = getAdminDb();
  if (!db) return null;
  const snap = await db.collection('chipDaily').orderBy('date', 'desc').limit(1).get();
  const d = snap.docs[0]?.data();
  if (!d?.codesJson) return null;
  return { date: d.date, map: JSON.parse(d.codesJson) };
});
export const runtime = 'nodejs';

// 三大法人籌碼訊號（四準則）。?code=2330 回單檔標籤；否則回全市場四榜。
export async function GET(request: Request) {
  const db = getAdminDb();
  if (!db) return unavailable('chip-signals');
  try {
    const code = new URL(request.url).searchParams.get('code')?.trim();
    const snap = await db.collection('chipSignals').doc('latest').get();
    if (!snap.exists) return NextResponse.json(null, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    const d = snap.data() || {};
    const meta = { dataDate: d.dataDate, marginDate: d.marginDate, counts: d.counts, updatedAt: d.updatedAt };
    if (code) {
      const v = d.byCode?.[code] || null;
      let day = null;
      try {
        const dm = await getChipDayMap();
        const r = dm?.map?.[code];
        if (Array.isArray(r)) day = { foreign: r[0] ?? 0, trust: r[1] ?? 0, dealer: r[2] ?? 0, date: dm!.date };
      } catch { /* 缺 day 不擋訊號 */ }
      return NextResponse.json({ ...meta, code, signal: v, day }, { headers: { 'Cache-Control': cacheHeader('intraday') } });
    }
    return gzipJson(request, { ...meta, rules: d.rules }, cacheHeader('intraday'));
  } catch { return unavailable('chip-signals'); }
}
