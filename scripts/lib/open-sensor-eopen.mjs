// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1：有效開盤 E、官方開盤失真、E′ 修正（effOpen0902-v2.1；純函式）
//   規格 design-v2.1 §5.5（S5）。官方開盤（t00 `o`）只當附註；開盤時沒成交的股票指數以昨收計，
//   所以用揭示 ≥ 09:02:00 的第一拍當有效開盤 E，再把「09:02 時確定未成交（B_0902 內最新一筆 v=0）」
//   之後開出的股票跳空補進 E′，每 10 分鐘一次、10:00 停。B_0902 沒掃到的股票記 unknown、不修正（不能確定它沒成交）。
//   w_i＝昨日市值占上市（上櫃）市值；忽略除數與權重漂移〔推估〕。
// ─────────────────────────────────────────────────────────────────────────
import { P, SUB_BASIS, median, retPct, rnd, tpeMs, tpeHmsOf } from './open-sensor-params.mjs';
import { firstContinuousAt, officialOpenOf } from './open-sensor-capture.mjs';

const okR = r => r != null && Math.abs(r) <= P.okRet;

/** 揭示 ≥ 09:02:00 的第一拍；環在 09:02 前後要連續（重啟後的第一拍不是真正的「第一拍」⇒ null，不拿較晚的拍子頂替） */
function eTick(ring, date) {
  const t = firstContinuousAt(ring, tpeMs(date, '09:02:00'));   // 與 indexRing.e 同一個判定（capture ringSide）
  if (!t || !(t[4] > 0)) return null;
  return { v: t[1], pct: rnd(retPct(t[1], t[4]), 3), revealAt: t[0], y: t[4] };
}

/** 加權有效開盤漲跌%（首判時 checks.e 還沒寫，大跳空日標記要用；環在 09:02 不連續時 null） */
export const eTsePctOf = (ring, date) => eTick(ring, date)?.pct ?? null;

/** U／unknown 分類（只看 B_0902；group＝{code:{w}}） */
function splitUnopened(buf, group, w30Set = null) {
  const u = [], unknown = [];
  let uCap = 0, kCap = 0, w30AllTraded = true;
  const uW30 = [];
  for (const c of Object.keys(group)) {
    const e = buf.get(c);
    if (!e) { unknown.push(c); kCap += group[c].w; if (w30Set?.has(c)) w30AllTraded = false; continue; }
    if (!(e.v > 0)) { u.push(c); uCap += group[c].w; if (w30Set?.has(c)) { uW30.push(c); w30AllTraded = false; } }
  }
  return { u, unknown, uCap, kCap, uW30, w30AllTraded };
}

/**
 * O*：個股開盤價合成 Σ w_i×(o_i/y_i−1)（%）。B_0902 內確定未成交（v＝0）者以 0 計（指數也以昨收計）。
 *   B_0902 沒掃到的股票（unknown）同樣只能貢獻 0——「沒掃到」不等於「沒開出」（§5.5 對 U 的同一個修正）——
 *   所以只在 unknown 市值 ≤ 100 − oStarCovPct 時才合成（呼叫端判），否則 O*、差值、失真一律 null。
 */
function oStarAt(group, firstOpen, T) {
  let s = 0;
  for (const c of Object.keys(group)) {
    const f = firstOpen.get(c);
    if (!f || f.r > T) continue;
    const r = retPct(f.o, f.y);
    if (okR(r)) s += group[c].w / 100 * r;
  }
  return s;
}

/**
 * 首判時的有效開盤（§5.5）：E_tse、E_otc、E_gen、官方開盤與失真、U／unknown、免修正判定。
 * @param {object} a { cap, uni, buf0902, gMedian（首判的 G） }
 */
