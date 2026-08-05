import { getAdminDb } from '@/lib/firebase-admin';
import { memoize } from '@/lib/singleflight';

// ── 推薦榜「已驗證訊號」修正量（2026-08-05）──────────────────────
// daemon 的 computeRecommendAdj 每日收盤後算好寫入 recommendAdj/latest；
// 這裡只負責讀取＋快取。**不在 route 內重算**——route 只拿得到單日資料，
// 算不出 20 日高／5 日漲幅／20 日波動／KD／MA5（三層架構鐵律）。
//
// 為什麼是「疊加」不是「取代」（screen-recommend-rank.mjs 對決結果）：
//   Ⓐ 修正後五大因子單獨  主窗Δ+0.236  OOT Δ+0.159
//   Ⓑ 這些已驗證訊號單獨  主窗Δ+0.053 ❌  OOT Δ+0.140   ← 比 Ⓐ 還差
//   Ⓒ Ⓐ＋Ⓑ×3           主窗Δ+0.249  OOT Δ+0.184   ← 四種配置全勝
// 這批訊號多是 −2 的「避開型」，擅長刪掉爛的、不擅長把好的排到前面。

export interface AdjEntry { a: number; w: string[] }
export interface AdjData { map: Record<string, AdjEntry>; weight: number; date: string | null }

const EMPTY: AdjData = { map: {}, weight: 3, date: null };

export const getRecommendAdj = memoize('recommendAdj', 300_000, async (): Promise<AdjData> => {
  try {
    const db = getAdminDb();
    if (!db) return EMPTY;
    const snap = await db.collection('recommendAdj').doc('latest').get();
    const d = snap.data();
    if (!d?.map) return EMPTY;
    return { map: JSON.parse(d.map), weight: d.weight ?? 3, date: d.date ?? null };
  } catch {
    // 讀不到就退回「只用五大因子」——Ⓐ 本身兩窗也都是正超額，
    // 降級後仍可用，不會因為缺這一份資料就整頁壞掉。
    return EMPTY;
  }
});
