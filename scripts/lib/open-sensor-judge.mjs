// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1：結構軸（權值 W／一般股 G）、七種狀態分類、資料閘門（純函式）
//   規格 design-v2.1 §3（O1、O4、O5、O6）、§5.6。狀態名照使用者原話；只描述結構事實，不是預測，非投資建議。
//   七種：①全面量大上漲 ②全面量縮下跌 ③量縮權值漲 ④量大一般股漲 ⑤量大權值下跌 ⑥量大權值漲 ⑦無方向；
//   其餘組合＝「不在狀態內」（只寫事實、計次數）。
// ─────────────────────────────────────────────────────────────────────────
import { P, median, quantile, retPct, rnd, tpeHmsOf } from './open-sensor-params.mjs';

const okR = r => r != null && Math.abs(r) <= P.okRet;
const fresh = e => !!e && e.live && e.p > 0 && e.y > 0;

/** 權值 30（§3.2）：W（市值加權）、台積電、其餘 29 檔 X 與漲跌平家數、方向 Wd（O4、O6） */
export function weightsAxis(buf, uni) {
  let wN = 0, wD = 0, capFresh = 0, capAll = 0, nFresh = 0, xN = 0, xD = 0;
  let tsmc = null, up = 0, down = 0, flat = 0, restFresh = 0;
  for (const c of uni.w30) {
    const cap = uni.tse[c].cap; capAll += cap;
    const e = buf.get(c);
    if (!fresh(e)) continue;
    const r = retPct(e.p, e.y);
    if (!okR(r)) continue;
    nFresh++; capFresh += cap; wN += cap * r; wD += cap;
    if (c === '2330') { tsmc = r; continue; }
    restFresh++; xN += cap * r; xD += cap;
    if (r > P.flatPct) up++; else if (r < -P.flatPct) down++; else flat++;
  }
  const W = wD ? wN / wD : null, X = xD ? xN / xD : null;
  let dir = null, sub = null;
  if (W != null) {
    if (Math.abs(W) < P.wFlat) dir = 'flat';
    else if (W > 0) dir = up >= P.restConfirm ? 'up' : 'unconfirmed';
    else dir = down >= P.restConfirm ? 'down' : 'unconfirmed';
    if (dir === 'unconfirmed') {
      const solo = tsmc != null && X != null && Math.sign(tsmc) === Math.sign(W) && Math.sign(X) === -Math.sign(W);
      sub = solo ? (W > 0 ? 'tsmcSolo' : 'tsmcWeak') : 'split';
    }
  }
  return {
    pct: rnd(W, 3), tsmcPct: rnd(tsmc, 3), restPct: rnd(X, 3),
    restUp: up, restDown: down, restFlat: flat, restFresh,
    dir, sub, fresh: nFresh, tsmcFresh: tsmc != null,
    capCovPct: capAll ? rnd(capFresh / capAll * 100, 2) : null,
    raw: W,
  };
}

/** 上市流動一般股（§3.3，O5）：中位數 G、上漲比例 B、方向 Gd、揭示時間分布（G3 用） */
export function genAxis(buf, uni) {
  const rs = [], reveals = [];
  let up = 0, down = 0, flat = 0;
  for (const c of uni.liquid) {
    const e = buf.get(c);
    if (!fresh(e)) continue;
    const r = retPct(e.p, e.y);
    if (!okR(r)) continue;
    rs.push(r); reveals.push(e.r);
    if (r > P.flatPct) up++; else if (r < -P.flatPct) down++; else flat++;
  }
  const G = median(rs), B = up + down ? up / (up + down) : null;
  let dir = null;
  if (G != null) dir = G >= P.gUp && B != null && B >= P.bUp ? 'up' : G <= -P.gUp && B != null && B <= P.bDown ? 'down' : 'flat';
  return {
    median: rnd(G, 3), upRatio: rnd(B, 4), up, down, flat,
    fresh: rs.length, n: uni.liquid.length, dir,
    revealMed: reveals.length ? Math.round(median(reveals)) : null,
    revealP10: reveals.length ? Math.round(quantile(reveals, 0.1)) : null,
    revealP90: reveals.length ? Math.round(quantile(reveals, 0.9)) : null,
    raw: G,
  };
}