export function eStart({ cap, uni, buf0902, gMedian }) {
  const date = cap.date, T = tpeMs(date, '09:02:00');
  const eT = eTick(cap.ringT, date), eO = eTick(cap.ringO, date);
  const off = officialOpenOf(cap.ringT);
  const offPct = off && off.y > 0 ? retPct(off.v, off.y) : null;
  const tse = splitUnopened(buf0902, uni.tse, uni.w30Set);
  const otc = uni.otc ? splitUnopened(buf0902, uni.otc) : null;
  // O* 只在 B_0902 的上市市值覆蓋夠（unknown 市值 ≤ 100 − oStarCovPct）而且有效開盤 E_tse 成立時合成；覆蓋見 eCorr.unknown.capPct
  const oStarOk = eT != null && 100 - tse.kCap >= P.oStarCovPct;
  const oStar = oStarOk ? oStarAt(uni.tse, cap.firstOpen, T) : null;
  const distortPp = oStar != null && offPct != null ? oStar - offPct : null;
  const e = {
    tse: eT ? { v: eT.v, pct: eT.pct, revealAt: eT.revealAt } : null,
    otc: eO ? { v: eO.v, pct: eO.pct, revealAt: eO.revealAt } : null,
    gen: gMedian ?? null,
    officialOpen: off ? off.v : null, officialOpenPct: rnd(offPct, 3), oStarPct: rnd(oStar, 3),
    distortPp: rnd(distortPp, 3), distorted: distortPp != null ? Math.abs(distortPp) >= P.distortPp : null,
    basis: SUB_BASIS.eOpen,
  };
  const eCorr = {
    unopened: { n: tse.u.length, capPct: rnd(tse.uCap, 3), w30: tse.uW30 },
    unknown: { n: tse.unknown.length, capPct: rnd(tse.kCap, 3) },
    eFinal: tse.uCap < P.eFinalCapPct && tse.w30AllTraded,
    uJson: JSON.stringify({ tse: tse.u, otc: otc ? otc.u : null }),
    tse: [], gen: [],
    otc: { status: otc ? 'ok' : 'uncorrected', list: [] },
  };
  return { e, eCorr, yTse: eT?.y ?? null, yOtc: eO?.y ?? null };
}

/** 某群 U 中、T 之前已開出者的跳空加總（百分點）與檔數 */
function addOpened(codes, group, firstOpen, T) {
  let add = 0, n = 0;
  for (const c of codes || []) {
    const f = firstOpen.get(c), g = group?.[c];
    if (!f || !g || f.r > T) continue;
    const r = retPct(f.o, f.y);
    if (!okR(r)) continue;
    add += g.w / 100 * r; n++;
  }
  return { add, n };
}

/**
 * T（09:10…10:00）時的 E′（§5.5）。e＝eStart().e；u＝{tse:[…], otc:[…]|null}（B_0902 確定未成交者）；
 * genRets0902＝{code: 09:02 報酬%}（流動一般股，僅記憶體；重啟後沒有 ⇒ gen 回 null）。
 */
export function eCorrAt({ T, e, u, uni, firstOpen, genRets0902 = null }) {
  const hms = tpeHmsOf(T);
  const out = { T: hms, tse: null, gen: null, otc: null };
  if (e?.tse) {
    const a = addOpened(u?.tse, uni.tse, firstOpen, T);
    out.tse = { T: hms, pct: rnd(e.tse.pct + a.add, 3), addPp: rnd(a.add, 3), nOpened: a.n };
  }
  if (e?.otc && uni.otc && Array.isArray(u?.otc)) {
    const a = addOpened(u.otc, uni.otc, firstOpen, T);
    out.otc = { T: hms, pct: rnd(e.otc.pct + a.add, 3), addPp: rnd(a.add, 3), nOpened: a.n };
  }
  if (genRets0902) {
    const rets = Object.values(genRets0902);
    const uSet = new Set(u?.tse || []);
    for (const c of uni.liquid) {
      if (!uSet.has(c)) continue;
      const f = firstOpen.get(c);
      if (!f || f.r > T) continue;
      const r = retPct(f.o, f.y);
      if (okR(r)) rets.push(r);
    }
    out.gen = { T: hms, pp: rnd(median(rets), 3) };
  }
  return out;
}

/** 流動一般股 09:02 報酬（E′_gen 的底；只放記憶體） */
export function genReturns(buf, uni) {
  const out = {};
  for (const c of uni.liquid) {
    const e = buf.get(c);
    if (!e || !e.live || !(e.p > 0) || !(e.y > 0)) continue;
    const r = retPct(e.p, e.y);
    if (okR(r)) out[c] = r;
  }
  return out;
}
