// ─────────────────────────────────────────────────────────────────────────────
// 當沖即時警示引擎（daemon 端狀態；訊號規則在 ./daytrade-signals.mjs，唯一實作）
//
// 零新增上游請求：監控名單擠進既有 5 秒快線的 120 檔（buildPriorityCodes 預留名額），
//   1 分 K 由快線取樣自組，VWAP 由主迴圈＋快線的取樣累積。對 MIS 的請求數不變。
// 產出：daytradeAlerts/live（警示＋評分＋計畫，≤ 每 15 秒一次）、daytradeJournal/{date}（日誌，≤ 每 60 秒一次）。
// ─────────────────────────────────────────────────────────────────────────────
import { newBarBook, pushSample, limitPrices } from './daytrade-signals.mjs';
import { scanDesk, DESK_PARAMS, DESK_VERSION } from './daytrade-setups.mjs';
import { scoreDesk, deskWarnings } from './daytrade-score.mjs';

export const DT_MONITOR_EACH = 18;   // 多、空各 18 檔 ⇒ 快線最多佔 36 格

// ── VWAP 取樣累積 ───────────────────────────────────────────────────
// MIS getStockInfo 沒有個股成交金額（2026-09-23 實測無 m 欄）⇒ 只能用 Σ(價×Δ量)/ΣΔ量 逼近。
// first＝首次看到時的當日累積量：這之前的量不在樣本內。覆蓋不足 80% 回 null（不捏造）。
export function createVwapBook() { return { date: '', by: {} }; }
export function accVwap(book, code, q, today) {
  if (book.date !== today) { book.date = today; book.by = {}; }
  if (!(q?.price > 0) || !(q.volume >= 0)) return;
  const e = book.by[code];
  if (!e) { book.by[code] = { pv: 0, v: 0, last: q.volume, first: q.volume }; return; }
  const dv = q.volume - e.last;
  e.last = q.volume;
  if (dv > 0) { e.pv += q.price * dv; e.v += dv; }
}
export function vwapOf(book, code, curVol) {
  const e = book.by[code];
  if (!e || !(e.v > 0) || !(curVol > 0)) return null;
  if (e.v < curVol * 0.8) return null;
  return +(e.pv / e.v).toFixed(3);
}
export function serializeVwap(book) {
  const out = {}; for (const c in book.by) { const e = book.by[c]; out[c] = [Math.round(e.pv), e.v, e.last, e.first]; }
  return { date: book.date, json: JSON.stringify(out) };
}
export function restoreVwap(book, doc, today) {
  if (!doc?.json || doc.date !== today) return 0;
  const m = JSON.parse(doc.json); book.date = today; book.by = {};
  for (const c in m) { const [pv, v, last, first] = m[c]; book.by[c] = { pv, v, last, first }; }
  return Object.keys(book.by).length;
}

// ── 監控名單 ─────────────────────────────────────────────────────────
/** 做空監控：今日曾漲≥5%、昨收>10、量≥500 張，依成交值排序（與做空訊號母體一致）。allow：當沖資格判斷（先濾再取前 n） */
export function pickShortMonitor(liveQuotes, n = DT_MONITOR_EACH, allow = () => true) {
  const arr = [];
  for (const k in liveQuotes) {
    const q = liveQuotes[k];
    if (!/^\d{4}$/.test(k) || k.startsWith('00') || !q?.live || !allow(k)) continue;
    const prev = q.price - q.change;
    if (!(prev > 10) || !(q.high > 0)) continue;
    if ((q.volume || 0) < 500_000) continue;
    if ((q.high / prev - 1) * 100 < 5) continue;
    arr.push([k, q.price * q.volume]);
  }
  return arr.sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
}

