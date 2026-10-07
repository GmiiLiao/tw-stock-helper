// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1：檢查點快照組裝、軌跡（cur／trail）推進、寫入決策（純函式）
//   規格 design-v2.1 §5.3、§5.4、§8.1、§8.4。寫入決策函式只看「文件現況」決定 patch：
//   快照欄位（c0902、rechecks.*、checks.*、indexRing、post）已存在就回 null（寫一次、重啟不覆蓋）；
//   cur／trail／outside 只在同一筆寫入新快照時更新；trail 只追加；cur.final 之後全部不動。
//   去重一律看文件欄位，不靠記憶體旗標。影子模式：這裡只產生文件內容，不發任何警示。
// ─────────────────────────────────────────────────────────────────────────
import { BASIS, MODE, SUB_BASIS, FIRST_KEYS, P, keyHms, rnd } from './open-sensor-params.mjs';
import { qAt, qAuction, priceSample, sumValue } from './open-sensor-capture.mjs';
import { weightsAxis, genAxis, openFacts, classify, gates, stateKeyOf } from './open-sensor-judge.mjs';
import { estimateVolume, rhoFor } from './open-sensor-volume.mjs';

const strip = ({ raw: _raw, ...rest }) => rest;

/**
 * 組一個檢查點快照（Check，§8.1）。只讀記憶體；不決定寫不寫（排程端依閘門與牆鐘決定）。
 * @param a.key   檢查點 'HHMM'；a.cap、a.uni、a.cBase（cBaseOf 結果）、a.H、a.rhoMeta
 * @param a.env   { tradingDay, zeroLive, sharesOk, sharesNote, late, restoredLive, slid, ePct }
 * @param a.idx   該時點的指數事實（由 eopen 產生；首判＝checks.e 的摘要）
 */
export function composeCheck({ key, cap, uni, cBase, H, rhoMeta, env = {}, idx = null, now }) {
  const T = cap.T[key], buf = cap.buf[key];
  const w = weightsAxis(buf, uni), g = genAxis(buf, uni);
  const q = qAt(cap.ringT, T), qAuc = qAuction(cap.ringT, cap.date);
  const isFirst = FIRST_KEYS.includes(key);
  const gt = gates({ T, w, g, q, qAuc, isFirst, tradingDay: env.tradingDay !== false, ringN: cap.ringT.length, zeroLive: !!env.zeroLive, sharesOk: env.sharesOk !== false, sharesNote: env.sharesNote });
  const px = q?.lots > 0 ? priceSample(buf, { T, sample: uni.sample, w30Set: uni.w30Set, liquidSet: uni.liquidSet, qLots: q.lots }) : null;
  const cb = cBase?.byKey?.[key] ?? null;
  const vol = estimateVolume({ q, qAuc, px, rho: rhoFor(key, rhoMeta), cb, cN: cb?.n ?? 0, H, ePct: env.ePct ?? null, vSum: sumValue(buf, uni.sample) });
  const state = classify({ gatesOk: gt.ok, w, g, vol: vol.label });
  const { rule, ...stateOut } = state;
  const of = openFacts(buf, uni);
  const S = w.raw != null && g.raw != null ? w.raw - g.raw : null;
  return {
    status: gt.ok ? 'ok' : 'undetermined', reasons: gt.reasons,
    late: !!env.late, slid: !!env.slid, restoredLive: env.restoredLive ?? null,
    T: keyHms(key), revealAt: T, revealP10: g.revealP10, revealP90: g.revealP90, writtenAt: now,
    state: stateOut,
    w: strip(w), g: strip(g),
    s: rnd(S, 3), dom: { rule, ratio: w.raw ? rnd(Math.abs(g.raw ?? 0) / Math.abs(w.raw), 3) : null },
    open: { ...of, dW: of.wOpenPct != null && w.raw != null ? rnd(w.raw - of.wOpenPct, 3) : null, dG: of.gOpenMedian != null && g.raw != null ? rnd(g.raw - of.gOpenMedian, 3) : null },
    vol,
    value: px?.ok ? { wYi: rnd(px.wYi, 1), gYi: rnd(px.gYi, 1), wSharePct: px.allYi > 0 ? rnd(px.wYi / px.allYi * 100, 2) : null, wShareBasePct: null } : null,
    idx,
  };
}

/** 寫不出快照時的空殼（§5.4 nodata：重啟逾窗、或窗內閘門始終不過） */
export const nodataCheck = (key, reasons, now, extra = {}) => ({ status: 'nodata', reasons, T: keyHms(key), writtenAt: now, ...extra });

