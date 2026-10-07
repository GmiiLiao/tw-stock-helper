// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1：擷取緩衝 B_T、t00／o00 環、價格樣本 S_T（純記憶體；0 上游請求）
//   規格 design-v2.1 §4.2、§5.1、§5.2、§8.5-2。
//   · 只吃 daemon 手上已有的報價（主迴圈 misBatch 合併處＋快線），以「揭示時間 revealAt」對齊，不用抓取時鐘。
//   · 揭示時間 > T 的報價永遠不進 B_T（後到不覆蓋）；同一檔以揭示時間較新者為準。
//   · 環只在揭示時間前進時推；缺段不補值（重啟後只有重啟之後的拍子）。
// ─────────────────────────────────────────────────────────────────────────
import { ALL_KEYS, P, SUB_BASIS, keyMs, tpeMs, tpeHmsOf, rnd } from './open-sensor-params.mjs';

/**
 * 環的揭示範圍終點。indexRing 的內容（各檢查點的拍、09:01–10:00 高低、分鐘序列）只用到 ≤10:00 的拍子，
 *   10:00 複判的 Q(10:00) 內插要用 10:00 後緊接的一拍（≤90 秒）；環收到 10:03:00 已足夠。
 *   2026-10-07 審查：原本收到 10:05:00、牆鐘 10:05:30 才寫 indexRing，但 O7 重啟禁止窗在 10:05 結束（10:05 起放行）——
 *   10:05:00–10:05:3x 重啟會讓整個環蒸發、只剩重啟後幾拍且寫一次不可補。改成環收到 10:03:00、牆鐘 10:03:30 寫出（runner），
 *   落在保護窗內；10:05 放行時環已落地。
 */
export const RING_END_HMS = '10:03:00';
/** 開盤後第一次更新的容許（t00 每 5 秒揭示一次）：環沒有更早的拍時，只有這麼貼近起點的拍才算「第一拍」 */
const FIRST_UPDATE_MS = 5_000;
/** Q_auc 只認開盤當下：揭示 ≤ 09:00:30 */
const AUC_WIN_MS = 30_000;

/** 新的一天：檢查點時刻、各 B_T、環、首見開盤。date＝交易日曆推定的今天 */
export function createCapture(date, keys = ALL_KEYS) {
  const T = {}, buf = {}, frozen = {};
  for (const k of keys) { T[k] = keyMs(date, k); buf[k] = new Map(); frozen[k] = false; }
  const lo = Math.min(...Object.values(T)) - P.bufMs, hi = Math.max(...Object.values(T));
  return {
    date, keys: [...keys], T, buf, frozen, lo, hi,
    ringLo: tpeMs(date, '09:00:00'), ringHi: tpeMs(date, RING_END_HMS),
    ringT: [], ringO: [],
    firstOpen: new Map(),   // code → { o, y, r }：最早看到「今日有量且有開盤價」的那一筆
  };
}

/**
 * 收一批 misBatch 結果（{code: {price, prev, volume(股), open, revealAt, hasLive}}；t00／o00 自動略過）。
 * accept(code)：只收名單關心的代號（可省略＝全收 4 碼／00xx）。回傳收進任一 B_T 的筆數。
 */
export function feedQuotes(cap, mis, accept = null) {
  if (!cap || !mis) return 0;
  let n = 0;
  for (const code in mis) {
    if (code === 't00' || code === 'o00') continue;
    if (accept ? !accept(code) : !/^(\d{4}|00\d{2,4})$/.test(code)) continue;
    const q = mis[code];
    const r = Number(q?.revealAt);
    if (!(r > 0) || r < cap.lo || r > cap.ringHi) continue;
    const v = Number(q.volume) || 0;
    if (v > 0 && q.open > 0 && q.prev > 0 && r <= cap.hi) {
      const f = cap.firstOpen.get(code);
      if (!f || r < f.r) cap.firstOpen.set(code, { o: q.open, y: q.prev, r });
    }
    if (r > cap.hi) continue;
    const e = { p: Number(q.price) || 0, y: Number(q.prev) || 0, v, o: Number(q.open) || 0, r, live: !!q.hasLive };
    for (const k of cap.keys) {
      if (cap.frozen[k]) continue;
      const T = cap.T[k];
      if (r > T || r < T - P.bufMs) continue;
      const m = cap.buf[k];
      const cur = m.get(code);
      if (!cur || cur.r < r) { m.set(code, e); n++; }
    }
  }
  return n;
}

