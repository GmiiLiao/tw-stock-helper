// ============================================================
// 投資組合帳本引擎 —— 交易紀錄是唯一真相，其他一律推導
//
// 為什麼存在（2026-08-01 對帳實例，nicholas 帳號 35 筆）：
// 舊作法把 realizedPnL 在「記錄當下」用手動持倉的 buyPrice 算好存死，
// 手動持倉與交易紀錄不同步時就成垃圾且無從追查：
//   · 大立光 7/6 賣出存 costBasis 4985，交易紀錄明明 6/25 買 4585
//     → 虧損多算 39 萬
//   · 華邦電賣出存 costBasis 226，交易紀錄買價 26 → 兩邊差 80 萬
//   · 2026-06 的早期紀錄只扣賣方費稅（少扣買進手續費）
//   · 群創 6/25 賣 66 張但帳上只買過 56 張（超賣無成本依據）
// 顯示的「已實現損益」是這些不一致方法的總和。
//
// 本引擎：逐 code 按時間重放交易 → 加權平均成本（含買進手續費）→
// 每筆賣出當下重算損益；與存檔值差 >1 元標 mismatch、超賣標 oversold，
// 全部攤在 UI 上讓使用者回頭修紀錄，而不是給一個對不上的總數。
//
// 口徑：
//   · 數量一律「張」（可小數，0.35 = 350 股），金額一律「元」
//   · 成本 = 買進淨支出（成交 + 買進手續費）→ avgCost 為每股含費成本
//   · 已實現 = 賣出淨收入（成交 − 手續費 − 稅）− 對應成本
//   · 股利記純現金收入，不調整持股成本（簡化；除權息成本還原不在此處理）
//   · 超賣部分的收入不計入已實現（無成本可對應），單獨列 warning
// ============================================================

import type { TradeRecord } from './store';
import { sharesOf } from './tw-fee';

export interface ClosedTrade {
  id: string;
  code: string;
  name: string;
  date: string;
  lots: number;            // 賣出張數
  sellPrice: number;
  avgCost: number;         // 賣出當下的每股加權成本（含買進費）
  proceeds: number;        // 淨收入（可對應部分）
  pnl: number;             // 重算後已實現淨損益
  roi: number;             // pnl / 對應成本 %
  storedPnL: number | null;// 紀錄當下存的值（可能用了過期的手動持倉價）
  mismatch: boolean;       // |pnl − storedPnL| > 1 → 需要人工核對
  oversoldLots: number;    // 無買進紀錄可對應的張數
  holdingDays: number | null; // 距最近一次買進的日曆天數
  dayTrade?: boolean;
}

export interface OpenPosition {
  code: string;
  name: string;
  lots: number;
  avgCost: number;         // 每股（含買進費）
  cost: number;            // 總成本
  lastBuyDate: string | null;
}

export interface CodeLedger {
  code: string;
  name: string;
  openLots: number;
  avgCost: number;
  openCost: number;
  realized: number;
  dividend: number;
  fee: number;
  tax: number;
  buyAmount: number;       // 累計買進淨支出
  sellAmount: number;      // 累計賣出淨收入
  closed: ClosedTrade[];
  lastBuyDate: string | null;
  warnings: string[];
}

export interface Ledger {
  byCode: Record<string, CodeLedger>;
  closed: ClosedTrade[];               // 全部平倉，新→舊
  openPositions: OpenPosition[];       // 依交易紀錄推算的現存部位
  totalRealized: number;
  totalDividend: number;
  totalFee: number;
  totalTax: number;
  totalBuyAmount: number;
  totalSellAmount: number;
  winCount: number;
  lossCount: number;
  closedCount: number;
  winRate: number;                     // %
  avgWin: number;
  avgLoss: number;
  expectancy: number;                  // 每筆平倉期望值
  monthly: Array<{ month: string; realized: number; dividend: number }>;
  mismatchCount: number;
  warnings: string[];                  // 全域彙整（超賣、對不上等）
}

const dayDiff = (a: string, b: string): number | null => {
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.max(0, Math.round((tb - ta) / 86400000));
};

