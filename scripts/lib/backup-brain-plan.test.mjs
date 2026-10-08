// node --test scripts/lib/backup-brain-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATED, CONTENT_DIFF, SKIP_COLLECTIONS, SINGLETON_FROM_LOCAL, FULL_SWEEP_DAYS, RUN_BUDGET_MS, SINGLETON_MAX_DOCS,
  taipeiDay, addDays, daysBetween, dayNumber, cutFor, sweepSlot, incrementalRanges, idInRanges, decideMode,
  isDateLikeId, singletonWarnings, budgetLevel, validateTables, safeFileName,
} from './backup-brain-plan.mjs';

const inRanges = idInRanges;

test('涵蓋表自我檢查通過（無重複、前綴合法、mopsNews 同時在 DATED）', () => {
  assert.deepEqual(validateTables(), []);
});

test('2026-10-08 稽核點名的逐日集合全部有分類（不再落入 singletons 被截斷）', () => {
  const dated = new Set(DATED.map(s => s.id));
  const must = ['newsVerdict', 'newsDigest', 'mopsNews', 'gapLimitUp', 'limitUpRecommend', 'squeezeRecommend', 'squeezeReport',
    'squeezeReview', 'squeezeTraining', 'surgeShadow', 'tailTrack', 'shortCandidates', 'shortTraining', 'sectorSpot', 'swingHold',
    'scoringV3', 'squeezePicks', 'squeezePicksLedger', 'stopEventShadow', 'openSensor', 'openSensorUniverse'];
  for (const id of must) assert.ok(dated.has(id), `${id} 應在 DATED`);
  assert.ok(CONTENT_DIFF.includes('earningsCallPreviews'));
  assert.ok(SKIP_COLLECTIONS.includes('alertDedup'));
  assert.deepEqual(SINGLETON_FROM_LOCAL, ['mopsNews']);
});

test('validateTables 抓得到重複、互為前綴、壞前綴、FROM_LOCAL 不在 DATED', () => {
  const p = validateTables({
    dated: [{ id: 'a' }, { id: 'b', families: ['x-', 'x-y-'] }, { id: 'c', families: ['2026-'] }, { id: 'd', lookbackDays: 0 }],
    contentDiff: ['a'], skip: [], fromLocal: ['zzz'],
  });
  assert.ok(p.some(s => s.includes('a 同時在')));
  assert.ok(p.some(s => s.includes('區間會重疊')));
  assert.ok(p.some(s => s.includes('「2026-」須以英文字母開頭')));
  assert.ok(p.some(s => s.includes('lookbackDays 0')));
  assert.ok(p.some(s => s.startsWith('zzz')));
});

test('台北日與日數運算（與機器時區無關）', () => {
  assert.equal(taipeiDay(Date.parse('2026-10-08T15:59:59Z')), '2026-10-08');
  assert.equal(taipeiDay(Date.parse('2026-10-08T16:00:00Z')), '2026-10-09');
  assert.equal(addDays('2026-10-01', -7), '2026-09-24');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-10-01', '2026-10-08'), 7);
  assert.equal(dayNumber('1970-01-08'), 7);
});

test('截止日：預設 7 天；月份 id 的集合放寬到 70 天，當月與上月都讀得到', () => {
  assert.equal(cutFor({ id: 'chipArchive' }, '2026-10-08'), '2026-10-01');
  const rev = DATED.find(s => s.id === 'revenueArchive');
  const ranges = incrementalRanges(rev.families, cutFor(rev, '2026-10-08'));
  assert.ok(inRanges(ranges, '2026-09'));   // 9 月營收 10/10 前陸續公布
  assert.ok(inRanges(ranges, '2026-08'));   // daemon 每天補最近 2 個月
  assert.ok(!inRanges(ranges, '2026-06'));
});

test('增量區間（純日期 id）：近 7 天＋latest／summary 讀得到，舊日期不讀', () => {
  const r = incrementalRanges([''], '2026-10-01');
  assert.deepEqual(r, [{ start: '2026-10-01', end: null }]);
  for (const id of ['2026-10-01', '2026-10-08', '2026-10-07-muyfb7s6', 'latest', 'summary', 'global', 'scoreboard', 'live'])
    assert.ok(inRanges(r, id), id);
  for (const id of ['2026-09-30', '2026-09-30-muoex1w8', '2022-07-18']) assert.ok(!inRanges(r, id), id);
});

