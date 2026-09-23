// ─────────────────────────────────────────────────────────────────────────────
// 當沖即時警示引擎（daemon 端狀態；訊號規則在 ./daytrade-signals.mjs，唯一實作）
//
// 零新增上游請求：監控名單擠進既有 5 秒快線的 120 檔（buildPriorityCodes 預留名額），
//   1 分 K 由快線取樣自組，VWAP 由主迴圈＋快線的取樣累積。對 MIS 的請求數不變。
// 產出：daytradeAlerts/live（每收一根 K、且有變化時寫；≤ 每 20 秒一次）。
// ─────────────────────────────────────────────────────────────────────────────
import { DEFAULT_PARAMS, newBarBook, pushSample, metricsAt, stepAlert, limitPrices } from './daytrade-signals.mjs';

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
/** 做空監控：今日曾漲≥5%、昨收>10、量≥500 張，依成交值排序（與做空訊號母體一致） */
export function pickShortMonitor(liveQuotes, n = DT_MONITOR_EACH) {
  const arr = [];
  for (const k in liveQuotes) {
    const q = liveQuotes[k];
    if (!/^\d{4}$/.test(k) || k.startsWith('00') || !q?.live) continue;
    const prev = q.price - q.change;
    if (!(prev > 10) || !(q.high > 0)) continue;
    if ((q.volume || 0) < 500_000) continue;
    if ((q.high / prev - 1) * 100 < 5) continue;
    arr.push([k, q.price * q.volume]);
  }
  return arr.sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
}

// ── 引擎 ────────────────────────────────────────────────────────────
export function createDaytradeEngine({ params = DEFAULT_PARAMS, evidence = null } = {}) {
  let date = '';
  let mon = { long: [], short: [], at: 0 };
  let books = {};                       // code → 1 分 K 累積器
  let states = { long: {}, short: {} }; // side → code → 狀態機
  let metrics = {};                     // code → 最近一根收完的指標
  let names = {};
  let events = [];                      // 最近 60 筆 on/stop
  let dirty = false;

  const reset = today => { date = today; books = {}; states = { long: {}, short: {} }; metrics = {}; events = []; dirty = true; };

  return {
    get monitor() { return mon; },
    monitorCodes() { return [...new Set([...mon.long, ...mon.short])]; },
    setMonitor(today, long, short) {
      if (date !== today) reset(today);
      mon = { long: long.slice(0, DT_MONITOR_EACH), short: short.slice(0, DT_MONITOR_EACH), at: Date.now() };
    },
    /** 餵快線報價（每 5 秒）。回傳本輪是否有任何一根 K 收完。 */
    onQuotes(today, quotes, vwapFn) {
      if (date !== today) reset(today);
      let closed = false;
      for (const code of this.monitorCodes()) {
        const q = quotes[code]; if (!q?.live || !(q.price > 0)) continue;
        names[code] = q.name || names[code] || code;
        const b = books[code] || (books[code] = newBarBook());
        const t = q.revealAt || q.liveAt || Date.now();
        if (!pushSample(b, { t, price: q.price, volume: q.volume })) continue;
        closed = true;
        const i = b.bars.length - 1; if (i < 0) continue;
        const prevClose = q.price - q.change; if (!(prevClose > 0)) continue;
        const m = metricsAt(b.bars, i, { prevClose, exactVwap: vwapFn(code, q.volume), dayHigh: q.high, allowBarVwap: false }, params);
        metrics[code] = { ...m, at: b.bars[i].t };
        for (const side of ['long', 'short']) {
          if (!mon[side].includes(code) && !states[side][code]?.phase) continue;
          const before = states[side][code];
          const after = stepAlert(before, side, b.bars, i, m, params);
          if (after !== before) {
            states[side][code] = after;
            if (after.phase && after.phase !== (before?.phase ?? null)) {
              events = [{ t: b.bars[i].t, code, name: names[code], side, kind: after.phase, px: m.c, room: after.room ?? null, ret: after.phase === 'stop' ? after.ret : null }, ...events].slice(0, 60);
            }
            dirty = true;
          }
        }
        dirty = true;
      }
      return closed;
    },
    /** 產生要寫進 Firestore 的文件；沒有變化回 null */
    snapshot(force = false) {
      if (!dirty && !force) return null;
      dirty = false;
      const row = (side, code) => {
        const m = metrics[code]; const s = states[side][code] || null;
        return {
          code, name: names[code] || code,
          st: s?.phase ? { phase: s.phase, since: s.since, entry: s.entry, best: s.best, room: s.room, stopAt: s.stopAt ?? null, stopPx: s.stopPx ?? null, ret: s.ret ?? null, n: s.n ?? 1 } : null,
          m: m ? { at: m.at, c: m.c, chg: +m.chg.toFixed(2), vwap: m.vwap != null ? +m.vwap.toFixed(2) : null, vwapDev: m.vwapDev != null ? +m.vwapDev.toFixed(2) : null,
            volX: m.volX != null ? +m.volX.toFixed(1) : null, roomUp: +m.roomUp.toFixed(2), roomDn: +m.roomDn.toFixed(2), hiUp: +m.hiUp.toFixed(2), give: +m.give.toFixed(2), bars: books[code]?.bars.length ?? 0 } : null,
        };
      };
      // 名單外但仍有訊號狀態的也留著（例如被擠出監控名單的成立中訊號）
      const sideCodes = side => [...new Set([...mon[side], ...Object.keys(states[side]).filter(c => states[side][c]?.phase)])];
      return {
        date, at: Date.now(), monitorAt: mon.at,
        params: { lookback: params.lookback, volWin: params.volWin, volK: params.volK, minRoom: params.minRoom, shortMinRoom: params.shortMinRoom, exitBars: params.exitBars, longExit: params.longExit, shortExit: params.shortExit, startMin: params.startMin, endMin: params.endMin },
        evidence,
        long: sideCodes('long').map(c => row('long', c)),
        short: sideCodes('short').map(c => row('short', c)),
        events,
      };
    },
  };
}

export { limitPrices };