/** 競價口徑事實（不參與判定）：同一批夠新的股票用個股開盤價 o 算 W_open、G_open */
export function openFacts(buf, uni) {
  let n = 0, d = 0;
  for (const c of uni.w30) {
    const e = buf.get(c); if (!fresh(e)) continue;
    const ro = retPct(e.o, e.y), r = retPct(e.p, e.y);
    if (!okR(r)) continue;
    const cap = uni.tse[c].cap; n += cap * (okR(ro) ? ro : r); d += cap;
  }
  const go = [];
  for (const c of uni.liquid) {
    const e = buf.get(c); if (!fresh(e)) continue;
    const ro = retPct(e.o, e.y), r = retPct(e.p, e.y);
    if (!okR(r)) continue;
    go.push(okR(ro) ? ro : r);
  }
  return { wOpenPct: d ? rnd(n / d, 3) : null, gOpenMedian: rnd(median(go), 3) };
}

/** 主導群與方向（§3.4 R1–R5；R0 由閘門決定，呼叫端先判） */
export function domRule(w, g) {
  if (w.dir === 'unconfirmed') return { rule: 'R1', dom: null, dir: null };
  if (w.dir === 'flat') return g.dir === 'flat' ? { rule: 'R2', dom: null, dir: null } : { rule: 'R3', dom: null, dir: g.dir };
  const W = w.raw, G = g.raw, S = W - G;
  if (g.dir === 'flat' || g.dir !== w.dir) return { rule: 'R4', dom: 'w', dir: w.dir, ratio: W ? rnd(Math.abs(G) / Math.abs(W), 3) : null };
  let dom = 'all';
  if (Math.abs(S) >= P.sDom && Math.abs(G) <= P.kappa * Math.abs(W)) dom = 'w';
  else if (Math.abs(S) >= P.sDom && Math.abs(W) <= P.kappa * Math.abs(G)) dom = 'gen';
  return { rule: 'R5', dom, dir: w.dir, ratio: W ? rnd(Math.abs(G) / Math.abs(W), 3) : null };
}

const CIRCLED = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦'];
/** 命名狀態（§3.5 對照表；鍵＝量|主導|方向） */
export const NAMED = Object.freeze({
  'big|all|up': Object.freeze({ key: 'allUpHeavy', num: 1, name: '全面量大上漲', lamp: 'red' }),
  'small|all|down': Object.freeze({ key: 'allDownLight', num: 2, name: '全面量縮下跌', lamp: 'green' }),
  'small|w|up': Object.freeze({ key: 'wUpLight', num: 3, name: '量縮權值漲', lamp: 'red' }),
  'big|gen|up': Object.freeze({ key: 'genUpHeavy', num: 4, name: '量大一般股漲', lamp: 'red' }),
  'big|w|down': Object.freeze({ key: 'wDownHeavy', num: 5, name: '量大權值下跌', lamp: 'green' }),
  'big|w|up': Object.freeze({ key: 'wUpHeavy', num: 6, name: '量大權值漲', lamp: 'red' }),
});
export const NO_DIRECTION = Object.freeze({ key: 'noDirection', num: 7, name: '無方向', lamp: 'neutral' });
const ZH = { big: '量大', small: '量縮', all: '全面', w: '權值', gen: '一般股', up: '漲', down: '跌' };
const SUB_ZH = { tsmcSolo: '台積電獨撐', tsmcWeak: '台積電獨弱', split: '權值分歧' };
/** 量大、量縮兩種都不是命名狀態的格（§3.6-3）：只有「一般股·跌」 */
export const VOL_FREE_OUTSIDE = Object.freeze(new Set(['gen|down']));

const namedState = (s, vol, dom, dir) => ({
  key: s.key, label: `${CIRCLED[s.num]} ${s.name}`, num: s.num, named: true,
  cell: { vol, dom, dir }, outsideReason: null, sub: null, lamp: s.lamp, candidates: [],
});
const outsideState = (reason, { vol = null, dom = null, dir = null, sub = null } = {}) => {
  let label = '不在狀態內';
  if (reason === 'wUnstated') label += '（權值未表態）';
  else if (reason === 'wUnconfirmed') label += `（權值未確認·${SUB_ZH[sub] || '權值分歧'}）`;
  else label += `（${[vol && vol !== 'pending' ? ZH[vol] : null, ZH[dom], ZH[dir]].filter(Boolean).join('·')}）`;
  return { key: 'outside', label, num: null, named: false, cell: { vol, dom, dir }, outsideReason: reason, sub, lamp: 'gray', candidates: [] };
};

/** 量未定時的候選文字（§3.6-4）：['量大＝① 全面量大上漲', '量縮＝不在狀態內']（字串，畫面直接列） */
function candidatesOf(dom, dir) {
  return ['big', 'small'].map(vol => {
    const s = NAMED[`${vol}|${dom}|${dir}`];
    return `${ZH[vol]}＝${s ? `${CIRCLED[s.num]} ${s.name}` : '不在狀態內'}`;
  });
}

