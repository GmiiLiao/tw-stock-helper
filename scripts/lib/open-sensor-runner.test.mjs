// 開盤感應器 v2.1 排程器：假 db＋假時鐘整日模擬（design-v2.1 §5、§8.3、§8.4、§12.4「寫入時序」）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenSensorRunner } from './open-sensor-runner.mjs';
import { tpeMs } from './open-sensor-params.mjs';
import { fakeDb, mkMarket, mkOpenMarks } from './open-sensor.fixture.mjs';
import { earliestRestart, WINDOWS } from './restart-windows.mjs';

const D = '2026-10-08';   // 週四
const at = hms => tpeMs(D, hms);

function setup({ db = fakeDb(), bootMs = at('08:00:00'), market = mkMarket() } = {}) {
  db.store.set('chipArchive/2026-10-07', { date: '2026-10-07', closeJson: JSON.stringify(market.closeMap) });
  const clock = { now: at('08:40:00') };
  const marks = [];
  const deps = {
    db, log: () => {}, nowMs: () => clock.now, holidays: () => new Set(), bootMs,
    marketOf: () => market.marketOf,
    loadShares: async () => ({ tse: { map: market.sharesTse, asOf: '2026-10-03', src: 'cache' }, otc: null }),
    loadExclusions: async () => ({ full: new Set(), periodic: new Set(), split: new Set(), src: {} }),
    loadAHistory: async (from, to) => { const o = {}; for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) o[d.toISOString().slice(0, 10)] = 8800; return o; },
    loadOpenMarks: async days => Object.fromEntries(days.map(d => [d, mkOpenMarks()])),
    restoredLive: () => null,
    orderFlowDone: () => true,
    readJobMarks: async () => Object.fromEntries(marks),
    markJobDone: async (k, d) => { marks.push([k, d]); },
    readIndexClose: async () => ({ t: '13:33:00', v: 48500, tseVolLots: 14_331_403, otcMRaw: 3_045_200 }),
  };
  return { db, clock, deps, marks, market, runner: createOpenSensorRunner(deps) };
}

/** 從 from 跑到 to（牆鐘，每 5 秒一輪）：揭示落後 35 秒；指數每拍、報價每 30 秒一批 */
async function runDay(ctx, from, to, { quotes = true } = {}) {
  const { clock, runner, market } = ctx;
  for (let w = at(from); w <= at(to); w += 5000) {
    clock.now = w;
    const r = w - 35_000;
    if (r >= at('09:00:00')) {
      const secs = (r - at('09:00:00')) / 1000;
      const q = 120_000 + secs * 5000;
      runner.onIndex(market.tickAt(r, q), market.otcAt(r));
      if (quotes && secs % 30 === 25) runner.onQuotes(market.quotesAt(r, Math.round(q * 1000 * 0.6 / market.codes.length)));
      runner.onRound(market.codes.length, true);
    }
    await runner.tick();
  }
}

