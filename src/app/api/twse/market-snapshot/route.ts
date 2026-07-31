import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader } from '@/lib/api-cache';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

// 全市場即時快照（daemon marketSnapshot/latest，~1900 檔、盤中每分更新）。
// 供急漲跌榜等需要「全市場」視角的清單——原本只用追蹤池(自選+AI推薦幾十檔)，
// 崩盤日跌停上百檔卻只顯示追蹤池裡的 3 檔（2026-07-17 實案）。
// 精簡欄位陣列以壓體積；s-maxage=30 收斂讀取。
export async function GET() {
  const db = getAdminDb();
  if (!db) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const s = (await db.collection('marketSnapshot').doc('latest').get()).data();
    if (!s?.quotesJson) return NextResponse.json({ found: false }, { headers: { 'Cache-Control': cacheHeader('quote') } });
    const q = JSON.parse(s.quotesJson as string) as Record<string, { name?: string; price?: number; change?: number; changePercent?: number; volume?: number; market?: string; open?: number; high?: number; low?: number; live?: boolean }>;
    // 20日均量表（daemon volAvg20，供量能倍數/強度分）
    let avg: Record<string, number> = {};
    try { const va = (await db.collection('volAvg20').doc('latest').get()).data(); if (va?.avgJson) avg = JSON.parse(va.avgJson as string); } catch { /* optional */ }
    const quotes = [];
    const marketOpen = !!s.marketOpen;
    for (const code in q) {
      if (!/^\d{4}$/.test(code)) continue;
      const x = q[code];
      if (!(Number(x.price) > 0)) continue;
      // 掃描期間(盤中+收盤後至15:00)只回真即時(live)——昨日種子混入會顯示昨日漲跌
      // （實案：東元+1.3%昨日 vs 實際-4.29%；收盤後達運光電+5.2%昨日 vs 實際-7.77%）。
      // 15:00 官方結算後快照整批換今日收盤，全數回傳。
      const sweeping = (s as { sweeping?: boolean }).sweeping ?? marketOpen;
      if (sweeping && !x.live) continue;
      const a = avg[code] || 0; // 20日均量(張)
      const volX = a > 0 ? +(((x.volume ?? 0) / 1000) / a).toFixed(1) : null;
      quotes.push({
        code, name: (x.name || '').trim(), price: x.price, change: x.change ?? 0,
        changePercent: x.changePercent ?? 0, volume: x.volume ?? 0, volX,
        market: x.market || 'tse', open: x.open ?? 0, high: x.high ?? 0, low: x.low ?? 0,
      });
    }
    return NextResponse.json(
      { found: true, updatedAt: s.sweepAt ?? null, marketOpen: !!s.marketOpen, count: quotes.length, quotes },
      { headers: { 'Cache-Control': cacheHeader('quote') } },
    );
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
