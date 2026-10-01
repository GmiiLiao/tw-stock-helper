// ─────────────────────────────────────────────────────────────────────────────
// 波段帳戶：帳戶摘要與每日戰績——同一套口徑（2026-09-30 使用者「持倉與平倉的資料好像不正確」）
//   原因：① 戰績原本每天只 upsert 當天一列，舊列沿用寫入當時的算法（09-24 列＝委託買單預扣現金、並以成本計入持倉市值）；
//         ② 表上「現金＋持倉市值」≠「帳戶總值」（總值用的是扣若賣出費稅的淨市值）；③ 上方卡片的「帳戶淨值」其實是本金＋已實現。
//   修正：每次由決策與成交記錄**逐日重算**整段戰績（只改呈現，不改任何成交）；每一列都滿足 現金＋持倉淨市值＝帳戶總值；
//         卡片與戰績共用 accountSummary()。
// ─────────────────────────────────────────────────────────────────────────────
import { portfolioSnapshot } from './ai-swing-portfolio.mjs';

const stateOf = h => h.state || (h.entryPx ? (h.sellReason != null || /賣出委託/.test(h.status || '') ? 'selling' : 'held') : 'pending');

/**
 * 帳戶摘要：總值＝現金＋已進場部位淨市值（扣若賣出的手續費＋證交稅）；待進場委託不計入（錢仍在現金，成交才扣）。
 * 可下單資金＝現金－委託買單保留＋委託賣單估計回收（同一 T+2 交割日淨額）。資金池＝本金＋已實現（不含未實現）。
 */
export function accountSummary(snap) {
  const hs = snap?.holdings || [], acct = snap?.account || {};
  const entered = hs.filter(h => stateOf(h) !== 'pending');
  const mkt = entered.reduce((a, h) => a + (h.mktValue ?? h.cost), 0);
  const netMkt = entered.reduce((a, h) => a + (h.netValue ?? h.mktValue ?? h.cost), 0);
  const cash = Math.round(acct.cash ?? 0), initial = acct.initial ?? 500000, total = Math.round(cash + netMkt);
  return {
    initial, cash, mktValue: Math.round(mkt), netMkt: Math.round(netMkt), estSellCost: Math.round(mkt - netMkt), total,
    totalPnl: total - initial, totalRetPct: +((total / initial - 1) * 100).toFixed(2),
    realized: Math.round(acct.realized ?? 0), unrealized: Math.round(entered.reduce((a, h) => a + (h.unrealized ?? 0), 0)),
    held: entered.filter(h => stateOf(h) === 'held').length, selling: entered.filter(h => stateOf(h) === 'selling').length,
    pending: hs.length - entered.length, closedN: (snap?.closed || []).length,
    pool: Math.round(initial + (acct.realized ?? 0)),
    reservedBuys: Math.round(acct.reservedBuys ?? 0), pendingSellEst: Math.round(acct.pendingSellEst ?? 0),
    freeCash: Math.round(acct.freeCash ?? cash), receivable: Math.round(acct.receivable ?? 0), payable: Math.round(acct.payable ?? 0),
  };
}

const twDate = at => (at ? new Date(at + 8 * 3600000).toISOString().slice(0, 10) : null);

/**
 * 每日戰績一列；prev＝前一列（算當日損益）。bought／sold＝當日實際成交的買進／賣出筆數（不是下單數）。
 * flow／twr（2026-10-01 會員帳戶·入金與提領）：當日損益扣掉當日資金異動；累積報酬改用時間加權——
 *   growth＝逐日（總值－當日異動）÷前一日總值 連乘，加碼不會被算成獲利。實驗帳戶（無資金異動）口徑不變。
 */
export function historyRow(snap, prev = null, { flow = 0, twr = false } = {}) {
  const s = accountSummary(snap), d = snap.dataDate;
  const soldToday = (snap.closed || []).filter(c => c.exitDate === d);
  const bought = (snap.holdings || []).filter(h => h.entryPx && h.entryDate === d).length + (snap.closed || []).filter(c => twDate(c.buy?.at) === d).length;
  return {
    date: d, holdings: s.held + s.selling, selling: s.selling, pending: s.pending, opened: bought, closed: soldToday.length,
    closedPnl: soldToday.reduce((a, c) => a + c.pnlTwd, 0), realized: s.realized, unrealized: s.unrealized,
    cash: s.cash, mktValue: s.mktValue, estSellCost: s.estSellCost, netMkt: s.netMkt, total: s.total,
    dayPnl: prev ? s.total - prev.total - flow : s.total - s.initial,
    ...(twr ? twrFields(s, prev, flow) : { cumRetPct: s.totalRetPct }),
  };
}

function twrFields(s, prev, flow) {
  const pg = prev ? (prev.growth ?? 1 + (prev.cumRetPct ?? 0) / 100) : null;
  const growth = prev ? pg * (prev.total > 0 ? (s.total - flow) / prev.total : 1) : (s.initial > 0 ? s.total / s.initial : 1);
  return { cumRetPct: +((growth - 1) * 100).toFixed(2), growth, flow, netInvested: s.initial };
}

/**
 * 由決策與成交記錄重算整段戰績：自第一個決策日起，每個交易日一列（as-of：只看當日以前的決策、當日以前的日線）。
 * 早於日線視窗、無法重算的舊列原樣保留。docs＝決策記錄；days＝還原後日線（舊→新）。
 */
export function rebuildHistory(docs, days, prevHist = [], opts = {}) {
  if (!docs?.length || !days?.length) return prevHist;
  const first = docs.reduce((m, d) => (d.date < m ? d.date : m), docs[0].date);
  // 保留無法重算的舊列：早於日線視窗、或早於第一個決策日（重算只涵蓋 ≥ max(視窗起點, 第一個決策日)）
  const cutoff = first > days[0].date ? first : days[0].date;
  const keep = prevHist.filter(r => r.date < cutoff);
  // opts＝{ initial, flows }（會員帳戶）：有資金異動 ⇒ 時間加權累積報酬；每列只計入當日（含之前非交易日）生效的異動
  const flows = opts.flows || [], twr = flows.length > 0;
  const flowSum = (from, to) => flows.filter(f => (from == null || f.date > from) && f.date <= to).reduce((a, f) => a + f.amount, 0);
  const rows = [];
  for (let i = 0; i < days.length; i++) {
    const date = days[i].date; if (date < first) continue;
    const snap = portfolioSnapshot(docs.filter(d => d.date <= date), days.slice(0, i + 1), twr ? { ...opts, flows: flows.filter(f => f.date <= date) } : opts);
    const prev = rows.at(-1) ?? keep.at(-1) ?? null;
    rows.push(historyRow(snap, prev, { flow: twr ? flowSum(prev?.date ?? null, date) : 0, twr }));
  }
  return [...keep, ...rows].slice(-400);
}
