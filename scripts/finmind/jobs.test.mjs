// 請求展開（日期×代號、只抓缺的、優先序、主佇列／空閒佇列）單元測試：node --test scripts/finmind/jobs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSpec } from './datasets.mjs';
import { MISSING_MEMBERS, phaseOf, defaultTo, monthChunks, groupKeys, requestFor, expandPlan, orderGroups, sampleDays, summarizePlan } from './jobs.mjs';

const DAYS = ['2022-12-29', '2022-12-30', '2023-01-03', '2023-01-04', '2023-03-15', '2024-06-14', '2026-10-06', '2026-10-07', '2026-10-08'];
const noneDone = () => ({ done: new Set(), final: false, status: null });

test('phaseOf：2023-01-01 以前歸空閒佇列', () => {
  assert.equal(phaseOf('2022-12-30'), 'idle');
  assert.equal(phaseOf('2023-01-03'), 'main');
  assert.equal(phaseOf(null), 'main');
});

test('defaultTo：最新交易日＝今天（台北）以前的最後一個交易日（今天的資料可能還沒齊）', () => {
  assert.equal(defaultTo(DAYS, '2026-10-08'), '2026-10-07');
  assert.equal(defaultTo(DAYS, '2026-10-09'), '2026-10-08');
});

test('monthChunks：依日曆月切段，邊界含頭含尾', () => {
  assert.deepEqual(monthChunks('2026-03-01', '2026-05-10'), [['2026-03-01', '2026-03-31'], ['2026-04-01', '2026-04-30'], ['2026-05-01', '2026-05-10']]);
});

test('groupKeys：market-day 依交易日、受 since 限制；range 一段；table 當天快照；PutProvision 的 end_date 延到隔年底', () => {
  const ctx = { days: DAYS, from: '2023-01-01', to: '2026-10-07', asOf: '2026-10-08' };
  assert.deepEqual(groupKeys(getSpec('TaiwanStockMarginMaintenance'), ctx).map(g => g.group), ['2023-01-03', '2023-01-04', '2023-03-15', '2024-06-14', '2026-10-06', '2026-10-07']);
  assert.deepEqual(groupKeys(getSpec('TaiwanStockActiveETFHolding'), ctx).map(g => g.group), ['2026-10-06', '2026-10-07']);
  assert.deepEqual(groupKeys(getSpec('TaiwanStockDispositionSecuritiesPeriod'), ctx), [{ group: 'range_2023-01-01_2026-10-07', date: null, phase: 'main', range: ['2023-01-01', '2026-10-07'] }]);
  assert.equal(groupKeys(getSpec('TaiwanStockConvertibleBondPutProvision'), ctx)[0].range[1], '2027-12-31');
  assert.deepEqual(groupKeys(getSpec('TaiwanStockIndustryChain'), ctx).map(g => g.group), ['snapshot_2026-10-08']);
  assert.deepEqual(groupKeys(getSpec('TaiwanStockSplitPrice'), ctx), [{ group: 'snapshot_2026-10-08', date: null, phase: 'main', range: ['2023-01-01', null] }]);
  assert.equal(groupKeys(getSpec('TaiwanOptionVix'), { ...ctx, from: '2026-03-01' }).length, 8);
  const wk = groupKeys(getSpec('TaiwanStockHoldingSharesPer'), { ...ctx, weeks: ['2022-12-30', '2023-01-06', '2026-10-02'] });
  assert.deepEqual(wk.map(g => [g.group, g.phase]), [['2023-01-06', 'main'], ['2026-10-02', 'main']]);
  assert.throws(() => groupKeys(getSpec('TaiwanStockHoldingSharesPer'), ctx), /週資料日/);
});

