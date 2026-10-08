// 下載執行器（假用戶端，不打網路）單元測試：node --test scripts/finmind/runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSpec } from './datasets.mjs';
import { expandPlan } from './jobs.mjs';
import { groupPaths, readDone, readGroupRows, readJson } from './store.mjs';
import { runPlan, variantOf, expectDate } from './runner.mjs';
import { FinMindError } from './client.mjs';

const DAYS = ['2023-03-15', '2026-10-06', '2026-10-07'];
const tmp = () => mkdtempSync(join(tmpdir(), 'fm-run-'));
const tpe = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

function plan(root, names, o = {}) {
  return expandPlan(names.map(getSpec), {
    days: DAYS, from: '2023-01-01', to: '2026-10-07', asOf: '2026-10-08',
    membersFor: () => ['2330', '6129'],
    doneFor: (spec, group) => readDone(groupPaths(root, spec.name, group)),
    ...o,
  }).groups;
}

function fakeClient(responder, info = { ok: true, level: 3, info: { user_count: 10, api_request_limit_hour: 6000 } }) {
  const calls = []; const infoCalls = [];
  return {
    calls, infoCalls,
    async fetchRows(job, makeSink) {
      calls.push(job);
      const out = await responder(job, calls.length);
      if (out instanceof Error) throw out;
      const sink = makeSink();
      if (out.length) await sink.write(out.map(r => JSON.stringify(r)));
      const result = await sink.end({ rows: out.length });
      return { http: 200, rows: out.length, result, attempt: 1 };
    },
    async userInfo() { infoCalls.push(1); return typeof info === 'function' ? info(infoCalls.length) : info; },
  };
}

const rowsFor = job => [{ date: job.params.start_date || job.params.date, stock_id: job.params.data_id || 'x', v: 1 }];
const base = (root, o = {}) => ({ root, now: () => tpe(2026, 10, 8, 20), todayIso: '2026-10-08', sleep: async () => {}, windowOpts: { isHoliday: () => false, busyWindows: [] }, ...o });

test('端對端：全市場單日＋分 K 兩檔，全部成功 → 正式檔、索引、_coverage 都寫好', async () => {
  const root = tmp();
  const groups = plan(root, ['TaiwanStockMarginMaintenance', 'TaiwanStockKBar']);
  const c = fakeClient(job => rowsFor(job));
  const s = await runPlan({ ...base(root), groups, client: c });
  assert.equal(s.stopReason, 'done');
  assert.equal(s.requests, 3 + 3 * 2);
  assert.equal(s.groupsFinalized, 6);
  const p = groupPaths(root, 'TaiwanStockKBar', '2026-10-07');
  assert.ok(existsSync(p.final));
  assert.deepEqual(readGroupRows(p).map(r => r.stock_id), ['2330', '6129']);
  const cov = readJson(join(root, 'TaiwanStockKBar', '_coverage.json'));
  assert.equal(cov.groups['2026-10-07'].status, 'complete');
  assert.equal(cov.summary.complete, 3);
  assert.deepEqual(cov.cols, ['date', 'stock_id', 'v']);
  assert.match(cov.source, /FinMind（第三方轉載官方）·研究用·不上站/);
  assert.equal(plan(root, ['TaiwanStockMarginMaintenance', 'TaiwanStockKBar']).length, 0, '再規劃一次：全部完成、沒有要抓的');
});

test('回聲驗證：回應的 date 不是請求日 → 不落地、記失敗、群組不收尾', async () => {
  const root = tmp();
  const groups = plan(root, ['TaiwanStockMarginMaintenance']).filter(g => g.group === '2023-03-15');
  const c = fakeClient(() => [{ date: '2023-03-14', stock_id: '2330' }]);
  const s = await runPlan({ ...base(root), groups, client: c });
  assert.equal(s.failures, 1);
  const p = groupPaths(root, 'TaiwanStockMarginMaintenance', '2023-03-15');
  assert.ok(!existsSync(p.final));
  const cov = readJson(join(root, 'TaiwanStockMarginMaintenance', '_coverage.json'));
  assert.equal(cov.failures['2023-03-15|*'].kind, 'echo');
});

