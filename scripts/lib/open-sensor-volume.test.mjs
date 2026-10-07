// 開盤感應器 v2.1 量軸：比率估計、ρ、c(T) 基準、門檻區段表（design-v2.1 §4、§12.4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateVolume, rhoFor, cBaseOf, segIndex, replayThreshold, thresholdStep } from './open-sensor-volume.mjs';
import { H_SEGS } from './open-sensor-params.mjs';

const pxOk = (bar = 80) => ({ ok: true, bar, win: 30, n: 700, volLots: 400_000, hasTsmc: true, w30n: 28 });

test('estimateVolume：V̂＝Q(張)×1000×P̄(元/股)×ρ÷1e8（億元）；E1＝V̂÷c；est ≥ H ⇒ big', () => {
  const v = estimateVolume({ q: { lots: 676_231, revealAt: 1 }, qAuc: { lots: 128_258 }, px: pxOk(80), rho: { v: 0.53, src: 'prior', n: 0 }, cb: { c: 0.0726, n: 20, lam: 1.4, cCont: 0.06 }, cN: 20, H: 8500 });
  const vHat = 676_231 * 1000 * 80 * 0.53 / 1e8;   // ≈ 286.7 億
  assert.equal(v.vHatYi, +vHat.toFixed(1));
  assert.equal(v.estYi, Math.round(vHat / 0.0726));
  assert.equal(v.label, vHat / 0.0726 >= 8500 ? 'big' : 'small');
  assert.equal(v.segThYi, +(8500 * 0.0726).toFixed(1));   // 同時段門檻 Th＝H×c(T)
  assert.equal(v.est, true); assert.equal(v.reason, null);
  assert.ok(v.estE2Yi > 0, 'E2 只當事實');
  const big = estimateVolume({ q: { lots: 676_231, revealAt: 1 }, qAuc: null, px: pxOk(300), rho: { v: 0.53, src: 'prior', n: 0 }, cb: { c: 0.0726, n: 20 }, cN: 20, H: 8500 });
  assert.equal(big.label, 'big');
  assert.equal(big.estE2Yi, null);
});

test('estimateVolume：量未定只在輸入缺漏（c 基準 <5、Q、價格樣本、ρ）', () => {
  const base = { q: { lots: 100, revealAt: 1 }, qAuc: null, px: pxOk(), rho: { v: 0.53, src: 'prior', n: 0 }, cb: { c: 0.07, n: 4 }, cN: 4, H: 8500 };
  assert.equal(estimateVolume(base).label, 'pending');
  assert.equal(estimateVolume(base).reason, 'cBase');
  assert.equal(estimateVolume({ ...base, cN: 5, cb: { c: 0.07, n: 5 }, q: null }).reason, 'q');
  assert.equal(estimateVolume({ ...base, cN: 5, cb: { c: 0.07, n: 5 }, px: { ok: false, reason: 'pxSample' } }).reason, 'pxSample');
  const vs = estimateVolume({ ...base, vSum: { yi: 1234.5, n: 900 } });
  assert.deepEqual(vs.vSum, { yi: 1234.5, n: 900 });   // 加總法只當伴隨值
  assert.equal(estimateVolume({ ...base, cN: 5, cb: { c: 0.07, n: 5 }, ePct: 1.2 }).gapDay, true);
});

test('rhoFor：先驗 0.53；該檢查點滿 5 日實測才切 live（近 20 日中位）', () => {
  assert.deepEqual(rhoFor('0902', null), { v: 0.53, src: 'prior', n: 0 });
  const four = { live: { m0902: [0.5, 0.52, 0.54, 0.56].map((rho, i) => ({ d: `2026-10-0${i + 1}`, rho })) } };
  assert.equal(rhoFor('0902', four).src, 'prior');
  const five = { live: { m0902: [...four.live.m0902, { d: '2026-10-08', rho: 0.6 }] } };
  assert.deepEqual(rhoFor('0902', five), { v: 0.54, src: 'live', n: 5 });
  assert.equal(rhoFor('0910', five).src, 'prior');   // 各檢查點各自計
});