/**
 * 分類（§3.4–3.6 的優先序）：R0 未判定 → R1／R3 不在狀態內、R2 ⑦（都不看量）→ 主導·方向格 →
 *   「一般股·跌」直接不在狀態內 → 量未定 → 對照表。vol＝'big'|'small'|'pending'。
 */
export function classify({ gatesOk, w, g, vol }) {
  if (!gatesOk) return { key: 'undetermined', label: '未判定', num: null, named: false, cell: { vol: null, dom: null, dir: null }, outsideReason: null, sub: null, lamp: 'gray', candidates: [], rule: 'R0' };
  const r = domRule(w, g);
  if (r.rule === 'R1') return { ...outsideState('wUnconfirmed', { sub: w.sub }), rule: 'R1' };
  if (r.rule === 'R2') return { ...namedState(NO_DIRECTION, null, null, null), cell: { vol: null, dom: null, dir: null }, rule: 'R2' };
  if (r.rule === 'R3') return { ...outsideState('wUnstated', { dir: r.dir }), rule: 'R3' };
  const cell = `${r.dom}|${r.dir}`;
  if (VOL_FREE_OUTSIDE.has(cell)) return { ...outsideState('cell', { vol, dom: r.dom, dir: r.dir }), rule: r.rule };
  if (vol !== 'big' && vol !== 'small') {
    return { key: 'volPending', label: '量能未定', num: null, named: false, cell: { vol: 'pending', dom: r.dom, dir: r.dir }, outsideReason: null, sub: null, lamp: 'gray', candidates: candidatesOf(r.dom, r.dir), rule: r.rule };
  }
  const s = NAMED[`${vol}|${cell}`];
  return { ...(s ? namedState(s, vol, r.dom, r.dir) : outsideState('cell', { vol, dom: r.dom, dir: r.dir })), rule: r.rule };
}

/** 軌跡比較用的狀態鍵（§5.4）：命名狀態 key；outside:{原因|格}；volPending；undetermined */
export function stateKeyOf(st) {
  if (!st) return null;
  if (st.key !== 'outside') return st.key;
  if (st.outsideReason === 'cell') return `outside:${[st.cell.vol, st.cell.dom, st.cell.dir].join('|')}`;
  if (st.outsideReason === 'wUnconfirmed') return `outside:wUnconfirmed:${st.sub || 'split'}`;
  return `outside:${st.outsideReason}`;
}

/**
 * 資料閘門 G1–G6、G10（§5.6）。G7 只標 late、G8 只影響量軸、G9（延後開盤）本版未接 market-clock（見 notes）。
 * 回傳 { ok, reasons:[…] }；原因字串以 'G#' 開頭，含涵蓋數字。
 */
export function gates({ T, w, g, q, qAuc, isFirst, tradingDay, ringN, zeroLive, sharesOk, sharesNote }) {
  const reasons = [];
  if (!(w.fresh >= P.g1W30 && (w.capCovPct ?? 0) >= P.g1CapPct && w.tsmcFresh)) {
    reasons.push(`G1:權值已成交 ${w.fresh}/30·市值覆蓋 ${w.capCovPct ?? 0}%·台積電${w.tsmcFresh ? '有' : '無'}（門檻 ${P.g1W30}/30·${P.g1CapPct}%·需台積電）`);
  }
  const need = Math.ceil(P.g2Frac * g.n);
  if (!(g.fresh >= need)) reasons.push(`G2:上市一般股已成交 ${g.fresh}/${g.n}（門檻 ${need}）`);
  if (!(g.revealMed != null && g.revealMed >= T - P.g3LagMs)) {
    reasons.push(`G3:揭示中位 ${g.revealMed ? tpeHmsOf(g.revealMed) : '—'}（門檻 ${tpeHmsOf(T - P.g3LagMs)}）`);
  }
  if (!q) reasons.push(`G4:t00 無拍子夾住 ${tpeHmsOf(T)}`);
  if (isFirst && !(qAuc?.lots > 0)) reasons.push('G4:無開盤競價量（t00 揭示 ≥09:00:00 且 m>0 的第一拍）');
  if (!tradingDay) reasons.push('G5:今天不是交易日');
  else if (!(ringN > 0)) reasons.push('G5:t00 環沒有今日揭示的拍子（資料日未經來源自報驗證）');
  if (zeroLive) reasons.push('G6:主迴圈最近一輪 0 live（疑似限流或封鎖）');
  if (!sharesOk) reasons.push(`G10:發行股數不可用或逾 ${P.g10Days} 個交易日${sharesNote ? `（${sharesNote}）` : ''}`);
  return { ok: reasons.length === 0, reasons };
}
