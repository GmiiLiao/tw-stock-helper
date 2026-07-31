// ============================================================
// 財報體質（server-only）— 與 daemon finQuality 同一套回測定案規則。
// 資料：daemon/backfill 寫入的 finReports（近2年8季，MOPS 官方彙總）與
// finSummary/latest（每日體質摘要）。
// 注意：MOPS Q2/Q3/Q4 損益為「年度累計」→ toSingles 換算單季後才算 TTM/YoY。
// 回測(2事件·公布後20日)：最低分組跑輸3.2-3.6pt → 權重重罰低分輕獎高分：
//   <20→-3, <40→-1, 40-60→0, 60-80→+1, ≥80→+2（×1.5 併入選股排序）
// PE 實證為短線反向 → 只展示不加權。
// ============================================================

import { getAdminDb } from './firebase-admin';

export interface FinQuarter {
  y: number; s: number;
  rev?: number | null; op?: number | null; ni?: number | null; eps?: number | null;
  gm?: number | null; om?: number | null; nm?: number | null;
  assets?: number | null; debt?: number | null; equity?: number | null; bps?: number | null;
}

export function toSingles(quarters: FinQuarter[]): FinQuarter[] {
  const byKey: Record<string, FinQuarter> = {};
  for (const x of quarters) if (x) byKey[`${x.y}Q${x.s}`] = x;
  return quarters.map(x => {
    if (!x) return x;
    if (x.s === 1) return { ...x };
    const prev = byKey[`${x.y}Q${x.s - 1}`];
    const d = (k: 'rev' | 'ni' | 'eps' | 'op') => (x[k] != null && prev?.[k] != null) ? +((x[k] as number) - (prev[k] as number)).toFixed(2) : null;
    return { ...x, rev: d('rev'), ni: d('ni'), eps: d('eps'), op: d('op') };
  });
}

export interface FinQualityResult {
  score: number; profit: number; growth: number; stable: number; valuation: number;
  ttmEps: number | null; pe: number | null; pb: number | null; roe: number | null;
  epsYoY: number | null; revYoY: number | null; streak: number; lossQ: number;
  debtRatio: number | null; gm: number | null; nm: number | null;
}

export function finQuality(quarters: FinQuarter[], price: number): FinQualityResult | null {
  const raw = quarters.filter(x => x && (x.eps != null || x.rev != null));
  if (raw.length < 4) return null;
  const q = toSingles(raw);
  const eps = (i: number) => q[i]?.eps ?? null;
  const ttmEps = [0, 1, 2, 3].every(i => eps(i) != null) ? +([0, 1, 2, 3].reduce((s, i) => s + (eps(i) as number), 0)).toFixed(2) : null;
  let profit = 0;
  if (ttmEps != null && ttmEps > 0) profit += 10;
  const nm0 = q[0]?.nm ?? null; if (nm0 != null) profit += nm0 >= 10 ? 10 : nm0 >= 5 ? 5 : 0;
  const ttmNi = [0, 1, 2, 3].every(i => q[i]?.ni != null) ? [0, 1, 2, 3].reduce((s, i) => s + (q[i].ni as number), 0) : null;
  const roe = ttmNi != null && (q[0]?.equity ?? 0) > 0 ? ttmNi / (q[0].equity as number) * 100 : null;
  if (roe != null) profit += roe > 15 ? 10 : roe > 8 ? 6 : roe > 0 ? 3 : 0;
  let growth = 0;
  const yoy = (i: number) => {
    const a = eps(i), b = eps(i + 4);
    return (a != null && b != null && Math.abs(b) > 0.01) ? (a - b) / Math.abs(b) * 100 : null;
  };
  const y0 = yoy(0); if (y0 != null) growth += y0 > 30 ? 12 : y0 > 0 ? 7 : 0;
  let streak = 0; for (let i = 0; i < 4; i++) { const y = yoy(i); if (y != null && y > 0) streak++; else break; }
  growth += streak >= 3 ? 10 : streak === 2 ? 6 : streak === 1 ? 3 : 0;
  const rev0 = q[0]?.rev ?? null, rev4 = q[4]?.rev ?? null;
  const revYoY = rev0 != null && rev4 != null && rev4 > 0 ? (rev0 - rev4) / rev4 * 100 : null;
  if (revYoY != null) growth += revYoY > 20 ? 8 : revYoY > 0 ? 4 : 0;
  const lossQ = q.slice(0, 8).filter(x => x && x.eps != null && (x.eps as number) < 0).length;
  const stable = lossQ === 0 ? 20 : lossQ === 1 ? 12 : lossQ === 2 ? 6 : 0;
  const pe = ttmEps != null && ttmEps > 0 && price > 0 ? price / ttmEps : null;
  const valuation = pe == null ? 0 : pe < 10 ? 20 : pe < 15 ? 15 : pe < 20 ? 10 : pe < 30 ? 5 : 0;
  const debtRatio = (q[0]?.assets ?? 0) > 0 && q[0]?.debt != null ? +((q[0].debt as number) / (q[0].assets as number) * 100).toFixed(1) : null;
  return {
    score: profit + growth + stable + valuation, profit, growth, stable, valuation,
    ttmEps, pe: pe != null ? +pe.toFixed(1) : null,
    pb: (q[0]?.bps ?? 0) > 0 && price > 0 ? +(price / (q[0].bps as number)).toFixed(2) : null,
    roe: roe != null ? +roe.toFixed(1) : null,
    epsYoY: y0 != null ? +y0.toFixed(1) : null, revYoY: revYoY != null ? +revYoY.toFixed(1) : null,
    streak, lossQ, debtRatio, gm: q[0]?.gm ?? null, nm: nm0,
  };
}

// 選股加權：讀 daemon 的 finSummary/latest（{code:{s,w,pe,...}}），5 分快取
export interface FinWeights { map: Record<string, { s: number; w: number; pe: number | null; yoy: number | null }>; count: number }
let _cache: (FinWeights & { at: number }) | null = null;
export async function getFinWeights(): Promise<FinWeights> {
  if (_cache && Date.now() - _cache.at < 5 * 60_000) return _cache;
  const db = getAdminDb();
  if (!db) return { map: {}, count: 0 };
  try {
    const doc = (await db.collection('finSummary').doc('latest').get()).data();
    const by = JSON.parse((doc?.byCodeJson as string) || '{}') as Record<string, { s: number; w: number; pe: number | null; yoy: number | null }>;
    _cache = { map: by, count: Object.keys(by).length, at: Date.now() };
    return _cache;
  } catch { return { map: {}, count: 0 }; }
}
