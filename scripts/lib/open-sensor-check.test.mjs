// 開盤感應器 v2.1：快照組裝、E′、寫入時序（模擬 db）（design-v2.1 §5、§8、§12.4「寫入時序」）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCapture, feedQuotes, feedIndex, buildIndexRing } from './open-sensor-capture.mjs';
import { buildUniverse } from './open-sensor-universe.mjs';
import { cBaseOf } from './open-sensor-volume.mjs';
import { eStart, eCorrAt, genReturns } from './open-sensor-eopen.mjs';
import { composeCheck, nodataCheck, advanceCur, docBase, decideFirst, decideRecheck, decidePattern, decideTimeoutFinal, decideIndexRing, decidePost, computePost, rhoMetaAfter, statsAfterFinal, indexMarksFromRing, checkLine } from './open-sensor-check.mjs';
import { createOpenSensorStore } from './open-sensor-store.mjs';
import { tpeMs, BASIS } from './open-sensor-params.mjs';

const D = '2026-10-08';
const at = hms => tpeMs(D, hms);

// ── 假 Firestore（collection/doc/get/set merge/create/runTransaction） ─────
function fakeDb() {
  const store = new Map(), writes = [];
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const merge = (a, b) => { const o = { ...(a || {}) }; for (const k of Object.keys(b)) o[k] = isObj(b[k]) && isObj(o[k]) ? merge(o[k], b[k]) : structuredClone(b[k]); return o; };
  const ref = (col, id) => {
    const key = `${col}/${id}`;
    const r = {
      key,
      get: async () => ({ exists: store.has(key), data: () => structuredClone(store.get(key)) }),
      set: async (data, opts) => { writes.push(key); store.set(key, opts?.merge ? merge(store.get(key), data) : structuredClone(data)); },
      create: async data => { if (store.has(key)) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; } writes.push(key); store.set(key, structuredClone(data)); },
    };
    return r;
  };
  return {
    store, writes,
    collection: col => ({ doc: id => ref(col, id) }),
    runTransaction: async fn => fn({ get: r => r.get(), set: (r, d, o) => { r.set(d, o); } }),
  };
}

// ── 合成一個交易日：120 檔上市普通股、t00 環、09:02 前的報價 ───────────
function dayFixture({ wPct = 2.6, gPct = 0.6, unopened = ['1219'] } = {}) {
  const closeMap = {}, sharesTse = {}, marketOf = {};
  for (let i = 0; i < 120; i++) {
    const c = i === 0 ? '2330' : String(1100 + i);
    closeMap[c] = [300, 5000]; sharesTse[c] = i === 0 ? 2e10 : 1e9 - i * 1e6; marketOf[c] = 'tse';
  }
  const uni = buildUniverse({ date: D, prevYmd: '2026-10-07', closeMap, sharesTse, marketOf, sharesAsOf: '2026-10-03', sharesSrc: 'mirror' });
  const cap = createCapture(D);
  const tick = (hms, z, m) => feedIndex(cap, 't', { price: z, prev: 48000, mVal: m, open: 48100, revealAt: at(hms), realTrade: true });
  tick('09:00:00', 48000, 0); tick('09:00:05', 48100, 120_000);
  for (let s = 10; s <= 600; s += 5) tick(new Date(at('09:00:00') + s * 1000 + 8 * 3600e3).toISOString().slice(11, 19), 48000 * (1 + wPct / 100), 120_000 + s * 5000);
  const mis = {};
  for (const c of Object.keys(uni.tse)) {
    const pct = uni.w30Set.has(c) ? wPct : gPct;
    mis[c] = unopened.includes(c)
      ? { price: 300, prev: 300, volume: 0, open: 0, revealAt: at('09:01:45'), hasLive: false }
      : { price: +(300 * (1 + pct / 100)).toFixed(2), prev: 300, volume: 2_000_000, open: 300.9, revealAt: at('09:01:45'), hasLive: true };
  }
  feedQuotes(cap, mis);
  // 09:10 的緩衝（同樣狀態）
  const mis10 = {};
  for (const c in mis) mis10[c] = { ...mis[c], volume: 8_000_000, revealAt: at('09:09:40') };
  mis10['1219'] = { price: 309, prev: 300, volume: 10_000, open: 309, revealAt: at('09:06:00'), hasLive: true };
  feedQuotes(cap, { 1219: mis10['1219'] });
  delete mis10['1219'];
  feedQuotes(cap, mis10);
  const om = pct => ({ basis: 'openSensorMarks-v1', auction: { yi: 150, lots: 120_000 }, day: { yi: 10_000, lots: 12_000_000 }, marks: { m0902: { yi: 10_000 * pct, lots: 700_000, pctYi: pct }, m0910: { yi: 1700, lots: 1_500_000, pctYi: 0.17 } } });
  const baseDays = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const cBase = cBaseOf(baseDays, Object.fromEntries(baseDays.map(d => [d, om(0.0726)])), ['0902', '0910', '0920']);
  return { uni, cap, cBase };
}

