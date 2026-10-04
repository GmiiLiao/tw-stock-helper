// ── 起漲影子名單（a35 shadow）→ 管理後台文件 ─────────────────────────────
// 研究端（scripts/surge-lab/a35_shadow_*.py）每個打分日盤後凍結一份名單（sha256 封印），
// 下一交易日收盤後對答案。這裡把凍結檔＋對答案結果整理成後台要顯示的精簡結構（純函式，不碰 I/O）：
//   · buildDayDoc：一個打分日的六個子榜（逐檔：名次、分數、打分日狀態、站上名次、隔日是否漲停／可買）
//   · buildIndexDoc：日期清單＋事前凍結（forward）合計＋歷史回推（would-have-been）合併統計
// 影子模式：不取代、不修改站上漲停預測。所有數字未扣成本、非投資建議。
// 欄位命名：避開未登記的 xxxAt／xxxDate（scripts/check-field-conventions.mjs）。

export const DAY_SCHEMA = 'surgeShadow.day.v1';
export const INDEX_SCHEMA = 'surgeShadow.index.v1';
export const FROZEN_SCHEMA = 'a35.shadow.v1';
export const SHADOW_LISTS = [
  ['overallTop30', '整體'],
  ['twseTop30', '上市'],
  ['tpexTop30', '上櫃'],
  ['freshTop30', '新起漲（打分日未漲停）'],
  ['continuationTop30', '延續（打分日已漲停）'],
  ['researchUniverseTop30', '研究母體（不套流動性濾網）'],
];
export const KINDS = { 'frozen-forward': '事前凍結', 'historical-would-have-been': '歷史回推' };
// 歷史合併統計只帶這些格子到後台（其餘留在研究輸出）
const HISTORY_KEYS = ['overallTop30@10', 'overallTop30@30', 'twseTop30@10', 'tpexTop30@10', 'freshTop30@10', 'continuationTop30@10', 'site_top10@10', 'site_top30@30'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const bool = v => (typeof v === 'boolean' ? v : null);
const str = v => (typeof v === 'string' ? v : null);

/** 凍結檔基本檢查：格式不對就丟錯，不要把半套資料寫上後台。 */
export function assertFrozen(fz) {
  if (!fz || typeof fz !== 'object') throw new Error('凍結檔不是物件');
  if (fz.schema !== FROZEN_SCHEMA) throw new Error(`凍結檔 schema 不符：${fz.schema}`);
  if (!KINDS[fz.kind]) throw new Error(`未知的凍結檔種類：${fz.kind}`);
  if (!DAY_RE.test(fz.scoringDay || '') || !DAY_RE.test(fz.targetDay || '')) throw new Error('scoringDay／targetDay 格式錯誤');
  if (!SHA_RE.test(fz.sha256 || '')) throw new Error('缺 sha256 封印');
  if (!fz.lists || typeof fz.lists !== 'object') throw new Error('缺 lists');
}

/**
 * 事前凍結的時間閘：凍結時刻（generatedAt）必須早於目標日 09:00（台北）。
 * kind 只看「打分日是不是面板最後一天」，不看產生時間——目標日收盤後才重產的名單不可算進前向成績（2026-10-04 審查）。
 */
export function forwardFreezeOk(fz) {
  const t = Date.parse(fz?.generatedAt || '');
  const open = Date.parse(`${fz?.targetDay}T09:00:00+08:00`);
  return Number.isFinite(t) && Number.isFinite(open) && t < open;
}

/**
 * 歷史回推合併統計是否就是「目前這批歷史名單」算出來的：兩邊封印集合完全相同才算 ok。
 * 名單用 --force 重產而沒重跑對答案時，合併檔還是舊名單的成績——不可顯示（2026-10-04 審查）。
 * lists：[{ scoringDay, sha256 }]（shadow_hist/ 目前的凍結檔）。
 */
export function historyConsistency(lists, pooled) {
  if (!pooled?.days?.length) return { status: 'missing', onlyInPooled: [], onlyInLists: lists.map(l => l.scoringDay) };
  const inLists = new Set(lists.map(l => l.sha256));
  const inPooled = new Set(pooled.days.map(d => d.frozenSha256));
  const onlyInPooled = pooled.days.filter(d => !inLists.has(d.frozenSha256)).map(d => d.scoringDay);
  const onlyInLists = lists.filter(l => !inPooled.has(l.sha256)).map(l => l.scoringDay);
  return { status: onlyInPooled.length || onlyInLists.length ? 'mismatch' : 'ok', onlyInPooled, onlyInLists };
}

/** 單日對答案檔（a35_shadow_score.py 單檔輸出）或合併檔的 days[] 一列 → 同一個形狀。 */
export function normalizeScore(x) {
  if (!x || typeof x !== 'object') return null;
  return {
    frozenSha256: str(x.frozenSha256),
    nLimitUp: x.truth?.nLimitUp ?? x.nLimitUp ?? null,
    nBuyableLimitUp: x.truth?.nBuyableLimitUp ?? x.nBuyableLimitUp ?? null,
    baseRatePool: x.baseRatePool ?? null,
    stats: x.lists ?? {},
    hits: x.hits ?? {},
    marketTarget: x.marketContext?.targetDay ?? null,
    warnings: Array.isArray(x.warnings) ? x.warnings.filter(w => typeof w === 'string') : [],
  };
}

function hitMap(rows) {
  const m = new Map();
  for (const h of rows || []) if (h && typeof h.code === 'string') m.set(h.code, { lu: bool(h.lu), buyable: bool(h.buyable) });
  return m;
}

function listRows(entries, siteRanks, hits) {
  return (entries || []).map(e => {
    const h = hits.get(e.code);
    return {
      rank: e.rank ?? null, code: String(e.code), name: str(e.name) ?? '', market: str(e.market),
      close: num(e.close, 2), chgPct: num(e.chgPct, 2), score: num(e.score, 3),
      limitUpAtS: bool(e.limitUpAtS), luStreakAtS: e.luStreakAtS ?? null, oneWordLockAtS: bool(e.oneWordLockAtS), closeAtHigh: bool(e.closeAtHigh),
      vol20Lots: num(e.vol20Lots, 0), siteRank: typeof siteRanks?.[e.code] === 'number' ? siteRanks[e.code] : null,
      lu: h ? h.lu : null, buyable: h ? h.buyable : null,
    };
  });
}

/** 一個打分日 → 後台日文件。score 可為 null（尚未對答案）；封印對不上就不採用並丟錯。 */
export function buildDayDoc(fz, rawScore = null) {
  assertFrozen(fz);
  const sc = normalizeScore(rawScore);
  if (sc && sc.frozenSha256 !== fz.sha256) throw new Error(`對答案檔的 frozenSha256 與凍結檔不符（${fz.scoringDay}）`);
  const site = fz.site || {};
  const lists = {};
  for (const [key] of SHADOW_LISTS) lists[key] = listRows(fz.lists[key], site.ranksTop120, hitMap(sc?.hits?.[key]));
  const t = fz.training || {};
  return {
    schema: DAY_SCHEMA, scoringDay: fz.scoringDay, targetDay: fz.targetDay, kind: fz.kind, sha256: fz.sha256,
    generatedAt: str(fz.generatedAt), modelHash: str(fz.modelHash),
    training: { trainCutoff: str(t.cutoffDate), lastLabel: str(t.lastLabelDate), retrain: str(t.retrain), fitRows: t.fitRows ?? null, positives: t.positives ?? null },
    universe: { pool: fz.universe?.pool ?? null, poolByMarket: { tse: fz.universe?.poolByMarket?.tse ?? null, otc: fz.universe?.poolByMarket?.otc ?? null }, alreadyLimitUpInPool: fz.universe?.alreadyLimitUpInPool ?? null },
    marketScoring: fz.marketContext ?? null,
    site: {
      dataDate: str(site.dataDate), source: str(site.source), written: str(site.writtenAt), canonicalAt: str(site.canonicalAt),
      top30: Array.isArray(site.codes) ? site.codes.map(String) : [],
      bList: Array.isArray(site.bList) ? site.bList.map(b => ({ code: String(b.code), est: b.est ?? null })) : [],
      overlapWithOverallTop30: site.overlapWithOverallTop30 ?? null,
    },
    lists,
    outcome: sc ? {
      nLimitUp: sc.nLimitUp, nBuyableLimitUp: sc.nBuyableLimitUp, baseRatePool: sc.baseRatePool, stats: sc.stats,
      siteTop30: (sc.hits.site_top30 || []).map(h => ({ rank: h.rank ?? null, code: String(h.code), lu: bool(h.lu), buyable: bool(h.buyable), limitUpAtS: bool(h.limitUpAtS) })),
      marketTarget: sc.marketTarget, warnings: sc.warnings,
    } : null,
  };
}

/** Firestore 文件 id：同一天可能同時有事前凍結與歷史回推，前綴分開。 */
export function dayDocId(kind, scoringDay) {
  if (!KINDS[kind] || !DAY_RE.test(scoringDay || '')) throw new Error(`無效的日文件 id：${kind} ${scoringDay}`);
  return `${kind === 'frozen-forward' ? 'fwd' : 'hist'}-${scoringDay}`;
}
export const DAY_ID_RE = /^(fwd|hist)-\d{4}-\d{2}-\d{2}$/;

const cell = s => (s ? { n: s.n ?? 0, hit: s.hit ?? 0, buy: s.buy ?? 0 } : null);
const add = (a, b) => (b ? { n: a.n + b.n, hit: a.hit + b.hit, buy: a.buy + b.buy } : a);

/** 日文件摘要（日期清單用）。 */
export function daySummary(doc) {
  const st = doc.outcome?.stats || {};
  return {
    id: dayDocId(doc.kind, doc.scoringDay),
    scoringDay: doc.scoringDay, targetDay: doc.targetDay, kind: doc.kind, sha12: doc.sha256.slice(0, 12), scored: !!doc.outcome,
    nLimitUp: doc.outcome?.nLimitUp ?? null,
    top10: cell(st.overallTop30?.['10']), top30: cell(st.overallTop30?.['30']),
    site10: cell(st.site_top10?.['10']), site30: cell(st.site_top30?.['30']),
  };
}

/** 事前凍結（forward）且已對答案的日子合計——真正的前向成績，與歷史回推分開列。 */
export function forwardTotals(summaries) {
  const zero = { n: 0, hit: 0, buy: 0 };
  const fwd = summaries.filter(s => s.kind === 'frozen-forward');
  const done = fwd.filter(s => s.scored);
  return {
    days: fwd.length, scored: done.length,
    top10: done.reduce((a, s) => add(a, s.top10), zero), top30: done.reduce((a, s) => add(a, s.top30), zero),
    site10: done.reduce((a, s) => add(a, s.site10), zero), site30: done.reduce((a, s) => add(a, s.site30), zero),
  };
}

function historyBlock(pooled) {
  if (!pooled?.pooled?.lists) return null;
  const days = (pooled.days || []).map(d => d.scoringDay).filter(Boolean).sort();
  const lists = {};
  for (const k of HISTORY_KEYS) {
    const s = pooled.pooled.lists[k];
    if (s) lists[k] = { n: s.n, hit: s.hit, buy: s.buy, precision: s.precision ?? null, wilson: s.precisionWilson ?? null, block: s.precisionBlock ?? null, buyable: s.buyable ?? null };
  }
  return { from: days[0] ?? null, to: days.at(-1) ?? null, days: pooled.pooled.days ?? days.length, blockDays: pooled.pooled.blockDays ?? null, lists, byLimitUpTercile: pooled.context?.byLimitUpTercile ?? [] };
}

/**
 * 日期清單＋前向合計＋歷史回推合併統計。summaries 由新到舊排序；id 重複直接丟錯（同一 batch 會互蓋、前端 key 衝突）。
 * historyStatus 不是 'ok' 時不帶合併統計（見 historyConsistency），只留狀態讓後台說明原因。
 */
export function buildIndexDoc(summaries, pooled, generatedAt, historyStatus = 'ok') {
  const ids = summaries.map(s => s.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) throw new Error(`日文件 id 重複：${[...new Set(dup)].join(', ')}`);
  const sorted = [...summaries].sort((a, b) => (a.scoringDay < b.scoringDay ? 1 : a.scoringDay > b.scoringDay ? -1 : a.kind < b.kind ? -1 : 1));
  return {
    schema: INDEX_SCHEMA, generatedAt, days: sorted, forward: forwardTotals(sorted),
    historyStatus, history: historyStatus === 'ok' ? historyBlock(pooled) : null,
  };
}
