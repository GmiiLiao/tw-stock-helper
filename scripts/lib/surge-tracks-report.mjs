// ── T1 分軌前向影子（登錄 T1-TRACKS-FWD-2026-10-05）→ surgeShadow/tracks-* 文件（純函式，不碰 I/O）──────────────
// 研究端 scripts/surge-lab/a37_tracks_fwd.py 寫本機 out/tracks_fwd/（凍結 core、到期評分、parity、缺口、摘要）；
// scripts/surge-lab/a37_tracks_publish.mjs 讀檔驗封印後交給這裡整理成後台文件；API（?view=tracks｜tracksDay）與後台元件只顯示。
//   · 後台文件一律不放任何報酬或報酬衍生數字（c1／c5／c10、超額、日均）：灰底清單（R0、W）依 G1 決定「介面不顯示報酬」，
//     S0／S_FB／M0 的名單卡片依登錄 presentation.returns_display 也只顯示 T1 命中與否與累計 Δprecision；報酬只留在本機研究記錄。
//     assertNoReturns 對每一份要寫的文件遞迴檢查鍵名，測試保證（G60 P8）。
//   · 各清單固定順序、各自一區、不混排：M0 參照 → S0 → S_FB → R0（灰底）→ W（灰底）。
//   · kind 絕不可用 'frozen-forward'（a35_shadow_publish.assertNoForwardReplace 以該值查詢，誤用會讓 a35 整批發佈中止）。
// 影子模式·未扣成本·非投資建議。欄位命名避開未登記的 xxxAt／xxxDate（scripts/check-field-conventions.mjs）。

export const TRACKS_INDEX_SCHEMA = 'surgeShadow.tracksIndex.v1';
export const TRACKS_DAY_SCHEMA = 'surgeShadow.tracksDay.v1';
export const TRACKS_KIND_DAY = 't1-tracks-forward';
export const TRACKS_KIND_INDEX = 't1-tracks-index';
export const TRACKS_INDEX_ID = 'tracks-index';
export const TRACKS_DAY_PREFIX = 'tracks-fwd-';
export const TRACKS_DAY_ID_RE = /^tracks-fwd-\d{4}-\d{2}-\d{2}$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_DOC_BYTES = 900_000;
export const REGISTRATION_ID = 'T1-TRACKS-FWD-2026-10-05';
export const FOOTER = '影子模式·未扣成本·非投資建議';
export const G60_N = 60;
export const G250_N = 250;

