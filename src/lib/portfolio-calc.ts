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
  cost: number;            // 對應成本（matchedCost，期間報酬率的分母來源）
  storedPnL: number | null;// 紀錄當下存的值（可能用了過期的手動持倉價）
  mismatch: boolean;       // |pnl − storedPnL| > 1 → 需要人工核對
  matchedLots: number;     // 真正有成本可對應的張數
  oversoldLots: number;    // 無買進紀錄可對應的張數
  holdingDays: number | null; // 距最近一次買進的日曆天數
  unit?: 'lot' | 'share';  // 沿用該筆賣出登錄時的顯示單位（零股單不進位成張）
  dayTrade?: boolean;
}

export interface OpenPosition {
  code: string;
  name: string;
  lots: number;
  avgCost: number;         // 每股（含買進費）——損益口徑
  // ⚠ avgPrice 與 avgCost 的差別不是小數點問題，用錯會**重複扣一次買進手續費**：
  //   手動持倉的 buyPrice 定義是「成交均價」，總覽算淨損益時會自己再估一次買進費。
  //   「依交易紀錄重建持倉」若寫入含費的 avgCost，那筆買進費就被算了兩次
  //   （實測 3008 一張＝多扣 3,568 元，而畫面上只是「淨利少一點」，看不出異常）。
  //   ⇒ 寫入手動持倉一律用 avgPrice；做損益比較才用 avgCost。
  avgPrice: number;        // 每股成交均價（不含買進費）——手動持倉 buyPrice 的口徑
  cost: number;            // 總成本（含買進費）
  lastBuyDate: string | null;
}

export interface CodeLedger {
  code: string;
  name: string;
  openLots: number;
  avgCost: number;
  avgPrice: number;        // 不含買進費（見 OpenPosition.avgPrice）
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
  // cost＝含買進費的淨支出（損益口徑）；gross＝純成交額（手動持倉 buyPrice 口徑）。
  // 兩者必須同步扣減，否則賣掉一部分之後 avgPrice 會漂掉。
  const state: Record<string, { lots: number; cost: number; gross: number }> = {};

