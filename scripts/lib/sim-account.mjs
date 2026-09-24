// ─────────────────────────────────────────────────────────────────────────────
// AI 實驗模擬帳戶（2026-09-24 使用者：「當沖與波段持有各總籌碼資金設定為 50 萬台幣，不可交換」）
//   兩個帳戶各自獨立、各 50 萬起始，資金不互相挪用。帳戶數字一律**由交易記錄重算**（不存可變餘額），可查核。
//   淨值＝起始資金＋已實現損益；可用現金＝淨值－未平倉部位成本。不融資、不借券額度。
//   部位大小：
//     當沖：單筆上限 25 萬（且不超過當下可用現金）、只下整張；買不起 1 張 ⇒ 記「資金不足」不成交。
//     波段：單筆上限 10 萬（約 5 檔同時持有）、可用零股（整張買不起時）、低於 1 萬不建倉；以 AI 決定當下的價格定股數並凍結。
// ─────────────────────────────────────────────────────────────────────────────

export const ACCOUNT_INITIAL = 500_000;
export const DT_MAX_PER_TRADE = 250_000;
export const SWING_PER_PICK = 100_000;
export const SWING_DEFAULT_EXIT_H = 20;    // AI 沒指定持有期時，帳戶以 20 日出場
export const SWING_MIN_POSITION = 10_000;  // 波段單筆低於 1 萬不建倉（剩餘零頭買幾十股沒有意義，記資金不足）

/** 依預算決定股數：買得起整張就只下整張；否則 allowOdd 時下零股 */
export function sizeShares(px, budget, allowOdd) {
  if (!(px > 0) || !(budget > 0)) return 0;
  const lots = Math.floor(budget / (px * 1000));
  if (lots >= 1) return lots * 1000;
  return allowOdd ? Math.floor(budget / px) : 0;
}

/**
 * 由已完成交易算帳：trades＝[{ pnlTwd, open?: boolean, cost?: number }]
 * open＝尚未平倉（cost＝持倉成本）；已平倉的 pnl 計入已實現。
 */
export function accountOf(trades, initial = ACCOUNT_INITIAL) {
  let realized = 0, openCost = 0, openN = 0, closedN = 0;
  for (const t of trades) {
    if (t.open) { openCost += t.cost || 0; openN++; }
    else if (t.pnlTwd != null) { realized += t.pnlTwd; closedN++; }
  }
  const equity = initial + realized;
  return { initial, realized, equity, openCost, cash: equity - openCost, openN, closedN, retPct: +(realized / initial * 100).toFixed(2) };
}
