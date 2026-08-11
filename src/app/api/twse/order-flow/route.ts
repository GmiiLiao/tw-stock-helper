import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader } from '@/lib/api-cache';

// ── 內外盤（取樣）───────────────────────────────────────────────────
// ⚠ 這不是券商等級的逐筆內外盤。TWSE MIS **沒有內外盤欄位**
//   （實測 getStockInfo 只有 a/b 五檔價、f/g 五檔量、z 成交價、v 累計量）。
//   daemon 是用「兩次輪詢之間的成交量增量」配上當下成交價相對五檔判方向：
//     成交價 ≥ 賣一 → 外盤；≤ 買一 → 內盤；介於中間 → 中性。
//   ⇒ 總量精確、**方向是 5 秒取樣**；且只涵蓋優先集（自選/持股/正在瀏覽的個股）。
//   回傳 since 讓前端標示「自 HH:MM 起」——daemon 重啟或該檔中途才進優先集時，
//   前面的量不在樣本內，不標出來會被誤讀成全日累計。
export async function GET(req: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  const code = new URL(req.url).searchParams.get('code') || '';
  if (!/^\d{4}$/.test(code)) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const d = (await db.collection('marketSnapshot').doc('flow').get()).data();
    if (!d?.byCodeJson) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('quote') } });
    const by = JSON.parse(d.byCodeJson as string) as Record<string, [number, number, number, number]>;
    const row = by[code];
    if (!row) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('quote') } });
    const [inner, outer, mid, since] = row;
    const total = inner + outer + mid;
    return NextResponse.json(
      { found: true, date: d.date, inner, outer, mid, total,
        outerPct: total > 0 ? +((outer / total) * 100).toFixed(1) : null,
        innerPct: total > 0 ? +((inner / total) * 100).toFixed(1) : null,
        since, at: d.at },
      { headers: { 'Cache-Control': cacheHeader('quote') } },
    );
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