test('composeCheck：09:02 ⑥量大權值漲（量為估計）；量＝Q×1000×P̄×ρ÷1e8；未開出只認 v=0', () => {
  const { uni, cap, cBase } = dayFixture();
  const ck = composeCheck({ key: '0902', cap, uni, cBase, H: 8500, rhoMeta: null, env: { ePct: 2.6 }, now: 1 });
  assert.equal(ck.status, 'ok', ck.reasons.join('；'));
  assert.equal(ck.state.key, 'wUpHeavy'); assert.equal(ck.state.label, '⑥ 量大權值漲'); assert.equal(ck.state.lamp, 'red');
  assert.equal(ck.T, '09:02:00'); assert.equal(ck.w.restUp, 29); assert.equal(ck.dom.rule, 'R5');
  assert.equal(ck.vol.label, 'big'); assert.equal(ck.vol.est, true); assert.equal(ck.vol.rho.src, 'prior'); assert.equal(ck.vol.gapDay, true);
  const expect = ck.vol.q.lots * 1000 * ck.vol.px.bar * 0.53 / 1e8;
  assert.ok(Math.abs(ck.vol.vHatYi - expect) < 0.2);
  assert.ok(!('raw' in ck.w) && !('raw' in ck.g), '內部原值不寫入');
  assert.match(checkLine('0902', ck), /⑥ 量大權值漲/);
  const e = eStart({ cap, uni, buf0902: cap.buf['0902'], gMedian: ck.g.median });
  assert.equal(e.eCorr.unopened.n, 1); assert.equal(e.eCorr.unknown.n, 0);
  assert.equal(e.e.tse.revealAt, at('09:02:00')); assert.equal(e.e.basis, 'effOpen0902-v2.1');
  assert.ok(e.eCorr.unopened.capPct >= 0.5); assert.equal(e.eCorr.eFinal, false, 'U 市值占比 ≥ 0.5% ⇒ 要修正');
  const f0 = dayFixture({ unopened: [] });
  assert.equal(eStart({ cap: f0.cap, uni: f0.uni, buf0902: f0.cap.buf['0902'], gMedian: 0.6 }).eCorr.eFinal, true, 'U 為空且 W30 全已成交 ⇒ 免修正');
  // B_0902 沒掃到的股票記 unknown、不修正
  cap.buf['0902'].delete('1102');
  const e2 = eStart({ cap, uni, buf0902: cap.buf['0902'], gMedian: 0.6 });
  assert.equal(e2.eCorr.unknown.n, 1); assert.equal(JSON.parse(e2.eCorr.uJson).tse.includes('1102'), false);
});

test('eStart：O*（個股開盤合成）只在 B_0902 上市市值覆蓋 ≥95% 且 E_tse 成立時合成；不足 ⇒ O*、差、失真寫 null（沒掃到≠沒開出）', () => {
  const full = dayFixture({ unopened: [] });
  const ok = eStart({ cap: full.cap, uni: full.uni, buf0902: full.cap.buf['0902'], gMedian: 0.6 }).e;
  assert.ok(Math.abs(ok.oStarPct - 0.3) < 1e-3, `全掃到：O* 為各檔開盤 +0.30% 的市值加權（${ok.oStarPct}）`);
  assert.equal(ok.officialOpenPct, 0.208);
  assert.ok(Math.abs(ok.distortPp - (0.3 - 0.20833)) < 1e-3); assert.equal(ok.distorted, false);
  const small = dayFixture({ unopened: [] });
  small.cap.buf['0902'].delete('1102');   // 小型股沒掃到：覆蓋仍 ≥ 95%
  assert.equal(typeof eStart({ cap: small.cap, uni: small.uni, buf0902: small.cap.buf['0902'], gMedian: 0.6 }).e.oStarPct, 'number');
  const big = dayFixture({ unopened: [] });
  big.cap.buf['0902'].delete('2330');     // 台積電沒掃到：未掃到市值 > 5%
  const nb = eStart({ cap: big.cap, uni: big.uni, buf0902: big.cap.buf['0902'], gMedian: 0.6 });
  assert.ok(nb.eCorr.unknown.capPct > 5);
  assert.equal(nb.e.oStarPct, null); assert.equal(nb.e.distortPp, null); assert.equal(nb.e.distorted, null);
  assert.equal(nb.e.officialOpenPct, 0.208, '官方開盤照記（事實）');
  // 09:02 前後環不連續（09:03 才開機）⇒ E_tse null ⇒ 不合成
  const lateRing = dayFixture({ unopened: [] });
  lateRing.cap.ringT.splice(0, lateRing.cap.ringT.findIndex(x => x[0] >= at('09:03:00')));
  const nl = eStart({ cap: lateRing.cap, uni: lateRing.uni, buf0902: lateRing.cap.buf['0902'], gMedian: 0.6 }).e;
  assert.equal(nl.tse, null); assert.equal(nl.oStarPct, null); assert.equal(nl.distorted, null);
});

