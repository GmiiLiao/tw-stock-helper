// 官方鏡像防呆（2026-10-04·WM-SCAN G4-32 daemon 重任務窗、G2-37 空表確認後定版＋快照鍵用官方回聲日）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as C from './official-mirror.mjs';

const jsonRes = obj => async () => ({ status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(JSON.stringify(obj)) });
const tmp = () => mkdtempSync(join(tmpdir(), 'omg-'));
const tw = (d, hm) => new Date(`${d}T${hm}:00+08:00`);

test('daemon 重任務窗：每天 16:25–16:55、21:40–22:35 擋；22:40 起可跑；平日盤中仍擋', () => {
  assert.ok(C.inDaemonBusyWindow(tw('2026-10-05', '16:30')));
  assert.ok(C.inDaemonBusyWindow(tw('2026-10-04', '22:00')), '週日也擋（不依賴交易日判斷）');
  assert.equal(C.inDaemonBusyWindow(tw('2026-10-05', '16:55')), null);
  assert.equal(C.inDaemonBusyWindow(tw('2026-10-05', '22:35')), null);
  assert.equal(C.blockedReason(tw('2026-10-05', '22:40')), null, '新排程 22:40 不在任何窗內');
  assert.equal(C.blockedReason(tw('2026-10-05', '22:15')) !== null, true, '舊排程 22:15 落在資券窗內');
  assert.match(C.blockedReason(tw('2026-10-05', '09:00')), /07:30/);
  assert.equal(C.blockedReason(tw('2026-10-03', '10:00')), null, '週六 10:00 可跑');
  assert.equal(C.blockedReason(tw('2026-10-05', '06:45')), null, 'retry 06:45 可跑');
  assert.equal(C.blockedReason(tw('2026-10-05', '23:20')), null, 'backfill 23:20 可跑');
});

test('家族佇列預設用全部禁跑窗，停止原因寫明哪個窗', async () => {
  const q = new C.FamilyQueue('twse', { quiet: () => C.blockedReason(tw('2026-10-05', '22:00')), log: () => {}, sleepFn: async () => {} });
  const r = await q.run(async () => ({}));
  assert.ok(r.skipped); assert.match(q.stopReason, /資券/);
});

