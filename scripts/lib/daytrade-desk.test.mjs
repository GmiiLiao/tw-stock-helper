// 當沖工作台單元測試：node --test scripts/lib/daytrade-desk.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDesk, roundTick, DESK_PARAMS } from './daytrade-setups.mjs';
import { scoreDesk } from './daytrade-score.mjs';

const T0 = Date.parse('2026-09-24T01:00:00Z');   // 台北 09:00
/** 以每分鐘 [o,h,l,c,v] 產生 K 棒 */
const mk = rows => rows.map(([o, h, l, c, v], i) => ({ t: T0 + i * 60000, o, h, l, c, v }));
const flat = (n, p, v = 1000) => Array.from({ length: n }, () => [p, p + 0.2, p - 0.2, p, v]);

// 價位 40 元（檔位 0.05）：開盤區間 39.9～40.1
const OPEN = () => [...flat(5, 40, 1000), ...flat(5, 40, 1000)];
const flat4 = (n, p) => Array.from({ length: n }, () => [p, p + 0.05, p - 0.05, p, 1000]);

test('ORB：突破→站穩→再攻 才觸發，結構停損取突破後低點', () => {
  const bars = mk([...OPEN(), [40.1, 40.5, 40.05, 40.4, 5000], [40.4, 40.45, 40.2, 40.35, 800], [40.35, 41.1, 40.35, 41.0, 3000], ...flat4(3, 41)]);
  const r = scanDesk(bars, 'long', { prevClose: 39.5, prevHigh: 45, prevLow: 38 });
  const t = r.trades[0] || r.active;
  assert.ok(t, '應觸發：' + JSON.stringify(r.vetoed.map(v => v.veto)));
  assert.equal(t.type, 'ORB');
  assert.equal(t.entry, 41);
  assert.equal(t.stop, 40.05);
  assert.deepEqual(t.targets, [41.95, 42.9, 43.85]);
});

test('ORB 假突破：突破後收回區間內 ⇒ 記假突破且不觸發', () => {
  const bars = mk([...OPEN(), [40.1, 40.5, 40.05, 40.4, 5000], [40.3, 40.35, 39.8, 39.95, 1000], ...flat4(5, 40)]);
  const r = scanDesk(bars, 'long', { prevClose: 39.5, prevHigh: 45, prevLow: 38 });
  assert.equal(r.trades.length, 0);
  assert.equal(r.falseBreaks[0]?.type, 'ORB');
});

test('否決：2R 目標超過漲停 ⇒ 進 vetoed 不進 trades', () => {
  const bars = mk([...OPEN(), [40.1, 40.5, 40.05, 40.4, 5000], [40.4, 40.45, 40.2, 40.35, 800], [40.35, 41.1, 40.35, 41.0, 3000]]);
  const r = scanDesk(bars, 'long', { prevClose: 38.5, prevHigh: 45, prevLow: 37 });   // 漲停 42.35 < 2R 42.9
  assert.equal(r.trades.length, 0);
  assert.ok(r.vetoed[0]?.veto.some(v => /超過漲停/.test(v)));
});

test('出場：到 1R 後停損移到成本，跌回成本出場', () => {
  const bars = mk([...OPEN(), [40.1, 40.5, 40.05, 40.4, 5000], [40.4, 40.45, 40.2, 40.35, 800], [40.35, 41.1, 40.35, 41.0, 3000],
    [41.0, 42.0, 41.0, 41.9, 2000], [41.9, 41.9, 40.8, 40.9, 2000], ...flat4(3, 40.9)]);
  const r = scanDesk(bars, 'long', { prevClose: 39.5, prevHigh: 45, prevLow: 38 });
  const t = r.trades[0];
  assert.ok(t?.hit[0], '應達 1R');
  assert.equal(t.exit?.reason, '回到成本（保本停損）');
  assert.ok(t.netR > 0, '1/3 在 1R 落袋、其餘略低於成本出場，扣成本後仍小幅為正');
});

test('做空鏡像：跌破開盤區間→站穩→再跌 觸發，停損在上方', () => {
  const bars = mk([...OPEN(), [39.9, 39.95, 39.5, 39.6, 5000], [39.6, 39.8, 39.55, 39.65, 800], [39.65, 39.65, 38.9, 39.0, 3000]]);
  const r = scanDesk(bars, 'short', { prevClose: 40.5, prevHigh: 42, prevLow: 35 });
  const t = r.trades[0] || r.active;
  assert.ok(t, '應觸發：' + JSON.stringify(r.vetoed.map(v => v.veto)));
  assert.equal(t.stop, 39.95);
  assert.ok(t.stop > t.entry);
});

test('roundTick 依檔位取價', () => {
  assert.equal(roundTick(101.23, -1), 101);   // 100~500 檔位 0.5
  assert.equal(roundTick(101.23, 1), 101.5);
  assert.equal(roundTick(49.97, 1), 50);      // 10~50 檔位 0.05
});

test('評分：缺資料記未知、不給分級，已知滿分只算已知子項', () => {
  const bars = mk(flat(12, 100));
  const scan = scanDesk(bars, 'long', { prevClose: 99, prevHigh: 101, prevLow: 98 });
  const s = scoreDesk({ side: 'long', index: null, regime: null, breadth: null, sector: null, stock: { market: 'tse', price: 100, chg: 1, valueTwd: 1e8, bid1: null, ask1: null, tick: 0.5, pace: null, prevHigh: 101, prevLow: 98 }, news: null, scan, bars, vwap: 100, warnings: [] });
  assert.equal(s.tier, null);
  assert.ok(s.missing.includes('新聞催化品質'));
  assert.ok(s.knownMax < 100);
  assert.ok(s.total <= s.knownMax);
});

test('參數凍結：DESK_PARAMS 不可被改（改規則必須升版）', () => {
  assert.throws(() => { 'use strict'; DESK_PARAMS.volK = 9; });
});
