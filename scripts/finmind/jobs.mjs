// ── 請求展開：資料集 × 日期（群組）× 代號／券商（成員）→ 只排缺的、依優先序 ───────────────────
// 群組＝一個輸出檔（一天、一段區間或一份快照）；成員＝群組內的一次請求（'*' 代表全市場一次拿完）。
// 主佇列（main）：2023-01-01 起；空閒佇列（idle）：更早的部分，排在 main 之後，且只在 --window idle 執行（backfill.mjs 把關）。
import { MAIN_START, DAILY_REPORT_EP } from './datasets.mjs';

export const SINGLE = '*';
export const MISSING_MEMBERS = '該日沒有代號清單（本機 chipArchive 收盤缺；分點券商路線則是證券商清單 TaiwanSecuritiesTraderInfo 未下載）';
const SINGLE_MODES = new Set(['market-day', 'range', 'table', 'week']);
const PRIORITIES = ['recent-first', 'oldest-first'];
const SAMPLE_ANCHOR = '2023-03-15';   // 目錄員實測 2023 年有資料的日子

export const phaseOf = date => (date && date < MAIN_START ? 'idle' : 'main');
export const isSingle = spec => SINGLE_MODES.has(spec.mode);

/** 預設 --to：今天（台北）以前的最後一個交易日。 */
export function defaultTo(days, todayIso) {
  const prev = days.filter(d => d < todayIso);
  return prev.length ? prev[prev.length - 1] : null;
}

const pad2 = n => String(n).padStart(2, '0');
const monthEnd = (y, m) => `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;

/** 依日曆月切段 [[from, to], ...]。 */
export function monthChunks(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  let start = from;
  while (start <= to) {
    const end = monthEnd(y, m) < to ? monthEnd(y, m) : to;
    out.push([start, end]);
    m += 1; if (m > 12) { m = 1; y += 1; }
    start = `${y}-${pad2(m)}-01`;
  }
  return out;
}

const maxDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
const PRE_END = new Date(Date.parse(`${MAIN_START}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);   // 2022-12-31

/** 某資料集在 [from, to] 的群組。ctx：{ days, from, to, asOf, weeks? }。 */
export function groupKeys(spec, { days, from, to, asOf, weeks }) {
  const f = maxDate(from, spec.since);
  const dayGroup = d => ({ group: d, date: d, phase: phaseOf(d) });
  switch (spec.mode) {
    case 'market-day': case 'code-day': case 'broker-day':
      return days.filter(d => d >= f && d <= to).map(dayGroup);
    case 'week':
      if (!Array.isArray(weeks)) throw new Error(`${spec.name} 需要先取得週資料日（discover）`);
      return weeks.filter(d => d >= f && d <= to).map(dayGroup);
    case 'range': {
      // 起點早於 2023 時切成「2023 以前（idle）＋2023 起（main）」兩段：空閒佇列的檔名固定（range_<起點>_2022-12-31，不隨 --to 長出新檔），
      // 而且同一次執行裡 main 那段排在前面，afterMain 閘門才放得行（2026-10-08 回補規劃）
      const pre = f < MAIN_START;
      if (spec.startOnly) {
        if (!pre) return [{ group: `snapshot_${asOf}`, date: null, phase: 'main', range: [f, null] }];
        return [{ group: `snapshot_${asOf}_from_${f}`, date: null, phase: 'idle', range: [f, null] }, { group: `snapshot_${asOf}`, date: null, phase: 'main', range: [MAIN_START, null] }];
      }
      const t = spec.rangeTo === 'next-year-end' ? `${Number(to.slice(0, 4)) + 1}-12-31` : to;
      if (f > t) return [];
      const chunks = spec.chunkMonths ? monthChunks(f, t) : pre && t >= MAIN_START ? [[f, PRE_END], [MAIN_START, t]] : [[f, t]];
      return chunks.map(([a, b]) => ({ group: `range_${a}_${b}`, date: null, phase: phaseOf(a), range: [a, b] }));
    }
    case 'table':
      return [{ group: `snapshot_${asOf}`, date: null, phase: 'main' }];
    default:
      throw new Error(`未知的 mode：${spec.mode}`);
  }
}

/** 一個成員的請求（endpoint＋參數；token 只在標頭，不在這裡）。 */
export function requestFor(spec, g, member, { route = 'broker' } = {}) {
  const base = { dataset: spec.name };
  switch (spec.mode) {
    case 'market-day': case 'week': return { endpoint: 'data', params: { ...base, start_date: g.date } };
    case 'code-day': return { endpoint: 'data', params: { ...base, data_id: member, start_date: g.date } };
    case 'broker-day': return { endpoint: spec.endpoint || DAILY_REPORT_EP, params: route === 'stock' ? { data_id: member, date: g.date } : { securities_trader_id: member, date: g.date } };
    case 'range': return { endpoint: 'data', params: g.range?.[1] ? { ...base, start_date: g.range[0], end_date: g.range[1] } : { ...base, start_date: g.range[0] } };
    case 'table': return { endpoint: 'data', params: base };
    default: throw new Error(`未知的 mode：${spec.mode}`);
  }
}

function memberIds(spec, g, ctx) {
  if (isSingle(spec)) return [SINGLE];
  if (ctx.codes?.length) return ctx.codes;
  return ctx.membersFor(spec, g.date);
}

