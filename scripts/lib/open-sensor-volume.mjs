// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1：量軸（比率估計 V̂、E1 點估計、c(T) 基準、ρ、門檻 H 區段表）——純函式
//   規格 design-v2.1 §4（volRatio-v1、rhoRatio-v1、H-SEG60-v1）。
//   單位鐵則：量＝張、值＝億元，分列；V̂＝Q(張)×1000×P̄(元/股)×ρ÷1e8。量一律標「（估）」，非官方值。
// ─────────────────────────────────────────────────────────────────────────
import { P, H_SEGS, SUB_BASIS, median, rnd, nextTradingIso } from './open-sensor-params.mjs';

const mk = key => `m${key}`;
const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * c(T) 基準（§4.5）：今天之前最近 20 個交易日 openMarks（basis openSensorMarks-v1）的 pctYi 中位數；
 *   缺 openMarks 的日子排除、列入 missing，不向前延伸；有效 n ≥ 5 才可用。
 *   另算 E2 事實用的 λ（競價金額占比÷競價量占比）與 c_cont（扣掉競價後的連續交易占比）。
 * @param baseDays  ['YYYY-MM-DD', …] 由舊到新（呼叫端依交易日曆給 20 日）
 * @param marksMap { date: openMarks|null }
 */
export function cBaseOf(baseDays, marksMap, keys) {
  const ok = [], missing = [];
  for (const d of baseDays) {
    const om = marksMap[d];
    if (om && om.basis === SUB_BASIS.marks && om.marks && om.day?.yi > 0) ok.push([d, om]); else missing.push(d);
  }
  const byKey = {};
  for (const key of keys) {
    const rows = ok.map(([, om]) => ({ m: om.marks[mk(key)], auc: om.auction, day: om.day })).filter(x => x.m?.yi > 0 && x.m.lots > 0);
    const c = median(rows.map(x => (isNum(x.m.pctYi) ? x.m.pctYi : x.m.yi / x.day.yi)));
    const lam = median(rows.filter(x => x.auc?.yi > 0 && x.auc.lots > 0).map(x => (x.auc.yi / x.m.yi) / (x.auc.lots / x.m.lots)));
    const cCont = median(rows.filter(x => x.auc?.yi > 0 && x.day.yi > x.auc.yi).map(x => (x.m.yi - x.auc.yi) / (x.day.yi - x.auc.yi)));
    byKey[key] = { c: rnd(c, 5), n: rows.length, lam: rnd(lam, 4), cCont: rnd(cCont, 5) };
  }
  return { n: ok.length, from: baseDays[0] ?? null, to: baseDays[baseDays.length - 1] ?? null, missing, byKey };
}

/** ρ（§4.1）：該檢查點近 20 日 live 實測 ≥ 5 日 ⇒ 用中位數（src live）；否則先驗 ρ0＝0.53（src prior） */
export function rhoFor(key, rhoMeta) {
  const arr = (rhoMeta?.live?.[mk(key)] || []).map(x => x?.rho).filter(v => isNum(v) && v > 0).slice(-P.rhoWin);
  if (arr.length >= P.rhoLiveMin) return { v: rnd(median(arr), 4), src: 'live', n: arr.length };
  return { v: P.rho0, src: 'prior', n: arr.length };
}

/**
 * 量軸（§4.1–4.3、§4.6）。px＝priceSample 結果；q＝qAt；qAuc＝qAuction；cb＝cBase.byKey[key]；cN＝基準有效日數。
 *   label：'big'（est ≥ H）／'small'／'pending'（只有輸入缺漏：c 基準 <5、Q 拿不到、價格樣本不過 GV、沒有 ρ）。
 */
export function estimateVolume({ q, qAuc, px, rho, cb, cN, H, ePct = null, vSum = null }) {
  const reasons = [];
  if (!(cN >= P.cBaseMin) || !(cb?.c > 0)) reasons.push('cBase');
  if (!(q?.lots > 0)) reasons.push('q');
  if (!px?.ok) reasons.push('pxSample');
  if (!(rho?.v > 0)) reasons.push('rho');
  if (!(H > 0)) reasons.push('H');
  const vHat = q?.lots > 0 && px?.ok && rho?.v > 0 ? q.lots * 1000 * px.bar * rho.v / 1e8 : null;
  const est = vHat != null && cb?.c > 0 && !reasons.includes('cBase') ? vHat / cb.c : null;
  let estE2 = null;
  if (vHat != null && qAuc?.lots > 0 && cb?.lam > 0 && cb?.cCont > 0) {
    const vAuc = vHat * (qAuc.lots / q.lots) * cb.lam;
    estE2 = vAuc + (vHat - vAuc) / cb.cCont;
  }
  const label = reasons.length ? 'pending' : (est >= H ? 'big' : 'small');
  return {
    q: q ? { lots: q.lots, revealAt: q.revealAt } : null,
    qAucLots: qAuc?.lots ?? null,
    px: px ? { bar: rnd(px.bar, 3), win: px.win ?? null, n: px.n ?? 0, volLots: px.volLots ?? 0, hasTsmc: !!px.hasTsmc, w30n: px.w30n ?? 0 } : null,
    rho: rho ? { v: rho.v, src: rho.src, n: rho.n } : null,
    vHatYi: rnd(vHat, 1), c: cb?.c ?? null, cN: cN ?? 0,
    estYi: rnd(est, 0), estE2Yi: rnd(estE2, 0),
    H: H ?? null, segThYi: cb?.c > 0 && H > 0 ? rnd(H * cb.c, 1) : null,
    label, est: true, reason: reasons.length ? reasons.join(',') : null,
    gapDay: ePct != null ? Math.abs(ePct) >= P.gapDayPct : null,
    vSum: vSum ?? null,
  };
}

