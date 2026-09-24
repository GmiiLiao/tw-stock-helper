// ─────────────────────────────────────────────────────────────────────────────
// 模擬交易帳（AI 實驗共用；2026-09-24 使用者：「記錄裡要包含買賣時間與金額標記，才能查看不是作弊」）
//   每筆模擬交易都產生一張可查核的交易單：買進／賣出的時間、價格、股數、金額、手續費、稅、淨損益（元）。
//   口徑：股數由模擬帳戶決定（./sim-account.mjs，各 50 萬）；未給股數時以 1 張計。手續費 0.1425% 無折讓、整張單筆最低 20 元、零股最低 1 元（同站上 tw-fee），元以下捨去；
//   證交稅賣出那一邊收：現股當沖 0.15%、一般 0.3%；元以下捨去。做空（先賣後買）＝先賣出、後買回。
//   防作弊查核：decidedAt（AI 做出決定的時刻）必須早於或等於進場時刻，noLookahead 由程式判定寫進記錄。
// ─────────────────────────────────────────────────────────────────────────────

export const SIM_LOTS = 1;
export const SIM_SHARES = 1000 * SIM_LOTS;
export const FEE_RATE = 0.001425;
export const MIN_FEE = 20;

const fee = (amount, shares = 1000) => Math.max(Math.floor(amount * FEE_RATE), shares < 1000 ? 1 : MIN_FEE);

/**
 * @param side 'long'（先買後賣）| 'short'（先賣後買）
 * @param entry { at: ms, px }  進場（多＝買進、空＝賣出）
 * @param exit  { at: ms, px }  出場（多＝賣出、空＝買回）
 * @param dayTrade 是否現股當沖（稅率 0.15%）
 * @param decidedAt AI 決定的時刻（防作弊查核）
 */
export function ledgerOf({ side, entry, exit, exits = null, dayTrade, decidedAt = null, shares = SIM_SHARES }) {
  // exits：分批出場 [{at, px, shares}]（股數合計＝shares）；未給則以 exit 一次出清
  const outs = (exits && exits.length ? exits : exit ? [{ ...exit, shares }] : []).filter(x => x?.px > 0 && x.shares > 0);
  if (!(entry?.px > 0) || !outs.length) return null;
  const taxRate = dayTrade ? 0.0015 : 0.003;
  const mk = (kind, at, px, n) => { const amount = Math.round(px * n); return { side: kind, at, px, shares: n, amount, fee: fee(amount, n), tax: kind === 'sell' ? Math.floor(amount * taxRate) : 0 }; };
  const entryKind = side === 'long' ? 'buy' : 'sell', exitKind = side === 'long' ? 'sell' : 'buy';
  const legs = [mk(entryKind, entry.at, entry.px, shares), ...outs.map(x => mk(exitKind, x.at, x.px, x.shares))];
  const agg = kind => {
    const ls = legs.filter(l => l.side === kind);
    const amount = ls.reduce((p, l) => p + l.amount, 0), n = ls.reduce((p, l) => p + l.shares, 0);
    return { at: Math.max(...ls.map(l => l.at || 0)) || null, px: +(amount / n).toFixed(3), amount, fee: ls.reduce((p, l) => p + l.fee, 0), tax: ls.reduce((p, l) => p + l.tax, 0) };
  };
  const buy = agg('buy'), sell = agg('sell');
  const costTwd = buy.fee + sell.fee + sell.tax;
  const pnl = sell.amount - buy.amount - costTwd;
  const capital = side === 'long' ? buy.amount + buy.fee : sell.amount;
  const lastExitAt = Math.max(...outs.map(x => x.at || 0)) || null;
  return {
    side, shares, dayTrade: !!dayTrade,
    buy: { at: side === 'long' ? entry.at : lastExitAt, px: buy.px, amount: buy.amount, fee: buy.fee },
    sell: { at: side === 'long' ? lastExitAt : entry.at, px: sell.px, amount: sell.amount, fee: sell.fee, tax: sell.tax },
    legs, costTwd, pnlTwd: pnl, retPct: +(pnl / capital * 100).toFixed(2),
    holdMs: lastExitAt && entry.at ? lastExitAt - entry.at : null,
    decidedAt, entryAt: entry.at,
    noLookahead: decidedAt != null && entry.at != null ? decidedAt <= entry.at : null,
  };
}

/** 工作台出場計畫的分批（1 張：333／333／334 股）→ 交易單出場腿 */
export function planExits({ fills = [], exitAt, exitPx, shares = SIM_SHARES }) {
  const split = [Math.floor(shares / 3), Math.floor(shares / 3)]; split.push(shares - split[0] - split[1]);
  const legs = []; let used = 0;
  for (const f of fills) { if (f.k < 0 || f.k > 2) continue; legs.push({ at: f.at, px: f.px, shares: split[f.k] }); used += split[f.k]; }
  if (shares - used > 0) legs.push({ at: exitAt, px: exitPx, shares: shares - used });
  return legs;
}

/** 台北時間的 D 日 hh:mm（ms） */
export const twAt = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