/** 固定順序（M0 參照最上，灰底在最後；各自一區） */
export const LIST_ORDER = ['M0@10', 'S0_atr14@5', 'SFB_atr14@5', 'R0_combo@5', 'W_atr14@3'];
export const LIST_META = {
  'M0@10': { section: 'M0_REF', title: 'M0 參照（主榜模型前 10）', grey: false, exploratory: false, K: 10,
    label: '主榜 M0 參照（M-UNCHANGED）·本研究未作可交易判定', verdict: 'M-UNCHANGED' },
  'S0_atr14@5': { section: 'S0', title: 'S 小量軌・觀察／研究榜（S0 atr14 前 5）', grey: false, exploratory: false, K: 5,
    label: '觀察／研究榜·代理 lift 的時間外複製·容量受限·不可交易·待前向確認', verdict: 'S-KEEP-AS-SHADOW' },
  'SFB_atr14@5': { section: 'S_FB', title: 'S_FB・觀察／研究榜（探索性；Mp 列 atr14 前 5）', grey: false, exploratory: true, K: 5,
    label: '探索性·觀察／研究榜·代理 lift 的時間外複製·容量受限·不可交易·待前向確認', verdict: 'SFB-KEEP-AS-SHADOW' },
  'R0_combo@5': { section: 'R_GREY', title: '灰底・R0 再點火 combo 前 5（不可交易，僅觀察）', grey: true, exploratory: false, K: 5,
    label: '不可交易，僅觀察（灰底；介面不顯示報酬，研究記錄照算）', verdict: 'R-WATCH-ONLY' },
  'W_atr14@3': { section: 'W_GREY', title: '灰底・W 觀察 atr14 前 3（不可交易，僅觀察）', grey: true, exploratory: false, K: 3,
    label: '不可交易，僅觀察（灰底；介面不顯示報酬，研究記錄照算）', verdict: 'W-WATCH-ONLY' },
};
/** 清單固定警示（登錄 lists／presentation；S 的容量提醒是使用者 G1 指定文字） */
export const LIST_WARNINGS = {
  'M0@10': ['M0 前向參照需重現凍結模型指紋（80ec0f8e…）後才凍結；尚未接線前本區不顯示名單'],
  'S0_atr14@5': ['量薄，單筆 ≤1% 均量', '容量受限（Qmax＝floor(1%×vol20)；HO 選股中位數 1 張）', '不可交易·只確認代理 lift 是否在前向成立'],
  'SFB_atr14@5': ['探索性（未納入 Holm）', '標籤沿用 S0（含容量受限）；實際 vol20 ≥ 300、HO Qmax(2%) 中位數 28 張'],
  'R0_combo@5': ['灰底：不可交易，僅觀察；介面不顯示任何報酬', '升級條件：G250 的 Δprecision CI 下界 > 0'],
  'W_atr14@3': ['灰底：不可交易，僅觀察；介面不顯示任何報酬', '只作描述，沒有升級途徑'],
};
/** v2 研究的參考數字（docs/SURGE-TRACKS-T1-2026-10-05.md 第 3 節；只列精確度、Δ 對 RAND 與 lift——不列報酬） */
export const REFERENCE = {
  'M0@10': { sel: { hits: 55, picks: 2390, precisionPct: 2.30, deltaPp: 2.11, deltaCiPp: [1.41, 2.84], lift: 12.31 }, ho: { hits: 74, picks: 3470, precisionPct: 2.13, deltaPp: 1.94, deltaCiPp: [1.27, 2.63], lift: 10.95 } },
  'S0_atr14@5': { sel: { hits: 13, picks: 1195, precisionPct: 1.09, deltaPp: 0.93, deltaCiPp: [0.45, 1.44], lift: 6.91 }, ho: { hits: 22, picks: 1735, precisionPct: 1.27, deltaPp: 1.11, deltaCiPp: [0.62, 1.66], lift: 8.24 } },
  'SFB_atr14@5': { sel: { hits: 4, picks: 1195, precisionPct: 0.33, deltaPp: 0.21, deltaCiPp: [-0.07, 0.53], lift: 2.59 }, ho: { hits: 12, picks: 1735, precisionPct: 0.69, deltaPp: 0.47, deltaCiPp: [0.21, 0.77], lift: 3.10 } },
  'R0_combo@5': { sel: { hits: 21, picks: 1192, precisionPct: 1.76, deltaPp: 0.59, deltaCiPp: [-0.10, 1.25], lift: 1.50 }, ho: { hits: 43, picks: 1734, precisionPct: 2.48, deltaPp: 0.93, deltaCiPp: [0.19, 1.78], lift: 1.60 } },
  'W_atr14@3': { sel: { hits: 12, picks: 717, precisionPct: 1.67, deltaPp: 1.50, deltaCiPp: [0.67, 2.34], lift: 9.74 }, ho: { hits: 18, picks: 1041, precisionPct: 1.73, deltaPp: 1.50, deltaCiPp: [0.61, 2.46], lift: 7.45 } },
};
export const REFERENCE_NOTE = 'SEL＝2025 選模視窗、HO＝2023-08～2024-12 保留驗證（研究回測、未扣成本）；前向數字要累積到 G60（約 3 個月）才看流程、G250（約 1 年）才判去留';
/** 成本參考（登錄 cost_reference；只作參考，不當門檻） */
export const COST_REF = [
  { item: '手續費（2.8 折），單邊', value: '0.0399%' },
  { item: '證交稅', value: '0.3%（當沖 0.15%）' },
  { item: '來回成本', value: '2.8 折約 0.38%；全額約 0.585%' },
  { item: '每持有日攤提', value: 'c5 約 0.076%／日；c10 約 0.038%／日' },
  { item: '未模擬', value: '小型股價差與滑價（1 檔約 0.1～0.2%）、開盤競價量、處置股分盤撮合與預收款券' },
];
export const FIXED_LABELS = [
  '未扣成本（成本參考：2.8 折來回約 0.38%、全額約 0.585%；只作參考，不當門檻）',
  '交易方法狀態未知（全額交割、變更交易方法、停止信用交易的來源未提供）',
  '容量以 s 日 vol20 估計，未模擬開盤競價量與滑價',
  '非投資建議',
];
export const FAIL_TEXT = {
  fP10: '收盤<10', fP5: '收盤<5', fV300: 'vol20<300 張', fV100: 'vol20<100 張', fVnan: 'vol20 缺值', fH125: '近130日有收盤<125日',
  fA60: '上市未滿60日', fN20: '近20日有缺值', fBP: '近125日價格結構斷點', fCD: '冷卻期（前10日內連板）',
  NE_TDR: 'TDR（不參與）', NE_SUSP: 's 日無收盤', NE_LU_S: 's 日已收漲停',
};
export const TRACK_TEXT = { M: 'M 主軌', Mp: 'Mp 放寬層', R: 'R 再點火', S: 'S 小量', W: 'W 其餘', NE_TDR: 'TDR', NE_SUSP: '停牌', NE_LU_S: 's 日已漲停', outside: '列範圍外' };
const DISPOSAL_BADGE = { DK1: '處置中（DK_s＝1）·交易規則另案登錄', DKNA: '處置狀態未知（來源缺漏）' };
// 報酬或報酬衍生的鍵名（後台文件一律不得出現）
const RETURN_KEY_RE = /^(m_)?c(1|5|10)(_|$)|return|excess|daily_?mean|pool_?mean|^ret$|^m_ret/i;