test('增量區間（前綴-日期，limitUpForecast）：舊 pred-／review- 不讀，其餘全讀', () => {
  const r = incrementalRanges(['review-', 'pred-'], '2026-10-01');
  assert.deepEqual(r, [{ start: null, end: 'pred-' }, { start: 'pred-2026-10-01', end: 'review-' }, { start: 'review-2026-10-01', end: null }]);
  for (const id of ['latest', 'live', 'scoreboard', 'pred-2026-10-07', 'review-2026-10-02']) assert.ok(inRanges(r, id), id);
  for (const id of ['pred-2026-07-16', 'review-2026-09-30']) assert.ok(!inRanges(r, id), id);
});

test('增量區間（surgeShadow 混合 id）：沒宣告前綴的研究文件每輪都讀，不會漏', () => {
  const spec = DATED.find(s => s.id === 'surgeShadow');
  const r = incrementalRanges(spec.families, '2026-10-01');
  for (const id of ['fwd-2026-10-07', 'hist-2026-10-01', 'index', 'lab-cv', 'lab-cvrows-t2L-current-all-outside', 'surge-v2',
    'surge-v2-2026-10-07', 'tracks-index', 'tracks-raw-gap-2026-10-06', 'tracks-raw-prewire-20261005T212506'])
    assert.ok(inRanges(r, id), id);
  for (const id of ['fwd-2026-09-30', 'hist-2026-07-16', 'surge-v2-2026-09-01', 'tracks-raw-gap-2026-09-01']) assert.ok(!inRanges(r, id), id);
});

test('增量區間：空前綴混前綴、空陣列等同純日期', () => {
  assert.deepEqual(incrementalRanges([], 'C'), [{ start: 'C', end: null }]);
  assert.deepEqual(incrementalRanges(['', 'fwd-'], '2026-10-01'), [{ start: '2026-10-01', end: 'fwd-' }, { start: 'fwd-2026-10-01', end: null }]);
});

test('全量比對槽位：大集合各自一天，且槽位穩定在 0–6', () => {
  const big = ['chipArchive', 'intradayArchive', 'volSurgeArchive', 'bookDepthArchive', 'newsVerdict', 'surgeShadow', 'revenueArchive'];
  const slots = big.map(id => sweepSlot(DATED.find(s => s.id === id)));
  assert.equal(new Set(slots).size, big.length, `大集合槽位重複：${slots}`);
  for (const s of DATED) { const v = sweepSlot(s); assert.ok(v >= 0 && v < FULL_SWEEP_DAYS); assert.equal(v, sweepSlot(s)); }
  // chipArchive 那天只有它和一個小集合
  const chipSlot = sweepSlot({ id: 'chipArchive', slot: 4 });
  assert.ok(DATED.filter(s => sweepSlot(s) === chipSlot).length <= 2);
});

test('decideMode：全量的各種理由與延後', () => {
  const spec = { id: 'x', slot: 0 };
  const base = { spec, localOld: 10, cloudOld: 10 };
  // 找一個 slot 0 的日子與一個非 slot 的日子
  const slotDay = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'].find(d => dayNumber(d) % 7 === 0);
  const offDay = addDays(slotDay, 1);
  assert.deepEqual(decideMode({ ...base, today: offDay, forceFull: true, last: { sweepDay: offDay } }), { mode: 'full', reason: 'flag-full' });
  assert.deepEqual(decideMode({ ...base, today: offDay, cloudOld: 11, last: { sweepDay: offDay } }), { mode: 'full', reason: 'local-missing' });
  assert.deepEqual(decideMode({ ...base, today: offDay, last: null }), { mode: 'full', reason: 'no-state' });
  assert.deepEqual(decideMode({ ...base, today: offDay, last: { sweepDay: 'garbage' } }), { mode: 'full', reason: 'no-state' });
  assert.deepEqual(decideMode({ ...base, today: offDay, last: { sweepDay: addDays(offDay, -1) } }), { mode: 'incremental', reason: 'recent-window' });
  assert.deepEqual(decideMode({ ...base, today: slotDay, last: { sweepDay: addDays(slotDay, -3) } }), { mode: 'full', reason: 'weekly-slot' });
  // 同一天重跑（重試）：今天已全量過 ⇒ 不再全量
  assert.deepEqual(decideMode({ ...base, today: slotDay, last: { sweepDay: slotDay } }), { mode: 'incremental', reason: 'recent-window' });
  // 錯過槽位（daemon 停機）⇒ 滿 7 天強制
  assert.deepEqual(decideMode({ ...base, today: offDay, last: { sweepDay: addDays(offDay, -7) } }), { mode: 'full', reason: 'weekly-overdue' });
  // 本機舊檔多於雲端（雲端刪過舊檔）不算缺
  assert.equal(decideMode({ ...base, today: offDay, localOld: 12, last: { sweepDay: addDays(offDay, -1) } }).mode, 'incremental');
  // 雲端份數讀不到（count 失敗）⇒ 不據此判缺
  assert.equal(decideMode({ ...base, today: offDay, cloudOld: null, last: { sweepDay: addDays(offDay, -1) } }).mode, 'incremental');
});

