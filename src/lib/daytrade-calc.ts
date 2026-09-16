// ============================================================
// 當沖損益分析（2026-09-16）
//
// 口徑與一般帳本（portfolio-calc）刻意分開：
//   帳本用「加權平均成本」——同一檔若長期有部位，當沖那一趟的成本會被舊持股稀釋，
//   算出來的不是「今天這一趟賺多少」。當沖的定義是**同日同碼買進又賣出**，
//   所以這裡以 (日期, 代號) 分組，成本＝**當日買進均價**，賣價＝當日賣出均價，
//   只配對當日買賣重疊的張數（min(買, 賣)）；多買的張數留倉、多賣的是出脫舊持股，都不算當沖。
//
// 費稅一律取**紀錄上的實際值**按配對比例分攤（不用費率重算——使用者可能有不同折讓、低消）。
// 賣出紀錄若沒勾「現股當沖」，紀錄裡的稅是 0.3%，本表照實列出並標示「未標當沖」，
// 因為那是紀錄的問題，不是分析要替它改口的事（不捏造）。
//
// 勾了當沖卻找不到同日買進紀錄的賣出 → 進 warnings，不進統計（分母不能放沒有成本的列）。
// ============================================================

import type { TradeRecord } from './store';
import { sharesOf } from './tw-fee';

export interface DayTradeRow {
  key: string;             // `${date}|${code}`
  date: string;
  code: string;
  name: string;
  buyLots: number;         // 當日買進總張數
  sellLots: number;        // 當日賣出總張數
  lots: number;            // 配對張數 = min(買, 賣)
  buyAvg: number;          // 當日買進均價
  sellAvg: number;         // 當日賣出均價
  gross: number;           // (賣均 − 買均) × 配對股數
  fee: number;             // 買賣雙邊手續費（按配對比例分攤）
  tax: number;             // 證交稅（按配對比例分攤）
  net: number;             // gross − fee − tax
  roi: number;             // net ÷ 買進成交金額 %
  flagged: boolean;        // 賣出紀錄有勾當沖
  unflaggedTax: boolean;   // 有配對但賣出未勾當沖（稅按 0.3% 記錄）
  unit?: 'lot' | 'share';
}

export interface DayTradeReport {
  rows: DayTradeRow[];                 // 新→舊
  count: number;
  winCount: number;
  lossCount: number;
  winRate: number;                     // %
  totalGross: number;
  totalFee: number;
  totalTax: number;
  totalNet: number;
  avgNet: number;                      // 每趟期望值
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;         // 總獲利 ÷ 總虧損（無虧損時 null）
  turnover: number;                    // 買進成交金額合計（費稅率的分母）
  costRatio: number;                   // (fee+tax) ÷ turnover %
  best: DayTradeRow | null;
  worst: DayTradeRow | null;
  maxLossStreak: number;               // 依日期舊→新的最長連續虧損趟數
  byCode: Array<{ code: string; name: string; count: number; net: number; winRate: number }>;
  monthly: Array<{ month: string; net: number; count: number; fee: number; tax: number }>;
  warnings: string[];
}

const EMPTY: DayTradeReport = {
  rows: [], count: 0, winCount: 0, lossCount: 0, winRate: 0, totalGross: 0, totalFee: 0, totalTax: 0, totalNet: 0,
  avgNet: 0, avgWin: 0, avgLoss: 0, profitFactor: null, turnover: 0, costRatio: 0, best: null, worst: null,
  maxLossStreak: 0, byCode: [], monthly: [], warnings: [],
};

