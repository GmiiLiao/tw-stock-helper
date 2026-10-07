// ─────────────────────────────────────────────────────────────────────────────
// 開盤感應器（openSensor-v2.1·影子）的讀取端正規化（純函式·唯一實作；超管路由 /api/admin/open-sensor 與戰情 v2 前端共用）
//
// 規格：開盤感應器 v2.1 規格凍結（design-v2.1.md）§8.1 文件形狀、§9 前端顯示。寫入端是 daemon（scripts/ai-daemon.mjs）。
//   openSensor/{date}            09:02 首判、09:10…10:00 複判、09:20／09:30 盤型、10:00 定格、盤後 post
//   openSensorUniverse/{date}    名單存證（這裡只摘要，不帶 codesJson）
//   openSensorMeta/threshold     門檻 H 區段表（H-SEG60-v1）
//   openSensorStats/outside      「不在狀態內」計次（以 10:00 定格狀態為準）
// 規則：缺欄位一律 null（不補預設值、不補 0）；陣列只收形狀正確的元素；時間欄位一律轉 epoch ms（數字、ISO、Firestore Timestamp）。
// 輸出與輸入同鍵名 ⇒ 再正規化一次結果不變（前端收到伺服器正規化過的回應可再過一次當形狀檢查）。
// 影子模式：只供超管畫面顯示；這裡不產生任何事件、警示或通知。
// 單元測試：node --test scripts/lib/warroom-open-sensor.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { toEpochMs } from './warroom-freshness.mjs';
import { taipeiMinuteOfDay } from './warroom-session.mjs';

