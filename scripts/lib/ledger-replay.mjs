// ─────────────────────────────────────────────────────────────────────────
// 交易帳本重放 —— mjs 側的唯一來源
//
// 為什麼存在：交易紀錄上的 `t.realizedPnL` 是「記錄當下」用手動持倉 buyPrice
// 算好存死的快照，而 store.updateTradeRecord 只要使用者編輯該筆就 `delete` 掉它。
// 於是 `t.realizedPnL != null` / `typeof t.realizedPnL === 'number'` 這類過濾
// 會把**每一筆被訂正過的交易整筆丟掉**——使用者越認真修資料，報表錯得越多，
// 而畫面上永遠是一個看起來很合理的數字。
// ⇒ 一律重放交易紀錄，存死值只能當「與重算不符 → 提醒使用者核對」的參考。
//
// ⚠鏡像警告：這是 src/lib/portfolio-calc.ts `buildLedger` 的精簡 mjs 副本，
//   口徑必須與 TS 那份一致（wm-source-aggregation「mirror 漂移」風險）。
//   不一致的後果很具體：2026-08-01 前 AI 覆盤讀存死值，同一頁上方寫
//   「總損益 -712,785」、下方重算寫 -533,480，使用者兩邊都不敢信。
//   mjs 這側原本在 ai-daemon.mjs 裡有一份，compute-analytics.mjs 眼看要抄第三份
//   ⇒ 統一到這裡，兩支 script 都 import 同一份。TS 那份還要算 openPositions／
//   avgPrice／monthly，暫時無法直接共用，但**任何口徑修改必須兩邊同時改**。
//
// 口徑：數量一律「張」（可小數，0.35 = 350 股）、金額一律「元」。
//   · 成本 ＝ 買進淨支出（成交 ＋ 買進手續費）→ 加權平均，非 FIFO
//   · 已實現 ＝ 賣出淨收入（成交 − 手續費 − 稅）− 對應成本
//   · 超賣部分的收入不計入已實現（無成本可對應）
//   · 股利（type === 'dividend'）不影響持股成本，此處直接跳過
//
// 使用時兩個坑（2026-08-12 daemon 週報/月報兩支都踩過，commit eff86ca）：
//   ① 期間報表（週報/月報/任何有時間窗的統計）一律**全量重放**，之後再依
//      closed[].date 篩期間。只把期間內的交易餵進重放的話，上個月買、這個月賣
//      的部位會因為找不到買進而被判成超賣，該筆損益直接歸 0（實測整份月報變 0）。
//   ② matchedLots === 0 的列 pnl 恆為 0（沒有任何成本可對應，既不是勝也不是負）。
//      它必須排除在勝率分母與期望值除數之外（用 statRows()），
//      但仍要出現在「平倉明細」這類列表裡，讓使用者據此回頭補買進紀錄。
// ─────────────────────────────────────────────────────────────────────────

/** 張 → 股（與 src/lib/tw-fee.ts sharesOf 同口徑） */
const sharesOf = (lots) => Math.round(lots * 1000);

/**
 * 逐 code 按時間重放交易紀錄。
 * @param {Array} records 全量交易紀錄（TradeRecord 同構）——期間報表也要餵全量
 * @returns {{closed: Array, byStock: Object, buyCount: number, sellCount: number,
 *            oversoldCount: number, totalBuyAmount: number, totalSellAmount: number}}
 *   closed 每列：{ id, code, name, date, lots, matchedLots, oversoldLots,
 *                 avgCost, cost, proceeds, pnl, storedPnL, mismatch, dayTrade }
 *   —— 含全額超賣列（matchedLots === 0，pnl 恆 0），統計前請先過 statRows()。
 */
export function replayLedger(records) {
  // 同日以 createdAt 次序（同日先買後賣的當沖才會對到成本）
  const sorted = [...(records || [])].sort(
    (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (a.createdAt || 0) - (b.createdAt || 0),
  );

  const state = {};              // code → { lots, cost }
  const closed = [], byStock = {};
  let buyCount = 0, sellCount = 0, oversoldCount = 0;
  let totalBuyAmount = 0, totalSellAmount = 0;

  for (const t of sorted) {
    if (t.type === 'dividend') continue;
    const st = (state[t.code] ??= { lots: 0, cost: 0, name: t.name || '' });
    if (t.name) st.name = t.name;

    if (t.type === 'buy') {
      st.lots += t.quantity;
      st.cost += Math.abs(t.totalAmount);          // 淨支出＝成交＋買進手續費
      totalBuyAmount += Math.abs(t.totalAmount);
      buyCount++;
      continue;
    }
    if (t.type !== 'sell') continue;

    sellCount++;
    const proceeds = t.totalAmount;                // 淨收入（已扣賣方費稅）
    totalSellAmount += proceeds;
    const matchedLots = Math.min(t.quantity, st.lots);
    const oversoldLots = +(t.quantity - matchedLots).toFixed(6);
    if (oversoldLots > 1e-6) oversoldCount++;

    const heldShares = sharesOf(st.lots);
    const avgCost = heldShares > 0 ? st.cost / heldShares : 0;
    const matchedCost = avgCost * sharesOf(matchedLots);
    // 超賣部分的收入不能算獲利（沒有成本可扣）——按比例只取可對應部分
    const proceedsMatched = t.quantity > 0 ? proceeds * (matchedLots / t.quantity) : 0;
    const pnl = Math.round(proceedsMatched - matchedCost);

    st.lots = +(st.lots - matchedLots).toFixed(6);
    st.cost = st.lots > 0 ? st.cost - matchedCost : 0;

    const storedPnL = t.realizedPnL ?? null;
    closed.push({
      id: t.id, code: t.code, name: t.name || st.name, date: t.date,
      lots: t.quantity, matchedLots, oversoldLots,
      avgCost: +avgCost.toFixed(4), cost: Math.round(matchedCost), proceeds: Math.round(proceedsMatched),
      pnl, storedPnL,
      mismatch: storedPnL != null && Math.abs(pnl - storedPnL) > 1,
      dayTrade: !!t.dayTrade,
    });
    if (matchedLots > 0) {
      (byStock[t.code] ??= { name: t.name || st.name, pnl: 0, n: 0 });
      byStock[t.code].pnl += pnl;
      byStock[t.code].n++;
    }
  }

  return { closed, byStock, buyCount, sellCount, oversoldCount, totalBuyAmount, totalSellAmount };
}

/**
 * 可進統計的平倉列：排除全額超賣（matchedLots === 0，pnl 恆 0）。
 * 勝率分母、期望值除數、賺賠比一律用這個；明細列表用原始 closed。
 */
export const statRows = (closed) => closed.filter((c) => c.matchedLots > 0);