test('連續失敗達上限就停；期間已成功的成員留在 .part 供續抓', async () => {
  const root = tmp();
  const groups = plan(root, ['TaiwanStockKBar'], { membersFor: () => ['2330', 'A', 'B', 'C'] });
  const c = fakeClient(job => (job.params.data_id === '2330' ? rowsFor(job) : new FinMindError('server', 'HTTP 503')));
  const s = await runPlan({ ...base(root), groups, client: c, maxConsecutiveFailures: 3 });
  assert.match(s.stopReason, /^consecutive-errors/);
  const st = readDone(groupPaths(root, 'TaiwanStockKBar', '2026-10-07'));
  assert.equal(st.final, false); assert.deepEqual([...st.done], ['2330']);
});

test('近日第一個請求 0 列 → 視為 FinMind 尚未更新，不落地；舊日 0 列 → 收尾為 empty', async () => {
  const root = tmp();
  const groups = plan(root, ['TaiwanStockMarginMaintenance']);
  const c = fakeClient(() => []);
  const s = await runPlan({ ...base(root), groups, client: c });
  assert.deepEqual(s.notPublished.sort(), ['TaiwanStockMarginMaintenance/2026-10-06', 'TaiwanStockMarginMaintenance/2026-10-07']);
  assert.equal(readDone(groupPaths(root, 'TaiwanStockMarginMaintenance', '2026-10-07')).status, null);
  assert.equal(readDone(groupPaths(root, 'TaiwanStockMarginMaintenance', '2023-03-15')).status, 'empty');
});

test('402：等額度（user_info 降到 90% 以下）後重試同一個請求', async () => {
  const root = tmp();
  const groups = plan(root, ['TaiwanStockMarginMaintenance']).slice(0, 1);
  const c = fakeClient((job, n) => (n === 1 ? new FinMindError('quota', 'HTTP 402') : rowsFor(job)),
    k => ({ ok: true, level: 3, info: { user_count: k === 1 ? 5900 : 100, api_request_limit_hour: 6000 } }));
  const s = await runPlan({ ...base(root), groups, client: c, quotaWaitMs: 1 });
  assert.equal(s.stopReason, 'done'); assert.equal(c.calls.length, 2); assert.equal(c.infoCalls.length, 2);
  assert.equal(s.groupsFinalized, 1);
});

test('403（auth）立即停，不再發下一個請求', async () => {
  const root = tmp();
  const groups = plan(root, ['TaiwanStockMarginMaintenance']);
  const c = fakeClient(() => new FinMindError('auth', 'HTTP 403：forbidden'));
  const s = await runPlan({ ...base(root), groups, client: c });
  assert.match(s.stopReason, /^auth/); assert.equal(c.calls.length, 1);
});

test('--max-requests：達上限停；再跑一次只排剩下的（續抓）', async () => {
  const root = tmp();
  const c = fakeClient(job => rowsFor(job));
  const s1 = await runPlan({ ...base(root), groups: plan(root, ['TaiwanStockKBar']), client: c, maxRequests: 3 });
  assert.equal(s1.stopReason, 'max-requests'); assert.equal(s1.requests, 3);
  const rest = plan(root, ['TaiwanStockKBar']);
  assert.equal(rest.reduce((n, g) => n + g.members.length, 0), 3);
  const s2 = await runPlan({ ...base(root), groups: rest, client: c });
  assert.equal(s2.stopReason, 'done');
  assert.equal(plan(root, ['TaiwanStockKBar']).length, 0);
});

test('idle 窗：平日盤中先睡到 15:30 再抓（時鐘隨 sleep 前進）', async () => {
  const root = tmp();
  let t = tpe(2026, 10, 8, 10, 0);
  const slept = []; const logs = [];
  const c = fakeClient(job => rowsFor(job));
  const s = await runPlan({ ...base(root), groups: plan(root, ['TaiwanStockMarginMaintenance']).slice(0, 1), client: c, window: 'idle',
    now: () => t, sleep: async ms => { slept.push(ms); t += ms; }, log: e => logs.push(e) });
  assert.equal(s.stopReason, 'done');
  assert.equal(slept.reduce((a, b) => a + b, 0), 5.5 * 3600e3);
  assert.ok(logs.some(e => e.type === 'pause' && /idle/.test(e.reason)));
});