const curBlank = () => ({ key: null, label: null, T: null, revealAt: null, final: false, frozenAt: null, finalBy: null, eTsePct: null, eGenPct: null });
/** outside 記錄用的格鍵（§3.7 例：big|all|down、wUnstated、wUnconfirmed:tsmcSolo）；openSensorStats 以整份 set（非 merge）寫入 */
export const cellKey = sk => String(sk).replace(/^outside:/, '');

/**
 * 依新快照推進 cur／trail／outside（§5.4）。doc＝文件現況；回傳 { cur, trail, outside }（新物件，不改輸入）。
 *   nodata 不改 cur、不加軌跡；狀態鍵變了才補記；E′ 移動 ≥ 0.10pp 補記 eCorr；final＝這一筆是 10:00 定格。
 */
export function advanceCur(doc, check, { eTsePct = null, eGenPct = null, final = false, now }) {
  const cur0 = doc?.cur ? { ...curBlank(), ...doc.cur } : curBlank();
  const trail = [...(doc?.trail || [])];
  const outside = { cells: [...(doc?.outside?.cells || [])], firstAt: doc?.outside?.firstAt ?? null };
  if (cur0.final) return { cur: cur0, trail, outside, changed: false };
  let cur = { ...cur0 };
  if (check.status !== 'nodata' && check.state) {
    const sk = stateKeyOf(check.state);
    if (cur.key !== sk) {
      trail.push({ T: check.T, kind: 'state', key: sk, label: check.state.label, revealAt: check.revealAt ?? null });
      cur = { ...cur, key: sk, label: check.state.label, T: check.T, revealAt: check.revealAt ?? null };
    }
    if (check.state.key === 'outside') {
      const ck = cellKey(sk);
      if (!outside.cells.includes(ck)) outside.cells.push(ck);
      if (!outside.firstAt) outside.firstAt = now;
    }
  }
  // E′：第一次只記基準（不加軌跡）；之後移動 ≥ 0.10pp 才補記（§5.4）
  if (eTsePct != null) {
    if (cur.eTsePct == null) cur.eTsePct = eTsePct;
    else if (Math.abs(eTsePct - cur.eTsePct) >= P.eMovePp) {
      trail.push({ T: check.T, kind: 'eCorr', key: 'eTse', label: `有效開盤修正 加權 ${sg(cur.eTsePct)}% → ${sg(eTsePct)}%`, revealAt: check.revealAt ?? null });
      cur.eTsePct = eTsePct;
    }
  }
  if (eGenPct != null) {
    if (cur.eGenPct == null) cur.eGenPct = eGenPct;
    else if (Math.abs(eGenPct - cur.eGenPct) >= P.eMovePp) {
      trail.push({ T: check.T, kind: 'eCorr', key: 'eGen', label: `有效開盤修正 一般股中位 ${sg(cur.eGenPct)}% → ${sg(eGenPct)}%`, revealAt: check.revealAt ?? null });
      cur.eGenPct = eGenPct;
    }
  }
  if (final) cur = { ...cur, final: true, frozenAt: now, finalBy: check.status === 'nodata' ? 'timeout' : 'r1000' };
  return { cur, trail, outside, changed: true };
}
const sg = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${(+v).toFixed(2)}`);

/** 新文件的頂層欄位（只在文件不存在時帶上） */
export function docBase({ date, dateSrc, params, universe, now }) {
  return { date, basis: BASIS, mode: MODE, dateSrc, writtenAt: now, params, universe };
}

/** 首判寫入決策（§8.4 交易三分支）：不存在 → 建立；存在無 c0902 → 補；已有 → null */
export function decideFirst(doc, { base, check, e = null, eCorr = null, ticksJson = null, now }) {
  if (doc?.c0902) return null;
  const c0902 = ticksJson != null ? { ...check, ticksJson } : check;
  const adv = advanceCur(doc, c0902, { eTsePct: e?.tse?.pct ?? null, eGenPct: e?.gen ?? null, now });
  return {
    ...(doc ? {} : base),
    c0902,
    ...(e ? { checks: { e } } : {}),
    ...(eCorr ? { eCorr } : {}),
    cur: adv.cur, trail: adv.trail, outside: adv.outside,
  };
}

/**
 * 複判寫入決策：rechecks.rHHMM 不存在才寫；同時可帶 E′（eCorrAt 結果）、盤型（checks.cHHMM）、10:00 定格。
 * eAt＝eCorrAt() 的結果或 null（eFinal、重啟後缺 E 時）。
 */
export function decideRecheck(doc, { base, key, check, eAt = null, pattern = null, final = false, now }) {
  const rk = `r${key}`;
  if (doc?.rechecks?.[rk]) return null;
  if (doc?.cur?.final) return { rechecks: { [rk]: check } };   // 定格後只留快照，不動 cur／trail
  const adv = advanceCur(doc, check, { eTsePct: eAt?.tse?.pct ?? null, eGenPct: eAt?.gen?.pp ?? null, final, now });
  const patch = { ...(doc ? {} : base), rechecks: { [rk]: check }, cur: adv.cur, trail: adv.trail, outside: adv.outside };
  if (eAt && doc?.eCorr) {
    const ec = doc.eCorr;
    patch.eCorr = {
      tse: eAt.tse ? [...(ec.tse || []), eAt.tse] : (ec.tse || []),
      gen: eAt.gen ? [...(ec.gen || []), eAt.gen] : (ec.gen || []),
      otc: { status: ec.otc?.status ?? 'uncorrected', list: eAt.otc ? [...(ec.otc?.list || []), eAt.otc] : (ec.otc?.list || []) },
    };
  }
  const ck = `c${key}`;
  if (pattern && !doc?.checks?.[ck]) patch.checks = { [ck]: pattern };
  return patch;
}

/** 盤型單獨寫入（複判已寫、盤型晚到時） */
export function decidePattern(doc, { base, key, pattern }) {
  const ck = `c${key}`;
  if (doc?.checks?.[ck]) return null;
  return { ...(doc ? {} : base), checks: { [ck]: pattern } };
}

/** 10:05：r1000 缺席（停機）時以當時的 cur 定格（finalBy timeout） */
export function decideTimeoutFinal(doc, { now }) {
  if (!doc || doc.cur?.final) return null;
  return { cur: { ...curBlank(), ...(doc.cur || {}), final: true, frozenAt: now, finalBy: 'timeout' } };
}

/** indexRing（牆鐘 10:03:30，O7 保護窗結束前）：寫一次（只寫在 openSensor/{date}；⚠ 不可在 15:25 前建 orderFlowArchive/{date}） */
export function decideIndexRing(doc, { base, indexRing }) {
  if (doc?.indexRing) return null;
  return { ...(doc ? {} : base), indexRing };
}

/** 盤後 post：寫一次（文件必須已存在） */
export function decidePost(doc, { post }) {
  if (!doc || doc.post) return null;
  return { post };
}

// ── 盤後（§8.5） ─────────────────────────────────────────────────────
/** 文件內所有 ok 的檢查點快照（首判以實際 T 計；滑動到 09:03／09:04 時用該分的官方值） */
export function okChecks(doc) {
  const out = [];
  if (doc?.c0902?.status === 'ok') out.push(doc.c0902);
  for (const k of Object.keys(doc?.rechecks || {}).sort()) if (doc.rechecks[k]?.status === 'ok') out.push(doc.rechecks[k]);
  return out;
}

/**
 * post（寫一次）：兩法各自對官方同時刻累積值的誤差（§4.6）、ρ 實測、Q 對帳。
 *   err＝估計 V(T) ÷ 官方 openMarks.marks.mHHMM.yi − 1；rhoRatio＝官方 yi×1e8 ÷ (Q×1000×P̄)；rhoSum＝官方 yi ÷ ΣP×V。
 */
export function computePost({ doc, openMarks, A, H, now }) {
  const qMatch = {}, rhoRatio = {}, rhoSum = {}, errRatio = {}, errSum = {};
  for (const ck of okChecks(doc)) {
    const mk = `m${String(ck.T).slice(0, 5).replace(':', '')}`;
    const m = openMarks?.marks?.[mk];
    const Q = ck.vol?.q?.lots, bar = ck.vol?.px?.bar, vHat = ck.vol?.vHatYi, vs = ck.vol?.vSum?.yi;
    if (!(m?.yi > 0) || !(m.lots > 0)) continue;
    if (Q > 0) qMatch[mk] = rnd(Math.abs(m.lots - Q) / Q, 5);
    if (Q > 0 && bar > 0) rhoRatio[mk] = rnd(m.yi * 1e8 / (Q * 1000 * bar), 4);
    if (vs > 0) { rhoSum[mk] = rnd(m.yi / vs, 4); errSum[mk] = rnd(vs / m.yi - 1, 4); }
    if (vHat > 0) errRatio[mk] = rnd(vHat / m.yi - 1, 4);
  }
  return {
    basis: BASIS, writtenAt: now, A: A ?? null, H: H ?? null,
    label: A > 0 && H > 0 ? (A >= H ? 'big' : 'small') : null,
    marksBasis: openMarks?.basis ?? null,
    qMatch, rhoRatio, rhoSum, errRatio, errSum,
  };
}

/** openSensorMeta/rho 追加當日實測（每檢查點留最近 20 筆；同一天已有就不重複） */
export function rhoMetaAfter(meta, date, rhoRatio, now) {
  const live = { ...(meta?.live || {}) };
  let added = 0;
  for (const mk of Object.keys(rhoRatio || {})) {
    const arr = [...(live[mk] || [])];
    if (arr.some(x => x?.d === date) || !(rhoRatio[mk] > 0)) continue;
    arr.push({ d: date, rho: rhoRatio[mk] });
    live[mk] = arr.slice(-P.rhoWin);
    added++;
  }
  return {
    basis: SUB_BASIS.rho, rho0: P.rho0, rho0Src: 'MI_INDEX 鏡像收盤口徑 9/08–10/05 中位（4碼＋00xx）',
    live, asOf: added ? date : (meta?.asOf ?? null), writtenAt: now, added,
  };
}

/** openSensorMeta/threshold：replayThreshold 結果＋history（同一 asOf 不重複） */
export function thresholdMetaOf(rep, now) {
  return {
    basis: SUB_BASIS.h, H: rep.H ?? null, effectiveFrom: rep.effectiveFrom ?? null, seg: rep.seg ?? null,
    m60: rep.m60 ?? null, n: rep.n ?? null, from: rep.from ?? null, to: rep.to ?? null,
    streak: rep.streak ?? null, gaps: rep.gaps ?? [], stale: !!rep.stale, asOf: rep.asOf ?? null,
    history: rep.history ?? [], writtenAt: now,
  };
}

/**
 * openSensorStats/outside（§8.6）：以「10:00 定格狀態」為準，每個交易日只計一次（countedDates 冪等）。
 * 回傳新文件或 null（已計過或沒有定格狀態）。
 */
export function statsAfterFinal(stats, date, cur, now) {
  if (!cur?.final) return null;
  const counted = stats?.countedDates || [];
  if (counted.includes(date)) return null;
  const cells = { ...(stats?.cells || {}) };
  const bump = o => ({ n: (o?.n || 0) + 1, dates: [...(o?.dates || []), date].slice(-10) });
  let pending = stats?.pending || { n: 0, dates: [] }, undetermined = stats?.undetermined || { n: 0, dates: [] };
  const k = cur.key || '';
  if (k.startsWith('outside:')) { const ck = cellKey(k); cells[ck] = bump(cells[ck]); }
  else if (k === 'volPending') pending = bump(pending);
  else if (k === 'undetermined' || !k) undetermined = bump(undetermined);
  return { basis: BASIS, cells, countedDates: [...counted, date].slice(-60), pending, undetermined, updatedAt: now };
}

/** indexRing → orderFlowArchive/{date}.indexMarks（盤後複製；close 取 marketIndex/latest 收盤，否則 null） */
export function indexMarksFromRing(indexRing, closeDoc = null) {
  if (!indexRing) return null;
  return { ...indexRing, close: closeDoc ? { t: closeDoc.t, v: closeDoc.v } : null, copiedFrom: `openSensor.indexRing（${SUB_BASIS.ring}）` };
}

/** 給 log 用的一行摘要 */
export function checkLine(key, ck) {
  if (!ck) return `${key} —`;
  if (ck.status === 'nodata') return `${key} 無資料（${(ck.reasons || []).join('；').slice(0, 80)}）`;
  const v = ck.vol;
  return `${key} ${ck.state?.label || '—'}｜W ${ck.w?.pct ?? '—'}% 其餘 ${ck.w?.restUp ?? 0}漲${ck.w?.restDown ?? 0}跌｜G ${ck.g?.median ?? '—'}% B ${ck.g?.upRatio ?? '—'}｜量（估）${v?.estYi ?? '—'}/${v?.H ?? '—'} 億 ${v?.label ?? ''}${ck.status === 'undetermined' ? `｜未判定 ${(ck.reasons || []).length} 項` : ''}${ck.late ? '｜late' : ''}${ck.slid ? `｜滑動 ${ck.T}` : ''}`;
}
