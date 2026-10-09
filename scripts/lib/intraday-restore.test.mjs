// 重啟接回今日分時序列 單元測試：node --test scripts/lib/intraday-restore.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRestoredIntraday, createIntradayRestorer, INTRADAY_MAX_PTS } from './intraday-restore.mjs';

const TODAY = '2026-10-02';
const at = (hhmm, sec = 0, day = TODAY) => Date.parse(`${day}T${hhmm}:${String(sec).padStart(2, '0')}+08:00`) / 1000;
// 每分鐘一點 [epoch秒, 價, 累積量]（與 recordIntraday 同形）
const mkPts = (fromHHMM, n, { sec = 10, px = 100, day = TODAY } = {}) => {
  const t0 = at(fromHHMM, sec, day);
  return Array.from({ length: n }, (_, i) => [t0 + i * 60, +(px + i * 0.5).toFixed(2), 1000 * (i + 1)]);
};
const empty = () => ({ date: '', series: {} });
const doc = (series, date = TODAY) => ({ date, updatedAt: at('15:50'), series });

test('開機（記憶體空）＋今日文件：完整接回，日期設為今天', () => {
  const series = { 2330: { prev: 1000, pts: mkPts('09:00', 120) }, 2409: { prev: 15, pts: mkPts('10:30', 30) } };
  const r = mergeRestoredIntraday(empty(), doc(series), TODAY);
  assert.equal(r.skipped, undefined);
  assert.equal(r.state.date, TODAY);
  assert.deepEqual(r.state.series, series);
  assert.equal(r.codes, 2);
  assert.equal(r.points, 150);
});

test('別天的文件不還原（跨日殘留不可沿用），記憶體原樣保留', () => {
  const cur = { date: TODAY, series: { 2330: { prev: 1000, pts: mkPts('13:00', 3) } } };
  const r = mergeRestoredIntraday(cur, doc({ 2330: { prev: 990, pts: mkPts('09:00', 200, { day: '2026-10-01' }) } }, '2026-10-01'), TODAY);
  assert.equal(r.skipped, 'other-day');
  assert.equal(r.state, cur);
  assert.equal(r.codes, 0);
});

test('沒有文件 → none；今日文件但序列解不出（分片代不一致）→ no-series，交由呼叫端重試、不覆蓋', () => {
  const cur = empty();
  assert.equal(mergeRestoredIntraday(cur, null, TODAY).skipped, 'none');
  const r = mergeRestoredIntraday(cur, { date: TODAY, updatedAt: 1, series: null }, TODAY);
  assert.equal(r.skipped, 'no-series');
  assert.equal(r.state, cur);
});

test('重試路徑：記憶體已有重啟後的點 ⇒ 逐點聯集、依時間排序、同秒以記憶體為準、只在記憶體的檔照留', () => {
  const restoredPts = mkPts('09:00', 90);                     // 09:00:10 ~ 10:29:10
  const restartPts = mkPts('10:29', 5, { px: 200 });          // 10:29:10（與文件最後一點同秒）~ 10:33:10
  const cur = { date: TODAY, series: { 2330: { prev: 1000, pts: restartPts }, 3008: { prev: 2500, pts: mkPts('10:30', 4) } } };
  const r = mergeRestoredIntraday(cur, doc({ 2330: { prev: 1000, pts: restoredPts } }), TODAY);
  const pts = r.state.series[2330].pts;
  assert.equal(pts.length, 90 + 5 - 1, '同秒那一點只留一個');
  assert.deepEqual(pts.map(p => p[0]), [...pts.map(p => p[0])].sort((a, b) => a - b), '依時間排序');
  assert.deepEqual(pts[0], restoredPts[0], '早盤在最前面（早盤回補據此判定已完整）');
  assert.equal(pts.find(p => p[0] === at('10:29', 10))[1], 200, '同秒以記憶體（現行程序）為準');
  assert.deepEqual(pts.at(-1), restartPts.at(-1));
  assert.deepEqual(r.state.series[3008], cur.series[3008], '只在記憶體的檔不受影響');
  assert.equal(r.codes, 1);
  assert.equal(r.points, 89);
});

