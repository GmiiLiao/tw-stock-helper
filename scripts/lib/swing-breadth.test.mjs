// 波段起漲空頭日 gate 的市場寬度 單元測試：node --test scripts/lib/swing-breadth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swingBreadth } from './swing-breadth.mjs';

// 600 檔普通股（1000~1599）；f(i) 給第 i 檔的收盤
const codes = Array.from({ length: 600 }, (_, i) => String(1000 + i));
const day = (date, f) => ({ date, close: Object.fromEntries(codes.map((c, i) => [c, [f(i), 100]])) });
const quotesOf = d => Object.fromEntries(Object.entries(d.close).map(([c, r]) => [c, { price: r[0] }]));

// 重現 2026-10-01：09-30 是 68.9% 上漲日、10-01 收盤 38.7%（空頭日）
const d0929 = day('2026-09-29', () => 100);
const d0930 = day('2026-09-30', i => (i < 413 ? 110 : 90));                    // 413/600 = 68.8% 上漲
const d1001 = day('2026-10-01', i => (i < 232 ? 120 : i < 413 ? 105 : 80));    // 對 09-30：232/600 = 38.7% 上漲；對 09-29：413/600 = 68.8%

test('收盤模式（歸檔末日＝今天）：今日歸檔收盤對前一日歸檔收盤', () => {
  const r = swingBreadth({ arch: [d0929, d0930, d1001], liveDay: false });
  assert.equal(r.breadth, 38.7); assert.equal(r.bearDay, true);
  assert.equal(r.up, 232); assert.equal(r.tot, 600);
});

test('快照模式（歸檔還沒有今天）：快照價對歸檔末日（前一交易日）——不是前天（2026-10-01 盤中整天誤判多頭日）', () => {
  const r = swingBreadth({ arch: [d0929, d0930], quotes: quotesOf(d1001), liveDay: true });
  assert.equal(r.breadth, 38.7); assert.equal(r.bearDay, true);   // 舊版拿前天（09-29）當前收：413/600 = 68.8% ⇒ 多頭日
});

test('liveDay 前提：快照仍是 arch[L] 那天的收盤卻當快照模式 ⇒ 全部平盤、寬度 0%（所以 liveDay 必須走 boardLiveBar：≥09:00）', () => {
  const r = swingBreadth({ arch: [d0929, d0930], quotes: quotesOf(d0930), liveDay: true });
  assert.equal(r.breadth, 0); assert.equal(r.bearDay, true);
  // 同一時點正確的判定是歸檔模式：09-30 對 09-29
  assert.equal(swingBreadth({ arch: [d0929, d0930], quotes: quotesOf(d0930), liveDay: false }).breadth, 68.8);
});

test('同一天：快照模式拿當日收盤當快照價，與歸檔落地後的收盤模式結果一致', () => {
  const live = swingBreadth({ arch: [d0929, d0930], quotes: quotesOf(d1001), liveDay: true });
  const close = swingBreadth({ arch: [d0929, d0930, d1001], liveDay: false });
  assert.deepEqual(live, close);
});

test('只算 4 碼普通股：00 開頭 ETF、權證／特別股等非 4 碼代號不計', () => {
  const extra = { '0050': [200, 1], '00878': [20, 1], '2330A': [50, 1], '123456': [10, 1] };
  const prev = { ...d0930, close: { ...d0930.close, '0050': [100, 1], '00878': [10, 1], '2330A': [40, 1], '123456': [5, 1] } };
  const now = { ...d1001, close: { ...d1001.close, ...extra } };
  const r = swingBreadth({ arch: [prev, now], liveDay: false });
  assert.equal(r.tot, 600); assert.equal(r.up, 232);
});

test('今日或前日缺價（含 0）的檔不計入分母；平盤計入分母但不算上漲（與回測同口徑）', () => {
  const now = { ...d1001, close: { ...d1001.close, 1000: [0, 0], 1001: [120, 1] } };
  const prev = { ...d0930, close: { ...d0930.close } };
  delete prev.close['1001'];
  const r = swingBreadth({ arch: [prev, now], liveDay: false });
  assert.equal(r.tot, 598); assert.equal(r.up, 230);
  const flat = swingBreadth({ arch: [d0930, d0930], liveDay: false });
  assert.equal(flat.tot, 600); assert.equal(flat.up, 0); assert.equal(flat.breadth, 0);
});

test('快照模式：快照沒有報價或價格為 0 的檔不計', () => {
  const quotes = quotesOf(d1001);
  delete quotes['1000']; quotes['1001'] = { price: 0 };
  const r = swingBreadth({ arch: [d0929, d0930], quotes, liveDay: true });
  assert.equal(r.tot, 598); assert.equal(r.up, 230);
});

test('有效家數 < 500 ⇒ 寬度不足，breadth 與 bearDay 皆為 null；恰好 500 就判（回測門檻 tot < 500 才跳過）', () => {
  const first = (d, n) => ({ ...d, close: Object.fromEntries(Object.entries(d.close).slice(0, n)) });
  const r = swingBreadth({ arch: [first(d0930, 499), first(d1001, 499)], liveDay: false });
  assert.equal(r.tot, 499); assert.equal(r.breadth, null); assert.equal(r.bearDay, null);
  const r500 = swingBreadth({ arch: [first(d0930, 500), first(d1001, 500)], liveDay: false });
  assert.equal(r500.tot, 500); assert.equal(r500.breadth, 46.4); assert.equal(r500.bearDay, true);   // 232/500
  assert.equal(swingBreadth({ arch: [d1001], liveDay: false }).breadth, null);   // 收盤模式只有一天：沒有前日
  assert.equal(swingBreadth({ arch: [], liveDay: true }).breadth, null);
});

test('上漲家數比恰為 50% 不是空頭日（回測：up/tot ≥ 0.5 ＝多頭）', () => {
  const r = swingBreadth({ arch: [d0929, day('2026-09-30', i => (i < 300 ? 101 : 99))], liveDay: false });
  assert.equal(r.breadth, 50); assert.equal(r.bearDay, false);
});
