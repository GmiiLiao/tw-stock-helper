// ─────────────────────────────────────────────────────────────────────────────
// 🤖 AI 波段帳戶·主動操作（2026-09-28 使用者：「波段期間由 AI 模擬交易，可以換股操作提升獲利結果，
//   而不是只買固定股票放著；要看的是 AI 選股交易是否聰明能獲利」）
//
//   帳戶是一個由 AI 管理的投資組合，不再是「買進後放到固定持有期」：
//   · 每個交易日盤後（資料日 D 收盤後），AI 同時檢視現有持股（可賣出）與當天候選池（可買進）。
//   · 買單與賣單都在 D 之後第一個交易日 09:00 開盤成交（盤後才決定，買賣不到 D 的收盤＝防偷看）；
//     該日無開盤價用收盤 13:30 並標記；該日沒有該股資料（停牌等）：買單作廢釋出資金、賣單順延到下一個有成交的交易日。
//   · 部位（lot）＝某一天買進的一檔；以 lotKey(買進決策日, 代號) 識別。同一檔同時只會有一個 lot（持有中不可重複買）。
//   · 可用現金＝50 萬＋已實現損益（含獲利）－未平倉成本 ⇒ 賣出後本金與獲利可再投入。
//   · 成交記錄寫回決策文件：買進 buyFills[代號]、賣出 sellFills[lotKey]（寫一次不改）；沒記錄時以日線即時推算（同一套函式）。
//   · 研究用的 5／10／20／60／120 日結果（ai-swing-lab 的 outcomes）照舊保留，量「選股眼光」；本帳戶量「交易決策」。
//   09-24 以前以固定持有期（exitH）設計的部位，自 2026-09-28 起一併交由 AI 管理（exitH 僅作為當時的預期持有期顯示）。
// ─────────────────────────────────────────────────────────────────────────────
import { ledgerOf, twAt, feeOf } from './sim-ledger.mjs';
import { accountOf } from './sim-account.mjs';

export const SWING_SELL_TAX = 0.003;
export const lotKey = (date, code) => `${date}_${code}`;   // 不含「.」：可直接當 Firestore 欄位路徑

/** 賣出估計費稅（手續費＋證交稅 0.3%，元以下捨去） */
export function estSellCost(px, shares) {
  const amount = Math.round(px * shares);
  return feeOf(amount, shares) + Math.floor(amount * SWING_SELL_TAX);
}
/** 賣出估計淨額（扣手續費＋證交稅 0.3%；決策當下定部位、持股淨市值用） */
export function estSellProceeds(px, shares) {
  return Math.round(px * shares) - estSellCost(px, shares);
}
/** 買進總成本＝成交金額＋買進手續費（2026-09-29 使用者：金額結算應計入手續費與稅金） */
export function buyCostOf(px, shares) {
  const amount = Math.round(px * shares);
  return amount + feeOf(amount, shares);
}

/**
 * 決策日之後第一個交易日的成交：開盤 09:00（無開盤用收盤 13:30 並標記）。
 * days：還原後日線「舊→新」[{date, m:{code:[收,量,開,高,低]}}]。回傳 null＝成交日還沒到；{failed}＝成交日該股無資料。
 */
export function nextFill(days, decisionDate, code, { skipMissing = false } = {}) {
  let d0 = days.findIndex(d => d.date > decisionDate);
  if (d0 < 0) return null;
  // 賣單：成交日該股無資料（停牌）就順延到下一個有成交的交易日；買單不追（作廢）
  if (skipMissing) { while (d0 < days.length && !(days[d0].m[code]?.[0] > 0)) d0++; if (d0 >= days.length) return null; }
  const r = days[d0].m[code];
  const openMissing = !(r?.[2] > 0);
  const px = openMissing ? r?.[0] : r[2];
  if (!(px > 0)) return { failed: true, date: days[d0].date, reason: '成交日無該股成交資料（停牌等）' };
  return { date: days[d0].date, at: twAt(days[d0].date, openMissing ? '13:30' : '09:00'), px, openMissing };
}

// 部位成本：已進場用成交價；待進場用決策價（再退回凍結時估的成本）
const costOf = l => (l.buy ? buyCostOf(l.buy.px, l.shares) : l.priceAtDecision > 0 ? buyCostOf(l.priceAtDecision, l.shares) : l.estCost ?? 0);

function sellFillOf(days, lot, order) {
  const f = nextFill(days, order.date, lot.code, { skipMissing: true });
  if (!f || f.failed) return f;
  const ledger = ledgerOf({ side: 'long', entry: { at: lot.buy.at, px: lot.buy.px }, exit: { at: f.at, px: f.px }, dayTrade: false, decidedAt: lot.decidedAt, shares: lot.shares });
  return { ...f, code: lot.code, lotDate: lot.date, ledger, sellDecidedAt: order.decidedAt, sellNoLookahead: order.decidedAt != null ? order.decidedAt <= f.at : null };
}