test('整日（影子）：盤前 0 寫入 → 09:02 首判 ⑥ → 每 10 分鐘複判留存 → 盤型 → 10:00 定格 → 10:03:30 indexRing → 盤後', async () => {
  const ctx = setup();
  const { db } = ctx;
  await runDay(ctx, '08:40:00', '09:01:55');
  assert.equal(db.writes.length, 0, '盤前不寫任何文件');
  await runDay(ctx, '09:02:00', '09:05:00');
  let doc = db.store.get(`openSensor/${D}`);
  assert.ok(doc?.c0902, '09:05 前寫出首判');
  assert.equal(doc.c0902.status, 'ok', (doc.c0902.reasons || []).join('；'));
  assert.equal(doc.c0902.state.key, 'wUpHeavy');
  assert.equal(doc.c0902.slid, false); assert.equal(doc.c0902.late, false);
  assert.equal(doc.c0902.vol.gapDay, true, '|E_tse| 2.6% ≥ 1.0% ⇒ 大跳空日（只標事實）');
  assert.equal(doc.mode, 'shadow'); assert.equal(doc.basis, 'openSensor-v2.1'); assert.equal(doc.dateSrc, 't00');
  assert.equal(doc.params.H, 8500); assert.equal(doc.params.cBase.n, 20);
  assert.equal(typeof doc.c0902.ticksJson, 'string');
  assert.ok(doc.checks.e.tse.revealAt >= at('09:02:00'));
  assert.ok(db.store.has(`openSensorUniverse/${D}`), '名單存證 create 一次');
  assert.equal(doc.trail.length, 1);
  await runDay(ctx, '09:05:05', '10:06:00');
  doc = db.store.get(`openSensor/${D}`);
  assert.deepEqual(Object.keys(doc.rechecks).sort(), ['r0910', 'r0920', 'r0930', 'r0940', 'r0950', 'r1000']);
  assert.ok(Object.values(doc.rechecks).every(c => c.status === 'ok'));
  assert.equal(doc.trail.filter(t => t.kind === 'state').length, 1, '狀態沒變不補記');
  assert.ok(doc.checks.c0920 && doc.checks.c0930);
  assert.equal(doc.checks.c0920.lines.tse.status, 'ok'); assert.equal(doc.checks.c0920.basis, 'pattern3-v2.1');
  assert.equal(doc.cur.final, true); assert.equal(doc.cur.finalBy, 'r1000');
  assert.ok(doc.indexRing?.n > 700, 'indexRing 寫一次');
  assert.equal(doc.c0902.vol.qAucLots, 120000, '開盤當下那一拍的競價量');
  assert.equal(typeof doc.checks.e.oStarPct, 'number', 'B_0902 覆蓋足夠 ⇒ 合成 O*');
  assert.deepEqual(db.store.get('openSensorStats/outside').countedDates, [D]);
  // 影子：不寫 aiMessages／alerts／推播；10:05 不建 orderFlowArchive
  assert.ok(!db.writes.some(k => /^(aiMessages|alerts|users)\//.test(k)));
  assert.ok(!db.store.has(`orderFlowArchive/${D}`));
  // 盤後：15:25 子程序寫了 orderFlowArchive（含 openMarks）之後
  db.store.set(`orderFlowArchive/${D}`, { date: D, tradeValue: 1_150_804, tradeVol: 14_331_403, curveJson: '[]', openMarks: mkOpenMarks() });
  ctx.clock.now = at('15:26:00');
  await ctx.runner.tick();
  doc = db.store.get(`openSensor/${D}`);
  assert.ok(doc.post); assert.equal(doc.post.label, 'big'); assert.ok(Object.keys(doc.post.rhoRatio).length >= 7);
  assert.ok(db.store.get(`orderFlowArchive/${D}`).indexMarks, 'indexMarks 盤後複製');
  assert.deepEqual(db.store.get(`orderFlowArchive/${D}`).indexMarks.close, { t: '13:33:00', v: 48500 });
  assert.deepEqual(doc.post.mClose, { t: '13:33:00', tseVolLots: 14_331_403, otcMRaw: 3_045_200 }, 'o00 m 語意核對原料');
  assert.equal(db.store.get(`orderFlowArchive/${D}`).curveJson, '[]');
  assert.equal(db.store.get('openSensorMeta/threshold').asOf, D);
  assert.ok(db.store.get('openSensorMeta/rho').live.m0902.length === 1);
  assert.deepEqual(ctx.marks.at(-1), ['openSensorPost', D]);
  const n = db.writes.length;
  ctx.clock.now = at('15:40:00'); await ctx.runner.tick();
  assert.equal(db.writes.length, n, '盤後每日一次');
});

test('重啟：已寫的檢查點不覆蓋；逾窗的檢查點寫 nodata(restart)；窗內恢復標 late；盤型不拿較晚的拍子頂替', async () => {
  const a = setup({ market: mkMarket({ unopened: ['1219'] }) });   // U 市值 ≥0.5% ⇒ 要做 E′ 修正
  await runDay(a, '08:40:00', '09:12:00');
  const before = structuredClone(a.db.store.get(`openSensor/${D}`));
  assert.ok(before.rechecks.r0910);
  assert.equal(before.eCorr.eFinal, false);
  const b = setup({ db: a.db, bootMs: at('09:25:00'), market: a.market });
  await runDay(b, '09:25:00', '09:40:00');
  const doc = a.db.store.get(`openSensor/${D}`);
  assert.deepEqual(doc.c0902, before.c0902, '首判不被重寫');
  assert.deepEqual(doc.rechecks.r0910, before.rechecks.r0910);
  assert.equal(doc.rechecks.r0920.status, 'nodata'); assert.deepEqual(doc.rechecks.r0920.reasons, ['restart']);
  assert.equal(doc.checks.c0920.lines.tse.status, 'nodata', '09:20 那拍不在重啟後的環裡');
  assert.equal(doc.rechecks.r0930.status, 'ok'); assert.equal(doc.rechecks.r0930.late, true);
  assert.equal(doc.trail.filter(t => t.kind === 'state').length, 1);
  assert.ok(doc.eCorr.tse.length >= 1, 'E′ 由文件接回 E 與 U');
});

test('O7：indexRing 與 10:00 定格都在重啟保護窗結束前落地；最早可重啟的那一分鐘重啟不影響', async () => {
  const sensor = WINDOWS.find(w => w.name.startsWith('開盤感應器'));
  const firstOk = earliestRestart({ mins: 9 * 60 + 30, isTradingDay: true });
  assert.equal(firstOk, sensor.to, '10:05 才放行');
  const a = setup();
  await runDay(a, '08:40:00', '10:04:55');   // 跑到保護窗結束前一刻
  const doc = a.db.store.get(`openSensor/${D}`);
  assert.ok(doc.indexRing?.n > 700, '10:05 放行前 indexRing 已寫出');
  assert.equal(doc.indexRing.gaps.length, 0);
  assert.equal(doc.cur.final, true);
  const restartAt = at(`${String(Math.floor(firstOk / 60)).padStart(2, '0')}:${String(firstOk % 60).padStart(2, '0')}:00`);
  const b = setup({ db: a.db, bootMs: restartAt, market: a.market });
  await runDay(b, '10:05:00', '10:07:00');
  assert.deepEqual(a.db.store.get(`openSensor/${D}`).indexRing, doc.indexRing, '重啟後不覆蓋、不缺段');
});

test('09:20 才開機：首判 nodata(restart)，不寫有效開盤與失真；複判不拿重啟後第一拍當競價量；indexRing 的 open／e 為 null', async () => {
  const ctx = setup({ bootMs: at('09:20:00') });
  await runDay(ctx, '09:20:00', '10:06:00');
  const doc = ctx.db.store.get(`openSensor/${D}`);
  assert.equal(doc.c0902.status, 'nodata'); assert.deepEqual(doc.c0902.reasons, ['restart']);
  assert.equal(doc.checks?.e, undefined, '不寫 checks.e（O*＝0、差＝−官方開盤% 的假失真）');
  assert.equal(doc.eCorr, undefined);
  assert.equal(doc.c0902.idx, undefined);
  assert.equal(doc.rechecks.r0930.vol.qAucLots, null);
  assert.equal(doc.rechecks.r0930.vol.estE2Yi, null);
  assert.equal(doc.indexRing.open, null);
  assert.equal(doc.indexRing.e, null);
  assert.ok(doc.indexRing.gaps[0].startsWith('09:00:00–09:19'), doc.indexRing.gaps.join('、'));
});

test('重啟（09:25）後的複判：qAucLots 寫 null、不算 E2（舊版把重啟後第一拍 7,445,000 張當開盤競價量）', async () => {
  const a = setup();
  await runDay(a, '08:40:00', '09:12:00');
  const b = setup({ db: a.db, bootMs: at('09:25:00'), market: a.market });
  await runDay(b, '09:25:00', '09:40:00');
  const doc = a.db.store.get(`openSensor/${D}`);
  assert.equal(doc.rechecks.r0910.vol.qAucLots, 120000);
  assert.equal(doc.rechecks.r0930.status, 'ok');
  assert.equal(doc.rechecks.r0930.vol.qAucLots, null);
  assert.equal(doc.rechecks.r0930.vol.estE2Yi, null);
  assert.ok(doc.rechecks.r0930.vol.estYi > 0, '主估計式不受影響');
});

test('09:05 前閘門始終不過 ⇒ 寫「未判定」並附原因（不捏造狀態）；開機晚於 09:05 ⇒ nodata(restart)', async () => {
  const ctx = setup();
  await runDay(ctx, '08:40:00', '09:05:05', { quotes: false });
  const doc = ctx.db.store.get(`openSensor/${D}`);
  assert.equal(doc.c0902.status, 'undetermined');
  assert.ok(doc.c0902.reasons.some(r => r.startsWith('G1:')) && doc.c0902.reasons.some(r => r.startsWith('G2:')));
  assert.equal(doc.cur.key, 'undetermined');
  const late = setup({ bootMs: at('09:06:00') });
  await runDay(late, '09:06:00', '09:06:10');
  assert.equal(late.db.store.get(`openSensor/${D}`).c0902.status, 'nodata');
});

test('非交易日不建文件、不寫任何東西', async () => {
  const ctx = setup();
  ctx.deps.holidays = () => new Set([D]);
  const r = createOpenSensorRunner(ctx.deps);
  ctx.clock.now = at('09:03:00');
  r.onIndex(ctx.market.tickAt(at('09:02:20'), 1), null);
  await r.tick();
  ctx.clock.now = at('15:30:00');
  await r.tick();
  assert.equal(ctx.db.writes.length, 0);
});

test('熱路徑：feed 遇到壞資料不拋例外', () => {
  const { runner, clock } = setup();
  clock.now = at('09:01:00');
  assert.doesNotThrow(() => runner.onQuotes({ 2330: null, 1101: { revealAt: 'x' } }));
  assert.doesNotThrow(() => runner.onIndex({ revealAt: at('09:00:30') }, undefined));
  assert.doesNotThrow(() => runner.onQuotes(null));
});