test('requestFor：各 mode 的參數；全市場不帶 end_date；分點用 date 參數與專屬 endpoint；token 絕不在參數裡', () => {
  const day = { group: '2026-10-07', date: '2026-10-07' };
  assert.deepEqual(requestFor(getSpec('TaiwanStockPriceLimit'), day, '*'), { endpoint: 'data', params: { dataset: 'TaiwanStockPriceLimit', start_date: '2026-10-07' } });
  assert.deepEqual(requestFor(getSpec('TaiwanStockKBar'), day, '2330'), { endpoint: 'data', params: { dataset: 'TaiwanStockKBar', data_id: '2330', start_date: '2026-10-07' } });
  assert.deepEqual(requestFor(getSpec('TaiwanStockTradingDailyReport'), day, '1020'), { endpoint: 'taiwan_stock_trading_daily_report', params: { securities_trader_id: '1020', date: '2026-10-07' } });
  assert.deepEqual(requestFor(getSpec('TaiwanStockTradingDailyReport'), day, '2330', { route: 'stock' }), { endpoint: 'taiwan_stock_trading_daily_report', params: { data_id: '2330', date: '2026-10-07' } });
  assert.deepEqual(requestFor(getSpec('TaiwanStockDispositionSecuritiesPeriod'), { group: 'range_a', range: ['2023-01-01', '2026-10-07'] }, '*').params,
    { dataset: 'TaiwanStockDispositionSecuritiesPeriod', start_date: '2023-01-01', end_date: '2026-10-07' });
  assert.deepEqual(requestFor(getSpec('TaiwanStockSplitPrice'), { group: 'snapshot_x', range: ['2023-01-01', null] }, '*').params, { dataset: 'TaiwanStockSplitPrice', start_date: '2023-01-01' });
  assert.deepEqual(requestFor(getSpec('TaiwanStockIndustryChain'), { group: 'snapshot_x' }, '*').params, { dataset: 'TaiwanStockIndustryChain' });
  assert.deepEqual(requestFor(getSpec('TaiwanStockHoldingSharesPer'), { group: '2026-10-02', date: '2026-10-02' }, '*').params, { dataset: 'TaiwanStockHoldingSharesPer', start_date: '2026-10-02' });
});

test('expandPlan：只排缺的；已完成的群組整個略過；部分完成只排剩下的代號', () => {
  const spec = getSpec('TaiwanStockKBar');
  const done = { '2026-10-07': { done: new Set(['2330']), final: false, status: 'partial' }, '2026-10-06': { done: new Set(['2330', '2603']), final: true, status: 'complete' } };
  const plan = expandPlan([spec], {
    days: DAYS, from: '2026-10-06', to: '2026-10-07', asOf: '2026-10-08',
    membersFor: () => ['2330', '2603'], doneFor: (s, g) => done[g] || noneDone(),
  });
  assert.deepEqual(plan.groups.map(g => [g.group, g.members]), [['2026-10-07', ['2603']]]);
  assert.equal(plan.groups[0].planned, 2);
});

test('expandPlan：單一成員群組（全市場單日）以狀態判斷；empty 預設不重抓、--retry-empty 才重抓；沒有清單的日子記入 skipped', () => {
  const spec = getSpec('TaiwanStockMarginMaintenance');
  const st = { '2026-10-07': { done: new Set(['*']), final: true, status: 'empty' } };
  const base = { days: DAYS, from: '2026-10-06', to: '2026-10-07', asOf: '2026-10-08', membersFor: () => ['*'], doneFor: (s, g) => st[g] || noneDone() };
  assert.deepEqual(expandPlan([spec], base).groups.map(g => g.group), ['2026-10-06']);
  assert.deepEqual(expandPlan([spec], { ...base, retryEmpty: true }).groups.map(g => g.group).sort(), ['2026-10-06', '2026-10-07']);
  const kbar = expandPlan([getSpec('TaiwanStockKBar')], { ...base, membersFor: (s, d) => (d === '2026-10-06' ? null : ['2330']) });
  assert.deepEqual(kbar.skipped, [{ dataset: 'TaiwanStockKBar', group: '2026-10-06', reason: MISSING_MEMBERS }]);
});

test('expandPlan：pre-2023 的群組標為 idle；main 一律排在 idle 前面', () => {
  const plan = expandPlan([getSpec('TaiwanStockMarginMaintenance')], { days: DAYS, from: '2022-12-01', to: '2023-01-04', asOf: '2026-10-08', membersFor: () => ['*'], doneFor: noneDone });
  assert.deepEqual(plan.groups.map(g => [g.group, g.phase]), [['2023-01-04', 'main'], ['2023-01-03', 'main'], ['2022-12-30', 'idle'], ['2022-12-29', 'idle']]);
});

