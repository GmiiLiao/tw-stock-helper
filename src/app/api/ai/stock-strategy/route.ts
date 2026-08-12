import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { memoize } from '@/lib/singleflight';
import { cacheHeader } from '@/lib/api-cache';
import { buildStrategySeries, buildStrategyWindows, computeHoldingStrategy } from '../../../../../scripts/lib/holding-strategy.mjs';

export const runtime = 'nodejs';

// ── 持股策略分析 on-demand（決策工作台用）────────────────────────────
//
// 為什麼是 web 端算而不是 daemon 預算：候選便條只存在前端（daemon 看不到），
// 工作台要對**任意**候選碼即點即看——預算清單永遠追不上使用者下一秒撿的股。
// 不變式仍守住：只讀 Firestore（chipArchive/chipCharacter），零上游請求。
//
// 計算共用 scripts/lib/holding-strategy.mjs（與 daemon 同一份，勿複製）。
// 脈絡（全市場序列＋~19萬個相似窗·Float32 打包 ~15MB）memoize 到 instance：
// 以「最新歸檔日」為鍵，收盤歸檔落地自動重建；首次建構 3~5 秒（singleflight
// 合流，同 instance 併發只建一次），之後每檔查詢 <100ms。
const getCtx = memoize('stock-strategy-ctx', 6 * 3600_000, async () => {
  const db = getAdminDb();
  if (!db) throw new Error('admin db unavailable');
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(262).get();
  const asc = snap.docs.map(d => d.data()).filter(a => a && a.closeJson).reverse();
  const series = buildStrategySeries(asc as Array<{ date: string; closeJson: string }>);
  const windows = buildStrategyWindows(series);
  let charMap: Record<string, { label?: string }> = {};
  try {
    const cd = await db.collection('chipCharacter').doc('latest').get();
    if (cd.exists) charMap = JSON.parse(cd.data()?.byCodeJson || '{}');
  } catch { /* 無分類則略 */ }
  // 股名對照（相似例顯示用）：marketSnapshot 快照全市場皆有 name
  let nameMap: Record<string, string> = {};
  try {
    const ms = (await db.collection('marketSnapshot').doc('latest').get()).data();
    const q = JSON.parse(ms?.quotesJson || '{}');
    for (const cc in q) if (q[cc]?.name) nameMap[cc] = q[cc].name;
  } catch { /* 缺名不擋 */ }
  const archDate = asc.length ? (asc[asc.length - 1] as { date: string }).date : null;
  return { series, windows, charMap, nameMap, archDate };
}, { timeoutMs: 60_000, isDegraded: v => !(v as { windows: { count: number } }).windows?.count });

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code || !/^\d{4,6}[A-Za-z]?$/.test(code)) {
    return NextResponse.json({ error: 'code required' }, { status: 400 });
  }
  const buyDate = request.nextUrl.searchParams.get('buyDate');   // 可選：持股才有
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ found: false, error: 'context unavailable' }, { status: 503 });
  const strategy = computeHoldingStrategy(ctx, code, buyDate || null);
  if (!strategy) {
    return NextResponse.json({ found: false, note: '該檔歷史序列不足（<25 個交易日）' },
      { headers: { 'Cache-Control': cacheHeader('intraday') } });
  }
  return NextResponse.json({ found: true, code, dataDate: ctx.archDate, strategy },
    { headers: { 'Cache-Control': cacheHeader('intraday') } });
}