test('decideMode：時間預算用掉 60% 後，週期性全量延後；缺檔與第一次不延', () => {
  const spec = { id: 'x', slot: 0 };
  const late = RUN_BUDGET_MS * 0.65;
  const today = '2026-10-20';
  assert.deepEqual(decideMode({ spec, today, localOld: 5, cloudOld: 5, last: { sweepDay: '2026-10-01' }, elapsedMs: late }),
    { mode: 'incremental', reason: 'deferred-budget' });
  assert.equal(decideMode({ spec, today, localOld: 4, cloudOld: 5, last: { sweepDay: '2026-10-19' }, elapsedMs: late }).reason, 'local-missing');
  assert.equal(decideMode({ spec, today, localOld: 5, cloudOld: 5, last: null, elapsedMs: late }).reason, 'no-state');
});

test('singletons 告警：截斷、未分類日期型、份數偏多', () => {
  assert.equal(singletonWarnings('latestOnly', { count: 1, ids: ['latest'] }).length, 0);
  const t = singletonWarnings('big', { count: SINGLETON_MAX_DOCS + 5, ids: [] });
  assert.ok(t[0].includes('截斷'));
  const d = singletonWarnings('newCol', { count: 4, ids: ['2026-10-06', '2026-10-07', '2026-10-08', 'latest'] });
  assert.ok(d.some(s => s.includes('應加進') && s.includes('DATED')));
  const m = singletonWarnings('uids', { count: 30, ids: Array.from({ length: 30 }, (_, i) => `uid${i}`) });
  assert.ok(m[0].includes('持續增長'));
  // 月份 id 也算日期型
  assert.ok(isDateLikeId('2026-09') && isDateLikeId('fwd-2026-10-02') && !isDateLikeId('2330') && !isDateLikeId('latest'));
});

test('預算等級與檔名', () => {
  assert.equal(budgetLevel(0), 'ok');
  assert.equal(budgetLevel(RUN_BUDGET_MS * 0.7), 'warn');
  assert.equal(budgetLevel(RUN_BUDGET_MS), 'over');
  assert.equal(safeFileName('2026-10-08'), '2026-10-08');
  assert.equal(safeFileName('a/b c'), 'a_b_c');
});

test('回歸：逐日集合雲端每天先多出當天那份，不可因此天天判缺檔而全量（比的是增量區間以外的舊文件）', () => {
  const spec = { id: 'chipArchive', slot: 4 };
  const today = '2026-10-09';
  const incr = incrementalRanges([''], cutFor(spec, today));
  const local = ['2026-09-30', '2026-10-01', '2026-10-08'];          // 本機到昨天
  const cloud = [...local, '2026-10-09'];                             // 雲端多了今天
  const old = (ids) => ids.filter(id => !idInRanges(incr, id)).length;
  const d = decideMode({ spec, today, last: { sweepDay: '2026-10-08' }, localOld: old(local), cloudOld: old(cloud) });
  assert.equal(d.mode, 'incremental');
  // 雲端事後補了一份舊日期 ⇒ 舊文件雲端比本機多 ⇒ 全量
  const d2 = decideMode({ spec, today, last: { sweepDay: '2026-10-08' }, localOld: old(local), cloudOld: old([...cloud, '2022-07-15']) });
  assert.deepEqual(d2, { mode: 'full', reason: 'local-missing' });
});
