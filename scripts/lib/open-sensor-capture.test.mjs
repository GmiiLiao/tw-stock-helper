// 開盤感應器 v2.1 擷取緩衝、t00 環、價格樣本（design-v2.1 §4.2、§5.1、§5.2、§12.4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCapture, feedQuotes, feedIndex, freeze, qAt, qAuction, priceSample, sumValue, buildIndexRing, ticksJsonAround, officialOpenOf } from './open-sensor-capture.mjs';
import { tpeMs } from './open-sensor-params.mjs';

const D = '2026-10-08';
const at = hms => tpeMs(D, hms);
const quote = (price, revealAt, extra = {}) => ({ price, prev: 100, volume: 1_000_000, open: 100.5, revealAt, hasLive: true, ...extra });

test('B_T：揭示 > T 不收、揭示 < T−120 秒不收、同檔以揭示較新者為準、凍結後不再更新', () => {
  const cap = createCapture(D);
  feedQuotes(cap, { 2330: quote(101, at('09:02:05')) });
  assert.equal(cap.buf['0902'].has('2330'), false, '揭示晚於 T');
  assert.equal(cap.buf['0910'].has('2330'), false, '揭示早於 09:10 的 T−120 秒');
  feedQuotes(cap, { 2330: quote(102, at('09:01:40')) });
  feedQuotes(cap, { 2330: quote(101.5, at('09:01:20')) });   // 較舊的晚到 ⇒ 不覆蓋
  assert.equal(cap.buf['0902'].get('2330').p, 102);
  assert.equal(cap.buf['0903'].get('2330').p, 101);          // 09:03 的窗：09:02:05 那筆較新
  feedQuotes(cap, { 2330: quote(103, at('09:01:59')) });
  assert.equal(cap.buf['0902'].get('2330').p, 103);
  freeze(cap, '0902');
  feedQuotes(cap, { 2330: quote(104, at('09:02:00')) });
  assert.equal(cap.buf['0902'].get('2330').p, 103, '凍結後不更新');
  assert.equal(cap.buf['0903'].get('2330').p, 101, '09:03 的窗仍以揭示較新（09:02:05）者為準');
  feedQuotes(cap, { t00: quote(1, at('09:01:00')), '2330A': quote(1, at('09:01:00')) });
  assert.equal(cap.buf['0902'].has('t00'), false);
});

test('未成交（v=0）的報價也進緩衝（E′ 判 U 用）；首見開盤只記今日有量者', () => {
  const cap = createCapture(D);
  feedQuotes(cap, { 1101: { price: 30, prev: 30, volume: 0, open: 0, revealAt: at('09:01:50'), hasLive: false } });
  assert.equal(cap.buf['0902'].get('1101').v, 0);
  assert.equal(cap.firstOpen.has('1101'), false);
  feedQuotes(cap, { 1101: { price: 30.5, prev: 30, volume: 5000, open: 30.4, revealAt: at('09:06:00'), hasLive: true } });
  assert.deepEqual(cap.firstOpen.get('1101'), { o: 30.4, y: 30, r: at('09:06:00') });
});