test('永不變少：每檔合併後點數 ≥ 記憶體與文件各自的點數', () => {
  const cur = { date: TODAY, series: { 2330: { prev: 1000, pts: mkPts('11:00', 40) }, 2317: { prev: 200, pts: mkPts('11:30', 10) }, 2603: { prev: 40, pts: mkPts('09:30', 10) } } };
  const r = mergeRestoredIntraday(cur, doc({ 2330: { prev: 1000, pts: mkPts('09:00', 20) }, 2317: { prev: 200, pts: mkPts('09:00', 150) }, 2603: { prev: 40, pts: mkPts('09:00', 60) } }), TODAY);
  assert.equal(r.state.series[2330].pts.length, 60);
  assert.equal(r.state.series[2317].pts.length, 160);
  assert.equal(r.state.series[2603].pts.length, 60, '重疊的秒數只算一次，但不少於任一邊');
});

test('超過每檔上限：與 recordIntraday 同規則保留最新的點（記憶體的新點不會被擠掉）', () => {
  const restartPts = mkPts('15:00', 30, { px: 300 });
  const cur = { date: TODAY, series: { 2330: { prev: 1000, pts: restartPts } } };
  const r = mergeRestoredIntraday(cur, doc({ 2330: { prev: 1000, pts: mkPts('08:40', INTRADAY_MAX_PTS) } }), TODAY);
  const pts = r.state.series[2330].pts;
  assert.equal(pts.length, INTRADAY_MAX_PTS);
  assert.deepEqual(pts.slice(-30), restartPts);
});

test('記憶體是別天的（尚未被 recordIntraday 換日）：比照換日重置，只留今日文件的序列', () => {
  const cur = { date: '2026-10-01', series: { 1101: { prev: 30, pts: mkPts('13:00', 5, { day: '2026-10-01' }) } } };
  const r = mergeRestoredIntraday(cur, doc({ 2330: { prev: 1000, pts: mkPts('09:00', 10) } }), TODAY);
  assert.equal(r.state.date, TODAY);
  assert.deepEqual(Object.keys(r.state.series), ['2330']);
});

test('文件中的壞點與別天的點丟掉（不信任外部資料）；記憶體的點不過濾', () => {
  const good = mkPts('09:00', 3);
  const bad = [[at('13:00', 0, '2026-10-01'), 99, 1], [at('09:10'), 0, 5], [at('09:11'), -1, 5], ['x', 100, 1], [NaN, 100, 1], null, 'pt'];
  const memOdd = [[at('09:05', 0, '2026-10-01'), 98, 1], [at('11:00'), 0, 7]];   // 記憶體裡就算有怪點也照留（永不變少）
  const cur = { date: TODAY, series: { 2330: { prev: 1000, pts: memOdd } } };
  const r = mergeRestoredIntraday(cur, doc({ 2330: { prev: 1000, pts: [...bad, ...good] }, 2454: { prev: 1, pts: 'nope' }, 6505: null }), TODAY);
  assert.deepEqual(r.state.series[2330].pts, [memOdd[0], ...good, memOdd[1]]);
  assert.equal(r.state.series[2454], undefined);
  assert.equal(r.state.series[6505], undefined);
  assert.equal(r.points, 3);
});

test('prev：記憶體有就用記憶體的，沒有才用文件的；文件 prev 非正數不採用', () => {
  const cur = { date: TODAY, series: { 2330: { prev: 1005, pts: mkPts('11:00', 2) } } };
  const r = mergeRestoredIntraday(cur, doc({ 2330: { prev: 1000, pts: mkPts('09:00', 2) }, 2303: { prev: 50, pts: mkPts('09:00', 2) }, 2002: { prev: 0, pts: mkPts('09:00', 2) } }), TODAY);
  assert.equal(r.state.series[2330].prev, 1005);
  assert.equal(r.state.series[2303].prev, 50);
  assert.equal(r.state.series[2002].prev, undefined);
});

test('不改動傳入的記憶體狀態與文件（回傳新物件）', () => {
  const cur = { date: TODAY, series: { 2330: { prev: 1000, pts: mkPts('11:00', 3) } } };
  const d = doc({ 2330: { prev: 1000, pts: mkPts('09:00', 3) } });
  const before = JSON.stringify({ cur, d });
  mergeRestoredIntraday(cur, d, TODAY);
  assert.equal(JSON.stringify({ cur, d }), before);
});

test('文件中的 __proto__ 鍵不會污染原型', () => {
  const series = JSON.parse(`{"__proto__":{"prev":1,"pts":[[${at('09:00')},10,1]]},"2330":{"prev":1000,"pts":[[${at('09:00')},1000,1]]}}`);
  const r = mergeRestoredIntraday(empty(), doc(series), TODAY);
  assert.equal(Object.getPrototypeOf(r.state.series), Object.prototype);
  assert.equal(({}).pts, undefined);
  assert.ok(r.state.series[2330]);
});