test('eCorrAt：只修正 U（09:02 確定 v=0）且 T 前已開出者', () => {
  const { uni, cap } = dayFixture();
  const s = eStart({ cap, uni, buf0902: cap.buf['0902'], gMedian: 0.6 });
  const u = JSON.parse(s.eCorr.uJson);
  const before = eCorrAt({ T: at('09:05:00'), e: s.e, u, uni, firstOpen: cap.firstOpen });
  assert.equal(before.tse.nOpened, 0); assert.equal(before.tse.addPp, 0);
  const after = eCorrAt({ T: at('09:10:00'), e: s.e, u, uni, firstOpen: cap.firstOpen, genRets0902: genReturns(cap.buf['0902'], uni) });
  assert.equal(after.tse.nOpened, 1);
  assert.ok(Math.abs(after.tse.addPp - uni.tse['1219'].w / 100 * 3) < 1e-3);
  assert.equal(after.tse.pct, +(s.e.tse.pct + after.tse.addPp).toFixed(3));
  assert.ok(after.gen.pp != null);
  assert.equal(eCorrAt({ T: at('09:10:00'), e: s.e, u, uni, firstOpen: cap.firstOpen }).gen, null, '重啟後沒有 09:02 報酬 ⇒ 不算 E′_gen');
});

test('advanceCur：狀態變才補記；E′ 移動 <0.10pp 不加軌跡；nodata 不改 cur；定格後不動', () => {
  const ck = st => ({ status: 'ok', T: '09:10:00', revealAt: 5, state: st });
  const s6 = { key: 'wUpHeavy', label: '⑥ 量大權值漲' }, s3 = { key: 'wUpLight', label: '③ 量縮權值漲' };
  let a = advanceCur(null, { ...ck(s6), T: '09:02:00' }, { eTsePct: 2.18, eGenPct: 0.58, now: 1 });
  assert.equal(a.trail.length, 1); assert.equal(a.cur.key, 'wUpHeavy'); assert.equal(a.cur.eTsePct, 2.18);
  const doc = { cur: a.cur, trail: a.trail };
  a = advanceCur(doc, ck(s6), { eTsePct: 2.25, eGenPct: 0.6, now: 2 });
  assert.equal(a.trail.length, 1, '同狀態、E′ 移動 <0.10pp');
  a = advanceCur(doc, ck(s6), { eTsePct: 2.31, now: 2 });
  assert.equal(a.trail.length, 2); assert.equal(a.trail[1].kind, 'eCorr'); assert.equal(a.cur.eTsePct, 2.31);
  a = advanceCur(doc, ck(s3), { now: 3 });
  assert.equal(a.trail.at(-1).key, 'wUpLight'); assert.equal(a.cur.T, '09:10:00');
  a = advanceCur(doc, { status: 'nodata', T: '09:20:00', reasons: ['restart'] }, { now: 4 });
  assert.equal(a.trail.length, 1); assert.equal(a.cur.key, 'wUpHeavy');
  const fin = advanceCur(doc, ck(s3), { final: true, now: 9 });
  assert.equal(fin.cur.final, true); assert.equal(fin.cur.finalBy, 'r1000'); assert.equal(fin.cur.frozenAt, 9);
  const after = advanceCur({ cur: fin.cur, trail: fin.trail }, ck(s6), { now: 10 });
  assert.equal(after.changed, false); assert.equal(after.cur.key, 'wUpLight');
  const out = advanceCur(null, ck({ key: 'outside', label: '不在狀態內（權值未表態）', outsideReason: 'wUnstated', cell: {} }), { now: 7 });
  assert.deepEqual(out.outside, { cells: ['wUnstated'], firstAt: 7 });
});