test('cBaseOf：缺 openMarks 的日子排除、列入 missing；不向前延伸；n<5 不可用', () => {
  const om = pct => ({ basis: 'openSensorMarks-v1', auction: { yi: 150, lots: 120_000 }, day: { yi: 10_000, lots: 12_000_000 }, marks: { m0902: { yi: 10_000 * pct, lots: 600_000, pctYi: pct } } });
  const days = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'];
  const byDate = { '2026-09-29': om(0.07), '2026-09-30': om(0.075), '2026-10-01': { basis: 'other' }, '2026-10-02': om(0.072), '2026-10-05': om(0.0877), '2026-10-06': null };
  const cb = cBaseOf(days, byDate, ['0902', '0910']);
  assert.equal(cb.n, 4);
  assert.deepEqual(cb.missing, ['2026-10-01', '2026-10-06']);
  assert.equal(cb.from, '2026-09-29'); assert.equal(cb.to, '2026-10-06');
  assert.equal(cb.byKey['0902'].n, 4);
  assert.equal(cb.byKey['0902'].c, +((0.072 + 0.075) / 2).toFixed(5));
  assert.equal(cb.byKey['0910'].n, 0); assert.equal(cb.byKey['0910'].c, null);
  const v = estimateVolume({ q: { lots: 1, revealAt: 1 }, px: pxOk(), rho: { v: 0.53 }, cb: cb.byKey['0902'], cN: cb.byKey['0902'].n, H: 8500 });
  assert.equal(v.label, 'pending');
});

test('segIndex：五段邊界左閉右開', () => {
  assert.equal(H_SEGS[segIndex(7249.9)].H, 7650);
  assert.equal(H_SEGS[segIndex(7250)].H, 8000);
  assert.equal(H_SEGS[segIndex(8249.99)].H, 8000);
  assert.equal(H_SEGS[segIndex(8250)].H, 8500);
  assert.equal(H_SEGS[segIndex(9250)].H, 9000);
  assert.equal(H_SEGS[segIndex(10249)].H, 9000);
  assert.equal(H_SEGS[segIndex(10250)].H, 9350);
});

test('thresholdStep：同一新段連 3 日才換、下一交易日生效；回到原段歸零；換到另一新段重新計數', () => {
  const hol = new Set();
  let st = thresholdStep({ state: null, streak: null }, 2, '2026-10-01', hol);
  assert.equal(st.state.H, 8500); assert.equal(st.state.effectiveFrom, '2026-10-02');
  st = thresholdStep(st, 3, '2026-10-02', hol); assert.equal(st.state.H, 8500); assert.equal(st.streak.n, 1);
  st = thresholdStep(st, 3, '2026-10-05', hol); assert.equal(st.streak.n, 2);
  const back = thresholdStep(st, 2, '2026-10-06', hol);            // 回到原段 ⇒ 歸零
  assert.equal(back.streak, null); assert.equal(back.state.H, 8500);
  const other = thresholdStep(st, 4, '2026-10-06', hol);           // 換到另一新段 ⇒ 重新計數
  assert.equal(other.streak.seg, 4); assert.equal(other.streak.n, 1); assert.equal(other.state.H, 8500);
  st = thresholdStep(st, 3, '2026-10-06', hol);                    // 同一新段第 3 日 ⇒ 換段、下一交易日生效
  assert.equal(st.switched, true); assert.equal(st.state.H, 9000); assert.equal(st.state.effectiveFrom, '2026-10-07');
  assert.equal(st.streak, null);
  assert.equal(thresholdStep(st, 2, '2026-10-08', new Set(['2026-10-09'])).streak.n, 1);
});

test('replayThreshold：A 缺日不計（記入 gaps）；最後一個交易日沒有 A ⇒ stale；不足 60 日不可用', () => {
  const days = Array.from({ length: 64 }, (_, i) => { const d = new Date(Date.UTC(2026, 0, 5)); d.setUTCDate(d.getUTCDate() + Math.floor(i / 5) * 7 + (i % 5)); return d.toISOString().slice(0, 10); });
  const aMap = Object.fromEntries(days.map(d => [d, 8800]));
  delete aMap[days[61]];
  let rep = replayThreshold({ days: days.slice(0, 63), aMap, holidays: new Set() });
  assert.equal(rep.H, 8500); assert.ok(rep.gaps.includes(days[61])); assert.equal(rep.stale, false);
  rep = replayThreshold({ days: days.slice(0, 62), aMap, holidays: new Set() });
  assert.equal(rep.stale, true);
  assert.equal(replayThreshold({ days: days.slice(0, 59), aMap, holidays: new Set() }).ok, false);
});

