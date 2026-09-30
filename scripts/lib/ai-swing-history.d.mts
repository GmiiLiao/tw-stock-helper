// 型別宣告：scripts/lib/ai-swing-history.mjs（帳戶摘要與每日戰績同一口徑）
export interface SwingAccountSummary {
  initial: number; cash: number; mktValue: number; netMkt: number; estSellCost: number; total: number; totalPnl: number; totalRetPct: number;
  realized: number; unrealized: number; held: number; selling: number; pending: number; closedN: number; pool: number;
  reservedBuys: number; pendingSellEst: number; freeCash: number; receivable: number; payable: number;
}
export declare function accountSummary(snap: unknown): SwingAccountSummary;
export declare function historyRow(snap: unknown, prev?: { total: number } | null): Record<string, number | string>;
export declare function rebuildHistory(docs: unknown[], days: unknown[], prevHist?: unknown[]): unknown[];
