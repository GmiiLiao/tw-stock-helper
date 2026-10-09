// 回補 CLI（參數、抽樣計畫、空閒佇列與驗證閘門）單元測試：node --test scripts/finmind/backfill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { getSpec } from './datasets.mjs';
import { groupPaths, openGroup, appendMember, finalizeGroup } from './store.mjs';
import { parseArgs, approxWeeks, buildContext, planAll, applyGates, diskCheck, mainRemaining, exitCodeFor, brokerProbeDates, idleBrokers, idleBrokerSet, SAMPLE_MAX_REQUESTS } from './backfill.mjs';

const DAYS = ['2022-12-29', '2022-12-30', '2023-01-03', '2023-03-15', '2024-06-14', '2026-10-06', '2026-10-07', '2026-10-08'];
const STOCKS = Array.from({ length: 30 }, (_, i) => String(1101 + i));
const fakeLd = { tradingDays: () => DAYS, stocksFor: () => STOCKS, etfsFor: () => ['0050'], brokersFor: () => ['1001', '1020', '9A00'] };
const tmp = () => mkdtempSync(join(tmpdir(), 'fm-cli-'));

test('parseArgs：旗標、帶值參數、驗證', () => {
  const o = parseArgs(['--dataset', 'TaiwanStockKBar', '--from', '2023-01-01', '--max-requests', '100', '--codes', '2330, 2317', '--dry-run', '--window', 'idle']);
  assert.equal(o.dataset, 'TaiwanStockKBar'); assert.equal(o.maxRequests, 100); assert.deepEqual(o.codes, ['2330', '2317']); assert.equal(o.dryRun, true); assert.equal(o.window, 'idle');
  assert.equal(parseArgs(['--status']).window, 'main');
  assert.throws(() => parseArgs(['--dataset']), /缺值/);
  assert.throws(() => parseArgs(['--bogus']), /看不懂/);
  assert.throws(() => parseArgs(['--dataset', 'X', '--from', '2023/01/01']), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--dataset', 'X', '--window', 'night']), /window/);
  assert.throws(() => parseArgs(['--dataset', 'X', '--max-requests', '-1']), /正整數/);
  assert.throws(() => parseArgs(['--dataset', 'X', '--codes', '2330;rm']), /英數/);
  assert.throws(() => parseArgs([]), /--dataset 或 --status/);
});

test('approxWeeks：每週最後一個交易日', () => {
  assert.deepEqual(approxWeeks(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-12']), ['2026-10-08', '2026-10-12']);
});

test('buildContext：預設區間 2023-01-01～今天以前最後交易日；分點券商路線把 1020 排第一當探針；ETF 宇宙', () => {
  const ctx = buildContext({ dataset: 'x' }, fakeLd, tmp(), '2026-10-08');
  assert.equal(ctx.from, '2023-01-01'); assert.equal(ctx.to, '2026-10-07');
  assert.deepEqual(ctx.membersFor(getSpec('TaiwanStockTradingDailyReport'), '2026-10-07'), ['1020', '1001', '9A00']);
  assert.deepEqual(ctx.membersFor(getSpec('TaiwanFuturesKBar'), '2026-10-07'), ['TX', 'MTX', 'TMF']);
  const etf = buildContext({ dataset: 'x', universe: 'stocks+etf' }, fakeLd, tmp(), '2026-10-08');
  assert.equal(etf.membersFor(getSpec('TaiwanStockKBar'), '2026-10-07').at(-1), '0050');
  const stockRoute = buildContext({ dataset: 'x', route: 'stock' }, fakeLd, tmp(), '2026-10-08');
  assert.equal(stockRoute.membersFor(getSpec('TaiwanStockTradingDailyReport'), '2026-10-07').length, 30);
});

test('buildContext：快照群組以抓取日（台北今天）命名，不可是 snapshot_undefined（2026-10-08 試抓實測的缺陷）', () => {
  const root = tmp();
  const ctx = buildContext({ dataset: 'x' }, fakeLd, root, '2026-10-08');
  assert.equal(ctx.asOf, '2026-10-08');
  const p = planAll(['TaiwanSecuritiesTraderInfo', 'TaiwanStockSplitPrice'].map(getSpec), ctx, { dataset: 'x', root });
  assert.deepEqual(p.groups.map(g => g.group).sort(), ['snapshot_2026-10-08', 'snapshot_2026-10-08']);
});

test('planAll --sample：每資料集 3 個抽樣日；分 K 只抓抽樣股；分點改股票路線；TXO 逐筆只抓最新一天', () => {
  const root = tmp();
  const opts = { dataset: 'x', sample: true, root };
  const ctx = buildContext(opts, fakeLd, root, '2026-10-08');
  const p = planAll(['TaiwanStockKBar', 'TaiwanStockTradingDailyReport', 'TaiwanOptionTick', 'TaiwanStockMarginMaintenance'].map(getSpec), ctx, opts);
  const by = name => p.groups.filter(g => g.dataset === name);
  assert.deepEqual(by('TaiwanStockKBar').map(g => g.group), ['2023-03-15', '2024-06-14', '2026-10-07'].reverse());
  assert.deepEqual(by('TaiwanStockKBar')[0].members, ['2330', '6129', '2603']);
  assert.ok(by('TaiwanStockTradingDailyReport').every(g => g.route === 'stock' && g.members.join() === '2330,6129,2603'));
  assert.deepEqual(by('TaiwanOptionTick').map(g => [g.group, g.members.join()]), [['2026-10-07', 'TXO']]);
  assert.equal(by('TaiwanStockMarginMaintenance').length, 3);
});

test('applyGates：window=main 時 2023 以前的群組不跑；window=idle 但主佇列沒完成（且沒全部排進本次）也不跑', () => {
  const root = tmp();
  const spec = getSpec('TaiwanStockMarginMaintenance');
  const opts = { dataset: 'x', from: '2022-12-01', sample: false, root, window: 'main' };
  const ctx = buildContext(opts, fakeLd, root, '2026-10-08');
  const plan = planAll([spec], ctx, opts);
  assert.ok(plan.groups.some(g => g.phase === 'idle'));
  const g1 = applyGates(plan, [spec], ctx, opts, root);
  assert.ok(g1.groups.every(g => g.phase === 'main')); assert.match(g1.notes[0], /空閒佇列/);
  // --to 截在主佇列前段 ⇒ 剩下的 main 沒全部排進本次 ⇒ 2023 以前不跑
  const cut = { ...opts, window: 'idle', to: '2023-03-15' };
  const ctxCut = buildContext(cut, fakeLd, root, '2026-10-08');
  const g2 = applyGates(planAll([spec], ctxCut, cut), [spec], ctxCut, cut, root);
  assert.ok(g2.groups.every(g => g.phase === 'main')); assert.match(g2.notes[0], /主佇列（2023 起）還差 5 個/);
});

test('applyGates：window=idle 且主佇列剩下的全部排在本次前段 ⇒ 2023 以前的群組標 afterMain、排在 main 之後（runner 再確認 main 都收尾）', () => {
  const root = tmp();
  const spec = getSpec('TaiwanStockMarginMaintenance');
  const opts = { dataset: 'x', from: '2022-12-01', sample: false, root, window: 'idle' };
  const ctx = buildContext(opts, fakeLd, root, '2026-10-08');
  const gates = applyGates(planAll([spec], ctx, opts), [spec], ctx, opts, root);
  assert.deepEqual(gates.groups.map(g => `${g.phase}:${g.group}${g.afterMain ? '*' : ''}`),
    ['main:2026-10-07', 'main:2026-10-06', 'main:2024-06-14', 'main:2023-03-15', 'main:2023-01-03', 'idle:2022-12-30*', 'idle:2022-12-29*']);
  assert.match(gates.notes[0], /剩 5 個請求排在本次前段/);
});

test('applyGates：主佇列都完成後，idle 才放行；mainRemaining 以「今天以前最後交易日」為準，不受 --to 影響', () => {
  const root = tmp();
  const spec = getSpec('TaiwanStockMarginMaintenance');
  for (const d of ['2023-01-03', '2023-03-15', '2024-06-14', '2026-10-06', '2026-10-07']) {
    const g = openGroup(groupPaths(root, spec.name, d)); appendMember(g, '*', gzipSync(`{"date":"${d}"}\n`), 1); finalizeGroup(g);
  }
  const opts = { dataset: 'x', from: '2022-12-01', to: '2022-12-31', root, window: 'idle' };
  const ctx = buildContext(opts, fakeLd, root, '2026-10-08');
  assert.equal(mainRemaining(spec, ctx), 0);
  const gates = applyGates(planAll([spec], ctx, opts), [spec], ctx, opts, root);
  assert.deepEqual(gates.groups.map(g => g.group), ['2022-12-30', '2022-12-29']);
  const ctx2 = buildContext({ ...opts, to: '2022-12-31' }, { ...fakeLd, tradingDays: () => [...DAYS, '2026-10-09'] }, root, '2026-10-10');
  assert.equal(mainRemaining(spec, ctx2), 2, '新的交易日（10-08、10-09）還沒抓 ⇒ 主佇列沒完成');
});

test('applyGates：未通過驗證的資料集超過抽樣上限就擋；--sample 不擋；通過驗證後放行', () => {
  const root = tmp();
  const spec = getSpec('TaiwanStockKBar');
  const opts = { dataset: 'x', root, window: 'main' };
  const ctx = buildContext(opts, fakeLd, root, '2026-10-08');
  const plan = planAll([spec], ctx, opts);
  assert.ok(plan.groups.reduce((n, g) => n + g.members.length, 0) > SAMPLE_MAX_REQUESTS);
  const g1 = applyGates(plan, [spec], ctx, opts, root);
  assert.equal(g1.groups.length, 0); assert.match(g1.refused[0], /尚未通過驗證/);
  mkdirSync(join(root, spec.name), { recursive: true });
  writeFileSync(join(root, spec.name, '_validation.json'), JSON.stringify({ status: 'pass' }));
  assert.equal(applyGates(plan, [spec], ctx, opts, root).groups.length, plan.groups.length);
  const small = applyGates(planAll([spec], ctx, { ...opts, sample: true }), [spec], ctx, { ...opts, sample: true }, tmp());
  assert.equal(small.refused.length, 0);
});

test('diskCheck：回報剩餘與需求（估 gz ×1.5＋20GB 保留）', () => {
  const d = diskCheck(join(tmp(), 'not', 'yet'), 1e9);
  assert.equal(d.need, 1.5e9 + 20e9); assert.ok(d.free > 0); assert.equal(typeof d.ok, 'boolean');
});

test('weeksFor：已存的週資料日要涵蓋本次起點（2023 起的 _weeks.json 不能拿來排 2023 以前的空閒佇列 ⇒ 要重新 discover）', () => {
  const root = tmp();
  const spec = getSpec('TaiwanStockHoldingSharesPer');
  mkdirSync(join(root, spec.name), { recursive: true });
  writeFileSync(join(root, spec.name, '_weeks.json'), JSON.stringify({ from: '2023-01-01', to: '2026-10-07', dates: ['2023-03-17', '2026-10-02'] }));
  const main = buildContext({ dataset: 'x' }, fakeLd, root, '2026-10-08');
  assert.deepEqual(main.weeksFor(spec), ['2023-03-17', '2026-10-02']);
  const idle = buildContext({ dataset: 'x', from: '2010-01-01', window: 'idle' }, fakeLd, root, '2026-10-08');
  assert.equal(idle.weeksFor(spec), undefined, '起點早於已存範圍 ⇒ 交給 discoverWeeks 重查');
  const dry = buildContext({ dataset: 'x', from: '2010-01-01', dryRun: true }, fakeLd, root, '2026-10-08');
  assert.ok(Array.isArray(dry.weeksFor(spec)), 'dry-run 用估計值');
});

test('exitCodeFor：done／max-requests＝0；SIGTERM 收尾＝4（串接 && 時下一步不會自動開跑）；其他停止原因＝1', () => {
  assert.equal(exitCodeFor('done'), 0); assert.equal(exitCodeFor('max-requests'), 0);
  assert.equal(exitCodeFor('signal'), 4);
  assert.equal(exitCodeFor('consecutive-errors：連續 5 次失敗'), 1); assert.equal(exitCodeFor('auth：HTTP 403'), 1);
});

test('brokerProbeDates：每年 1 月、7 月第一個交易日＋區間最後一日（分點停業券商探針日）', () => {
  const days = ['2022-12-30', '2023-01-03', '2023-01-04', '2023-07-03', '2023-07-04', '2024-01-02', '2024-07-01', '2025-01-02', '2026-10-07', '2026-10-08'];
  assert.deepEqual(brokerProbeDates(days, '2023-01-01', '2026-10-08'), ['2023-01-03', '2023-07-03', '2024-01-02', '2024-07-01', '2025-01-02', '2026-10-08']);
  assert.deepEqual(brokerProbeDates(days, '2023-01-01', '2026-10-07'), ['2023-01-03', '2023-07-03', '2024-01-02', '2024-07-01', '2025-01-02', '2026-10-07']);
});

test('--skip-idle-brokers：探針日（≥4 個已收尾）全部 0 列的券商，只在探針日區間內略過；探針不足或區間外照抓', () => {
  const root = tmp();
  const spec = getSpec('TaiwanStockTradingDailyReport');
  const days = ['2022-12-30', '2023-01-03', '2023-03-15', '2023-07-03', '2024-01-02', '2024-06-14', '2024-07-01', '2026-10-07'];
  const ld = { ...fakeLd, tradingDays: () => days, brokersFor: () => ['1020', '1001', '9A00', '5555'] };
  const probe = (d, rowsBy) => { const g = openGroup(groupPaths(root, spec.name, d)); for (const [m, n] of Object.entries(rowsBy)) appendMember(g, m, n ? gzipSync(`{"date":"${d}"}\n`) : null, n); finalizeGroup(g); };
  for (const d of ['2023-01-03', '2023-07-03', '2024-01-02']) probe(d, { 1020: 5, 1001: 0, '9A00': 3, 5555: 0 });
  const opts = { dataset: 'x', root, skipIdleBrokers: true };
  const few = buildContext(opts, ld, root, '2026-10-08');
  assert.deepEqual(few.membersFor(spec, '2023-03-15'), ['1020', '1001', '9A00', '5555'], '只有 3 個探針 ⇒ 不略過');
  probe('2024-07-01', { 1020: 5, 1001: 0, '9A00': 0, 5555: 2 });
  probe('2026-10-07', { 1020: 5, 1001: 0, '9A00': 0, 5555: 0 });
  const ctx = buildContext(opts, ld, root, '2026-10-08');
  assert.deepEqual(ctx.idleBrokers.ids, ['1001'], '5555 在 2024-07-01 有成交 ⇒ 不算閒置；9A00 早期有成交 ⇒ 不算');
  assert.deepEqual(ctx.membersFor(spec, '2024-06-14'), ['1020', '9A00', '5555']);
  assert.deepEqual(ctx.membersFor(spec, '2022-12-30'), ['1020', '1001', '9A00', '5555'], '探針區間外（2023 以前）照抓');
  assert.deepEqual(buildContext({ dataset: 'x', root }, ld, root, '2026-10-08').membersFor(spec, '2024-06-14').length, 4, '沒帶旗標 ⇒ 全部券商');
});

test('--skip-idle-brokers：探針日本身永遠排全部券商（暫定群組重抓不可把閒置判定的證據抓掉）；閒置集合只用在分點資料表', () => {
  const root = tmp();
  const spec = getSpec('TaiwanStockTradingDailyReport');
  const days = ['2023-01-03', '2023-03-15', '2023-07-03', '2024-01-02', '2024-06-14', '2024-07-01', '2026-10-07'];
  const all = ['1020', '1001', '9A00', '5555'];
  const ld = { ...fakeLd, tradingDays: () => days, brokersFor: () => all };
  const probe = (d, rowsBy) => { const g = openGroup(groupPaths(root, spec.name, d)); for (const [m, n] of Object.entries(rowsBy)) appendMember(g, m, n ? gzipSync(`{"date":"${d}"}\n`) : null, n); finalizeGroup(g); };
  for (const d of ['2023-01-03', '2023-07-03', '2024-01-02', '2024-07-01', '2026-10-07']) probe(d, { 1020: 5, 1001: 0, '9A00': 3, 5555: 2 });
  const ctx = buildContext({ dataset: 'x', root, skipIdleBrokers: true }, ld, root, '2026-10-08');
  assert.deepEqual(ctx.idleBrokers.ids, ['1001']);
  assert.deepEqual(ctx.membersFor(spec, '2024-06-14'), ['1020', '9A00', '5555'], '區間內非探針日 ⇒ 略過閒置');
  assert.deepEqual(ctx.membersFor(spec, '2024-07-01'), all, '探針日 ⇒ 全部券商（重抓時不可漏掉閒置券商，否則下次判定失去證據）');
  assert.deepEqual(ctx.membersFor(spec, '2026-10-07'), all, '最後一個探針日（常是暫定群組、會被重抓）⇒ 全部券商');
  assert.deepEqual(ctx.membersFor(getSpec('TaiwanStockWarrantTradingDailyReport'), '2024-06-14'), all, '閒置集合由分點資料表算出，不套到其他券商路線資料集');
});

test('planAll --probe-brokers：分點只排探針日；其他資料集照常', () => {
  const root = tmp();
  const days = ['2023-01-03', '2023-03-15', '2023-07-03', '2024-01-02', '2026-10-07'];
  const ld = { ...fakeLd, tradingDays: () => days };
  const opts = { dataset: 'x', root, probeBrokers: true };
  const ctx = buildContext(opts, ld, root, '2026-10-08');
  const p = planAll(['TaiwanStockTradingDailyReport', 'TaiwanStockMarginMaintenance'].map(getSpec), ctx, opts);
  assert.deepEqual(p.groups.filter(g => g.dataset === 'TaiwanStockTradingDailyReport').map(g => g.group), ['2026-10-07', '2024-01-02', '2023-07-03', '2023-01-03']);
  assert.equal(p.groups.filter(g => g.dataset === 'TaiwanStockMarginMaintenance').length, 5);
});

test('idleBrokers：探針日全 0 列、但探針區間內其他已抓日有成交的券商不算閒置（2026-10-09 實測：9279 凱基-忠孝 09-29 設立，探針全 0、09-30 起有成交）', () => {
  const root = tmp();
  const spec = getSpec('TaiwanStockTradingDailyReport');
  const day = (d, rowsBy) => { const g = openGroup(groupPaths(root, spec.name, d)); for (const [m, n] of Object.entries(rowsBy)) appendMember(g, m, n ? gzipSync(`{"date":"${d}"}\n`) : null, n); finalizeGroup(g); };
  const probes = ['2023-01-03', '2023-07-03', '2024-01-02', '2024-07-01'];
  for (const d of probes) day(d, { 1020: 5, 1001: 0, 5555: 0, 7777: 0 });
  day('2024-03-15', { 1020: 5, 1001: 0, 5555: 2, 7777: 0 });   // 區間內、非探針：5555 有成交 ⇒ 排除
  day('2022-12-30', { 1020: 5, 1001: 9, 5555: 0, 7777: 0 });   // 區間外（略過只在探針區間內生效）⇒ 不當佐證
  const r = idleBrokers(root, spec, probes, { evidenceDays: ['2022-12-30', '2024-03-15', '2024-07-01'] });
  assert.deepEqual(r.ids, ['1001', '7777']);
  assert.deepEqual(r.excluded, [{ id: '5555', dates: ['2024-03-15'] }]);
  assert.deepEqual([r.from, r.to], ['2023-01-03', '2024-07-01']);
  assert.deepEqual(idleBrokers(root, spec, probes).ids, ['1001', '5555', '7777'], '沒給佐證日＝只看探針（舊行為）');
});

test('idleBrokerSet：探針＝2023 起每年 1／7 月首個交易日＋今天以前最後交易日；佐證＝其他交易日；holdOut 的日子不當佐證（稽核日留作檢驗）', () => {
  const root = tmp();
  const spec = getSpec('TaiwanStockTradingDailyReport');
  const days = ['2022-12-30', '2023-01-03', '2023-07-03', '2024-01-02', '2024-03-15', '2024-07-01', '2024-10-08', '2025-01-02'];
  const day = (d, rowsBy) => { const g = openGroup(groupPaths(root, spec.name, d)); for (const [m, n] of Object.entries(rowsBy)) appendMember(g, m, n ? gzipSync(`{"date":"${d}"}\n`) : null, n); finalizeGroup(g); };
  for (const d of ['2023-01-03', '2023-07-03', '2024-01-02', '2024-07-01', '2025-01-02']) day(d, { 1020: 5, 1001: 0, 5555: 0 });
  day('2024-10-08', { 1020: 5, 1001: 0, 5555: 3 });
  const all = idleBrokerSet(root, days, '2025-01-03');
  assert.deepEqual(all.probes, ['2023-01-03', '2023-07-03', '2024-01-02', '2024-07-01', '2025-01-02']);
  assert.deepEqual(all.ids, ['1001'], '5555 在 2024-10-08 有成交 ⇒ 不略過');
  const held = idleBrokerSet(root, days, '2025-01-03', { holdOut: ['2024-10-08'] });
  assert.deepEqual(held.ids, ['1001', '5555'], '稽核日不當佐證 ⇒ 5555 仍是候選，稽核才抓得到它');
  const ctx = buildContext({ dataset: 'x', root, skipIdleBrokers: true }, { ...fakeLd, tradingDays: () => days, brokersFor: () => ['1020', '1001', '5555'] }, root, '2025-01-03');
  assert.deepEqual(ctx.idleBrokers.ids, all.ids, '--skip-idle-brokers 與 idleBrokerSet 同一口徑');
  assert.deepEqual(ctx.membersFor(spec, '2024-03-15'), ['1020', '5555']);
});