/**
 * 暫定群組：抓取日（台北，正式檔的修改時間）不晚於結算日 ⇒ 下次重抓（replace）。
 *   結算日＝資料日之後第 settleDays−1 個交易日（預設 1＝資料日當天：當天晚上抓的當日資料一律暫定；交易日表外＝還沒到）。
 *   2026-10-08 實測：當晚抓的主動 ETF 持股 10-08 只有 10／38 檔、10-07 也只有 31 檔（投信隔日陸續揭露）——0 列才算「尚未更新」的規則抓不到。
 */
export function isProvisional(spec, g, st, days) {
  if (!st?.fetchedOn) return false;
  // 區間群組：抓取日不晚於區間終點 ⇒ 內容還會變（例：可轉債賣回權時程 end＝明年底、含未來場次；群組名一整年不變，
  //   舊規則下抓過一次就永不更新，之後新發行的 CB 都漏掉——2026-10-09 審查）⇒ 下次重抓（舊版搬 _superseded/）
  if (!g.date && g.range?.[1]) return st.fetchedOn <= g.range[1];
  if (!g.date || !Array.isArray(days)) return false;
  const i = days.indexOf(g.date);
  const settle = i < 0 ? g.date : days[i + (spec.settleDays || 1) - 1];
  return !settle || st.fetchedOn <= settle;
}

/**
 * 展開計畫。ctx：{ days, from, to, asOf, membersFor(spec,date), doneFor(spec,group)→{done:Set,final,status},
 *   codes?, weeksFor?(spec), route?, retryEmpty?, priority?, interleave? }
 * 回傳 { groups, skipped }；groups 已排序。
 */
export function expandPlan(specs, ctx) {
  const groups = []; const skipped = [];
  for (const spec of specs) {
    const weeks = spec.mode === 'week' ? ctx.weeksFor?.(spec) : undefined;
    for (const g of groupKeys(spec, { ...ctx, weeks })) {
      const ids = memberIds(spec, g, ctx);
      if (!ids) { skipped.push({ dataset: spec.name, group: g.group, reason: MISSING_MEMBERS }); continue; }
      const st = ctx.doneFor(spec, g.group) || { done: new Set(), final: false, status: null };
      const replace = !!(ctx.retryEmpty && st.final && st.status === 'empty') || (st.final && isProvisional(spec, g, st, ctx.days));
      if (st.final && !replace && (isSingle(spec) || ids.every(id => st.done.has(id)))) continue;
      // 成員都到齊但還沒收尾（程序在收尾前被殺）⇒ members=[]、只收尾；--retry-empty 的空群組整個重抓（replace）
      const missing = replace ? (isSingle(spec) ? [SINGLE] : ids) : (isSingle(spec) ? [SINGLE] : ids).filter(id => !st.done.has(id));
      groups.push({ dataset: spec.name, spec, rank: spec.rank, ...g, members: missing, planned: ids.length, route: ctx.route || 'broker', replace, finalizeOnly: !missing.length });
    }
  }
  return { groups: orderGroups(groups, ctx), skipped };
}

/** 排序：main 先於 idle；預設依資料集 rank 依序、同資料集依日期；interleave 改為日期優先。 */
export function orderGroups(groups, { priority = 'recent-first', interleave = false } = {}) {
  if (!PRIORITIES.includes(priority)) throw new Error(`未知的 priority：${priority}（只接受 ${PRIORITIES.join('／')}）`);
  const desc = priority === 'recent-first';
  const dateKey = g => g.date ?? (desc ? '9999-99-99' : '0000-00-00');
  const cmpDate = (a, b) => (desc ? dateKey(b).localeCompare(dateKey(a)) : dateKey(a).localeCompare(dateKey(b)));
  const cmpDs = (a, b) => a.rank - b.rank || a.dataset.localeCompare(b.dataset);
  return [...groups].sort((a, b) => (a.phase === b.phase ? 0 : a.phase === 'main' ? -1 : 1)
    || (interleave ? cmpDate(a, b) || cmpDs(a, b) : cmpDs(a, b) || cmpDate(a, b))
    || a.group.localeCompare(b.group));
}

/** 抽樣日：區間內 2023-03-15 起第一天、中間一天、最後一天（去重）。 */
export function sampleDays(days, { from, to }) {
  const r = days.filter(d => d >= from && d <= to);
  if (!r.length) return [];
  let i0 = r.findIndex(d => d >= SAMPLE_ANCHOR); if (i0 < 0) i0 = 0;
  const i2 = r.length - 1;
  return [...new Set([r[i0], r[Math.floor((i0 + i2) / 2)], r[i2]])];
}

/** 計畫摘要：請求數、估計 gz、各 phase／資料集分計。 */
export function summarizePlan(groups) {
  const s = { requests: 0, estGzBytes: 0, groups: groups.length, byPhase: { main: 0, idle: 0 }, byDataset: {} };
  for (const g of groups) {
    const n = g.members.length;
    const per = g.route === 'stock' && g.spec.estGzStock ? g.spec.estGzStock : g.spec.estGz;
    s.requests += n; s.estGzBytes += n * per; s.byPhase[g.phase] += n;
    const d = (s.byDataset[g.dataset] ||= { requests: 0, estGzBytes: 0, groups: 0 });
    d.requests += n; d.estGzBytes += n * per; d.groups += 1;
  }
  return s;
}