// 本機 orderFlowArchive（MI_5MINS 13:30 累積成交金額÷100，億元）2026-04-01 至 10-06〔實測〕
const A_SERIES = [['0401', 6161.22], ['0402', 6729.07], ['0407', 5643.42], ['0408', 8562.6], ['0409', 8442.86], ['0410', 8295.37], ['0413', 7787.66], ['0414', 9717.31], ['0415', 9820.05], ['0416', 8867.92], ['0417', 9431.19], ['0420', 9199.77], ['0421', 9815.25], ['0422', 9460.33], ['0423', 14014.97], ['0424', 10329.2], ['0427', 11844.5], ['0428', 10002.96], ['0429', 8750.76], ['0430', 10220.37], ['0504', 10068.87], ['0505', 9976.43], ['0506', 14491.48], ['0507', 11943.41], ['0508', 12450.02], ['0511', 11135.27], ['0512', 13789.84], ['0513', 12038.12], ['0514', 12167.78], ['0515', 13141.08], ['0518', 9904.66], ['0519', 10880.73], ['0520', 9789.23], ['0521', 10129.31], ['0522', 11884.32], ['0525', 13013.25], ['0526', 14732.23], ['0527', 15568.44], ['0528', 15904.76], ['0529', 18164.5], ['0601', 14770.85], ['0602', 16075.83], ['0603', 14508.77], ['0604', 12388.14], ['0605', 12294], ['0608', 11325.31], ['0609', 11519.3], ['0610', 13240.93], ['0611', 12579.75], ['0612', 11176.45], ['0615', 10639.92], ['0616', 11977.9], ['0617', 11020.51], ['0618', 15439.24], ['0622', 14414.68], ['0623', 16008.56], ['0624', 14536.18], ['0625', 13093.94], ['0626', 15498.28], ['0629', 9975.14], ['0630', 12033.23], ['0701', 13019.72], ['0702', 10163.6], ['0703', 10155.7], ['0706', 10196.66], ['0707', 11696.26], ['0708', 9583.46], ['0709', 9443.41], ['0713', 10257.16], ['0714', 11786.17], ['0715', 9840.81], ['0716', 9008.38], ['0717', 12129.57], ['0720', 9838.63], ['0721', 8356.24], ['0722', 9826.45], ['0723', 8925.15], ['0724', 7924.35], ['0727', 7176.86], ['0728', 8094.82], ['0729', 10835.69], ['0730', 11036.86], ['0731', 8337.13], ['0803', 8445.31], ['0804', 10362.81], ['0805', 11441.62], ['0806', 9403.91], ['0807', 8192.04], ['0810', 8473.72], ['0811', 8690.16], ['0812', 8587.32], ['0813', 10498], ['0814', 10645.11], ['0817', 9420.25], ['0818', 9584.43], ['0819', 8478.57], ['0820', 7929.62], ['0821', 7192.8], ['0824', 6294.27], ['0825', 6960.54], ['0826', 8042.49], ['0827', 9246.83], ['0828', 10230.44], ['0831', 12017.92], ['0901', 10810.25], ['0902', 9183.93], ['0903', 9462.71], ['0904', 8256.26], ['0907', 9399.26], ['0908', 8766.62], ['0909', 7735.06], ['0910', 7139.72], ['0911', 7219.08], ['0914', 6309.17], ['0915', 6034.53], ['0916', 6437.65], ['0917', 8194.05], ['0918', 10750.65], ['0921', 8202.15], ['0922', 10215.69], ['0923', 8559.53], ['0924', 7366.23], ['0929', 7850.39], ['0930', 8756.72], ['1001', 8374.31], ['1002', 8981.74], ['1005', 11508.04], ['1006', 9759.35]];

test('replayThreshold：用 10/06 為止的 A 重現 H＝8,500（M60＝8,762）〔實測〕', () => {
  const days = A_SERIES.map(([md]) => `2026-${md.slice(0, 2)}-${md.slice(2)}`);
  const aMap = Object.fromEntries(A_SERIES.map(([md, a]) => [`2026-${md.slice(0, 2)}-${md.slice(2)}`, a]));
  const rep = replayThreshold({ days, aMap, holidays: new Set() });
  assert.equal(rep.ok, true);
  assert.equal(rep.H, 8500);
  assert.equal(Math.round(rep.m60), 8762);
  assert.deepEqual(rep.seg, [8250, 9250]);
  assert.equal(rep.asOf, '2026-10-06'); assert.equal(rep.stale, false);
  assert.equal(rep.streak, null);
  // 7/31 當時的 H（錨點：A 8,337 < 當時 H 9,350）
  const upTo = d => replayThreshold({ days: days.filter(x => x <= d), aMap, holidays: new Set() });
  assert.equal(upTo('2026-07-30').H, 9350);
});