test('t00 環：只在揭示前進時推；範圍 09:00:00–10:03:00；Q(T) 線性內插；兩拍相距過久不內插', () => {
  const cap = createCapture(D);
  const t = (hms, z, m) => ({ price: z, prev: 48475.74, mVal: m, open: 48574.95, revealAt: at(hms), realTrade: true });
  assert.equal(feedIndex(cap, 't', t('08:59:55', 48475.74, 0)), false);
  assert.equal(feedIndex(cap, 't', t('09:00:00', 48475.74, 0)), true);
  assert.equal(feedIndex(cap, 't', t('09:00:05', 48574.95, 128258)), true);
  assert.equal(feedIndex(cap, 't', t('09:00:05', 48574.95, 128258)), false, '同一揭示時間不重推');
  feedIndex(cap, 't', t('09:01:55', 49400, 600000));
  feedIndex(cap, 't', t('09:02:05', 49530, 700000));
  assert.deepEqual(qAuction(cap.ringT, D), { lots: 128258, revealAt: at('09:00:05') });
  const q = qAt(cap.ringT, at('09:02:00'));
  assert.equal(q.lots, 650000);
  assert.equal(qAt(cap.ringT, at('09:03:00')), null, '沒有拍子夾住 T');
  feedIndex(cap, 't', t('09:05:00', 49600, 900000));
  assert.equal(qAt(cap.ringT, at('09:03:00')), null, '前後兩拍相距 > 90 秒不內插');
  assert.deepEqual(officialOpenOf(cap.ringT), { v: 48574.95, y: 48475.74 });
  assert.equal(JSON.parse(ticksJsonAround(cap.ringT, D)).length, 2);
  assert.equal(feedIndex(cap, 't', t('10:03:00', 49700, 5_000_000)), true, '環收到揭示 10:03:00（含）');
  assert.equal(feedIndex(cap, 't', t('10:03:05', 49710, 5_010_000)), false, '揭示 10:03:00 之後不收（indexRing 在 10:03:30 寫出）');
});

test('Q_auc 只認開盤當下那一拍：環缺開盤段（重啟、停機）⇒ null，不拿較晚的累積量頂替', () => {
  const t = (hms, m) => ({ price: 48500, prev: 48475.74, mVal: m, open: 48574.95, revealAt: at(hms), realTrade: true });
  const ok = createCapture(D);
  feedIndex(ok, 't', t('09:00:00', 0)); feedIndex(ok, 't', t('09:00:05', 128258)); feedIndex(ok, 't', t('09:00:10', 150000));
  assert.deepEqual(qAuction(ok.ringT, D), { lots: 128258, revealAt: at('09:00:05') }, '前面有 m＝0 的昨收回音');
  const first = createCapture(D);   // 09:00:02 開機：看到的第一拍就是開盤後第一次更新
  feedIndex(first, 't', t('09:00:05', 128258)); feedIndex(first, 't', t('09:00:10', 150000));
  assert.deepEqual(qAuction(first.ringT, D), { lots: 128258, revealAt: at('09:00:05') });
  const late = createCapture(D);    // 09:00:07 開機：第一拍 09:00:10 已含連續競價量
  feedIndex(late, 't', t('09:00:10', 150000));
  assert.equal(qAuction(late.ringT, D), null);
  const restart = createCapture(D); // 09:25 重啟
  feedIndex(restart, 't', t('09:24:25', 7_445_000)); feedIndex(restart, 't', t('09:24:30', 7_450_000));
  assert.equal(qAuction(restart.ringT, D), null, 'reviewer 試算：舊版會把 7,445,000 張當開盤競價量');
  const stall = createCapture(D);   // 有回音，但第一個 m>0 拍已在 09:00:30 之後
  feedIndex(stall, 't', t('09:00:00', 0)); feedIndex(stall, 't', t('09:00:45', 400000));
  assert.equal(qAuction(stall.ringT, D), null);
});

test('buildIndexRing：重啟後環缺開盤段 ⇒ open／e 為 null，只留 gaps（不把 09:19 那拍記成開盤）', () => {
  const cap = createCapture(D);
  const t = (ms, z) => ({ price: z, prev: 48475.74, mVal: 9_000_000, open: 48574.95, revealAt: ms, realTrade: true });
  for (let r = at('09:19:25'); r <= at('10:03:00'); r += 5000) feedIndex(cap, 't', t(r, 48600));
  const ring = buildIndexRing(cap);
  assert.equal(ring.open, null);
  assert.equal(ring.e, null);
  assert.equal(ring.ref0900, null);
  assert.deepEqual(ring.gaps, ['09:00:00–09:19:25']);
  assert.equal(ring.taiex.m0902, null);
  assert.deepEqual(ring.taiex.m0930, { t: '09:30:00', v: 48600 }, '之後的檢查點照實記（附實際揭示時間）');
});