  for (const t of sorted) {
    if (!byCode[t.code]) {
      byCode[t.code] = {
        code: t.code, name: t.name, openLots: 0, avgCost: 0, avgPrice: 0, openCost: 0,
        realized: 0, dividend: 0, fee: 0, tax: 0, buyAmount: 0, sellAmount: 0,
        closed: [], lastBuyDate: null, warnings: [],
      };
      state[t.code] = { lots: 0, cost: 0, gross: 0 };
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
      st.gross += Math.abs(t.totalAmount) - (t.fee || 0);  // 純成交額
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
    const avgGross = heldShares > 0 ? st.gross / heldShares : 0;
    const matchedCost = avgCost * sharesOf(matchedLots);
    const matchedGross = avgGross * sharesOf(matchedLots);
    // 超賣部分的收入不能算獲利（沒有成本可扣）——按比例只取可對應部分
    const proceedsMatched = t.quantity > 0 ? proceeds * (matchedLots / t.quantity) : 0;
    const pnl = Math.round(proceedsMatched - matchedCost);
    const roi = matchedCost > 0 ? +((pnl / matchedCost) * 100).toFixed(2) : 0;
    st.lots = +(st.lots - matchedLots).toFixed(6);
    st.cost = st.lots > 0 ? st.cost - matchedCost : 0;
    st.gross = st.lots > 0 ? st.gross - matchedGross : 0;

    const storedPnL = t.realizedPnL ?? null;
    const closed: ClosedTrade = {
      id: t.id, code: t.code, name: t.name, date: t.date,
      lots: t.quantity, sellPrice: t.price,
      avgCost: +avgCost.toFixed(4), proceeds: Math.round(proceedsMatched),
      pnl, roi, cost: Math.round(matchedCost), storedPnL,
      // 門檻 10 元（2026-09-16 使用者實案：南亞兩筆各差 2 元被標紅）：存檔值是記錄當下逐項捨入
      // （手續費/稅無條件捨去再加總），重算是 totalAmount − 加權成本後再四捨五入，兩條路徑各捨一次
      // 就差 1~2 元，張數多也不會放大。真正的成本脫鉤（手動持倉價與紀錄不符）是數百到數萬元。
      mismatch: storedPnL != null && Math.abs(pnl - storedPnL) > 10,
      matchedLots, oversoldLots, unit: t.unit,
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
    led.avgPrice = st.lots > 0 ? +(st.gross / sharesOf(st.lots)).toFixed(4) : 0;
    if (st.lots > 0.0005) {
      openPositions.push({ code, name: led.name, lots: st.lots, avgCost: led.avgCost, avgPrice: led.avgPrice, cost: led.openCost, lastBuyDate: led.lastBuyDate });
    }
  }
  openPositions.sort((a, b) => b.cost - a.cost);

  const allClosed = Object.values(byCode).flatMap(l => l.closed)
    .sort((a, b) => b.date.localeCompare(a.date));
  // 全額超賣（沒有任何買進可對應）的那一列 pnl 必然是 0——它既不是勝也不是負，
  // 但若留在分母裡，勝率會被一筆「根本沒有損益」的紀錄稀釋，期望值也被除大。
  // 這種列仍要出現在平倉明細（使用者要據此回頭補紀錄），只是不進統計。
  const stat = allClosed.filter(c => c.matchedLots > 0);
  const wins = stat.filter(c => c.pnl > 0);
  const losses = stat.filter(c => c.pnl < 0);
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
    closedCount: stat.length,
    winRate: stat.length ? +(wins.length / stat.length * 100).toFixed(1) : 0,
    avgWin,
    avgLoss,
    expectancy: stat.length ? Math.round(totalRealized / stat.length) : 0,
    monthly: Object.values(monthlyMap).sort((a, b) => a.month.localeCompare(b.month)),
    mismatchCount: allClosed.filter(c => c.mismatch).length,
    warnings: Object.values(byCode).flatMap(l => l.warnings),
  };
}

// ─── 期間報酬率（2026-08-19）────────────────────────────────────────────
// 口徑：期間內平倉的已實現淨損益（pnl，含費稅） ÷ 該批平倉的對應成本（cost）。
// 這是「平倉資金報酬率」，分母是實際投入該批交易的成本，不是總資產——
// 對高周轉（隔日沖）交易者這是最貼近體感的口徑；沒有每日權益快照，
// 資產基準的時間加權報酬無法誠實計算，寧缺毋濫。
// 年化＝全期間報酬率 × 365 ÷ 全期間日曆天數（單利換算；期間 <30 天不年化）。
export interface PeriodReturn {
  pnl: number;             // 期間已實現淨損益（元）
  cost: number;            // 期間平倉對應成本（元）
  pct: number | null;      // pnl / cost %（無平倉 → null）
  count: number;           // 期間平倉筆數
}
export interface PeriodReturns {
  month: PeriodReturn;     // 本月（日曆月）
  quarter: PeriodReturn;   // 本季（日曆季）
  all: PeriodReturn;       // 全期間（首筆平倉起）
  annualizedPct: number | null;  // 全期間單利年化 %（期間 <30 天 → null）
  spanDays: number;        // 首筆平倉 → 今天 的日曆天數
}

function sumWindow(closed: ClosedTrade[], fromIso: string): PeriodReturn {
  let pnl = 0, cost = 0, count = 0;
  for (const c of closed) {
    if (c.date < fromIso || c.matchedLots <= 0) continue;
    pnl += c.pnl; cost += c.cost; count++;
  }
  return { pnl: Math.round(pnl), cost: Math.round(cost), pct: cost > 0 ? +((pnl / cost) * 100).toFixed(2) : null, count };
}

export function periodReturns(closed: ClosedTrade[], todayIso?: string): PeriodReturns {
  const today = todayIso || new Date().toISOString().split('T')[0];
  const y = +today.slice(0, 4), m = +today.slice(5, 7);
  const monthStart = `${today.slice(0, 7)}-01`;
  const qStartMonth = m - ((m - 1) % 3);
  const quarterStart = `${y}-${String(qStartMonth).padStart(2, '0')}-01`;
  const month = sumWindow(closed, monthStart);
  const quarter = sumWindow(closed, quarterStart);
  const all = sumWindow(closed, '0000-00-00');
  const dates = closed.filter(c => c.matchedLots > 0).map(c => c.date).sort();
  const first = dates[0] || today;
  const spanDays = Math.max(1, Math.round((Date.parse(today) - Date.parse(first)) / 86400000));
  const annualizedPct = all.pct != null && spanDays >= 30
    ? +((all.pct * 365) / spanDays).toFixed(2)
    : null;
  return { month, quarter, all, annualizedPct, spanDays };
}
