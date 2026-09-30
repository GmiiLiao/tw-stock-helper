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
import { ledgerOf, twAt, feeOf, FEE_RATE } from './sim-ledger.mjs';
import { accountOf, sizeShares, ACCOUNT_INITIAL, SWING_MIN_POSITION } from './sim-account.mjs';

export const SWING_SELL_TAX = 0.003;
export const SETTLE_DAYS = 2;   // T+2 交割
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

// 部位成本（含買進手續費）：已成交用成交價×成交股數；待進場用決策價×計畫股數（上限為預算）
const costOf = l => (l.buy ? buyCostOf(l.buy.px, l.shares) : l.priceAtDecision > 0 ? Math.min(buyCostOf(l.priceAtDecision, l.shares), l.budget ?? Infinity) : l.estCost ?? 0);

function sellFillOf(days, lot, order) {
  const f = nextFill(days, order.date, lot.code, { skipMissing: true });
  if (!f || f.failed) return f;
  const ledger = ledgerOf({ side: 'long', entry: { at: lot.buy.at, px: lot.buy.px }, exit: { at: f.at, px: f.px }, dayTrade: false, decidedAt: lot.decidedAt, shares: lot.shares });
  return { ...f, code: lot.code, lotDate: lot.date, ledger, sellDecidedAt: order.decidedAt, sellNoLookahead: order.decidedAt != null ? order.decidedAt <= f.at : null };
}
const proceedsOf = L => (L?.sell ? L.sell.amount - L.sell.fee - L.sell.tax : 0);

// 成交時依資金池裁減股數（2026-09-29 使用者：資金池內的金額才能交易、帳面餘額應為正數）
function capShares(px, planned, alloc) {
  let n = Math.min(planned, sizeShares(px, alloc / (1 + FEE_RATE), true));
  while (n > 0 && buyCostOf(px, n) > alloc) n -= n >= 1000 && n % 1000 === 0 ? 1000 : 1;
  return Math.max(0, n);
}