const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, nd) => (fin(v) === null ? null : Math.round(v * 10 ** nd) / 10 ** nd);
const str = v => (typeof v === 'string' ? v : null);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const ci2 = v => (Array.isArray(v) && v.length === 2 && v.every(x => fin(x) !== null) ? [v[0], v[1]] : null);

export const dayDocId = day => `${TRACKS_DAY_PREFIX}${day}`;
export const isTracksDayId = id => TRACKS_DAY_ID_RE.test(String(id || ''));

/** 遞迴檢查：任何鍵名像報酬就丟錯（發佈前與測試都跑）。 */
export function assertNoReturns(doc, path = '$') {
  if (Array.isArray(doc)) { doc.forEach((x, i) => assertNoReturns(x, `${path}[${i}]`)); return; }
  if (!isObj(doc)) return;
  for (const [k, v] of Object.entries(doc)) {
    if (RETURN_KEY_RE.test(k)) throw new Error(`後台文件不得含報酬欄位：${path}.${k}`);
    assertNoReturns(v, `${path}.${k}`);
  }
}

/** undefined → null（Firestore 拒寫 undefined）；NaN／Infinity → null。 */
export function clean(v) {
  if (v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(clean);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  return v;
}

function pickRow(p, outcome) {
  const flags = str(p?.flags_known) || '';
  return {
    rank: fin(p?.rank), code: str(p?.code), name: str(p?.name), nameSrc: str(p?.name_src), market: str(p?.market), track: str(p?.track),
    close: round(p?.close, 2), vol20: round(p?.vol20, 0), qmaxLots: fin(p?.qmax_lots), qmaxRule: str(p?.qmax_rule),
    dk: fin(p?.DK_s), disposalBadge: flags.includes('DK1') ? DISPOSAL_BADGE.DK1 : flags.includes('DKNA') ? DISPOSAL_BADGE.DKNA : null,
    attention5: fin(p?.at_known5), attentionBadge: fin(p?.at_known5) === null ? '注意狀態未知（來源缺漏）' : p.at_known5 > 0 ? `近 5 日注意 ${p.at_known5} 次` : null,
    score: round(p?.score, 6), comboN: fin(p?.combo_n),
    outcome: outcome ? {
      t1: outcome.y === 1, buyable: outcome.m_buyable === 1, lockedOpen: outcome.m_locked_open === 1, noOpen: outcome.m_has_open_t === 0,
      dispT: outcome.m_disp_t_exec === 1, flags: str(outcome.flags) || '',
    } : null,
  };
}

function listBlock(id, core, y) {
  const meta = LIST_META[id];
  const fl = core?.lists?.[id] || null;
  const yl = y?.lists?.[id] || null;
  const base = { id, section: meta.section, title: meta.title, label: meta.label, listVerdict: `${meta.verdict}：${meta.label}`, grey: meta.grey,
    exploratory: meta.exploratory, K: meta.K, warnings: LIST_WARNINGS[id], reference: REFERENCE[id] || null };
  if (!fl) return { ...base, status: id === 'M0@10' ? 'not-wired' : 'missing', nPool: null, ranking: null, picks: [], rand: null, outcome: null };
  const byRank = new Map((yl?.picks_outcome || []).map(o => [o.rank, o]));
  const outcome = yl ? {
    events: fin(yl.events), picks: fin(yl.picks), hits: fin(yl.hits), expectedRand: round(yl.E_rand, 4),
    baseRatePct: fl.n_pool ? round((yl.events / fl.n_pool) * 100, 3) : null,
    precisionPct: yl.picks ? round((yl.hits / yl.picks) * 100, 2) : null,
    deltaPp: yl.picks ? round(((yl.hits - yl.E_rand) / yl.picks) * 100, 3) : null,
    randDrawHits: fin(yl.rand_draw_hits),
  } : null;
  return {
    ...base, status: 'frozen', nPool: fin(fl.n_pool), ranking: str(fl.ranking),
    rand: { picks: fin(fl.rand?.picks), drawCodes: Array.isArray(fl.rand?.draw) ? fl.rand.draw.map(String) : [] },
    picks: (fl.picks || []).map(p => pickRow(p, byRank.get(p.rank))), outcome,
  };
}

function eventRow(e) {
  return {
    code: str(e.code), name: str(e.name), market: str(e.market), track: str(e.track), trackText: TRACK_TEXT[e.track] || str(e.track),
    failing: (Array.isArray(e.failing) ? e.failing : []).map(f => FAIL_TEXT[f] || f), listId: str(e.list_id), rank: fin(e.rank), K: fin(e.K),
    nPool: fin(e.n_pool), picked: e.picked === true, note: str(e.note) || str(e.outside_reason),
  };
}

/**
 * 一個決策日的後台文件。core＝凍結檔（必須已驗封印）；y／c5／c10＝評分檔（frozen_seal 必須等於 core.seal，否則視為未評分）；parity 同理。
 * 報酬（c1／c5／c10）一律不帶進文件，只帶「是否已到期」的狀態。
 */
export function buildTracksDayDoc({ core, y = null, c5 = null, c10 = null, parity = null }) {
  if (!core || core.kind !== 't1-tracks-core' || !DAY_RE.test(core.date_s || '') || typeof core.seal !== 'string') throw new Error('core 凍結檔格式不對');
  if (core.rehearsal) throw new Error(`演練凍結檔不得發佈：${core.date_s}`);
  const mine = d => (d && d.frozen_seal === core.seal ? d : null);
  const [yy, c55, c1010, pp] = [mine(y), mine(c5), mine(c10), mine(parity)];
  const yOk = yy && yy.status === 'ok' ? yy : null;
  const doc = {
    schema: TRACKS_DAY_SCHEMA, kind: TRACKS_KIND_DAY, registrationId: REGISTRATION_ID, day: core.date_s, t: str(core.t), seal: core.seal,
    sealShort: core.seal.slice(0, 12), frozenAt: str(core.frozen_time), deadline: str(core.deadline),
    trackCounts: isObj(core.track_counts) ? core.track_counts : {},
    matured: { y: yy ? yy.status : null, h5: c55 ? c55.status : null, h10: c1010 ? c1010.status : null },   // 只帶到期狀態（報酬不進文件）
    lists: LIST_ORDER.map(id => listBlock(id, core, yOk)),
    events: yOk ? (yOk.events || []).map(eventRow) : null,
    eventsByTrack: yOk && isObj(yOk.events_by_track) ? yOk.events_by_track : null,
    parity: pp ? { verdict: str(pp.verdict), nDiffs: fin(pp.n_diffs), inputsChanged: Array.isArray(pp.inputs_changed) ? pp.inputs_changed : [] } : null,
    disposalAttention: { strictUnknown: isObj(core.disposal_attention?.strict_unknown) ? core.disposal_attention.strict_unknown : null },
    closesAtS: isObj(core.closes_at_s) ? core.closes_at_s : null,
    fixedLabels: FIXED_LABELS, costRef: COST_REF, referenceNote: REFERENCE_NOTE, footer: FOOTER,
  };
  const out = clean(doc);
  assertNoReturns(out);
  return out;
}

export function tracksDaySummary(doc) {
  const lists = {};
  for (const b of doc.lists || []) {
    if (b.status !== 'frozen') continue;
    lists[b.id] = { picks: b.outcome ? b.outcome.picks : null, hits: b.outcome ? b.outcome.hits : null, nPool: b.nPool };
  }
  return { id: dayDocId(doc.day), day: doc.day, t: doc.t, status: 'frozen', sealShort: doc.sealShort, matured: doc.matured, lists,
    nEvents: Array.isArray(doc.events) ? doc.events.length : null, parity: doc.parity ? doc.parity.verdict : null, gapReason: null };
}

export function gapSummary(gap) {
  return { id: null, day: str(gap?.date_s), t: str(gap?.t), status: 'gap', sealShort: typeof gap?.seal === 'string' ? gap.seal.slice(0, 12) : null,
    matured: null, lists: {}, nEvents: null, parity: null, gapReason: str(gap?.reason),
    unmet: isObj(gap?.unmet_conditions) ? Object.keys(gap.unmet_conditions) : [] };
}

function statBlock(st) {
  if (!isObj(st)) return null;
  return { days: fin(st.days), windowDays: fin(st.window_days), picks: fin(st.picks), hits: fin(st.hits), expectedRand: round(st.E_rand, 4),
    precisionPct: fin(st.precision_pct), randPrecisionPct: fin(st.rand_precision_pct), deltaPp: fin(st.delta_pp), deltaCiPp: ci2(st.delta_ci_pp),
    lift: fin(st.lift), liftCi: ci2(st.lift_ci) };
}

/**
 * 索引文件：每日一列（新→舊；凍結與缺口並列）＋累計精確度／Δ／lift（判定窗）＋G60／G250 進度＋流程檢查。
 * summary＝a37_tracks_fwd.py 的 tracks_fwd_summary.json（stats 只取精確度類，報酬類欄位一律不帶）。
 */
export function buildTracksIndexDoc({ days = [], summary = null, status = null, generatedAt }) {
  const rows = [...days].filter(d => d && DAY_RE.test(d.day || '')).sort((a, b) => b.day.localeCompare(a.day));
  const st = isObj(summary?.stats) ? summary.stats : {};
  const nScored = fin(summary?.n_scored) ?? 0;
  const doc = {
    schema: TRACKS_INDEX_SCHEMA, kind: TRACKS_KIND_INDEX, registrationId: REGISTRATION_ID, generatedAt: str(generatedAt), s0: str(summary?.s0),
    days: rows, nCore: rows.filter(r => r.status === 'frozen').length, nGaps: rows.filter(r => r.status === 'gap').length,
    cumulative: Object.fromEntries(LIST_ORDER.filter(id => id !== 'M0@10').map(id => [id, statBlock(st[id])])),
    gates: {
      nScored, g60: { target: G60_N, reached: nScored >= G60_N, crash: isObj(summary?.gate) ? Object.fromEntries(Object.entries(summary.gate).map(([k, v]) => [k, v?.g60_crash ?? null])) : {} },
      g250: { target: G250_N, reached: nScored >= G250_N, verdict: isObj(summary?.gate) ? Object.fromEntries(Object.entries(summary.gate).map(([k, v]) => [k, v?.g250 ?? null])) : {} },
      note: 'G60 只查流程與崩壞；G250 以 Δprecision@5(S0 − RAND) 判 CONFIRM／EXTEND／DROP（登錄 §9～§10）',
    },
    process: isObj(summary?.process) ? summary.process : null,
    pipeline: isObj(status) ? { finished: str(status.finished), exit: fin(status.exit), errors: Array.isArray(status.errors) ? status.errors.length : null,
      skipped: str(status.skipped) } : null,
    listMeta: Object.fromEntries(LIST_ORDER.map(id => [id, { title: LIST_META[id].title, grey: LIST_META[id].grey, exploratory: LIST_META[id].exploratory }])),
    referenceNote: REFERENCE_NOTE, footer: FOOTER,
  };
  const out = clean(doc);
  assertNoReturns(out);
  return out;
}

/** 文件大小（UTF-8 位元組）；任何一份超過上限就丟錯（整批不寫）。 */
export function assertTracksDocSizes(writes) {
  const sizes = writes.map(([id, w]) => [id, Buffer.byteLength(typeof w.reportJson === 'string' ? w.reportJson : JSON.stringify(w), 'utf8')]);
  const big = sizes.filter(([, n]) => n > MAX_DOC_BYTES);
  if (big.length) throw new Error(`文件過大（需改壓縮／分片）：${big.map(([id, n]) => `${id} ${n}B`).join(', ')}`);
  return sizes;
}

/** 已發佈的前向凍結日文件不可被不同封印覆蓋、也不可消失（前向成績不可事後改寫）。published＝[{ id, seal }]。 */
export function forwardReplaceProblems(published, next) {
  const want = new Map(next.map(w => [w.id, w.seal]));
  const clash = published.filter(p => want.has(p.id) && want.get(p.id) !== p.seal).map(p => p.id);
  const missing = published.filter(p => !want.has(p.id)).map(p => p.id);
  return { clash, missing };
}
