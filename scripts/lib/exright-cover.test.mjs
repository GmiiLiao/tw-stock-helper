// 榜單用官方除權息係數 單元測試：node --test scripts/lib/exright-cover.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustItemsFor, createExrightCover } from './exright-cover.mjs';
import { applyPriceFactors, factorsFromItems } from './price-factors.mjs';

const H = { from: '2022-07-01', to: '2026-09-30', items: [['2026-07-01', '2330', 0.99], ['2026-09-30', '01004T', 0.977384]] };

test('adjustItemsFor：歷史檔＋近期區間＋priceEvents 合併；同檔同日以官方為準；事件日晚於 asOf 不收（官方前一晚公布隔日除權息）', () => {
  const recent = [['2026-10-01', '9927', 0.928673], ['2026-10-02', '1111', 0.95]];
  const pf = { 9927: [{ date: '2026-10-01', factor: 0.5 }], 5555: [{ date: '2026-08-01', factor: 2 }], 6666: [{ date: '2026-10-02', factor: 3 }] };
  const r = adjustItemsFor({ history: H, recent, recentRange: { from: '2026-10-01', to: '2026-10-02' }, priceFactors: pf, from: '2026-09-01', asOf: '2026-10-01' });
  const key = e => `${e.date}:${e.code}:${e.factor}`;
  assert.deepEqual(r.items.map(key).sort(), ['2026-07-01:2330:0.99', '2026-08-01:5555:2', '2026-09-30:01004T:0.977384', '2026-10-01:9927:0.928673'].sort());
  assert.equal(r.meta.exrightOk, true, '涵蓋到 10-02 ≥ asOf');
  assert.equal(r.meta.exright, 2, '(from, asOf] 內有除權息的檔：01004T、9927');
});

test('adjustItemsFor：近期區間取不到 ⇒ 涵蓋停在歷史檔尾、exrightOk=false，仍回歷史檔＋priceEvents', () => {
  const r = adjustItemsFor({ history: H, recent: null, recentRange: null, priceFactors: { 5555: [{ date: '2026-08-01', factor: 2 }] }, from: '2026-09-01', asOf: '2026-10-05' });
  assert.equal(r.meta.exrightOk, false); assert.equal(r.meta.exrightTo, '2026-09-30');
  assert.equal(r.items.length, 3);
});

test('adjustItemsFor：歷史檔讀不到 ⇒ 只剩 priceEvents（同舊行為）且 exrightOk=false', () => {
  const r = adjustItemsFor({ history: null, priceFactors: { 5555: [{ date: '2026-08-01', factor: 2 }], 6666: [{ date: '2026-10-09', factor: 3 }] }, from: '2026-09-01', asOf: '2026-10-05' });
  assert.deepEqual(r.items, [{ date: '2026-08-01', code: '5555', factor: 2 }]);
  assert.deepEqual(r.meta, { exright: 0, exrightOk: false, exrightTo: null });
});

test('除息還原（官方係數）：除息日漲跌＝對參考價、最新收盤不變；尚未發生的除息不乘（ad5a3be 測試移植）', () => {
  // 9927 泰銘 2026-10-01 除息 5 元：前收 70.10 → 參考價 65.10（TWT49U 實際列）；假設除息日收 66.00
  const f = +(65.10 / 70.10).toFixed(6);
  const days = [{ date: '2026-09-29', m: { 9927: [69.5, 1, 69, 70, 69] } }, { date: '2026-09-30', m: { 9927: [70.1, 1, 69.5, 70.5, 69.4] } }, { date: '2026-10-01', m: { 9927: [66, 1, 65.2, 66.3, 65] } }];
  const src = { history: H, recent: [['2026-10-01', '9927', f]], recentRange: { from: '2026-10-01', to: '2026-10-01' } };
  const adj = applyPriceFactors(days, factorsFromItems(adjustItemsFor({ ...src, from: '2026-09-29', asOf: '2026-10-01' }).items));
  const chg = (adj[2].m['9927'][0] / adj[1].m['9927'][0] - 1) * 100;
  assert.ok((days[2].m['9927'][0] / days[1].m['9927'][0] - 1) * 100 < -5, '未還原＝假跌');
  assert.ok(Math.abs(chg - (66 / 65.1 - 1) * 100) < 0.02, `還原後＝對參考價 ${chg.toFixed(2)}%`);
  assert.equal(adj[2].m['9927'][0], 66, '最新收盤不變');
  const early = applyPriceFactors(days.slice(0, 2), factorsFromItems(adjustItemsFor({ ...src, from: '2026-09-29', asOf: '2026-09-30' }).items));
  assert.equal(early[1].m['9927'][0], 70.1, '9/30 盤後已知 10/01 除息，但 10/01 還沒發生 ⇒ 9/30 收盤不可改成參考價');
});

test('createExrightCover：asOf ≤ 歷史檔尾不打上游；之後抓「檔尾隔日～asOf」一次並記憶化；失敗 retryMs 內不重打', async () => {
  let t = 0; const calls = [];
  let fail = false;
  const cover = createExrightCover({ readHistory: () => H, now: () => t, retryMs: 600_000,
    fetchExright: async (from, to) => { calls.push([from, to]); if (fail) throw new Error('TWSE 除權息 stat=X'); return { items: [['2026-10-01', '9927', 0.93]] }; } });
  const a = await cover.sourcesFor('2026-09-30');
  assert.equal(calls.length, 0); assert.equal(a.recentRange, null); assert.equal(a.error, null);
  const b = await cover.sourcesFor('2026-10-02');
  assert.deepEqual(calls, [['2026-10-01', '2026-10-02']]); assert.equal(b.recent.length, 1);
  await cover.sourcesFor('2026-10-02'); await cover.fetch('2026-10-01', '2026-10-02');
  assert.equal(calls.length, 1, '同區間共用（停損影子注入同一個 fetch）');
  fail = true;
  const c = await cover.sourcesFor('2026-10-05');
  assert.equal(calls.length, 2); assert.match(c.error, /stat=X/); assert.equal(c.recent, null);
  t += 60_000;
  const d = await cover.sourcesFor('2026-10-05');
  assert.equal(calls.length, 2, '10 分鐘內不重打'); assert.match(d.error, /不重打/);
  await assert.rejects(cover.fetch('2026-10-01', '2026-10-05'), /不重打/);
  fail = false; t += 600_000;
  const e = await cover.sourcesFor('2026-10-05');
  assert.equal(calls.length, 3); assert.equal(e.error, null);
});

test('createExrightCover：併發同區間只打一次；歷史檔讀不到只讀一次並回 error', async () => {
  let n = 0;
  const cover = createExrightCover({ readHistory: () => H, fetchExright: async () => { n++; await new Promise(r => setTimeout(r, 5)); return { items: [] }; } });
  await Promise.all([cover.sourcesFor('2026-10-02'), cover.sourcesFor('2026-10-02'), cover.fetch('2026-10-01', '2026-10-02')]);
  assert.equal(n, 1);
  let reads = 0; const logs = [];
  const bad = createExrightCover({ readHistory: () => { reads++; throw new Error('ENOENT'); }, fetchExright: async () => ({ items: [] }), log: m => logs.push(m) });
  const r1 = await bad.sourcesFor('2026-10-02'); await bad.sourcesFor('2026-10-03');
  assert.equal(r1.history, null); assert.match(r1.error, /歷史檔/); assert.equal(reads, 1); assert.equal(logs.length, 1);
});