test('停止訊號：已中止就不發任何請求；額度監看發現等級掉到 Sponsor 以下就停', async () => {
  const root = tmp();
  const ac = new AbortController(); ac.abort();
  const c = fakeClient(job => rowsFor(job));
  const s = await runPlan({ ...base(root), groups: plan(root, ['TaiwanStockMarginMaintenance']), client: c, stopSignal: ac.signal });
  assert.equal(s.stopReason, 'signal'); assert.equal(c.calls.length, 0);
  const c2 = fakeClient(job => rowsFor(job), { ok: true, level: 2, info: { user_count: 1, api_request_limit_hour: 600 } });
  const s2 = await runPlan({ ...base(root), groups: plan(root, ['TaiwanStockMarginMaintenance']), client: c2, monitorEvery: 1 });
  assert.match(s2.stopReason, /^level/); assert.equal(c2.calls.length, 1);
});

test('variantOf／expectDate：股票路線的分點另存 by-stock；區間群組的回聲檢查', () => {
  const spec = getSpec('TaiwanStockTradingDailyReport');
  assert.equal(variantOf({ spec, route: 'stock' }), 'by-stock');
  assert.equal(variantOf({ spec, route: 'broker' }), null);
  const ok = expectDate({ range: ['2023-01-01', '2026-10-07'] });
  assert.equal(ok('2026-10-07'), true); assert.equal(ok('2026-10-08'), false);
  assert.equal(expectDate({ range: ['2023-01-01', null] })('2099-01-01'), true);
});

test('只收尾的群組：成員都在 .part 裡 → 不發請求直接收尾；--retry-empty 的空群組先搬到 _superseded 再抓', async () => {
  const { openGroup, appendMember, closeGroup, finalizeGroup } = await import('./store.mjs');
  const { gzipSync } = await import('node:zlib');
  const root = tmp();
  const p = groupPaths(root, 'TaiwanStockMarginMaintenance', '2023-03-15');
  const g = openGroup(p); appendMember(g, '*', gzipSync('{"date":"2023-03-15"}\n'), 1); closeGroup(g);   // 收尾前被殺
  const p2 = groupPaths(root, 'TaiwanStockMarginMaintenance', '2026-10-06');
  const g2 = openGroup(p2); appendMember(g2, '*', null, 0); finalizeGroup(g2);   // 舊的空群組
  const c = fakeClient(job => rowsFor(job));
  const groups = plan(root, ['TaiwanStockMarginMaintenance'], { retryEmpty: true });
  const s = await runPlan({ ...base(root), groups, client: c });
  assert.equal(s.stopReason, 'done');
  assert.deepEqual(c.calls.map(j => j.params.start_date).sort(), ['2026-10-06', '2026-10-07']);
  assert.equal(readDone(p).status, 'complete');
  assert.equal(readDone(p2).status, 'complete');
  assert.equal(readGroupRows(p2).length, 1);
  // 被取代的舊檔不刪：搬到 <年>/_superseded/（之後要比對新舊版或還原都還在）
  const { readdirSync } = await import('node:fs');
  const moved = readdirSync(join(p2.dir, '_superseded'));
  assert.equal(moved.filter(f => f.startsWith('2026-10-06.superseded-') && f.endsWith('.jsonl.gz')).length, 1);
  assert.equal(moved.filter(f => f.endsWith('.idx.tsv')).length, 1);
});

test('整條鏈（真用戶端＋假 fetch → 執行器 → 落地＋請求記錄）：任何落地檔與記錄都找不到 token 或末 8 碼', async () => {
  const { createFinMindClient } = await import('./client.mjs');
  const { createRequestLog } = await import('./reqlog.mjs');
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { gunzipSync } = await import('node:zlib');
  const TOKEN = 'eyFAKEe2etokenxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxE2ETAIL8';
  const root = tmp();
  const logPath = join(root, '..', `${root.split('/').pop()}-requests.log`);
  const enc = new TextEncoder();
  const fetchImpl = async url => {
    const u = new URL(url); const d = u.searchParams.get('start_date'); const id = u.searchParams.get('data_id');
    if (id === '6129') return { status: 400, text: async () => JSON.stringify({ msg: `bad id ${TOKEN}`, status: 400, token_tail: TOKEN.slice(-8) }) };
    const body = JSON.stringify({ msg: 'success', status: 200, data: [{ date: d, minute: '09:00:00', stock_id: id, open: 1, high: 1, low: 1, close: 1, volume: 1 }] });
    const bytes = enc.encode(body);
    return { status: 200, body: (async function* () { for (let i = 0; i < bytes.length; i += 9) yield bytes.subarray(i, i + 9); })() };
  };
  const reqlog = createRequestLog(logPath, { secrets: [TOKEN], batch: 1 });
  const client = createFinMindClient({ token: TOKEN, fetchImpl, sleep: async () => {}, log: r => reqlog.write(r), retry: { server: [], rate: [] } });
  const groups = plan(root, ['TaiwanStockKBar']);
  const s = await runPlan({ ...base(root), groups, client });
  reqlog.flush();
  assert.equal(s.failures, 3); assert.equal(s.members, 3);
  const files = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
  walk(root); files.push(logPath);
  assert.ok(files.length > 5);
  for (const f of files) {
    const raw = readFileSync(f);
    const text = f.endsWith('.gz') ? gunzipSync(raw).toString() : raw.toString();
    assert.ok(!text.includes(TOKEN) && !text.includes(TOKEN.slice(-8)), `token 外洩：${f}`);
  }
  assert.match(readFileSync(logPath, 'utf8'), /"http":400/);
});