/**
 * 由決策記錄（＋日線）重建所有部位與帳戶。beforeDate：只看決策日早於它的記錄（給當天定部位用）。
 * lot.status：pending（待進場）／held（持有中）／selling（已下賣單、待成交）／closed（已賣出）／void（進場失敗）
 */
export function portfolioState(docs, days = null, beforeDate = null) {
  const ds = [...docs].filter(d => !beforeDate || d.date < beforeDate).sort((a, b) => a.date.localeCompare(b.date));
  const orders = new Map();   // lotKey → 最早的賣出委託
  for (const d of ds) for (const s of d.review?.sells || []) {
    if (!s?.key || orders.has(s.key)) continue;
    orders.set(s.key, { date: d.date, reason: s.reason || '', decidedAt: d.frozenAt ?? null, recorded: d.sellFills?.[s.key] || null });
  }
  const lots = [];
  for (const d of ds) for (const p of d.picks || []) {
    const shares = p.position?.shares; if (!(shares > 0)) continue;
    const key = lotKey(d.date, p.code);
    const buy = d.buyFills?.[p.code] || (days ? nextFill(days, d.date, p.code) : null);
    const lot = { key, date: d.date, code: p.code, name: p.name || p.code, shares, reason: p.reason || '', horizon: p.horizon ?? p.position?.exitH ?? null,
      priceAtDecision: p.priceAtDecision ?? null, estCost: p.position?.estCost ?? null, decidedAt: d.frozenAt ?? null, buy: buy && !buy.failed ? buy : null, buyFailed: buy?.failed ? buy : null, sell: null, status: 'pending' };
    if (lot.buyFailed) { lot.status = 'void'; lots.push(lot); continue; }
    if (!lot.buy) { lots.push(lot); continue; }
    lot.status = 'held';
    const o = orders.get(key);
    if (o) {
      const fill = o.recorded || (days ? sellFillOf(days, lot, o) : null);
      lot.sell = { orderDate: o.date, reason: o.reason, decidedAt: o.decidedAt, fill: fill && !fill.failed ? fill : null };
      lot.status = lot.sell.fill?.ledger ? 'closed' : 'selling';
    }
    lots.push(lot);
  }
  const trades = lots.filter(l => l.status !== 'void').map(l => (l.status === 'closed'
    ? { pnlTwd: l.sell.fill.ledger.pnlTwd }
    : { open: true, cost: costOf(l) }));
  return { lots, account: accountOf(trades) };
}

/** 尚未寫入的成交記錄 → [{date, upd}]（upd 為點路徑欄位，交給 runner 寫回各決策文件） */
export function settleFills(docs, days) {
  const byDate = new Map(docs.map(d => [d.date, d]));
  const out = new Map();
  const put = (date, k, v) => { if (!out.has(date)) out.set(date, {}); out.get(date)[k] = v; };
  for (const lot of portfolioState(docs, days).lots) {
    const bd = byDate.get(lot.date);
    const buy = lot.buy || lot.buyFailed;
    if (buy && !bd?.buyFills?.[lot.code]) put(lot.date, `buyFills.${lot.code}`, buy);
    if (lot.sell?.fill && !byDate.get(lot.sell.orderDate)?.sellFills?.[lot.key]) put(lot.sell.orderDate, `sellFills.${lot.key}`, lot.sell.fill);
  }
  return [...out].map(([date, upd]) => ({ date, upd }));
}

/**
 * 解析 AI 決策：sells 只收「可賣」持股（已進場、未下賣單）；picks 只收池內、且未持有（含待進場）；最多 5 檔。格式錯回 null（不猜）。
 */
export function parseDecision(text, poolCodes, sellableCodes, heldCodes, maxPicks = 5, horizons = [5, 10, 20, 60, 120]) {
  const m = text?.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || typeof j !== 'object' || (j.picks != null && !Array.isArray(j.picks)) || (j.sells != null && !Array.isArray(j.sells))) return null;
  const code4 = v => String(v?.code || '').match(/\d{4}/)?.[0];
  let rejected = 0;
  const sells = [], sSeen = new Set();
  for (const s of j.sells || []) { const c = code4(s); if (!c || !sellableCodes.has(c) || sSeen.has(c)) { rejected++; continue; } sSeen.add(c); sells.push({ code: c, reason: String(s.reason || '').slice(0, 120) }); }
  const picks = [], pSeen = new Set();
  for (const p of j.picks || []) {
    const c = code4(p);
    if (!c || !poolCodes.has(c) || heldCodes.has(c) || pSeen.has(c) || picks.length >= maxPicks) { rejected++; continue; }
    pSeen.add(c);
    const h = Number(String(p.horizon || '').match(/\d+/)?.[0]);
    picks.push({ code: c, confidence: Math.max(0, Math.min(100, Math.round(Number(p.confidence) || 0))), horizon: horizons.includes(h) ? h : null, reason: String(p.reason || '').slice(0, 120), risk: String(p.risk || '').slice(0, 80) });
  }
  return { sells, picks, note: String(j.note || '').slice(0, 120), rejected };
}