test('orderGroups：recent-first（預設）／oldest-first；多資料集依 rank 依序，--interleave 改依日期交錯', () => {
  const g = (dataset, rank, date, phase = 'main') => ({ dataset, rank, date, group: date, phase, members: ['*'] });
  const gs = [g('B', 30, '2026-10-06'), g('A', 10, '2026-10-06'), g('A', 10, '2026-10-07'), g('B', 30, '2026-10-07'), g('A', 10, '2022-12-30', 'idle')];
  assert.deepEqual(orderGroups(gs, { priority: 'recent-first' }).map(x => `${x.dataset}${x.date.slice(-2)}`), ['A07', 'A06', 'B07', 'B06', 'A30']);
  assert.deepEqual(orderGroups(gs, { priority: 'recent-first', interleave: true }).map(x => `${x.dataset}${x.date.slice(-2)}`), ['A07', 'B07', 'A06', 'B06', 'A30']);
  assert.deepEqual(orderGroups(gs, { priority: 'oldest-first' }).map(x => `${x.dataset}${x.date.slice(-2)}`), ['A06', 'A07', 'B06', 'B07', 'A30']);
  assert.throws(() => orderGroups(gs, { priority: 'nope' }), /priority/);
});

test('sampleDays：在 [since, to] 內挑 2023-03-15 起第一天、中間一天、最後一天', () => {
  assert.deepEqual(sampleDays(DAYS, { from: '2023-01-01', to: '2026-10-07' }), ['2023-03-15', '2024-06-14', '2026-10-07']);
  assert.deepEqual(sampleDays(DAYS, { from: '2026-10-06', to: '2026-10-07' }), ['2026-10-06', '2026-10-07']);
});

test('summarizePlan：請求數、估計 gz 位元組、各 phase 分計', () => {
  const spec = getSpec('TaiwanStockKBar');
  const s = summarizePlan([{ dataset: spec.name, spec, phase: 'main', members: ['1', '2'] }, { dataset: spec.name, spec, phase: 'idle', members: ['1'] }]);
  assert.equal(s.requests, 3); assert.equal(s.byPhase.main, 2); assert.equal(s.byPhase.idle, 1);
  assert.equal(s.estGzBytes, 3 * spec.estGz);
  assert.equal(s.byDataset[spec.name].requests, 3);
});

test('expandPlan：成員都到齊但還沒收尾（收尾前被殺）→ 排一個只收尾的群組；--retry-empty 的空群組標 replace', () => {
  const spec = getSpec('TaiwanStockKBar');
  const st = { '2026-10-07': { done: new Set(['2330', '2603']), final: false, status: 'partial' } };
  const p = expandPlan([spec], { days: DAYS, from: '2026-10-07', to: '2026-10-07', asOf: '2026-10-08', membersFor: () => ['2330', '2603'], doneFor: (s, g) => st[g] || noneDone() });
  assert.deepEqual(p.groups.map(g => [g.group, g.members, g.finalizeOnly]), [['2026-10-07', [], true]]);
  const single = getSpec('TaiwanStockMarginMaintenance');
  const st2 = { '2026-10-07': { done: new Set(['*']), final: false, status: 'partial' }, '2026-10-06': { done: new Set(['*']), final: true, status: 'empty' } };
  const p2 = expandPlan([single], { days: DAYS, from: '2026-10-06', to: '2026-10-07', asOf: '2026-10-08', membersFor: () => null, doneFor: (s, g) => st2[g] || noneDone(), retryEmpty: true });
  assert.deepEqual(p2.groups.map(g => [g.group, g.members, !!g.finalizeOnly, !!g.replace]), [['2026-10-07', [], true, false], ['2026-10-06', ['*'], false, true]]);
});