test('寫入時序（模擬 db）：首判三分支、快照寫一次、trail 只在變時追加、定格、盤型、timeout、indexRing、universe、post', async () => {
  const db = fakeDb();
  const os = createOpenSensorStore(db);
  const { uni, cap, cBase } = dayFixture();
  const base = docBase({ date: D, dateSrc: 't00', params: { H: 8500 }, universe: { liquidN: uni.liquid.length }, now: 1 });
  // 盤前 0 寫入
  assert.equal(db.writes.length, 0);
  const c0902 = composeCheck({ key: '0902', cap, uni, cBase, H: 8500, rhoMeta: null, env: { ePct: 2.6 }, now: 2 });
  const s = eStart({ cap, uni, buf0902: cap.buf['0902'], gMedian: c0902.g.median });
  const r1 = await os.txDay(D, doc => decideFirst(doc, { base, check: c0902, e: s.e, eCorr: s.eCorr, ticksJson: '[]', now: 2 }));
  assert.equal(r1.wrote, true);
  let doc = await os.readDay(D);
  assert.equal(doc.basis, BASIS); assert.equal(doc.mode, 'shadow'); assert.equal(doc.dateSrc, 't00');
  assert.equal(doc.c0902.state.key, 'wUpHeavy'); assert.equal(doc.trail.length, 1); assert.equal(doc.checks.e.tse.revealAt, at('09:02:00'));
  // 已有 c0902 ⇒ 跳過（重啟不可覆蓋）
  const r2 = await os.txDay(D, d => decideFirst(d, { base, check: { ...c0902, status: 'undetermined' }, now: 3 }));
  assert.equal(r2.wrote, false);
  // 複判 09:10：同狀態 ⇒ 只寫快照、不加軌跡
  const c0910 = composeCheck({ key: '0910', cap, uni, cBase, H: 8500, rhoMeta: null, now: 4 });
  assert.equal(c0910.state.key, 'wUpHeavy');
  const eAt = eCorrAt({ T: at('09:10:00'), e: s.e, u: JSON.parse(s.eCorr.uJson), uni, firstOpen: cap.firstOpen });
  await os.txDay(D, d => decideRecheck(d, { base, key: '0910', check: c0910, eAt, now: 4 }));
  doc = await os.readDay(D);
  assert.ok(doc.rechecks.r0910); assert.equal(doc.trail.filter(t => t.kind === 'state').length, 1);
  assert.equal(doc.eCorr.tse.length, 1); assert.equal(doc.c0902.state.key, 'wUpHeavy', 'merge 不動既有快照');
  assert.equal((await os.txDay(D, d => decideRecheck(d, { base, key: '0910', check: c0910, now: 5 }))).wrote, false, '同一檢查點只寫一次');
  // 09:20：狀態改變 ⇒ 補記；盤型同筆寫入
  const changed = { ...c0910, T: '09:20:00', state: { ...c0910.state, key: 'wUpLight', label: '③ 量縮權值漲' } };
  await os.txDay(D, d => decideRecheck(d, { base, key: '0920', check: changed, pattern: { T: '09:20:00', lines: {} }, now: 6 }));
  doc = await os.readDay(D);
  assert.equal(doc.trail.at(-1).key, 'wUpLight'); assert.equal(doc.cur.key, 'wUpLight'); assert.ok(doc.checks.c0920);
  assert.equal(await os.txDay(D, d => decidePattern(d, { base, key: '0920', pattern: { x: 1 } })).then(r => r.wrote), false);
  // 09:30 重啟逾窗 ⇒ nodata：不改 cur、不加軌跡
  await os.txDay(D, d => decideRecheck(d, { base, key: '0930', check: nodataCheck('0930', ['restart'], 7), now: 7 }));
  doc = await os.readDay(D);
  assert.equal(doc.rechecks.r0930.status, 'nodata'); assert.equal(doc.cur.key, 'wUpLight');
  // 10:00 定格
  await os.txDay(D, d => decideRecheck(d, { base, key: '1000', check: { ...changed, T: '10:00:00' }, final: true, now: 8 }));
  doc = await os.readDay(D);
  assert.equal(doc.cur.final, true); assert.equal(doc.cur.finalBy, 'r1000');
  assert.equal((await os.txDay(D, d => decideTimeoutFinal(d, { now: 9 }))).wrote, false, '已定格不再 timeout');
  assert.equal(await os.countOutside(D, doc.cur, 9), true);
  assert.equal(await os.countOutside(D, doc.cur, 9), false, 'countedDates 冪等');
  // 10:05 indexRing 寫一次；不建 orderFlowArchive/{date}
  const ring = buildIndexRing(cap);
  assert.equal((await os.txDay(D, d => decideIndexRing(d, { base, indexRing: ring }))).wrote, true);
  assert.equal((await os.txDay(D, d => decideIndexRing(d, { base, indexRing: ring }))).wrote, false);
  assert.ok(!db.store.has(`orderFlowArchive/${D}`));
  assert.equal(await os.copyIndexMarks(D, indexMarksFromRing(ring)), 'noDoc', '15:25 前不建空殼');
  db.store.set(`orderFlowArchive/${D}`, { date: D, tradeValue: 1_000_000, curveJson: '[]' });
  assert.equal(await os.copyIndexMarks(D, indexMarksFromRing(ring, { t: '13:30:00', v: 48500 })), 'written');
  assert.equal(await os.copyIndexMarks(D, indexMarksFromRing(ring)), 'exists');
  assert.equal(db.store.get(`orderFlowArchive/${D}`).curveJson, '[]', 'merge 不動既有欄位');
  // universe create() 一次
  assert.equal(await os.createUniverse(D, { date: D }), 'created');
  assert.equal(await os.createUniverse(D, { date: D, x: 2 }), 'exists');
  // post 寫一次
  const openMarks = { basis: 'openSensorMarks-v1', marks: { m0902: { yi: 1009.36, lots: 676_231 }, m0910: { yi: 1700, lots: 1_500_000 } } };
  const post = computePost({ doc, openMarks, A: 11508, H: 8500, now: 10 });
  assert.equal(post.label, 'big'); assert.ok(post.rhoRatio.m0902 > 0); assert.ok('m0902' in post.errRatio);
  assert.equal((await os.txDay(D, d => decidePost(d, { post }))).wrote, true);
  assert.equal((await os.txDay(D, d => decidePost(d, { post }))).wrote, false);
  assert.equal(decidePost(null, { post }), null, '沒有文件不建 post');
  // ρ meta 同日不重複；threshold 同 asOf 跳過
  assert.equal(await os.appendRho(D, post.rhoRatio, 11), Object.keys(post.rhoRatio).length);
  assert.equal(await os.appendRho(D, post.rhoRatio, 12), 0);
  assert.equal(await os.writeThreshold({ ok: true, H: 8500, asOf: D, history: [] }, 13), true);
  assert.equal(await os.writeThreshold({ ok: true, H: 8500, asOf: D, history: [] }, 14), false);
});