/** 持股檢視資料（給 AI 看）：只列已進場、未下賣單的部位 */
export function reviewHoldings(lots, days, { pool = [], news = {}, disp = new Set() } = {}) {
  const last = days[days.length - 1];
  const inPool = new Set(pool.map(c => c.code));
  return lots.filter(l => l.status === 'held').map(l => {
    const i0 = days.findIndex(d => d.date === l.buy.date);
    let hi = l.buy.px, lo = l.buy.px;
    for (let k = Math.max(0, i0); k < days.length; k++) { const r = days[k].m[l.code]; if (r?.[0] > 0) { hi = Math.max(hi, r[3] > 0 ? r[3] : r[0]); lo = Math.min(lo, r[4] > 0 ? r[4] : r[0]); } }
    const lastPx = last?.m[l.code]?.[0] ?? null;
    return { key: l.key, code: l.code, name: l.name, shares: l.shares, buyDate: l.buy.date, buyPx: l.buy.px, lastPx,
      // 損益已扣費稅：買進手續費＋（若現在賣）手續費與證交稅
      pnlPct: lastPx ? +((estSellProceeds(lastPx, l.shares) / buyCostOf(l.buy.px, l.shares) - 1) * 100).toFixed(2) : null, heldDays: i0 >= 0 ? days.length - i0 : null,
      maxUp: +((hi / l.buy.px - 1) * 100).toFixed(2), maxDD: +((lo / l.buy.px - 1) * 100).toFixed(2),
      onList: inPool.has(l.code), news: news[l.code]?.label || null, disposition: disp.has(l.code), reason: l.reason, horizon: l.horizon };
  });
}

/** 帳戶快照（後台讀這份）：持有清單 marked-to-market＋已賣出清單（附買賣時間金額與 AI 賣出理由） */
export function portfolioSnapshot(docs, days) {
  const { lots, account } = portfolioState(docs, days);
  const last = days[days.length - 1];
  const holdings = [], closed = [];
  for (const l of lots) {
    if (l.status === 'void') continue;
    if (l.status === 'closed') {
      const L = l.sell.fill.ledger;
      closed.push({ date: l.date, code: l.code, name: l.name, shares: l.shares, buy: L.buy, sell: L.sell, costTwd: L.costTwd, pnlTwd: L.pnlTwd, retPct: L.retPct,
        exitDate: l.sell.fill.date, sellReason: l.sell.reason, sellOrderDate: l.sell.orderDate, buyReason: l.reason, sellNoLookahead: l.sell.fill.sellNoLookahead, noLookahead: L.noLookahead });
      continue;
    }
    const entered = !!l.buy;
    const lastPx = entered ? last?.m[l.code]?.[0] ?? null : null;
    const cost = costOf(l);   // 含買進手續費
    const mkt = lastPx ? Math.round(lastPx * l.shares) : null;
    const sellCost = lastPx ? estSellCost(lastPx, l.shares) : null;   // 若以最新收盤賣出的手續費＋證交稅
    const net = mkt != null ? mkt - sellCost : null;
    const i0 = entered ? days.findIndex(d => d.date === l.buy.date) : -1;
    holdings.push({
      date: l.date, code: l.code, name: l.name, shares: l.shares, horizon: l.horizon, reason: l.reason,
      status: l.status === 'selling' ? `AI 賣出委託（${l.sell.orderDate} 盤後決定，下一交易日 09:00 開盤成交）` : entered ? '持有中' : '待進場（下一交易日 09:00 開盤）',
      sellReason: l.sell?.reason || null,
      entryDate: l.buy?.date ?? null, entryAt: l.buy?.at ?? null, entryPx: l.buy?.px ?? null, cost,
      buyFee: l.buy ? cost - Math.round(l.buy.px * l.shares) : null,
      lastDate: entered ? last?.date ?? null : null, lastPx, mktValue: mkt, estSellCost: sellCost, netValue: net,
      unrealized: net != null ? net - cost : null,   // 淨未實現＝扣完買賣費稅
      unrealizedPct: net != null && cost ? +((net / cost - 1) * 100).toFixed(2) : null, heldDays: i0 >= 0 ? days.length - i0 : 0,
    });
  }
  return { at: Date.now(), dataDate: last?.date || null, account, holdings: holdings.sort((a, b) => a.date.localeCompare(b.date)), closed: closed.sort((a, b) => (b.sell.at || 0) - (a.sell.at || 0)) };
}