// ── 開機還原控制器（daemon 的閘門：回 true 才回補與寫入）────────────────────────
const harness = (reads, { maxTries = 3, initial = empty() } = {}) => {
  const h = { state: initial, logs: [], reads: 0 };
  h.restore = createIntradayRestorer({
    readDoc: async () => { const r = reads[Math.min(h.reads++, reads.length - 1)]; if (r instanceof Error) throw r; return typeof r === 'function' ? r(h) : r; },
    getState: () => h.state, setState: s => { h.state = s; }, log: m => h.logs.push(m), maxTries,
  });
  return h;
};

test('控制器：首輪讀到今日文件 ⇒ 接回並回 true（同一輪就可寫入），之後不再讀文件', async () => {
  const h = harness([doc({ 2330: { prev: 1000, pts: mkPts('09:00', 30) } })]);
  assert.equal(await h.restore(TODAY), true);
  assert.equal(h.state.series[2330].pts.length, 30);
  assert.match(h.logs[0], /✓ 還原今日分時序列 1 檔／30 點/);
  assert.equal(await h.restore(TODAY), true);
  assert.equal(h.reads, 1);
});

test('控制器：沒有文件／別天文件 ⇒ 立即回 true、記憶體不動、記錄原因（中文）', async () => {
  for (const [d, why] of [[null, '沒有文件'], [doc({ 2330: { pts: mkPts('09:00', 3, { day: '2026-10-01' }) } }, '2026-10-01'), '文件不是今天的']]) {
    const init = { date: TODAY, series: { 2317: { prev: 200, pts: mkPts('10:00', 2) } } };
    const h = harness([d], { initial: init });
    assert.equal(await h.restore(TODAY), true);
    assert.equal(h.state, init);
    assert.ok(h.logs[0].includes(why), h.logs[0]);
  }
});

test('控制器：讀取連續丟例外 ⇒ 前兩次回 false（本輪不寫入、記憶體保留），第 3 次放棄回 true；之後不再讀', async () => {
  const init = { date: TODAY, series: { 2330: { prev: 1000, pts: mkPts('10:30', 2) } } };
  const h = harness([new Error('DEADLINE_EXCEEDED')], { initial: init });
  assert.deepEqual([await h.restore(TODAY), await h.restore(TODAY), await h.restore(TODAY)], [false, false, true]);
  assert.equal(h.state, init, '放棄時記憶體原樣，不清空');
  assert.match(h.logs[2], /⚠ 放棄還原.*第 3 次.*DEADLINE_EXCEEDED/);
  assert.equal(await h.restore(TODAY), true);
  assert.equal(h.reads, 3);
});

test('控制器：今日分片代不一致（series=null）兩次後讀成功 ⇒ 期間記錄的點與文件合併，不覆蓋', async () => {
  const restoredPts = mkPts('09:00', 60);
  const h = harness([{ date: TODAY, updatedAt: 1, series: null }, { date: TODAY, updatedAt: 1, series: null }, doc({ 2330: { prev: 1000, pts: restoredPts } })],
    { initial: { date: TODAY, series: { 2330: { prev: 1000, pts: mkPts('10:30', 1, { px: 200 }) } } } });
  assert.equal(await h.restore(TODAY), false);
  h.state.series[2330].pts.push(...mkPts('10:31', 1, { px: 201 }));   // 未接回期間 recordIntraday 照常累積
  assert.equal(await h.restore(TODAY), false);
  assert.match(h.logs[1], /✖ 還原今日分時序列失敗.*分片代不一致/);
  assert.equal(await h.restore(TODAY), true);
  const pts = h.state.series[2330].pts;
  assert.equal(pts.length, 62);
  assert.deepEqual(pts.slice(0, 60), restoredPts);
  assert.deepEqual(pts.slice(-2).map(p => p[1]), [200, 201]);
});

test('控制器：記憶體在讀完文件後才取（讀取期間 recordIntraday 新增的點不會被舊快照蓋掉）', async () => {
  const late = mkPts('10:45', 1, { px: 300 });
  const h = harness([h0 => { h0.state = { date: TODAY, series: { 2454: { prev: 1500, pts: late } } }; return doc({ 2330: { prev: 1000, pts: mkPts('09:00', 5) } }); }]);
  assert.equal(await h.restore(TODAY), true);
  assert.deepEqual(h.state.series[2454].pts, late);
  assert.equal(h.state.series[2330].pts.length, 5);
});