/** 收一拍指數（快線 misBatch 的 t00／o00 解析結果：price＝z、mVal＝m、open＝o、prev＝y、revealAt＝tlong） */
export function feedIndex(cap, which, q) {
  if (!cap || !q) return false;
  const r = Number(q.revealAt);
  if (!(r > 0) || r < cap.ringLo || r > cap.ringHi) return false;
  if (!(q.price > 0) || q.realTrade === false) return false;
  const ring = which === 'o' ? cap.ringO : cap.ringT;
  const last = ring[ring.length - 1];
  if (last && r <= last[0]) return false;
  ring.push([r, Number(q.price), Number(q.mVal) || 0, Number(q.open) || 0, Number(q.prev) || 0]);
  return true;
}

export const freeze = (cap, key) => { if (cap?.frozen && key in cap.frozen) cap.frozen[key] = true; };

// ── 環查詢（拍＝[revealAt, z, m, o, y]） ─────────────────────────────
export function lastAtOrBefore(ring, T) {
  let hit = null;
  for (const t of ring) { if (t[0] > T) break; hit = t; }
  return hit;
}
export const firstAtOrAfter = (ring, T) => ring.find(t => t[0] >= T) || null;

/**
 * 揭示 ≥ T 的第一拍，而且環在 T 前後連續：前一拍（揭示 < T）與它相距 ≤ ringGapMs。
 *   環沒有 T 之前的拍時：edgeMs 為 null ⇒ 不認（不能確定它是「第一拍」）；否則本拍揭示須 ≤ T＋edgeMs。
 *   重啟或停機後的第一拍不能頂替（回 null），缺的段落只留在 gaps。
 */
export function firstContinuousAt(ring, T, edgeMs = null) {
  const t = firstAtOrAfter(ring, T);
  if (!t) return null;
  const b = lastAtOrBefore(ring, T - 1);
  if (b) return t[0] - b[0] <= P.ringGapMs ? t : null;
  return edgeMs != null && t[0] <= T + edgeMs ? t : null;
}

/** Q(T)：T 落在兩拍之間時線性內插（兩拍相距 > ringGapMs 視為缺段，回 null；G4） */
export function qAt(ring, T) {
  const a = lastAtOrBefore(ring, T), b = firstAtOrAfter(ring, T);
  if (!a || !b) return null;
  if (a[0] === T) return { lots: a[2], revealAt: T, lo: a[0], hi: a[0] };
  if (b[0] - a[0] > P.ringGapMs) return null;
  const lots = a[2] + (b[2] - a[2]) * (T - a[0]) / (b[0] - a[0]);
  return { lots: Math.round(lots), revealAt: T, lo: a[0], hi: b[0] };
}

/**
 * Q_auc：揭示 ≥ 09:00:00 的第一個 m > 0 拍（開盤競價量，張）。只認開盤當下那一拍：
 *   揭示 ≤ 09:00:30，而且環從開盤起連續——它之前看過 m＝0 的拍（09:00:00 昨收回音），或它本身就是開盤後第一次更新（揭示 ≤ 09:00:05）。
 *   重啟、停機後環缺開盤段 ⇒ null（首判 G4 不過；複判 qAucLots 寫 null、不算 E2）——不拿較晚的累積量頂替競價量。
 */
