// ── 當沖工作台：整張部位與扣成本淨 R（tw-day-trading 技巧的部位公式；純函式）──────────
// n 取滿足以下的最大非負整數：
//   n×1000×d ＋ 買賣手續費(n) ＋ 賣出稅(n) ＋ 雙邊滑價(n) ≤ 每筆損失上限
//   且 n×1000×進場價 ＋ 進場手續費 ≤ 可用資金／額度
// 手續費用使用者自己的券商折讓與最低手續費（useBrokerSettings）；稅＝現股當沖 0.15%（賣出那一邊）。
// 缺每筆風險上限 ⇒ 只列觀察、不給張數（技巧原文規定）。
import { calcFee, calcTax, type BrokerSettings } from '@/lib/tw-fee';

export interface DeskRisk {
  riskCapTwd: number | null;    // 每筆最大可承受損失（元）
  capitalTwd: number | null;    // 可用資金／當沖額度（元）
  dailyCapTwd: number | null;   // 單日虧損上限（元）
  todayLossTwd: number;         // 今日已實現虧損（元，正數）
  slipTicks: number;            // 預估單邊滑價（檔）
}
export const DEFAULT_RISK: DeskRisk = { riskCapTwd: null, capitalTwd: null, dailyCapTwd: null, todayLossTwd: 0, slipTicks: 1 };

const tickOf = (p: number) => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);

/** 一筆來回（進場價→出場價）的成本（元）：雙邊手續費＋賣出那邊的當沖稅＋雙邊滑價 */
function roundTripCost(side: 'long' | 'short', entry: number, exit: number, lots: number, b: BrokerSettings, slipTicks: number): number {
  const sellPx = side === 'long' ? exit : entry;
  return calcFee(entry, lots, b) + calcFee(exit, lots, b) + calcTax(sellPx, lots, { dayTrade: true }) + 2 * slipTicks * tickOf(entry) * 1000 * lots;
}

export interface LotPlan {
  lots: number | null;          // null＝缺參數；0＝算得出來但一張都放不下
  why: string | null;           // 為什麼沒有張數
  riskTwd: number | null;       // 在結構停損出場的總損失（含成本）＝初始風險（淨 R 的分母）
  netTwd: (number | null)[];    // 1R/2R/3R 扣成本淨損益（元）
  netR: (number | null)[];      // 1R/2R/3R 扣成本淨 R
}

export function planLots(side: 'long' | 'short', entry: number, stop: number, targets: number[], b: BrokerSettings, r: DeskRisk): LotPlan {
  const s = side === 'long' ? 1 : -1;
  const d = s * (entry - stop);
  const empty: LotPlan = { lots: null, why: null, riskTwd: null, netTwd: [null, null, null], netR: [null, null, null] };
  if (!(d > 0)) return { ...empty, why: '停損不在進場價的反方向' };
  const lossAt = (n: number) => n * 1000 * d + roundTripCost(side, entry, stop, n, b, r.slipTicks);
  const netAt = (n: number) => targets.map(t => n * 1000 * s * (t - entry) - roundTripCost(side, entry, t, n, b, r.slipTicks));
  // 沒有風險上限：只列觀察；仍用 1 張示範淨 R（淨 R 與張數幾乎無關，最低手續費除外）
  if (r.riskCapTwd == null || !(r.riskCapTwd > 0)) {
    const one = lossAt(1); const nets = netAt(1);
    return { lots: null, why: '缺每筆風險上限：只列觀察、不給張數', riskTwd: null, netTwd: [null, null, null], netR: nets.map(v => +(v / one).toFixed(2)) };
  }
  const dailyLeft = r.dailyCapTwd != null && r.dailyCapTwd > 0 ? r.dailyCapTwd - r.todayLossTwd : Infinity;
  if (dailyLeft <= 0) return { ...empty, lots: 0, why: '已達單日虧損上限：停止提出進場' };
  const cap = Math.min(r.riskCapTwd, dailyLeft);
  let n = 0;
  for (let k = 1; k <= 500; k++) {
    if (lossAt(k) > cap) break;
    if (r.capitalTwd != null && r.capitalTwd > 0 && k * 1000 * entry + calcFee(entry, k, b) > r.capitalTwd) break;
    n = k;
  }
  if (n === 0) {
    const need = Math.ceil(lossAt(1));
    return { ...empty, lots: 0, why: `1 張的停損損失約 ${need.toLocaleString()} 元已超過上限（或資金不足）` };
  }
  const risk = lossAt(n); const nets = netAt(n);
  return { lots: n, why: null, riskTwd: Math.round(risk), netTwd: nets.map(v => Math.round(v)), netR: nets.map(v => +(v / risk).toFixed(2)) };
}