// ── 門檻 H（H-SEG60-v1；§4.4） ────────────────────────────────────────
/** M60（億元）→ 區段索引 0..4（左閉右開） */
export function segIndex(m60) {
  for (let i = 0; i < H_SEGS.length; i++) {
    const s = H_SEGS[i];
    if ((s.lo == null || m60 >= s.lo) && (s.hi == null || m60 < s.hi)) return i;
  }
  return H_SEGS.length - 1;
}
export const segBounds = i => [H_SEGS[i].lo, H_SEGS[i].hi];

/**
 * 換段狀態機一步（§4.4）：st＝{ state:{seg,H,effectiveFrom}|null, streak:{seg,n,dates}|null }、s＝當日 M60 的段、d＝當日。
 *   同一新段連續 3 日 ⇒ 下一交易日起 H＝新段值；回到原段 ⇒ 計數歸零；換到另一新段 ⇒ 改計這一段、計數＝1。
 */
export function thresholdStep({ state, streak }, s, d, holidays) {
  if (!state) return { state: { seg: s, H: H_SEGS[s].H, effectiveFrom: nextTradingIso(d, holidays) }, streak: null, switched: false };
  if (s === state.seg) return { state, streak: null, switched: false };
  const next = streak && streak.seg === s ? { seg: s, n: streak.n + 1, dates: [...streak.dates, d] } : { seg: s, n: 1, dates: [d] };
  if (next.n >= 3) return { state: { seg: s, H: H_SEGS[s].H, effectiveFrom: nextTradingIso(d, holidays) }, streak: null, switched: true };
  return { state, streak: next, switched: false };
}

/**
 * 重放區段表（純函式，冪等）：days＝交易日（由舊到新，到 asOf 為止）；aMap＝{date: A 億元}（A 已回音驗證）。
 *   M60_d＝截至 d（含）最近 60 個有 A 的交易日中位數；同一新段連續 3 日 ⇒ 下一交易日起 H＝新段值；
 *   回到原段 ⇒ 計數歸零；中途換到另一新段 ⇒ 重新計數；A 缺的交易日不計、不中斷，記入 gaps。
 *   回傳的 H 適用於 asOf 的下一個交易日；最後一個交易日沒有 A ⇒ stale。
 */
export function replayThreshold({ days, aMap, holidays }) {
  const vals = [], gaps = [], history = [];
  let state = null, streak = null, lastM60 = null, lastWin = null;
  for (const d of days) {
    const A = aMap[d];
    if (!(A > 0)) { gaps.push(d); continue; }
    vals.push([d, A]);
    if (vals.length < 60) continue;
    const win = vals.slice(-60);
    const m60 = median(win.map(x => x[1]));
    const s = segIndex(m60);
    lastM60 = m60; lastWin = win;
    const step = thresholdStep({ state, streak }, s, d, holidays);
    ({ state, streak } = step);
    const switched = step.switched;
    history.push({ asOf: d, m60: rnd(m60, 1), seg: segBounds(s), H: state.H, switched });
  }
  const asOf = days[days.length - 1] ?? null;
  if (!state) return { ok: false, basis: SUB_BASIS.h, H: null, reason: `有 A 的交易日 ${vals.length} < 60`, gaps: gaps.slice(-60), asOf };
  return {
    ok: true, basis: SUB_BASIS.h, H: state.H, effectiveFrom: state.effectiveFrom, seg: segBounds(state.seg),
    m60: rnd(lastM60, 1), n: 60, from: lastWin[0][0], to: lastWin[59][0],
    streak: streak ? { seg: segBounds(streak.seg), n: streak.n, dates: streak.dates } : null,
    gaps: gaps.filter(g => g >= lastWin[0][0]), stale: !(aMap[asOf] > 0), asOf,
    history: history.slice(-60),
  };
}
