import { getAdminDb } from '@/lib/firebase-admin';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 個股當日三大法人 + 外資連買天數（讀 chipDaily，全個股皆有，PIT：EOD/盤中即 t-1）。
export async function GET(request: Request) {
  const db = getAdminDb();
  const code = new URL(request.url).searchParams.get('code')?.trim();
  if (!db || !code) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const snap = await db.collection('chipDaily').orderBy('date', 'desc').limit(8).get();
    const days = snap.docs.map(d => {
      const x = d.data();
      return { date: (x.date as string) || d.id, map: JSON.parse((x.codesJson as string) || '{}') as Record<string, number[]> };
    });
    if (!days.length) return NextResponse.json({ code, found: false }, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
    const row = days[0].map[code];
    if (!row) return NextResponse.json({ code, found: false, dataDate: days[0].date }, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
    let streak = 0;
    for (const day of days) { if ((day.map[code]?.[0] || 0) > 0) streak++; else break; }
    // 連買期間累計三大法人（多日連買時用累計判斷，勝過單日雜訊）
    const nCum = Math.max(streak, 1);
    let fCum = 0, tCum = 0, dCum = 0;
    for (let k = 0; k < nCum; k++) { const r = days[k]?.map[code]; if (r) { fCum += r[0] || 0; tCum += r[1] || 0; dCum += r[2] || 0; } }
    // 成交量(張)——供「大買」改用相對比例(外資佔成交量%)，上市/上櫃一致
    let vol = 0;
    try {
      const arch = (await db.collection('chipArchive').doc(days[0].date).get()).data();
      if (arch?.closeJson) vol = (JSON.parse(arch.closeJson as string)[code]?.[1]) || 0;
    } catch { /* optional */ }
    return NextResponse.json(
      { code, found: true, dataDate: days[0].date, foreign: row[0] || 0, trust: row[1] || 0, dealer: row[2] || 0, streak, vol, foreignCum: fCum, trustCum: tCum, dealerCum: dCum },
      { headers: { 'Cache-Control': 'public, s-maxage=300' } },
    );
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