test('timeout 定格：r1000 缺席時以當時 cur 定格；沒有 cur 也能定格（key null）', () => {
  assert.deepEqual(decideTimeoutFinal({ cur: { key: 'wUpHeavy', label: 'x', T: '09:50:00' } }, { now: 5 }).cur.finalBy, 'timeout');
  assert.equal(decideTimeoutFinal({ c0902: { status: 'nodata' } }, { now: 5 }).cur.key, null);
  assert.equal(decideTimeoutFinal(null, { now: 5 }), null);
});

test('statsAfterFinal／rhoMetaAfter：計數規則', () => {
  const st = statsAfterFinal(null, D, { key: 'outside:big|all|down', final: true }, 1);
  assert.deepEqual(st.cells, { 'big|all|down': { n: 1, dates: [D] } });
  assert.equal(statsAfterFinal(st, D, { key: 'outside:big|all|down', final: true }, 2), null);
  assert.equal(statsAfterFinal(st, '2026-10-09', { key: 'volPending', final: true }, 2).pending.n, 1);
  assert.equal(statsAfterFinal(null, D, { key: 'wUpHeavy', final: false }, 1), null);
  const rm = rhoMetaAfter({ live: { m0902: Array.from({ length: 20 }, (_, i) => ({ d: `x${i}`, rho: 0.5 })) } }, D, { m0902: 0.55 }, 1);
  assert.equal(rm.live.m0902.length, 20); assert.equal(rm.live.m0902.at(-1).rho, 0.55); assert.equal(rm.added, 1);
});