export function buildDayTradeReport(records: TradeRecord[]): DayTradeReport {
  if (!records.length) return EMPTY;
  type Side = { lots: number; gross: number; fee: number; tax: number; flagged: boolean; unit?: 'lot' | 'share'; name: string };
  const groups: Record<string, { date: string; code: string; buy: Side; sell: Side }> = {};
  const side = (name: string): Side => ({ lots: 0, gross: 0, fee: 0, tax: 0, flagged: false, name });
  for (const t of records) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    if (!(t.price > 0) || !(t.quantity > 0)) continue;
    const key = `${t.date}|${t.code}`;
    const g = (groups[key] ||= { date: t.date, code: t.code, buy: side(t.name), sell: side(t.name) });
    const s = t.type === 'buy' ? g.buy : g.sell;
    s.lots = +(s.lots + t.quantity).toFixed(6);
    s.gross += t.price * sharesOf(t.quantity);
    s.fee += t.fee || 0;
    s.tax += t.tax || 0;
    s.flagged = s.flagged || !!t.dayTrade;
    if (t.unit === 'share') s.unit = 'share';
    if (t.name) s.name = t.name;
  }

  const rows: DayTradeRow[] = [];
  const warnings: string[] = [];
  for (const g of Object.values(groups)) {
    const hasBuy = g.buy.lots > 0, hasSell = g.sell.lots > 0;
    if (!hasBuy || !hasSell) {
      if (hasSell && g.sell.flagged) warnings.push(`${g.date} ${g.code} ${g.sell.name} 賣出勾了當沖，但當日沒有買進紀錄——無法配對，未計入`);
      if (hasBuy && g.buy.flagged) warnings.push(`${g.date} ${g.code} ${g.buy.name} 買進勾了當沖，但當日沒有賣出紀錄——未計入`);
      continue;
    }
    const lots = Math.min(g.buy.lots, g.sell.lots);
    const shares = sharesOf(lots);
    const buyAvg = g.buy.gross / sharesOf(g.buy.lots);
    const sellAvg = g.sell.gross / sharesOf(g.sell.lots);
    const rb = lots / g.buy.lots, rs = lots / g.sell.lots;   // 配對比例
    const fee = Math.round(g.buy.fee * rb + g.sell.fee * rs);
    const tax = Math.round(g.sell.tax * rs);
    const gross = Math.round((sellAvg - buyAvg) * shares);
    const net = gross - fee - tax;
    const buyCost = buyAvg * shares;
    rows.push({
      key: `${g.date}|${g.code}`, date: g.date, code: g.code, name: g.sell.name || g.buy.name,
      buyLots: g.buy.lots, sellLots: g.sell.lots, lots,
      buyAvg: +buyAvg.toFixed(4), sellAvg: +sellAvg.toFixed(4),
      gross, fee, tax, net, roi: buyCost > 0 ? +((net / buyCost) * 100).toFixed(2) : 0,
      flagged: g.sell.flagged || g.buy.flagged, unflaggedTax: !g.sell.flagged,
      unit: g.sell.unit || g.buy.unit,
    });
  }
  if (!rows.length) return { ...EMPTY, warnings };

  rows.sort((a, b) => b.date.localeCompare(a.date) || a.code.localeCompare(b.code));
  const wins = rows.filter(r => r.net > 0), losses = rows.filter(r => r.net < 0);
  const sum = (a: DayTradeRow[], k: keyof DayTradeRow) => a.reduce((s, r) => s + (r[k] as number), 0);
  const totalGross = sum(rows, 'gross'), totalFee = sum(rows, 'fee'), totalTax = sum(rows, 'tax'), totalNet = sum(rows, 'net');
  const turnover = rows.reduce((s, r) => s + r.buyAvg * sharesOf(r.lots), 0);
  const winSum = sum(wins, 'net'), lossSum = -sum(losses, 'net');

  let streak = 0, maxLossStreak = 0;
  for (const r of [...rows].reverse()) { if (r.net < 0) { streak++; if (streak > maxLossStreak) maxLossStreak = streak; } else if (r.net > 0) streak = 0; }

  const codeMap: Record<string, { code: string; name: string; count: number; net: number; wins: number }> = {};
  for (const r of rows) { const c = (codeMap[r.code] ||= { code: r.code, name: r.name, count: 0, net: 0, wins: 0 }); c.count++; c.net += r.net; if (r.net > 0) c.wins++; }
  const byCode = Object.values(codeMap).map(c => ({ code: c.code, name: c.name, count: c.count, net: c.net, winRate: +((c.wins / c.count) * 100).toFixed(1) })).sort((a, b) => b.net - a.net);

  const monthMap: Record<string, { month: string; net: number; count: number; fee: number; tax: number }> = {};
  for (const r of rows) { const m = (monthMap[r.date.slice(0, 7)] ||= { month: r.date.slice(0, 7), net: 0, count: 0, fee: 0, tax: 0 }); m.net += r.net; m.count++; m.fee += r.fee; m.tax += r.tax; }
  const monthly = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

  return {
    rows, count: rows.length, winCount: wins.length, lossCount: losses.length,
    winRate: +((wins.length / rows.length) * 100).toFixed(1),
    totalGross, totalFee, totalTax, totalNet,
    avgNet: Math.round(totalNet / rows.length),
    avgWin: wins.length ? Math.round(winSum / wins.length) : 0,
    avgLoss: losses.length ? -Math.round(lossSum / losses.length) : 0,
    profitFactor: lossSum > 0 ? +(winSum / lossSum).toFixed(2) : null,
    turnover: Math.round(turnover),
    costRatio: turnover > 0 ? +(((totalFee + totalTax) / turnover) * 100).toFixed(3) : 0,
    best: rows.reduce<DayTradeRow | null>((b, r) => (b == null || r.net > b.net ? r : b), null),
    worst: rows.reduce<DayTradeRow | null>((b, r) => (b == null || r.net < b.net ? r : b), null),
    maxLossStreak, byCode, monthly, warnings,
  };
}

// 損益兩平所需漲幅（%）：買賣雙邊手續費＋當沖稅。給使用者一個「至少要漲這麼多才不虧」的尺。
export function dayTradeBreakEvenPct(discount: number, dayTrade = true): number {
  const fee = 0.001425 * (discount || 1) * 2;
  const tax = dayTrade ? 0.0015 : 0.003;
  return +((fee + tax) * 100).toFixed(3);
}
