// ============================================================
// 四大法人加權（server-only）— 與 daemon instWeight 同一套回測驗證權重。
// 回測（隔日沖 83 日）：基準 Top5 勝率 48.4% → 保守加權 51.3%、報酬 1.03%→1.26%。
// 資料：daemon 寫入的 chipDaily（全個股每日 [外資,投信,自營] 張，EOD → 盤中即 t-1，
// PIT 安全）＋ etfInfluence byCode（第四法人：0050/006208 成分/邊緣）。
// 權重（保守版，勿隨意調大——「積極」與「正比拉抬」皆因訊號相關過擬合而輸給保守）：
//   外資方向 買+3 / 賣超-6（外資賣超隔日沖勝率僅39%、負報酬）
//   外資連買 +1×min(天數,6)；三方同買 +3；外資大買≥5000張 +2；投信買 +1；ETF成分 +1.5
// ============================================================

import { getAdminDb } from './firebase-admin';

// map ＝舊版完整權重（volSurge 等榜仍用同式，顯示用）；map2 ＝ 2026-09-18 權值稽核 D2 修剪版：
//   只留外資方向（買+3／賣−6：480 日兩窗方向皆顯著），連買／三方同買／≥5000 張／投信／ETF 歸零
//   （連買樣本外顯著為負 −0.05～−0.14pp；三方同買在歸檔無自營商欄位、從未可驗；其餘 CI 跨 0）。
//   推薦榜排序鍵改用 map2×0.5（screen-weights-v2：五大+法人×1.5 樣本外 +0.21 < 五大 +0.29、×0.5 +0.27）。
interface InstWeights { map: Record<string, number>; map2: Record<string, number>; date: string; version: string }
export const INST_WEIGHT_VERSION = { version: '2026-09-18.v2', trainedThrough: '2026-09-16', oosFrom: '2026-06-10', reviewBy: '2026-11-17' } as const;

let _cache: (InstWeights & { at: number }) | null = null;

export async function getInstWeights(): Promise<InstWeights> {
  if (_cache && Date.now() - _cache.at < 5 * 60_000) return _cache;
  const db = getAdminDb();
  if (!db) return { map: {}, map2: {}, date: '', version: INST_WEIGHT_VERSION.version };
  try {
    const snap = await db.collection('chipDaily').orderBy('date', 'desc').limit(8).get();
    const days = snap.docs.map(d => {
      const x = d.data();
      return { date: (x.date as string) || d.id, map: JSON.parse((x.codesJson as string) || '{}') as Record<string, number[]> };
    });
    if (!days.length) return { map: {}, map2: {}, date: '', version: INST_WEIGHT_VERSION.version };

    let etf: Record<string, { bigEtf?: boolean; edge?: string }> = {};
    try { etf = ((await db.collection('etfInfluence').doc('latest').get()).data()?.byCode as typeof etf) || {}; } catch { /* optional */ }

    const latest = days[0].map;
    const map: Record<string, number> = {}; const map2: Record<string, number> = {};
    for (const code in latest) {
      const row = latest[code] || [];
      const f = row[0] || 0, t = row[1] || 0, dd = row[2] || 0;
      let streak = 0;
      for (const day of days) { if ((day.map[code]?.[0] || 0) > 0) streak++; else break; }
      let w = (f > 0 ? 3 : f < 0 ? -6 : 0)
        + Math.min(streak, 6)
        + (f > 0 && t > 0 && dd > 0 ? 3 : 0)
        + (f >= 5000 ? 2 : 0)
        + (t > 0 ? 1 : 0);
      const e = etf[code];
      if (e && (e.bigEtf || e.edge)) w += 1.5;
      if (w !== 0) map[code] = w;
      const w2 = f > 0 ? 3 : f < 0 ? -6 : 0;
      if (w2 !== 0) map2[code] = w2;
    }
    _cache = { at: Date.now(), map, map2, date: days[0].date, version: INST_WEIGHT_VERSION.version };
    return _cache;
  } catch {
    return { map: {}, map2: {}, date: '', version: INST_WEIGHT_VERSION.version };
  }
}