// ── 引擎（2026-09-23 v2：改用當沖工作台 setup 掃描＋M/S/E 規則符合度；舊的單純突破觸發已退役）──
// 每收一根 1 分 K：scanDesk（./daytrade-setups.mjs）重掃當日 → 警示狀態（閃爍＝Trigger、🏁＝出場）＋評分＋日誌。
// onTrigger：規則通過全部否決而觸發新交易時呼叫（🤖 當沖 AI 實驗的決策點）；例外不影響引擎
export function createDaytradeEngine({ evidence = null, params = DESK_PARAMS, onTrigger = null } = {}) {
  let date = '';
  let mon = { long: [], short: [], at: 0 };
  let books = {};                        // code → 1 分 K 累積器（收完的 K 棒帶 vw＝當時取樣 VWAP）
  let rows = { long: {}, short: {} };    // side → code → 最近一次評估結果
  let names = {};
  let ctx = null;
  let events = [];                       // 最近 60 筆 on/stop
  let journal = { entries: {}, candidates: {}, falseBreaks: {} };
  let dirty = false, jDirty = false;
  // ⚠ Firestore 拒收 undefined 欄位（2026-09-24 實案：{...params, split: undefined} 讓 daytradeAlerts 整天寫入失敗 956 次）
  const { split: _split, ...paramsOut } = params;
  const reset = today => { date = today; books = {}; rows = { long: {}, short: {} }; events = []; journal = { entries: {}, candidates: {}, falseBreaks: {} }; dirty = jDirty = true; };

  function evaluate(code, side, q, depth) {
    const b = books[code]; const bars = b?.bars || []; if (!bars.length || !ctx) return;
    const prev = ctx.prev?.[code] || null;             // [收, 量, 開, 高, 低]（昨日）
    const prevClose = q.price - q.change; if (!(prevClose > 0)) return;
    const scan = scanDesk(bars, side, { prevClose, prevHigh: prev?.[3] || null, prevLow: prev?.[4] || null, vwapOfBar: i => bars[i]?.vw ?? null }, params);
    const vwap = bars[bars.length - 1]?.vw ?? null;
    const vwapPrev10 = bars.length >= 11 ? bars[bars.length - 11]?.vw ?? null : null;
    const idx = q.market === 'otc' ? ctx.index?.otc : ctx.index?.tse;
    const warnings = deskWarnings(bars, side, scan, vwap, idx?.slope15 ?? null);
    const lim = limitPrices(prevClose);
    const avg20 = ctx.avg20?.[code] || 0;
    const pace = avg20 > 0 && ctx.elapsedFrac > 0 ? (q.volume / 1000) / avg20 / ctx.elapsedFrac : null;
    const tick = q.price < 10 ? 0.01 : q.price < 50 ? 0.05 : q.price < 100 ? 0.1 : q.price < 500 ? 0.5 : q.price < 1000 ? 1 : 5;
    const score = scoreDesk({
      side, index: ctx.index, regime: ctx.regime, breadth: ctx.breadth, sector: ctx.sectorOf?.(code, side) || null,
      stock: { market: q.market, price: q.price, chg: q.changePercent, valueTwd: q.price * q.volume, bid1: depth?.[0] ?? null, ask1: depth?.[1] ?? null, tick, pace, prevHigh: prev?.[3] || null, prevLow: prev?.[4] || null },
      news: ctx.news?.[code] || null, scan, bars, vwap, vwapPrev10, warnings,
    });
    const L = side === 'long'; const sg = L ? 1 : -1;
    const tr = scan.active; const lastDone = scan.trades.filter(t => t.exit).at(-1) || null;
    let st = null;
    if (tr) st = { phase: 'on', since: tr.t, entry: tr.entry, best: tr.best, room: +(sg * (lim[L ? 'up' : 'down'] - tr.entry) / tr.entry * 100).toFixed(2), stopAt: null, stopPx: null, ret: null, n: scan.trades.length };
    else if (lastDone) st = { phase: 'stop', since: lastDone.t, entry: lastDone.entry, best: lastDone.best, room: null, stopAt: lastDone.exit.t, stopPx: lastDone.exit.px, ret: +(sg * (lastDone.exit.px / lastDone.entry - 1) * 100).toFixed(2), n: scan.trades.length, reason: lastDone.exit.reason, netR: lastDone.netR };
    const plan = tr || lastDone;
    const prevRow = rows[side][code];
    const row = {
      code, name: names[code] || code, st,
      m: { at: bars[bars.length - 1].t, c: q.price, chg: +q.changePercent.toFixed(2), vwap: vwap != null ? +vwap.toFixed(2) : null, vwapDev: vwap ? +((q.price / vwap - 1) * 100).toFixed(2) : null, pace: pace != null ? +pace.toFixed(1) : null, bars: bars.length },
      score, warnings,
      plan: plan ? { type: plan.type, why: plan.why, t: plan.t, entry: plan.entry, stop: plan.stop, d: plan.d, costR: plan.costR, targets: plan.targets, hit: plan.hit, trail: plan.trail, exit: plan.exit, netR: plan.netR ?? null } : null,
      watch: scan.watch, vetoed: scan.vetoed.at(-1) ? { type: scan.vetoed.at(-1).type, t: scan.vetoed.at(-1).t, veto: scan.vetoed.at(-1).veto } : null,
      orb: scan.orb, falseBreaks: scan.falseBreaks.length,
    };
    rows[side][code] = row;
    if ((prevRow?.st?.phase ?? null) !== (st?.phase ?? null) || prevRow?.st?.since !== st?.since) {
      if (st) events = [{ t: st.phase === 'stop' ? st.stopAt : st.since, code, name: row.name, side, kind: st.phase, px: st.phase === 'stop' ? st.stopPx : st.entry, room: st.room, ret: st.phase === 'stop' ? st.ret : null, reason: st.reason || null, type: plan?.type || null }, ...events].slice(0, 60);
      if (st?.phase === 'on' && tr && onTrigger) { try { onTrigger({ side, code, name: row.name, row, trade: tr, id: `${side}:${code}:${tr.type}:${tr.t}`, ctxInfo: { regime: ctx.regime || null, news: ctx.news?.[code]?.label || null, sector: ctx.sectorOf?.(code, side)?.name || null } }); } catch { /* 實驗失敗不影響工作台 */ } }
    }
    // ── 日誌：候選（首次評估的分數凍結）、每一筆觸發／否決／假突破（觸發當下的分數凍結，出場另填）──
    const ck = `${side}:${code}`;
    // s6Version 逐筆帶（2026-10-08 審查）：日內重啟會以新 params 覆寫當日 journal 文件，文件層版本不保證涵蓋當日全部條目
    const s6Version = score.s6Version ?? null;
    if (!journal.candidates[ck]) { journal.candidates[ck] = { code, name: row.name, side, firstAt: row.m.at, total: score.total, knownMax: score.knownMax, tier: score.tier, missing: score.missing, s6Version }; jDirty = true; }
    for (const t of [...scan.trades, ...scan.vetoed]) {
      const id = `${ck}:${t.type}:${t.t}`; const e = journal.entries[id];
      if (!e) {
        journal.entries[id] = { code, name: row.name, side, type: t.type, t: t.t, minute: t.minute, bucket: t.minute < 570 ? '09:00-09:30' : t.minute < 630 ? '09:30-10:30' : t.minute < 750 ? '10:30-12:30' : '12:30-',
          traded: !t.veto.length, veto: t.veto, why: t.why, entry: t.entry, stop: t.stop, d: t.d, costR: t.costR, targets: t.targets,
          score: { total: score.total, knownMax: score.knownMax, tier: score.tier, parts: score.parts, missing: score.missing, s6Version }, warnings,
          sector: ctx.sectorOf?.(code, side)?.name || null, regime: ctx.regime || null, news: ctx.news?.[code]?.label || null, exit: null, netR: null, mfeR: null, hit: null };
        jDirty = true;
      } else if (!e.exit && t.exit) { e.exit = t.exit; e.netR = t.netR; e.mfeR = t.mfeR; e.hit = t.hit; e.fills = (t.fills || []).map(x => ({ k: x.k, px: x.px, at: x.t + 60_000 })); jDirty = true; }   // 分批成交：at＝達標那根 K 收盤
    }
    if ((journal.falseBreaks[ck] || 0) !== scan.falseBreaks.length) { journal.falseBreaks[ck] = scan.falseBreaks.length; jDirty = true; }
    dirty = true;
  }

  return {
    get monitor() { return mon; },
    // 持倉中的（成立未出場）即使掉出名單也留在快線，直到出場——否則 🏁 永遠不會出現
    monitorCodes() { const open = side => Object.keys(rows[side]).filter(c => rows[side][c]?.st?.phase === 'on'); return [...new Set([...mon.long, ...mon.short, ...open('long'), ...open('short')])]; },
    setMonitor(today, long, short) {
      if (date !== today) reset(today);
      mon = { long: long.slice(0, DT_MONITOR_EACH), short: short.slice(0, DT_MONITOR_EACH), at: Date.now() };
    },
    setContext(c) { ctx = c; },
    /** 餵快線報價（每 5 秒）；depth：code → [買一, 賣一]。回傳本輪是否收完任何一根 K。 */
    onQuotes(today, quotes, vwapFn, depth = {}) {
      if (date !== today) reset(today);
      let closed = false;
      for (const code of this.monitorCodes()) {
        const q = quotes[code]; if (!q?.live || !(q.price > 0)) continue;
        names[code] = q.name || names[code] || code;
        const b = books[code] || (books[code] = newBarBook());
        const t = q.revealAt || q.liveAt || Date.now();
        if (!pushSample(b, { t, price: q.price, volume: q.volume })) continue;
        closed = true;
        const lastBar = b.bars[b.bars.length - 1]; if (lastBar) lastBar.vw = vwapFn(code, q.volume);
        for (const side of ['long', 'short']) {
          if (!mon[side].includes(code) && rows[side][code]?.st?.phase !== 'on') continue;   // 名單外但持倉中者繼續追蹤到出場
          evaluate(code, side, q, depth[code]);
        }
      }
      return closed;
    },
    snapshot(force = false) {
      if (!dirty && !force) return null;
      dirty = false;
      const pick = side => [...new Set([...mon[side], ...Object.keys(rows[side]).filter(c => rows[side][c]?.st?.phase === 'on')])].map(c => rows[side][c]).filter(Boolean);
      return {
        date, at: Date.now(), monitorAt: mon.at, version: DESK_VERSION,
        params: paramsOut, evidence,
        long: pick('long'), short: pick('short'), events,
      };
    },
    /** 日誌條目（id＝side:code:type:t），供 AI 實驗結算 */
    journalEntry(id) { return journal.entries[id] || null; },
    journalDoc(force = false) {
      if (!jDirty && !force) return null;
      jDirty = false;
      return { date, version: DESK_VERSION, at: Date.now(), params: paramsOut, entriesJson: JSON.stringify(journal.entries), candidatesJson: JSON.stringify(journal.candidates), falseBreaksJson: JSON.stringify(journal.falseBreaks) };
    },
  };
}

export { limitPrices };