/**
 * 由決策記錄（＋日線）重建所有部位與帳戶。beforeDate：只看決策日早於它的記錄（給當天定部位用）。
 * lot.status：pending（待進場）／held（持有中）／selling（已下賣單、待成交）／closed（已賣出）／void（進場失敗或資金不足）
 *
 * 資金規則（2026-09-29 使用者）：
 *   · 資金池＝50 萬＋已實現損益；只有池內的錢能交易，**現金永不為負**——買單在成交日開盤依當下可用金額裁減股數，
 *     不足 1 萬＝資金不足作廢（決策時的股數只是計畫）。
 *   · **T+2 交割**：成交後第 2 個交易日交割；交割前賣出款列應收、買進款列應付。一般股票可用同一交割日的賣出款（淨額交割），
 *     每天先成交賣單、再成交買單。
 *   · **處置股需預收款**（position.prefund）：只能用已交割現金（不含任何未交割的賣出款）。
 *   · 委託中（尚未成交）的買單列 reservedBuys，不直接扣成負現金；freeCash＝現金－委託保留。
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
    lots.push({ key: lotKey(d.date, p.code), date: d.date, code: p.code, name: p.name || p.code, shares, plannedShares: shares, reason: p.reason || '',
      horizon: p.horizon ?? p.position?.exitH ?? null, priceAtDecision: p.priceAtDecision ?? null, estCost: p.position?.estCost ?? null,
      // budget：舊記錄無預算欄 ⇒ 不以預算裁減（estCost 不含手續費，拿來當上限會誤裁）
      budget: p.position?.budget ?? null, prefund: !!p.position?.prefund, decidedAt: d.frozenAt ?? null,
      recordedBuy: d.buyFills?.[p.code] || null, order: null, buy: null, buyFailed: null, sell: null, status: 'pending' });
  }
  for (const l of lots) l.order = orders.get(l.key) || null;

  let cash = ACCOUNT_INITIAL;
  const unsettled = [];   // { kind:'recv'|'pay', amt, settleIdx }（無日線時 settleIdx＝Infinity：無法判定交割日，視為未交割）
  const idxOf = new Map((days || []).map((d, i) => [d.date, i]));
  const unsettledAt = (kind, i) => unsettled.filter(u => u.kind === kind && u.settleIdx > i).reduce((a, u) => a + u.amt, 0);
  const execBuy = (l, f, i) => {
    let n = f.shares ?? l.plannedShares;
    if (!l.recordedBuy?.px) {   // 已寫入的成交（含股數）照用；未寫入的依資金池裁減
      const avail = l.prefund ? cash - unsettledAt('recv', i) : cash;
      const alloc = Math.min(l.budget ?? Infinity, avail);
      n = alloc >= SWING_MIN_POSITION ? capShares(f.px, l.plannedShares, alloc) : 0;
      if (!(n > 0)) { l.buyFailed = { failed: true, date: f.date, reason: `資金不足（成交時資金池可用 ${Math.max(0, Math.round(avail)).toLocaleString()} 元${l.prefund ? '·處置股限已交割現金' : ''}）` }; l.status = 'void'; return; }
    }
    l.shares = n; l.buy = { ...f, shares: n }; l.status = 'held';
    const cost = buyCostOf(f.px, n); cash -= cost;
    unsettled.push({ kind: 'pay', amt: cost, settleIdx: i + SETTLE_DAYS });
  };
  const execSell = (l, fill, i) => {
    l.sell = { orderDate: l.order.date, reason: l.order.reason, decidedAt: l.order.decidedAt, fill }; l.status = 'closed';
    const amt = proceedsOf(fill.ledger); cash += amt;
    unsettled.push({ kind: 'recv', amt, settleIdx: i + SETTLE_DAYS });
  };

  if (days?.length) {
    for (let i = 0; i < days.length; i++) {
      const t = days[i].date;
      // ① 賣單（先）：持有中、已下賣單、成交日＝今天
      for (const l of lots) {
        if (l.status !== 'held' || !l.order) continue;
        const fill = l.order.recorded?.ledger ? l.order.recorded : sellFillOf(days, l, l.order);
        if (fill && !fill.failed && fill.ledger && fill.date === t) execSell(l, fill, i);
      }
      // ② 買單（後）：依決策日、選股順序
      for (const l of lots) {
        if (l.status !== 'pending') continue;
        const f = l.recordedBuy || nextFill(days, l.date, l.code);
        if (!f || f.date !== t) continue;
        if (f.failed) { l.buyFailed = f; l.status = 'void'; continue; }
        execBuy(l, f, i);
      }
    }
  } else {
    // 無日線：只用已寫入的成交記錄（依成交日排序；交割日無法判定）
    const ev = [];
    for (const l of lots) {
      if (l.recordedBuy) ev.push({ date: l.recordedBuy.date, k: 1, l });
      if (l.order?.recorded?.ledger) ev.push({ date: l.order.recorded.date, k: 0, l });
    }
    ev.sort((a, b) => a.date.localeCompare(b.date) || a.k - b.k);
    for (const e of ev) {
      if (e.k === 1) { if (e.l.recordedBuy.failed) { e.l.buyFailed = e.l.recordedBuy; e.l.status = 'void'; } else execBuy(e.l, e.l.recordedBuy, Infinity); }
      else if (e.l.status === 'held') execSell(e.l, e.l.order.recorded, Infinity);
    }
  }
  for (const l of lots) if (l.status === 'held' && l.order) { l.sell = { orderDate: l.order.date, reason: l.order.reason, decidedAt: l.order.decidedAt, fill: null }; l.status = 'selling'; }

  const lastIdx = days?.length ? days.length - 1 : Infinity;
  const trades = lots.filter(l => l.status === 'closed' || l.status === 'held' || l.status === 'selling').map(l => (l.status === 'closed'
    ? { pnlTwd: l.sell.fill.ledger.pnlTwd }
    : { open: true, cost: costOf(l) }));
  const base = accountOf(trades);
  const receivable = days?.length ? unsettledAt('recv', lastIdx) : 0, payable = days?.length ? unsettledAt('pay', lastIdx) : 0;
  const reservedBuys = lots.filter(l => l.status === 'pending').reduce((a, l) => a + costOf(l), 0);
  // 委託中賣單的估計回收款（最新收盤、扣費稅）：與委託中買單同一 T+2 交割日淨額，可抵用
  const lastM = days?.length ? days[days.length - 1].m : null;
  const pendingSellEst = lastM ? lots.filter(l => l.status === 'selling').reduce((a, l) => a + (lastM[l.code]?.[0] > 0 ? estSellProceeds(lastM[l.code][0], l.shares) : 0), 0) : 0;
  return { lots, account: { ...base, receivable, payable, settledCash: base.cash - receivable + payable, reservedBuys, pendingSellEst, freeCash: base.cash - reservedBuys + pendingSellEst } };
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
        exitDate: l.sell.fill.date, sellReason: l.sell.reason, sellSource: l.sell.fill.source ?? null, sellRecordedAt: l.sell.fill.recordedAt ?? null, buySource: l.buy?.source ?? null, sellOrderDate: l.sell.orderDate, buyReason: l.reason, sellNoLookahead: l.sell.fill.sellNoLookahead, noLookahead: L.noLookahead });
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
      state: l.status === 'selling' ? 'selling' : entered ? 'held' : 'pending',   // 機器可讀狀態（2026-09-30；status 為給人看的文字）
      status: l.status === 'selling' ? `AI 賣出委託（${l.sell.orderDate} 盤後決定，下一交易日 09:00 開盤成交）` : entered ? '持有中' : '待進場（下一交易日 09:00 開盤）',
      sellReason: l.sell?.reason || null, fillSource: l.buy?.source ?? null, fillRecordedAt: l.buy?.recordedAt ?? null,
      entryDate: l.buy?.date ?? null, entryAt: l.buy?.at ?? null, entryPx: l.buy?.px ?? null, cost,
      buyFee: l.buy ? cost - Math.round(l.buy.px * l.shares) : null,
      lastDate: entered ? last?.date ?? null : null, lastPx, mktValue: mkt, estSellCost: sellCost, netValue: net,
      unrealized: net != null ? net - cost : null,   // 淨未實現＝扣完買賣費稅
      unrealizedPct: net != null && cost ? +((net / cost - 1) * 100).toFixed(2) : null, heldDays: i0 >= 0 ? days.length - i0 : 0,
    });
  }
  return { at: Date.now(), dataDate: last?.date || null, account, holdings: holdings.sort((a, b) => a.date.localeCompare(b.date)), closed: closed.sort((a, b) => (b.sell.at || 0) - (a.sell.at || 0)) };
}