export function buildLedger(records: TradeRecord[]): Ledger {
  // 時間序重放：同日以 createdAt 次序（同日先買後賣的當沖才會對到成本）
  const sorted = [...records].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0),
  );

  const byCode: Record<string, CodeLedger> = {};
  const state: Record<string, { lots: number; cost: number }> = {};

  for (const t of sorted) {
    if (!byCode[t.code]) {
      byCode[t.code] = {
        code: t.code, name: t.name, openLots: 0, avgCost: 0, openCost: 0,
        realized: 0, dividend: 0, fee: 0, tax: 0, buyAmount: 0, sellAmount: 0,
        closed: [], lastBuyDate: null, warnings: [],
      };
      state[t.code] = { lots: 0, cost: 0 };
    }
    const led = byCode[t.code];
    const st = state[t.code];
    led.name = t.name || led.name;
    led.fee += t.fee || 0;
    led.tax += t.tax || 0;

    if (t.type === 'dividend') {
      led.dividend += t.totalAmount || 0;
      continue;
    }
    if (t.type === 'buy') {
      st.lots += t.quantity;
      st.cost += Math.abs(t.totalAmount);      // 淨支出＝成交＋買進手續費
      led.buyAmount += Math.abs(t.totalAmount);
      led.lastBuyDate = t.date;
      continue;
    }
    // sell
    const proceeds = t.totalAmount;            // 淨收入（已扣賣方費稅）
    led.sellAmount += proceeds;
    const matchedLots = Math.min(t.quantity, st.lots);
    const oversoldLots = +(t.quantity - matchedLots).toFixed(6);
    const heldShares = sharesOf(st.lots);
    const avgCost = heldShares > 0 ? st.cost / heldShares : 0;
    const matchedCost = avgCost * sharesOf(matchedLots);
    // 超賣部分的收入不能算獲利（沒有成本可扣）——按比例只取可對應部分
    const proceedsMatched = t.quantity > 0 ? proceeds * (matchedLots / t.quantity) : 0;
    const pnl = Math.round(proceedsMatched - matchedCost);
    const roi = matchedCost > 0 ? +((pnl / matchedCost) * 100).toFixed(2) : 0;
    st.lots = +(st.lots - matchedLots).toFixed(6);
    st.cost = st.lots > 0 ? st.cost - matchedCost : 0;

    const storedPnL = t.realizedPnL ?? null;
    const closed: ClosedTrade = {
      id: t.id, code: t.code, name: t.name, date: t.date,
      lots: t.quantity, sellPrice: t.price,
      avgCost: +avgCost.toFixed(4), proceeds: Math.round(proceedsMatched),
      pnl, roi, storedPnL,
      mismatch: storedPnL != null && Math.abs(pnl - storedPnL) > 1,
      oversoldLots,
      holdingDays: led.lastBuyDate ? dayDiff(led.lastBuyDate, t.date) : null,
      dayTrade: t.dayTrade,
    };
    if (matchedLots > 0) led.realized += pnl;
    led.closed.push(closed);
    if (oversoldLots > 0) {
      led.warnings.push(
        `${t.date} 賣出 ${t.quantity} 張但帳上僅持有 ${matchedLots} 張——超賣 ${oversoldLots} 張無買進紀錄可對應，其收入未計入已實現損益（請補記買進或修正張數）`,
      );
    }
  }

  // 收尾：每 code 的現存部位
  const openPositions: OpenPosition[] = [];
  for (const code of Object.keys(byCode)) {
    const led = byCode[code], st = state[code];
    led.openLots = st.lots;
    led.openCost = Math.round(st.cost);
    led.avgCost = st.lots > 0 ? +(st.cost / sharesOf(st.lots)).toFixed(4) : 0;
    if (st.lots > 0.0005) {
      openPositions.push({ code, name: led.name, lots: st.lots, avgCost: led.avgCost, cost: led.openCost, lastBuyDate: led.lastBuyDate });
    }
  }
  openPositions.sort((a, b) => b.cost - a.cost);

  const allClosed = Object.values(byCode).flatMap(l => l.closed)
    .sort((a, b) => b.date.localeCompare(a.date));
  const wins = allClosed.filter(c => c.pnl > 0);
  const losses = allClosed.filter(c => c.pnl < 0);
  const totalRealized = Object.values(byCode).reduce((s, l) => s + l.realized, 0);
  const totalDividend = Object.values(byCode).reduce((s, l) => s + l.dividend, 0);

  const monthlyMap: Record<string, { month: string; realized: number; dividend: number }> = {};
  for (const c of allClosed) {
    const m = c.date.slice(0, 7);
    (monthlyMap[m] ||= { month: m, realized: 0, dividend: 0 }).realized += c.pnl;
  }
  for (const t of sorted) {
    if (t.type !== 'dividend') continue;
    const m = t.date.slice(0, 7);
    (monthlyMap[m] ||= { month: m, realized: 0, dividend: 0 }).dividend += t.totalAmount || 0;
  }

  const avgWin = wins.length ? wins.reduce((s, c) => s + c.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, c) => s + c.pnl, 0) / losses.length : 0;

  return {
    byCode,
    closed: allClosed,
    openPositions,
    totalRealized,
    totalDividend,
    totalFee: Object.values(byCode).reduce((s, l) => s + l.fee, 0),
    totalTax: Object.values(byCode).reduce((s, l) => s + l.tax, 0),
    totalBuyAmount: Object.values(byCode).reduce((s, l) => s + l.buyAmount, 0),
    totalSellAmount: Object.values(byCode).reduce((s, l) => s + l.sellAmount, 0),
    winCount: wins.length,
    lossCount: losses.length,
    closedCount: allClosed.length,
    winRate: allClosed.length ? +(wins.length / allClosed.length * 100).toFixed(1) : 0,
    avgWin,
    avgLoss,
    expectancy: allClosed.length ? Math.round(totalRealized / allClosed.length) : 0,
    monthly: Object.values(monthlyMap).sort((a, b) => a.month.localeCompare(b.month)),
    mismatchCount: allClosed.filter(c => c.mismatch).length,
    warnings: Object.values(byCode).flatMap(l => l.warnings),
  };
}