test('續抓已有資料的近日群組：第一個請求 0 列不算「尚未更新」，照常落地；同一請求連續 402 超過 3 次就停', async () => {
  const { openGroup, appendMember, closeGroup } = await import('./store.mjs');
  const { gzipSync } = await import('node:zlib');
  const root = tmp();
  const p = groupPaths(root, 'TaiwanStockKBar', '2026-10-07');
  const g = openGroup(p); appendMember(g, '2330', gzipSync('{"date":"2026-10-07"}\n'), 1); closeGroup(g);
  const groups = plan(root, ['TaiwanStockKBar'], { from: '2026-10-07' });
  assert.deepEqual(groups[0].members, ['6129']);
  const s = await runPlan({ ...base(root), groups, client: fakeClient(() => []) });
  assert.equal(s.notPublished.length, 0); assert.equal(readDone(p).status, 'complete');
  const c = fakeClient(() => new FinMindError('quota', 'HTTP 402'), { ok: true, level: 3, info: { user_count: 1, api_request_limit_hour: 6000 } });
  const s2 = await runPlan({ ...base(tmp()), groups: plan(tmp(), ['TaiwanStockMarginMaintenance']).slice(0, 1), client: c, quotaWaitMs: 1 });
  assert.match(s2.stopReason, /^quota/); assert.equal(c.calls.length, 4);
});

test('afterMain：同一資料集本次 main 群組都收尾才跑 2023 以前；有 main 沒收尾（失敗）就整批留到下次，其他資料集不受影響', async () => {
  const root = tmp();
  const days = ['2022-12-30', ...DAYS];
  const groups = plan(root, ['TaiwanStockMarginMaintenance', 'TaiwanStockPriceLimit'], { days, from: '2022-12-01' })
    .map(g => (g.phase === 'idle' ? { ...g, afterMain: true } : g));
  assert.deepEqual(groups.filter(g => g.phase === 'idle').map(g => `${g.dataset}/${g.group}`).sort(), ['TaiwanStockMarginMaintenance/2022-12-30', 'TaiwanStockPriceLimit/2022-12-30']);
  const failDay = '2026-10-06';
  const c = fakeClient(job => (job.params.dataset === 'TaiwanStockMarginMaintenance' && job.params.start_date === failDay ? new FinMindError('server', 'HTTP 503') : rowsFor(job)));
  const logs = [];
  const s = await runPlan({ ...base(root), groups, client: c, log: e => logs.push(e) });
  assert.equal(s.stopReason, 'done');
  const asked = c.calls.map(j => `${j.params.dataset}/${j.params.start_date}`);
  assert.ok(!asked.includes('TaiwanStockMarginMaintenance/2022-12-30'), 'main 有失敗 ⇒ 該資料集 2023 以前不跑');
  assert.ok(asked.includes('TaiwanStockPriceLimit/2022-12-30'), '另一個資料集 main 全收尾 ⇒ 照跑');
  assert.ok(asked.indexOf('TaiwanStockPriceLimit/2022-12-30') > asked.indexOf('TaiwanStockPriceLimit/2023-03-15'), 'idle 排在 main 之後');
  assert.deepEqual(s.heldBack, { TaiwanStockMarginMaintenance: 1 });
  assert.ok(logs.some(e => e.type === 'skip' && /TaiwanStockMarginMaintenance.*2023 以前的 1 個群組先不跑/.test(e.reason)));
  assert.equal(existsSync(groupPaths(root, 'TaiwanStockMarginMaintenance', '2022-12-30').final), false);
  assert.equal(existsSync(groupPaths(root, 'TaiwanStockPriceLimit', '2022-12-30').final), true);
});

