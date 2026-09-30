// 推薦成績記分板彙總 單元測試：node --test scripts/lib/picks-scoreboard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggRets, aggregatePicks, scoreboardDoc } from './picks-scoreboard.mjs';

test('aggRets：樣本數、勝率、平均、中位數', () => {
  assert.deepEqual(aggRets([1, -1, 3]), { n: 3, winRate: 67, avgRet: 1, medRet: 1 });
  assert.equal(aggRets([]), null);
});

test('aggregatePicks：基準只取該榜有推薦的進場日（不被沒有推薦的偏空日拉低而灌水超額）', () => {
  const docs = [
    { date: '07-06', calib: 'v1', eval5: { base: [-5, -5], top20: { all: [-4], tradable: [-4] } } },            // 偏空日：只有 top20
    { date: '08-05', calib: 'v2', eval5: { base: [1, 1], top20: { all: [1.5], tradable: [1.5] }, growth: { all: [1.2], tradable: [1.2] } } },
  ];
  const a = aggregatePicks(docs, ['top20', 'growth']);
  assert.equal(a.growth.d5.base.avgRet, 1, '成長榜只在 08-05 有推薦 ⇒ 基準只取 08-05');
  assert.equal(a.growth.d5.excess, 0.2, '1.2 − 1（舊版會拿全期間基準 −2 ⇒ 灌水成 +3.2）');
  assert.equal(a.top20.d5.entryDays, 2); assert.equal(a.top20.d5.base.avgRet, -2);
});

test('scoreboardDoc：全歷史／現行口徑／舊口徑分開；舊口徑範圍正確', () => {
  const docs = [
    { date: '2026-07-06', calib: 'v1', eval5: { base: [0], top20: { all: [1], tradable: [1] } } },
    { date: '2026-08-05', calib: 'v2', eval5: { base: [0], top20: { all: [2], tradable: [2] } } },
  ];
  const s = scoreboardDoc(docs, ['top20'], 'v2');
  assert.equal(s.recordsV2, 1); assert.equal(s.recordsLegacy, 1); assert.equal(s.legacyTo, '2026-07-06'); assert.equal(s.calibFrom, '2026-08-05');
  assert.equal(s.aggV2.top20.d5.avgRet, 2); assert.equal(s.aggLegacy.top20.d5.avgRet, 1); assert.equal(s.agg.top20.d5.n, 2);
  assert.equal('netRet' in s.aggV2.top20.d5, false, '不扣成本');
});

test('recentPicks：逐檔 5／10／20 日與至今報酬；未到期為 null；新→舊、只取最近 N 個進場日', async () => {
  const { recentPicks } = await import('./picks-scoreboard.mjs');
  const dates = Array.from({ length: 12 }, (_, i) => `2026-09-${String(10 + i).padStart(2, '0')}`);
  const px = { 1111: i => 100 + i };   // 每日 +1
  const closeOf = (d, c) => (px[c] ? px[c](dates.indexOf(d)) : null);
  const docs = [{ date: dates[0], top20: [{ code: '1111', name: 'A', price: 100 }] }, { date: dates[9], top20: [{ code: '1111', name: 'A', price: 109 }, { code: '9999', price: 50 }] }];
  const out = recentPicks(docs, closeOf, dates, { days: 2 });
  assert.equal(out[0].date, dates[9], '新→舊');
  assert.equal(out[1].picks[0].r5, 5); assert.equal(out[1].picks[0].r10, 10); assert.equal(out[1].picks[0].r20, null, '未到期');
  assert.equal(out[1].picks[0].rNow, 11); assert.equal(out[0].picks[1].rNow, null, '無收盤＝null');
  assert.equal(recentPicks(docs, closeOf, dates, { days: 1 }).length, 1);
});