const M = (h, m) => h * 60 + m;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = v => (isNum(v) ? v : null);
const nonNeg = v => (isNum(v) && v >= 0 ? v : null);
const str = (v, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const bool = v => (typeof v === 'boolean' ? v : null);
const oneOf = (v, list) => (list.includes(v) ? v : null);
const objOrNull = (v, fn) => (isObj(v) ? fn(v) : null);
const strList = (v, max = 40) => (Array.isArray(v) ? v.filter(s => typeof s === 'string' && s).slice(0, max).map(s => s.slice(0, 200)) : []);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const HMS_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const MARK_RE = /^m\d{4}$/;
const ymdOrNull = v => (typeof v === 'string' && YMD_RE.test(v) ? v : null);
const hmsOrNull = v => (typeof v === 'string' && HMS_RE.test(v) ? v : null);

// ── 常數（規格 §1、§3.5、§5、§9） ────────────────────────────────────────────

export const OS_BASIS = 'openSensor-v2.1';
/** 影子標章（規格 §0-1：固定字樣） */
export const OS_BADGE = '影子·只記錄·先驗未校準';
/** 首判＋複判的文件鍵（時間順序） */
export const OS_CHECK_KEYS = Object.freeze(['c0902', 'r0910', 'r0920', 'r0930', 'r0940', 'r0950', 'r1000']);
export const OS_RECHECK_KEYS = Object.freeze(OS_CHECK_KEYS.slice(1));
export const OS_PATTERN_KEYS = Object.freeze(['c0920', 'c0930']);
/** 時點（台北分鐘）：首判 09:02、最晚寫出 09:05、定格 10:00、逾時定格 10:05 */
export const OS_TIMES = Object.freeze({ first: M(9, 2), deadline: M(9, 5), freeze: M(10, 0), timeoutFreeze: M(10, 5) });
/** 影子層輪詢窗（規格 §9.1）：交易日 08:55–10:15 每 30 秒；其餘時間掛載時抓一次 */
export const OS_POLL = Object.freeze({ fromMinute: M(8, 55), untilMinute: M(10, 15), everyMs: 30_000 });

const STATUS = ['ok', 'undetermined', 'nodata'];
const VOL_LABEL = ['big', 'small', 'pending'];
const DOMS = ['all', 'w', 'gen'];
const DIRS = ['up', 'down'];
const W_DIRS = ['up', 'down', 'flat', 'unconfirmed'];
const G_DIRS = ['up', 'down', 'flat'];
const LAMPS = ['red', 'green', 'neutral', 'gray'];
const OUTSIDE_REASONS = ['cell', 'wUnconfirmed', 'wUnstated'];

// ── 輪詢窗（純函式；前端 useWarRoomBus 影子層用） ───────────────────────────

/** 影子層是否該輪詢：交易日、台北 08:55–10:15、分頁在前景 */
export function shouldPollOpenSensorAt(ms, tradingDay, hidden = false) {
  if (hidden || !tradingDay) return false;
  const m = taipeiMinuteOfDay(ms);
  return m >= OS_POLL.fromMinute && m < OS_POLL.untilMinute;
}

/** 距今日影子層輪詢窗開始（08:55）的 ms；已過或非交易日回 null */
export function msUntilOpenSensorWindow(ms, tradingDay) {
  if (!tradingDay) return null;
  const m = taipeiMinuteOfDay(ms);
  return m < OS_POLL.fromMinute ? Math.ceil((OS_POLL.fromMinute - m) * 60_000) : null;
}

/** 看板日期：今天是交易日用今天，否則往前找最後一個交易日（最多回看 20 天；找不到回 null） */
export function resolveBoardYmd(todayYmd, isTradingYmd) {
  if (!YMD_RE.test(todayYmd)) return null;
  const [y, m, d] = todayYmd.split('-').map(Number);
  for (let back = 0; back <= 20; back++) {
    const t = new Date(Date.UTC(y, m - 1, d - back));
    const ymd = t.toISOString().slice(0, 10);
    if (isTradingYmd(ymd)) return ymd;
  }
  return null;
}

// ── 檢查點快照 Check（§8.1） ───────────────────────────────────────────────

function normState(s) {
  const cell = isObj(s.cell)
    ? { vol: oneOf(s.cell.vol, VOL_LABEL), dom: oneOf(s.cell.dom, DOMS), dir: oneOf(s.cell.dir, DIRS) }
    : null;
  const n = num(s.num);
  return {
    key: str(s.key, 80),
    label: str(s.label),
    num: n != null && Number.isInteger(n) && n >= 1 && n <= 7 ? n : null,
    named: bool(s.named),
    cell,
    outsideReason: oneOf(s.outsideReason, OUTSIDE_REASONS),
    sub: str(s.sub, 80),
    lamp: oneOf(s.lamp, LAMPS),
    candidates: strList(s.candidates, 4),
  };
}

const normW = w => ({
  pct: num(w.pct), tsmcPct: num(w.tsmcPct), restPct: num(w.restPct),
  restUp: nonNeg(w.restUp), restDown: nonNeg(w.restDown), restFlat: nonNeg(w.restFlat), restFresh: nonNeg(w.restFresh),
  dir: oneOf(w.dir, W_DIRS), fresh: nonNeg(w.fresh), capCovPct: nonNeg(w.capCovPct),
});

const normG = g => ({
  median: num(g.median), upRatio: nonNeg(g.upRatio), up: nonNeg(g.up), down: nonNeg(g.down), flat: nonNeg(g.flat),
  fresh: nonNeg(g.fresh), n: nonNeg(g.n), dir: oneOf(g.dir, G_DIRS), revealMed: toEpochMs(g.revealMed),
});

function normVol(v) {
  const px = isObj(v.px) ? v.px : null;
  const rho = isObj(v.rho) ? v.rho : null;
  const q = isObj(v.q) ? v.q : null;
  const vs = isObj(v.vSum) ? v.vSum : null;
  const win = num(px?.win);
  return {
    q: q ? { lots: nonNeg(q.lots), revealAt: toEpochMs(q.revealAt) } : null,
    qAucLots: nonNeg(v.qAucLots),
    px: px ? {
      bar: nonNeg(px.bar), win: win === 30 || win === 60 || win === 120 ? win : null, n: nonNeg(px.n),
      volLots: nonNeg(px.volLots), hasTsmc: bool(px.hasTsmc), w30n: nonNeg(px.w30n),
    } : null,
    rho: rho ? { v: nonNeg(rho.v), src: oneOf(rho.src, ['prior', 'live']), n: nonNeg(rho.n) } : null,
    vHatYi: nonNeg(v.vHatYi), c: nonNeg(v.c), cN: nonNeg(v.cN), estYi: nonNeg(v.estYi), estE2Yi: nonNeg(v.estE2Yi),
    H: nonNeg(v.H), segThYi: nonNeg(v.segThYi), label: oneOf(v.label, VOL_LABEL), est: bool(v.est),
    reason: str(v.reason, 80), gapDay: bool(v.gapDay),
    vSum: vs ? { yi: nonNeg(vs.yi), n: nonNeg(vs.n) } : null,
  };
}

const normIdxSide = s => ({ e: nonNeg(s.e), pct: num(s.pct), revealAt: toEpochMs(s.revealAt) });

const normIdx = x => ({
  tse: objOrNull(x.tse, normIdxSide), otc: objOrNull(x.otc, normIdxSide),
  officialOpen: nonNeg(x.officialOpen), officialOpenPct: num(x.officialOpenPct), oStarPct: num(x.oStarPct),
  distortPp: num(x.distortPp), distorted: bool(x.distorted),
});

/** 一個檢查點快照（c0902／rechecks.rHHMM）；status 不認得回 null。ticksJson 不帶（畫面用不到） */
export function normalizeCheck(c) {
  if (!isObj(c)) return null;
  const status = oneOf(c.status, STATUS);
  if (!status) return null;
  const dom = isObj(c.dom) ? { rule: str(c.dom.rule, 8), ratio: num(c.dom.ratio) } : null;
  const open = isObj(c.open)
    ? { wOpenPct: num(c.open.wOpenPct), gOpenMedian: num(c.open.gOpenMedian), dW: num(c.open.dW), dG: num(c.open.dG) }
    : null;
  const value = isObj(c.value)
    ? { wYi: nonNeg(c.value.wYi), gYi: nonNeg(c.value.gYi), wSharePct: nonNeg(c.value.wSharePct), wShareBasePct: nonNeg(c.value.wShareBasePct) }
    : null;
  const rl = c.restoredLive;
  return {
    status,
    reasons: strList(c.reasons, 20),
    late: c.late === true,
    slid: c.slid === true,
    restoredLive: isNum(rl) || typeof rl === 'boolean' ? rl : null,
    T: hmsOrNull(c.T),
    revealAt: toEpochMs(c.revealAt),
    revealP10: toEpochMs(c.revealP10),
    revealP90: toEpochMs(c.revealP90),
    writtenAt: toEpochMs(c.writtenAt),
    state: objOrNull(c.state, normState),
    w: objOrNull(c.w, normW),
    g: objOrNull(c.g, normG),
    s: num(c.s),
    dom,
    open,
    vol: objOrNull(c.vol, normVol),
    value,
    idx: objOrNull(c.idx, normIdx),
  };
}

// ── 盤型 Pattern（§6、§8.1） ─────────────────────────────────────────────────

function normLine(l) {
  return {
    status: str(l.status, 20), key: str(l.key, 40), label: str(l.label, 60),
    gp: num(l.gp), d: num(l.d), f: num(l.f), p: nonNeg(l.p), pPct: num(l.pPct),
    eUsed: nonNeg(l.eUsed), eCorrected: bool(l.eCorrected), revealAt: toEpochMs(l.revealAt),
  };
}

export function normalizePattern3(p) {
  if (!isObj(p)) return null;
  const lines = isObj(p.lines) ? p.lines : {};
  return {
    T: hmsOrNull(p.T),
    writtenAt: toEpochMs(p.writtenAt),
    lines: { tse: objOrNull(lines.tse, normLine), otc: objOrNull(lines.otc, normLine), gen: objOrNull(lines.gen, normLine) },
    qualifier: str(p.qualifier, 60),
    basis: str(p.basis, 40),
  };
}

// ── 文件 openSensor/{date}（§8.1） ───────────────────────────────────────────

function normE(e) {
  return {
    tse: objOrNull(e.tse, s => ({ v: nonNeg(s.v), pct: num(s.pct), revealAt: toEpochMs(s.revealAt) })),
    otc: objOrNull(e.otc, s => ({ v: nonNeg(s.v), pct: num(s.pct), revealAt: toEpochMs(s.revealAt) })),
    gen: num(e.gen),
    officialOpen: nonNeg(e.officialOpen), officialOpenPct: num(e.officialOpenPct), oStarPct: num(e.oStarPct),
    distortPp: num(e.distortPp), distorted: bool(e.distorted), basis: str(e.basis, 40),
  };
}

function normECorr(x) {
  const tse = Array.isArray(x.tse)
    ? x.tse.filter(isObj).slice(0, 12).map(r => ({ T: hmsOrNull(r.T), pct: num(r.pct), addPp: num(r.addPp), nOpened: nonNeg(r.nOpened) }))
    : [];
  const gen = Array.isArray(x.gen) ? x.gen.filter(isObj).slice(0, 12).map(r => ({ T: hmsOrNull(r.T), pp: num(r.pp) })) : [];
  return {
    unopened: objOrNull(x.unopened, u => ({ n: nonNeg(u.n), capPct: nonNeg(u.capPct), w30: strList(u.w30, 30) })),
    unknown: objOrNull(x.unknown, u => ({ n: nonNeg(u.n), capPct: nonNeg(u.capPct) })),
    eFinal: bool(x.eFinal),
    tse,
    gen,
    otc: objOrNull(x.otc, o => ({ status: oneOf(o.status, ['ok', 'uncorrected']) })),
  };
}

function normCur(c) {
  return {
    key: str(c.key, 80), label: str(c.label), T: hmsOrNull(c.T), revealAt: toEpochMs(c.revealAt),
    final: c.final === true, frozenAt: toEpochMs(c.frozenAt), finalBy: str(c.finalBy, 20),
    eTsePct: num(c.eTsePct), eGenPct: num(c.eGenPct),
  };
}

function normTrail(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(isObj).slice(0, 40).map(t => ({
    T: hmsOrNull(t.T), kind: oneOf(t.kind, ['state', 'eCorr']), key: str(t.key, 80), label: str(t.label), revealAt: toEpochMs(t.revealAt),
  })).filter(t => t.kind != null);
}

/** { mHHMM: 數字 } 形的盤後誤差表 */
function markMap(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (MARK_RE.test(k) && isNum(x)) out[k] = x;
  return out;
}

function normPost(p) {
  return {
    basis: str(p.basis, 40), writtenAt: toEpochMs(p.writtenAt), A: nonNeg(p.A), H: nonNeg(p.H),
    label: oneOf(p.label, ['big', 'small']),
    qMatch: markMap(p.qMatch), rhoRatio: markMap(p.rhoRatio), rhoSum: markMap(p.rhoSum),
    errRatio: markMap(p.errRatio), errSum: markMap(p.errSum),
  };
}

function normParams(p) {
  const seg = Array.isArray(p.hSeg) && p.hSeg.length === 2 && p.hSeg.every(x => x == null || isNum(x)) ? [p.hSeg[0] ?? null, p.hSeg[1] ?? null] : null;
  return {
    H: nonNeg(p.H), hSeg: seg, hBasis: str(p.hBasis, 40), struct: str(p.struct, 40), vol: str(p.vol, 40),
    cBase: objOrNull(p.cBase, c => ({ n: nonNeg(c.n), from: ymdOrNull(c.from), to: ymdOrNull(c.to), missing: strList(c.missing, 20).filter(s => YMD_RE.test(s)) })),
    rho0: nonNeg(p.rho0),
  };
}

const normUniverseInDoc = u => ({
  sharesAsOf: str(u.sharesAsOf, 20), sharesSrc: oneOf(u.sharesSrc, ['cache', 'mirror']), prevYmd: ymdOrNull(u.prevYmd),
  w30CapPct: nonNeg(u.w30CapPct), tsmcCapPct: nonNeg(u.tsmcCapPct), tsmcInW30Pct: nonNeg(u.tsmcInW30Pct),
  liquidN: nonNeg(u.liquidN), liquidMinLots: nonNeg(u.liquidMinLots),
});

/** openSensor/{date} → 畫面用文件；文件不存在或沒有合法 date 回 null */
export function normalizeOpenSensor(doc) {
  if (!isObj(doc)) return null;
  const date = ymdOrNull(doc.date);
  if (!date) return null;
  const rechecks = isObj(doc.rechecks) ? doc.rechecks : {};
  const checks = isObj(doc.checks) ? doc.checks : {};
  const rc = {};
  for (const k of OS_RECHECK_KEYS) rc[k] = normalizeCheck(rechecks[k]);
  const ring = isObj(doc.indexRing) ? doc.indexRing : null;
  return {
    date,
    basis: str(doc.basis, 40),
    mode: str(doc.mode, 20),
    dateSrc: oneOf(doc.dateSrc, ['t00', 'clock']),
    writtenAt: toEpochMs(doc.writtenAt),
    params: objOrNull(doc.params, normParams),
    universe: objOrNull(doc.universe, normUniverseInDoc),
    c0902: normalizeCheck(doc.c0902),
    rechecks: rc,
    checks: {
      e: objOrNull(checks.e, normE),
      c0920: normalizePattern3(checks.c0920),
      c0930: normalizePattern3(checks.c0930),
    },
    eCorr: objOrNull(doc.eCorr, normECorr),
    cur: objOrNull(doc.cur, normCur),
    trail: normTrail(doc.trail),
    outside: objOrNull(doc.outside, o => ({ cells: strList(o.cells, 20), firstAt: toEpochMs(o.firstAt) })),
    // 早盤指數環（10:03:30 寫）：畫面只看「有沒有、幾拍、缺段」（完整序列在盤後複製成 indexMarks）
    indexRing: ring ? { n: nonNeg(ring.n), gaps: Array.isArray(ring.gaps) ? ring.gaps.length : nonNeg(ring.gaps) } : null,
    post: objOrNull(doc.post, normPost),
  };
}

/** 依時間序取目前要顯示的檢查點：最後一個不是 nodata 的快照；都沒有回 null */
export function currentCheck(doc) {
  if (!doc) return null;
  for (let i = OS_CHECK_KEYS.length - 1; i >= 0; i--) {
    const key = OS_CHECK_KEYS[i];
    const c = key === 'c0902' ? doc.c0902 : doc.rechecks?.[key];
    if (c && c.status !== 'nodata') return { key, check: c };
  }
  return null;
}

/** 取一個檢查點快照（c0902 或 rechecks.rHHMM） */
export function checkOf(doc, key) {
  if (!doc) return null;
  return key === 'c0902' ? doc.c0902 : (doc.rechecks?.[key] ?? null);
}

// ── 其他三份文件 ───────────────────────────────────────────────────────────

const segOf = v => {
  if (isNum(v)) return v;
  if (Array.isArray(v) && v.length === 2 && v.every(x => x == null || isNum(x))) return [v[0] ?? null, v[1] ?? null];
  return str(v, 40);
};

/** openSensorMeta/threshold → 門檻摘要（history 不帶） */
export function normalizeOsThreshold(doc) {
  if (!isObj(doc)) return null;
  const st = isObj(doc.streak) ? doc.streak : null;
  return {
    basis: str(doc.basis, 40), H: nonNeg(doc.H), effectiveFrom: ymdOrNull(doc.effectiveFrom), seg: segOf(doc.seg),
    m60: nonNeg(doc.m60), n: nonNeg(doc.n), from: ymdOrNull(doc.from), to: ymdOrNull(doc.to),
    streak: st ? { seg: segOf(st.seg), n: nonNeg(st.n), dates: strList(st.dates, 5).filter(s => YMD_RE.test(s)) } : null,
    gaps: Array.isArray(doc.gaps) ? strList(doc.gaps, 20) : [],
    stale: bool(doc.stale), asOf: ymdOrNull(doc.asOf), writtenAt: toEpochMs(doc.writtenAt),
  };
}

const countAndDates = v => (isObj(v) ? { n: nonNeg(v.n), dates: strList(v.dates, 60).filter(s => YMD_RE.test(s)) } : null);

/** openSensorStats/outside → 各格／原因的次數（n 由大到小）。cells 收文件的 { 格: {n,dates} } 或已正規化的陣列（前端再過一次） */
export function normalizeOsOutsideStats(doc) {
  if (!isObj(doc)) return null;
  const entries = Array.isArray(doc.cells)
    ? doc.cells.filter(c => isObj(c) && typeof c.key === 'string').map(c => [c.key, c])
    : isObj(doc.cells) ? Object.entries(doc.cells) : [];
  const cells = entries.filter(([k, v]) => k && isObj(v)).slice(0, 40)
    .map(([key, v]) => ({ key: key.slice(0, 80), n: nonNeg(v.n), dates: strList(v.dates, 10).filter(s => YMD_RE.test(s)) }))
    .sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || a.key.localeCompare(b.key));
  return {
    basis: str(doc.basis, 40),
    cells,
    countedDates: strList(doc.countedDates, 60).filter(s => YMD_RE.test(s)),
    pending: countAndDates(doc.pending),
    undetermined: countAndDates(doc.undetermined),
    updatedAt: toEpochMs(doc.updatedAt),
  };
}