export function qAuction(ring, date) {
  const t0 = tpeMs(date, '09:00:00');
  const i = ring.findIndex(x => x[0] >= t0 && x[2] > 0);
  if (i < 0) return null;
  const t = ring[i];
  if (t[0] > t0 + AUC_WIN_MS) return null;
  // 環只收揭示 ≥ 09:00:00 的拍，i 之前的拍 m 都是 0（且在 30 秒窗內，間距必 ≤ ringGapMs）
  if (i === 0 && t[0] > t0 + FIRST_UPDATE_MS) return null;
  return { lots: t[2], revealAt: t[0] };
}

/** 官方開盤（t00 `o`）：環中最後一拍的 o（>0） */
export function officialOpenOf(ring) {
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i][3] > 0) return { v: ring[i][3], y: ring[i][4] };
  return null;
}

/**
 * 價格樣本 S_T（§4.2）：依序試 30／60／120 秒窗，第一個通過 GV 的就用。
 * GV＝含 2330、W30 ≥ 20 檔、Σv ≥ 0.25×Q×1000 股。三窗都不過 ⇒ ok:false、reason 'pxSample'。
 */
export function priceSample(buf, { T, sample, w30Set, liquidSet, qLots }) {
  const tried = [];
  for (const win of P.pxWins) {
    let sv = 0, spv = 0, n = 0, w30n = 0, wPv = 0, gPv = 0, hasTsmc = false;
    for (const [code, e] of buf) {
      if (!sample.has(code) || !e.live || !(e.v > 0) || !(e.p > 0)) continue;
      if (e.r > T || e.r < T - win * 1000) continue;
      sv += e.v; spv += e.p * e.v; n++;
      if (code === '2330') hasTsmc = true;
      if (w30Set.has(code)) { w30n++; wPv += e.p * e.v; } else if (liquidSet?.has(code)) gPv += e.p * e.v;
    }
    const volOk = qLots > 0 && sv >= P.gvVolFrac * qLots * 1000;
    const row = { win, n, w30n, hasTsmc, volLots: Math.round(sv / 1000) };
    tried.push(row);
    if (hasTsmc && w30n >= P.gvW30 && volOk) {
      return { ok: true, ...row, bar: spv / sv, wYi: wPv / 1e8, gYi: gPv / 1e8, allYi: spv / 1e8, tried };
    }
  }
  return { ok: false, reason: 'pxSample', ...tried[tried.length - 1], bar: null, tried };
}

/** 加總法伴隨值 vSum（§4.6）：整個 B_T、價格樣本宇宙、今日有成交的 Σp·v（億元，不對齊、不乘係數） */
export function sumValue(buf, sample) {
  let s = 0, n = 0;
  for (const [code, e] of buf) {
    if (!sample.has(code) || !e.live || !(e.v > 0) || !(e.p > 0)) continue;
    s += e.p * e.v; n++;
  }
  return { yi: rnd(s / 1e8, 2), n };
}

// ── indexRing（openSensorIndexRing-v1；鍵名對齊 deriveIndexMarks；牆鐘 10:03:30 寫，見 RING_END_HMS） ──
const RING_MARKS = ['09:01', '09:02', '09:03', '09:04', '09:05', '09:10', '09:20', '09:30', '09:40', '09:50', '10:00'];
const markKey = hm => `m${hm.replace(':', '')}`;

function ringGaps(ring, from, to) {
  const gaps = [];
  let prev = from;
  for (const t of ring) {
    if (t[0] < from) continue;
    if (t[0] - prev > P.ringGapMs) gaps.push(`${tpeHmsOf(prev)}–${tpeHmsOf(t[0])}`);
    prev = t[0];
  }
  if (to - prev > P.ringGapMs) gaps.push(`${tpeHmsOf(prev)}–${tpeHmsOf(to)}`);
  return gaps;
}