test('groupKeys：起點早於 2023 的區間型資料集切成「2023 以前（idle，固定檔名）＋2023 起（main）」；起點參考價表另起一份 idle 快照', () => {
  const ctx = { days: DAYS, from: '1990-01-01', to: '2026-10-07', asOf: '2026-11-05' };
  assert.deepEqual(groupKeys(getSpec('TaiwanStockDispositionSecuritiesPeriod'), ctx), [
    { group: 'range_2001-01-01_2022-12-31', date: null, phase: 'idle', range: ['2001-01-01', '2022-12-31'] },
    { group: 'range_2023-01-01_2026-10-07', date: null, phase: 'main', range: ['2023-01-01', '2026-10-07'] }]);
  assert.deepEqual(groupKeys(getSpec('TaiwanStockConvertibleBondPutProvision'), ctx).map(g => [g.group, g.phase]),
    [['range_2011-06-22_2022-12-31', 'idle'], ['range_2023-01-01_2027-12-31', 'main']]);
  assert.deepEqual(groupKeys(getSpec('TaiwanStockDispositionSecuritiesPeriod'), { ...ctx, to: '2022-06-30' }).map(g => [g.group, g.phase]), [['range_2001-01-01_2022-06-30', 'idle']]);
  assert.deepEqual(groupKeys(getSpec('TaiwanStockParValueChange'), ctx), [
    { group: 'snapshot_2026-11-05_from_2020-01-01', date: null, phase: 'idle', range: ['2020-01-01', null] },
    { group: 'snapshot_2026-11-05', date: null, phase: 'main', range: ['2023-01-01', null] }]);
  const vix = groupKeys(getSpec('TaiwanOptionVix'), ctx);
  assert.ok(vix.every(g => g.phase === 'main') && vix[0].group === 'range_2026-03-01_2026-03-31', '月切段的資料集原本就在月界切開');
});

test('expandPlan：暫定群組（抓取日 ≤ 結算日）要重抓——當天晚上抓的當日資料、主動 ETF 持股（投信隔日才陸續揭露，settleDays 2）', () => {
  const fin = fetchedOn => ({ done: new Set(['*']), final: true, status: 'complete', fetchedOn });
  const ctx = (spec, st) => ({ days: DAYS, from: '2026-10-06', to: '2026-10-08', asOf: '2026-10-09', membersFor: () => null, doneFor: (s, g) => st[g] || noneDone() });
  const mm = getSpec('TaiwanStockMarginMaintenance');
  const p = expandPlan([mm], ctx(mm, { '2026-10-08': fin('2026-10-08'), '2026-10-07': fin('2026-10-08'), '2026-10-06': fin('2026-10-06') }));
  assert.deepEqual(p.groups.map(g => [g.group, g.members, !!g.replace]), [['2026-10-08', ['*'], true], ['2026-10-06', ['*'], true]], '當天抓的（10-08、10-06）重抓；隔天抓的 10-07 已結算');
  const etf = getSpec('TaiwanStockActiveETFHolding');
  assert.equal(etf.settleDays, 2);
  const q = expandPlan([etf], ctx(etf, { '2026-10-08': fin('2026-10-09'), '2026-10-07': fin('2026-10-08'), '2026-10-06': fin('2026-10-08') }));
  assert.deepEqual(q.groups.map(g => g.group), ['2026-10-08', '2026-10-07'], '10-07 的結算日是下一個交易日 10-08，10-08 抓的仍暫定；10-08 的結算日還沒到（交易日表外）');
  const none = expandPlan([mm], ctx(mm, { '2026-10-08': { ...fin(undefined) }, '2026-10-07': fin('2026-10-08'), '2026-10-06': fin('2026-10-07') }));
  assert.equal(none.groups.length, 0, '沒有抓取日資訊（舊檔）不判暫定');
});

test('expandPlan：區間群組抓取日不晚於區間終點＝暫定（賣回權時程 end＝明年底），下次重抓；終點已過的區間不重抓', () => {
  const fin = fetchedOn => ({ done: new Set(['*']), final: true, status: 'complete', fetchedOn });
  const put = getSpec('TaiwanStockConvertibleBondPutProvision');
  const ctx = st => ({ days: DAYS, from: '2023-01-01', to: '2026-10-08', asOf: '2026-10-09', membersFor: () => null, doneFor: (s, g) => st[g] || noneDone() });
  const p = expandPlan([put], ctx({ 'range_2023-01-01_2027-12-31': fin('2026-10-08') }));
  assert.deepEqual(p.groups.map(g => [g.group, !!g.replace]), [['range_2023-01-01_2027-12-31', true]]);
  const cap = getSpec('TaiwanStockCapitalReductionReferencePrice');
  const q = expandPlan([cap], { ...ctx({ 'range_2023-01-01_2026-10-08': fin('2026-10-09') }), from: '2023-01-01' });
  assert.equal(q.groups.length, 0, '10-09 抓的 2023-01-01～10-08 區間已定版');
});