const countOf = v => (Array.isArray(v) ? v.length : nonNeg(v));

/** openSensorUniverse/{date} → 名單摘要（伺服器端用；codesJson 約 15 KB 不送前端） */
export function summarizeOsUniverse(doc) {
  if (!isObj(doc)) return null;
  const liquid = isObj(doc.liquid) ? doc.liquid : {};
  const ex = isObj(doc.excluded) ? doc.excluded : {};
  const w30 = Array.isArray(doc.w30)
    ? doc.w30.filter(r => isObj(r) && typeof r.code === 'string' && /^\d{4}$/.test(r.code)).slice(0, 30)
      .map(r => ({ code: r.code, capYi: nonNeg(r.capYi), wPct: nonNeg(r.wPct) }))
    : [];
  return {
    date: ymdOrNull(doc.date), basis: str(doc.basis, 40), createdAt: toEpochMs(doc.createdAt),
    sharesAsOf: str(doc.sharesAsOf, 20), sharesSrc: oneOf(doc.sharesSrc, ['cache', 'mirror']), prevYmd: ymdOrNull(doc.prevYmd),
    w30, tsmcCapPct: nonNeg(doc.tsmcCapPct), w30CapPct: nonNeg(doc.w30CapPct),
    // 文件是 liquid.{n,minLots}；已摘要過的（前端再過一次）是 liquidN／liquidMinLots
    liquidN: nonNeg(liquid.n) ?? nonNeg(doc.liquidN), liquidMinLots: nonNeg(liquid.minLots) ?? nonNeg(doc.liquidMinLots),
    excluded: { etf: countOf(ex.etf), tdr: countOf(ex.tdr), fullDelivery: countOf(ex.fullDelivery), split: countOf(ex.split) },
  };
}

// ── 路由回應（前端再過一次當形狀檢查） ─────────────────────────────────────

/** /api/admin/open-sensor 的回應 → 匯流排狀態；形狀不對回 null */
export function normalizeOpenSensorPayload(j) {
  if (!isObj(j) || !isNum(j.at)) return null;
  const date = ymdOrNull(j.date);
  const today = ymdOrNull(j.today);
  if (!date || !today) return null;
  const doc = normalizeOpenSensor(j.doc);
  return {
    at: j.at,
    date,
    today,
    tradingToday: j.tradingToday === true,
    doc: doc && doc.date === date ? doc : null,
    universe: isObj(j.universe) ? summarizeOsUniverse(j.universe) : null,
    threshold: normalizeOsThreshold(j.threshold),
    outsideStats: normalizeOsOutsideStats(j.outsideStats),
    failed: strList(j.failed, 8),
  };
}