test('空表：第一次不定版；同輪重抓不算確認；隔 ≥6 小時仍空才定版；之後不重寫', async () => {
  const root = tmp();
  try {
    const ad = { id: 'x', host: 'www.twse.com.tw', kind: 'json', validator: 'twseDate', request: () => ({ url: 'https://h/x' }) };
    const ctx = C.ctxOf({ day: '2026-10-05' }); const man = { id: 'x', host: 'www.twse.com.tw', rows: {} };
    const empty = jsonRes({ stat: 'OK', date: '20261005', fields: ['a'], data: [] });
    await C.fetchAndStore(ad, { root, key: '2026-10-05', ctx, man, now: new Date('2026-10-05T14:40:00Z'), fetchImpl: empty });
    assert.equal(man.rows['2026-10-05'].status, 'empty'); assert.equal(C.isFinal(man, '2026-10-05'), false, '第一次空不定版');
    await C.fetchAndStore(ad, { root, key: '2026-10-05', ctx, man, now: new Date('2026-10-05T14:41:00Z'), fetchImpl: empty });
    assert.equal(C.isFinal(man, '2026-10-05'), false, '1 分鐘後再看不算確認');
    assert.equal(man.rows['2026-10-05'].emptySince, '2026-10-05T14:40:00.000Z', 'emptySince 保留第一次時刻');
    await C.fetchAndStore(ad, { root, key: '2026-10-05', ctx, man, now: new Date('2026-10-05T22:45:00Z'), fetchImpl: empty });
    assert.equal(C.isFinal(man, '2026-10-05'), true, '隔 8 小時仍空 ⇒ 定版'); assert.equal(man.rows['2026-10-05'].emptySeen, 3);
    const before = man.rows['2026-10-05'];
    await C.fetchAndStore(ad, { root, key: '2026-10-05', ctx, man, now: new Date('2026-10-06T22:45:00Z'), fetchImpl: empty });
    assert.equal(man.rows['2026-10-05'], before, '已定版的空列不重寫');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('空表後補到資料：直接存 ok 定版（不受空表規則影響）；呼叫端 final=false 的空表永不定版', async () => {
  const root = tmp();
  try {
    const ad = { id: 'x', host: 'www.twse.com.tw', kind: 'json', validator: 'twseDate', request: () => ({ url: 'https://h/x' }) };
    const ctx = C.ctxOf({ day: '2026-10-05' }); const man = { id: 'x', host: 'www.twse.com.tw', rows: {} };
    await C.fetchAndStore(ad, { root, key: '2026-10-05', ctx, man, now: new Date('2026-10-05T14:40:00Z'), fetchImpl: jsonRes({ stat: 'OK', date: '20261005', fields: ['a'], data: [] }) });
    await C.fetchAndStore(ad, { root, key: '2026-10-05', ctx, man, now: new Date('2026-10-05T22:45:00Z'), fetchImpl: jsonRes({ stat: 'OK', date: '20261005', tables: [{ data: [[1]] }] }) });
    assert.equal(man.rows['2026-10-05'].status, 'ok'); assert.equal(C.isFinal(man, '2026-10-05'), true);
    const d = C.emptyDecision({ status: 'empty', emptySince: '2026-10-01T00:00:00Z' }, '2026-10-05T00:00:00Z', false);
    assert.equal(d.final, false, '呼叫端不允許定版（當月表）時空表也不定版');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('快照鍵用官方回聲日：落後一日的內容存成回聲日；同回聲日同內容不另存；同回聲日不同內容加 .r2', async () => {
  const root = tmp();
  try {
    const ad = { id: 's', host: 'openapi.twse.com.tw', kind: 'json', validator: 'openapi', request: () => ({ url: 'https://h/s' }) };
    const man = { id: 's', host: 'openapi.twse.com.tw', rows: {} };
    const r1 = await C.fetchAndStore(ad, { root, key: '2026-10-05', ctx: {}, man, snapshot: true, keyByEcho: true, fetchImpl: jsonRes([{ Date: '1151002', v: 1 }]) });
    assert.equal(r1.key, '2026-10-02', '執行日 10-05、官方回聲 10-02 ⇒ 鍵 10-02');
    assert.equal(man.rows['2026-10-02'].runKey, '2026-10-05'); assert.ok(!man.rows['2026-10-05']);
    assert.ok(existsSync(join(root, 'openapi.twse.com.tw', 's', '2026-10-02.json.gz')));
    const r2 = await C.fetchAndStore(ad, { root, key: '2026-10-06', ctx: {}, man, snapshot: true, keyByEcho: true, fetchImpl: jsonRes([{ Date: '1151002', v: 1 }]) });
    assert.equal(r2.key, '2026-10-02'); assert.equal(man.rows['2026-10-02'].status, 'ok', '同內容不改狀態'); assert.ok(man.rows['2026-10-02'].recheck);
    const r3 = await C.fetchAndStore(ad, { root, key: '2026-10-06', ctx: {}, man, snapshot: true, keyByEcho: true, fetchImpl: jsonRes([{ Date: '1151002', v: 2 }]) });
    assert.equal(r3.key, '2026-10-02.r2', '同回聲日、內容不同 ⇒ .r2');
    const r4 = await C.fetchAndStore(ad, { root, key: '2026-10-07', ctx: {}, man, snapshot: true, keyByEcho: true, fetchImpl: jsonRes([{ Date: '1151007', v: 3 }]) });
    assert.equal(r4.key, '2026-10-07');
    const r5 = await C.fetchAndStore(ad, { root, key: '2026-10-08', ctx: {}, man, snapshot: true, keyByEcho: true, fetchImpl: jsonRes([{ x: 1 }]) });
    assert.equal(r5.key, '2026-10-08', '沒有回聲日 ⇒ 用執行鍵');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 停擺日進 _alerts（2026-10-08·WP7）──
test('dailySnapshotGaps：交易日收盤後到下一交易日開盤前沒有 daily 抓齊每日快照 ⇒ 列出（實案 10-05～10-07）', () => {
  const runs = [
    { date: '2026-10-05', requests: 0, stats: { skipped: 216 }, at: '2026-10-05T14:15:04.734Z' },          // 22:15 落在禁跑窗：0 請求
    { date: '2026-10-05', requests: 3, stats: { ok: 3 }, at: '2026-10-05T14:38:26.283Z' },                 // 手動補 3 個快照：不算抓齊
    { date: '2026-10-08', requests: 400, dailySnap: { planned: 104, ok: 104 }, at: '2026-10-08T15:30:00Z' }, // 10-08 23:30 正常
  ];
  const next = { '2026-10-02': '2026-10-05', '2026-10-05': '2026-10-06', '2026-10-06': '2026-10-07', '2026-10-07': '2026-10-08' };
  const g = C.dailySnapshotGaps(['2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'], runs, { next, since: '2026-10-05' });
  assert.deepEqual(g.map(x => [x.key, x.ran]), [['2026-10-05', false], ['2026-10-06', false], ['2026-10-07', false]], '10-02 早於鏡像第一輪 daily，不算停擺；10-05 兩輪舊 log 共 3 個請求＝實質沒跑');
  // 部分抓到（例：櫃買家族中途停）⇒ 列出比例；--only 的局部輪不算；只跑帶日期（planned 0）不算快照輪
  const g2 = C.dailySnapshotGaps(['2026-10-08'], [
    { date: '2026-10-08', dailySnap: { planned: 104, ok: 60 }, at: '2026-10-08T15:30:00Z' },
    { date: '2026-10-08', dailySnap: { planned: 2, ok: 2 }, only: ['x', 'y'], at: '2026-10-08T15:40:00Z' },
    { date: '2026-10-08', dailySnap: { planned: 0, ok: 0 }, at: '2026-10-08T15:50:00Z' },
  ], { next: { '2026-10-08': '2026-10-09' } });
  assert.deepEqual(g2, [{ key: '2026-10-08', ran: true, ok: 60, planned: 104 }]);
  // 窗外（下一交易日 07:30 之後才跑）抓到的已是下一天的快照 ⇒ 不算
  const g3 = C.dailySnapshotGaps(['2026-10-07'], [{ date: '2026-10-07', dailySnap: { planned: 104, ok: 104 }, at: '2026-10-08T09:00:00Z' }], { next: { '2026-10-07': '2026-10-08' } });
  assert.equal(g3.length, 1);
});

test('fetchedOkSince：本輪寫入／再確認／unchanged 才算；失敗只記 lastTry 的不算', () => {
  const since = '2026-10-08T14:40:00.000Z';
  assert.ok(C.fetchedOkSince({ rows: { '2026-10-08': { status: 'ok', at: '2026-10-08T14:41:00.000Z' } } }, since));
  assert.ok(C.fetchedOkSince({ rows: { '2026-10-07': { status: 'ok', at: '2026-10-07T14:41:00.000Z', recheck: '2026-10-08T14:42:00.000Z' } } }, since));
  assert.ok(!C.fetchedOkSince({ rows: { '2026-10-07': { status: 'ok', at: '2026-10-07T14:41:00.000Z', lastTry: { status: 'fail', at: '2026-10-08T14:42:00.000Z' } } } }, since));
  assert.ok(!C.fetchedOkSince({ rows: { '2026-10-08': { status: 'fail', at: '2026-10-08T14:42:00.000Z' } } }, since));
  assert.ok(!C.fetchedOkSince(null, since));
});