test('priceSample：30 秒窗不過 GV 依序放寬到 60、120；缺台積電就放寬；三窗皆不過 ⇒ pxSample', () => {
  const T = at('09:02:00');
  const w30 = Array.from({ length: 30 }, (_, i) => (i === 0 ? '2330' : String(2400 + i)));
  const opts = { T, sample: new Set([...w30, '0050', '3000']), w30Set: new Set(w30), liquidSet: new Set(['3000']), qLots: 1000 };
  const buf = new Map();
  w30.forEach((c, i) => buf.set(c, { p: 100, y: 100, v: 20_000, r: T - (i < 21 ? 50_000 : 10_000), live: true }));
  buf.set('2330', { p: 1000, y: 1000, v: 20_000, r: T - 100_000, live: true });   // 台積電只在 120 秒窗
  buf.set('3000', { p: 50, y: 50, v: 100_000, r: T - 5_000, live: true });
  buf.set('9999', { p: 1, y: 1, v: 1e9, r: T - 1_000, live: true });              // 不在樣本宇宙
  buf.set('0050', { p: 100, y: 100, v: 1e6, r: T + 1_000, live: true });         // 揭示 > T 不收
  const px = priceSample(buf, opts);
  assert.equal(px.ok, true); assert.equal(px.win, 120); assert.equal(px.hasTsmc, true); assert.equal(px.w30n, 30);
  assert.deepEqual(px.tried.map(x => x.win), [30, 60, 120]);
  const sv = 29 * 20_000 + 20_000 + 100_000;
  assert.ok(Math.abs(px.bar - (29 * 20_000 * 100 + 20_000 * 1000 + 100_000 * 50) / sv) < 1e-9);
  assert.equal(px.volLots, Math.round(sv / 1000));
  buf.set('2330', { p: 1000, y: 1000, v: 20_000, r: T - 10_000, live: true });
  const p60 = priceSample(buf, opts);   // 30 秒窗只有 10 檔 W30 ⇒ 放寬到 60 秒
  assert.equal(p60.ok, true); assert.equal(p60.win, 60); assert.equal(p60.tried[0].w30n, 10);
  const none = priceSample(buf, { ...opts, qLots: 10_000_000 });   // Σv < 0.25×Q×1000
  assert.equal(none.ok, false); assert.equal(none.reason, 'pxSample');
  buf.delete('0050');   // 真實緩衝不會有揭示 > T 的報價（feedQuotes 擋掉）
  assert.deepEqual(sumValue(buf, opts.sample), { yi: +((29 * 20_000 * 100 + 20_000 * 1000 + 100_000 * 50) / 1e8).toFixed(2), n: 31 });
});

test('buildIndexRing：鍵名對齊 deriveIndexMarks；缺段列 gaps、不補值', () => {
  const cap = createCapture(D);
  const t = (hms, z, m) => ({ price: z, prev: 48475.74, mVal: m, open: 48574.95, revealAt: at(hms), realTrade: true });
  feedIndex(cap, 't', t('09:00:00', 48475.74, 0));
  for (let s = 5; s <= 600; s += 5) feedIndex(cap, 't', t(new Date(at('09:00:00') + s * 1000 + 8 * 3600e3).toISOString().slice(11, 19), 48500 + s, s * 1000));
  const ring = buildIndexRing(cap);
  assert.equal(ring.basis, 'openSensorIndexRing-v1'); assert.equal(ring.src, 'mis_t00_ring');
  assert.deepEqual(ring.ref0900, { t: '09:00:00', v: 48475.74 });
  assert.deepEqual(ring.open, { t: '09:00:05', v: 48574.95 });
  assert.deepEqual(ring.e, { t: '09:02:00', v: 48620 });
  assert.deepEqual(ring.taiex.m0902, { t: '09:02:00', v: 48620 });
  assert.equal(ring.taiex.m0930, ring.taiex.m1000 && ring.taiex.m0930);
  assert.deepEqual(ring.gaps, ['09:10:00–10:03:00'], '09:10 之後缺段（算到環的終點 10:03:00）');
  assert.equal(JSON.parse(ring.minJson).length, 61);
  assert.equal(ring.otc, null);
  assert.equal(ring.n, 121);
});