function ringMarks(ring, date) {
  const out = {};
  for (const hm of RING_MARKS) {
    const t = lastAtOrBefore(ring, tpeMs(date, `${hm}:00`));
    out[markKey(hm)] = t && t[0] >= tpeMs(date, '09:00:00') ? { t: tpeHmsOf(t[0]), v: t[1] } : null;
  }
  return out;
}

function ringMinJson(ring, date) {
  const rows = [];
  for (let m = 0; m <= 60; m++) {
    const hm = `${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const t = lastAtOrBefore(ring, tpeMs(date, `${hm}:00`));
    rows.push([hm, t && t[0] >= tpeMs(date, '09:00:00') ? t[1] : null]);
  }
  return JSON.stringify(rows);
}

/** ref＝揭示恰為 09:00:00 的拍；open＝揭示 ≥ 09:00:05 的第一拍；e＝揭示 ≥ 09:02:00 的第一拍（與 eopen 的 E 同一個連續性檢查）。
 *  open、e 都要環在該時點前後連續，否則 null（重啟後的第一拍不頂替；缺段只記在 gaps） */
function ringSide(ring, date) {
  if (!ring.length) return null;
  const t0 = tpeMs(date, '09:00:00'), t5 = tpeMs(date, '09:00:05'), te = tpeMs(date, '09:02:00');
  const ref = ring.find(t => t[0] === t0) || null;
  const open = firstContinuousAt(ring, t5, 0);
  const e = firstContinuousAt(ring, te);
  return { ref, open, e };
}

/** 由環產生 indexRing（缺拍不補值，缺段列 gaps；n＝拍數） */
export function buildIndexRing(cap) {
  const date = cap.date, t = cap.ringT, o = cap.ringO;
  const side = ringSide(t, date);
  const pt = x => (x ? { t: tpeHmsOf(x[0]), v: x[1] } : null);
  let hl = null;
  for (const x of t) {
    if (x[0] < tpeMs(date, '09:01:00') || x[0] > tpeMs(date, '10:00:00')) continue;
    if (!hl) hl = { hi: x[1], hiT: tpeHmsOf(x[0]), lo: x[1], loT: tpeHmsOf(x[0]) };
    if (x[1] > hl.hi) { hl.hi = x[1]; hl.hiT = tpeHmsOf(x[0]); }
    if (x[1] < hl.lo) { hl.lo = x[1]; hl.loT = tpeHmsOf(x[0]); }
  }
  const oSide = ringSide(o, date);
  return {
    basis: SUB_BASIS.ring, src: 'mis_t00_ring',
    ref0900: side?.ref ? pt(side.ref) : null,
    open: side?.open ? { t: tpeHmsOf(side.open[0]), v: side.open[3] > 0 ? side.open[3] : side.open[1] } : null,
    e: pt(side?.e),
    prevClose: t.find(x => x[4] > 0)?.[4] ?? null,
    taiex: ringMarks(t, date),
    hl0901: hl,
    minJson: ringMinJson(t, date),
    n: t.length,
    gaps: ringGaps(t, tpeMs(date, '09:00:00'), cap.ringHi),
    otc: o.length ? {
      open: oSide?.open ? { t: tpeHmsOf(oSide.open[0]), v: oSide.open[3] > 0 ? oSide.open[3] : oSide.open[1] } : null,
      e: pt(oSide?.e),
      prevClose: o.find(x => x[4] > 0)?.[4] ?? null,
      marks: ringMarks(o, date), n: o.length,
    } : null,
  };
}

/** 首判附的原拍：09:01:30–09:02:30 [[revealAt, z, m], …] 的 JSON 字串（Firestore 不收巢狀陣列） */
export function ticksJsonAround(ring, date) {
  const a = tpeMs(date, '09:01:30'), b = tpeMs(date, '09:02:30');
  return JSON.stringify(ring.filter(t => t[0] >= a && t[0] <= b).map(t => [t[0], t[1], t[2]]));
}