test('重資料集（spec.heavy）：平日盤中 10:00 先睡到 13:45 才抓；輕資料集同時段不等', async () => {
  assert.equal(getSpec('TaiwanOptionTick').heavy, true);
  assert.equal(getSpec('TaiwanStockKBar').heavy, false);
  const run = async (name) => {
    const root = tmp();
    let t = tpe(2026, 10, 8, 10, 0);
    const slept = []; const logs = [];
    const c = fakeClient(job => rowsFor(job));
    const groups = plan(root, [name], { membersFor: () => ['TXO'] }).slice(0, 1);
    const s = await runPlan({ ...base(root), groups, client: c, now: () => t, sleep: async ms => { slept.push(ms); t += ms; }, log: e => logs.push(e) });
    return { s, slept: slept.reduce((a, b) => a + b, 0), logs, calls: c.calls.length };
  };
  const h = await run('TaiwanOptionTick');
  assert.equal(h.s.stopReason, 'done'); assert.equal(h.calls, 1);
  assert.equal(h.slept, 3.75 * 3600e3);
  assert.ok(h.logs.some(e => e.type === 'pause' && /重資料集/.test(e.reason)));
  const l = await run('TaiwanFuturesKBar');
  assert.equal(l.s.stopReason, 'done'); assert.equal(l.slept, 0);
});

test('區間群組：新區間（同起點、終點較晚）收尾後，舊區間檔（含 .part）搬到 _superseded/，coverage 只留新的——合併讀不會重複', async () => {
  const { openGroup, appendMember, closeGroup, finalizeGroup } = await import('./store.mjs');
  const { gzipSync } = await import('node:zlib');
  const { readdirSync } = await import('node:fs');
  const root = tmp();
  const ds = 'TaiwanStockCapitalReductionReferencePrice';
  const old = groupPaths(root, ds, 'range_2023-01-01_2026-10-06');
  const g1 = openGroup(old); appendMember(g1, '*', gzipSync('{"date":"2023-02-13"}\n'), 1); finalizeGroup(g1);
  const older = groupPaths(root, ds, 'range_2023-01-01_2026-10-05');
  const g0 = openGroup(older); closeGroup(g0);   // 沒收尾的舊 .part
  const other = groupPaths(root, ds, 'range_2011-01-01_2022-12-31');
  const g2 = openGroup(other); appendMember(g2, '*', gzipSync('{"date":"2012-01-01"}\n'), 1); finalizeGroup(g2);   // 不同起點（空閒佇列）不動
  const groups = expandPlan([getSpec(ds)], { days: DAYS, from: '2023-01-01', to: '2026-10-07', asOf: '2026-10-08', membersFor: () => null,
    doneFor: (spec, group) => readDone(groupPaths(root, spec.name, group)) }).groups;
  assert.deepEqual(groups.map(g => g.group), ['range_2023-01-01_2026-10-07']);
  const s = await runPlan({ ...base(root), groups, client: fakeClient(() => [{ date: '2023-02-13', stock_id: '1101' }]) });
  assert.equal(s.stopReason, 'done');
  const left = readdirSync(join(root, ds)).filter(f => f.endsWith('.jsonl.gz')).sort();
  assert.deepEqual(left, ['range_2011-01-01_2022-12-31.jsonl.gz', 'range_2023-01-01_2026-10-07.jsonl.gz']);
  const moved = readdirSync(join(root, ds, '_superseded'));
  assert.equal(moved.filter(f => f.endsWith('.jsonl.gz')).length, 2);
  const cov = readJson(join(root, ds, '_coverage.json'));
  assert.deepEqual(Object.keys(cov.groups).sort(), ['range_2023-01-01_2026-10-07']);
});

test('_coverage 記 zeroMembers：分 K 某檔回 0 列（當日有量的股票卻沒棒＝缺口）要看得見', async () => {
  const root = tmp();
  const groups = plan(root, ['TaiwanStockKBar']).filter(g => g.group === '2023-03-15');
  const c = fakeClient(job => (job.params.data_id === '6129' ? [] : rowsFor(job)));
  const s = await runPlan({ ...base(root), groups, client: c });
  assert.equal(s.stopReason, 'done');
  const cov = readJson(join(root, 'TaiwanStockKBar', '_coverage.json'));
  assert.equal(cov.groups['2023-03-15'].zeroMembers, 1);
  assert.equal(cov.summary.zeroMembers, 1);
});
