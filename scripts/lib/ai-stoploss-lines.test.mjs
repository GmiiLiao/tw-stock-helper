// AI 停損規範 stop-v1.1·組成線原料（官方日 K 還原、ATR14、ATR 帶、持有期最高收盤、保本／追蹤、係數涵蓋、歸檔歸屬 A3、
// 前端暫算 K66′）單元測試：node --test scripts/lib/ai-stoploss-lines.test.mjs
// 編號對應實作計畫 warroom/stoploss/v1.1/impl-plan.md §5（L、M、K66′）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  adjustBars, atr14Of, atrBandOf, holdHighClose, stepHoldHigh, profitLines, exCoverageOf, lineInputsOf, frontLinesOf,
  barArchiveOf, hasOfficialBars, BAR_ARCHIVES, resolveStop, roundTick, EMPTY_EX_TABLE, aggregatePositions, STOP_PARAMS,
  uncoveredBreakBars, STRUCT_BREAK,
} from './ai-stoploss.mjs';

const HOLIDAYS = new Set(['2026-10-09']);
const isTD = ymd => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !HOLIDAYS.has(ymd); };
/** 從 start 起的 n 個交易日 */
function tradingDays(start, n) {
  const out = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); out.length < n; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (isTD(d)) out.push(d);
  }
  return out;
}
/** 收盤序列 → 日 K（開＝前收、高＝max(開收)+spread、低＝min(開收)−spread） */
function barsOf(start, closes, spread = 1) {
  const days = tradingDays(start, closes.length);
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { date: days[i], o, h: Math.max(o, c) + spread, l: Math.min(o, c) - spread, c, v: 1000 };
  });
}
const linear = (n, from, step) => Array.from({ length: n }, (_, i) => +(from + i * step).toFixed(2));

// calculateAtrStop／calculateATR 的 JS 逐行抄本（src/lib/indicators.ts:155-201）——金樣本比對用；下一個測試釘住原始碼沒有改
function calculateATR(bars, period = 14) {
  if (!bars || bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  if (recent.length === 0) return 0;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}
function calculateAtrStop(bars, price, supportHint, atrMult = 0.5) {
  if (!bars || bars.length < 15 || !(price > 0)) return null;
  const atr = calculateATR(bars, 14);
  if (!(atr > 0)) return null;
  const recentLow = Math.min(...bars.slice(-10).map(b => b.l).filter(v => v > 0));
  const candidates = [supportHint, recentLow].filter(v => typeof v === 'number' && v > 0 && v < price);
  const support = candidates.length ? Math.max(...candidates) : price - atr;
  let stop = support - atrMult * atr;
  const minStop = price * 0.85, maxStop = price * 0.97;
  stop = Math.min(Math.max(stop, minStop), maxStop);
  return { price: +stop.toFixed(2), atr: +atr.toFixed(2), support: +support.toFixed(2) };
}
const ma20x098 = bars => (bars.length >= 20 ? Math.round((bars.slice(-20).reduce((a, b) => a + b.c, 0) / 20) * 0.98 * 100) / 100 : undefined);

test('L1 原始碼釘住：indicators.ts 的 calculateAtrStop／calculateATR 仍是移植時的算式（改了就要同步 atrBandOf 與規範）', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'indicators.ts'), 'utf8');
  for (const s of [
    'if (!bars || bars.length < 15 || !(price > 0)) return null;',
    'const atr = calculateATR(bars, 14);',
    'const recentLow = Math.min(...bars.slice(-10).map(b => b.l).filter(v => v > 0));',
    'const support = candidates.length ? Math.max(...candidates) : price - atr;',
    'let stop = support - atrMult * atr;',
    'const minStop = price * 0.85, maxStop = price * 0.97;',
    'trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));',
  ]) assert.ok(src.includes(s), s);
  const enrich = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'analysis-enrich.ts'), 'utf8');
  assert.ok(enrich.includes('calculateAtrStop(bars!, stock.price, standard.price)'), 'supportHint＝標準買點');
  const ind = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'indicators.ts'), 'utf8');
  assert.ok(ind.includes("price: round2(snap.ma.ma20 * 0.98)"), '標準買點＝MA20×0.98');
});

test('L1 atrBandOf 與 calculateAtrStop 金樣本：同一組日 K、price＝最後收盤、supportHint＝MA20×0.98 ⇒ 差異 ≤1 檔（只來自向下取檔）', () => {
  const series = [
    barsOf('2026-06-01', linear(40, 100, 0.5)),                  // 上升：MA20 支撐
    barsOf('2026-06-01', linear(40, 150, -0.8)),                 // 下跌：無支撐候選 ⇒ 收盤 − ATR
    barsOf('2026-06-01', [...linear(30, 50, 0.1), ...linear(10, 53, -0.3)], 0.4),
    barsOf('2026-06-01', linear(25, 800, 3), 12),                // 高價股（檔位 1）
    barsOf('2026-06-01', linear(16, 30, 0.05), 0.2),             // 少於 20 根：沒有 MA20 候選
  ];
  for (const bars of series) {
    const last = bars[bars.length - 1].c;
    const g = calculateAtrStop(bars, last, ma20x098(bars));
    const b = atrBandOf(bars);
    assert.ok(g && b, 'both');
    const tick = roundTick(g.price, 1) - roundTick(g.price, -1) || 0.01;
    assert.ok(b.price <= g.price + 1e-9 && g.price - b.price <= tick + 1e-9, `${b.price} vs ${g.price}`);
    assert.equal(b.dataDate, bars[bars.length - 1].date);
    assert.ok(Math.abs(b.atr14 - calculateATR(bars, 14)) < 1e-9);
  }
});

test('L2 少於 15 根 ⇒ null；沒有支撐候選 ⇒ 收盤 − ATR；夾值下界（−15%）與上界（−3%）；ETF 檔位', () => {
  assert.equal(atrBandOf(barsOf('2026-06-01', linear(14, 100, 1))), null);
  assert.equal(atr14Of(barsOf('2026-06-01', linear(14, 100, 1))), null);
  const down = barsOf('2026-06-01', linear(30, 150, -0.8), 0);   // 最後一根低＝收盤、MA20 在收盤上 ⇒ 沒有低於收盤的候選
  const b = atrBandOf(down);
  const close = down[down.length - 1].c, atr = atr14Of(down);
  assert.ok(Math.abs(b.support - (close - atr)) < 1e-9);
  // 下界：波幅巨大 ⇒ 帶被夾在收盤×0.85
  const wild = barsOf('2026-06-01', linear(30, 100, 0), 20);
  assert.equal(atrBandOf(wild).price, roundTick(100 * 0.85, -1));
  // 上界：支撐貼著收盤 ⇒ 帶被夾在收盤×0.97
  const tight = barsOf('2026-06-01', linear(30, 100, 0), 0.01);
  assert.equal(atrBandOf(tight).price, 97);
  const etf = atrBandOf(barsOf('2026-06-01', linear(30, 30, 0.013), 0.11), true);
  assert.equal(+(etf.price * 100).toFixed(6) % 1, 0, 'ETF <50 元檔位 0.01');
});

test('L3 adjustBars：事件日之前的開高低收 × 之後的累乘係數（量不動）；面額變更 f＝0.1；最後一根之後的事件不乘', () => {
  const bars = barsOf('2026-09-01', [100, 100, 100, 50, 50]);
  const ex = { events: [['2026-09-04', 0.5], ['2026-10-30', 0.9]], coverFrom: '2022-07-01', coverTo: '2026-10-30' };
  const adj = adjustBars(bars, ex);
  assert.deepEqual(adj.map(b => b.c), [50, 50, 50, 50, 50]);
  assert.equal(adj[0].v, 1000);
  assert.equal(adj[0].h, bars[0].h * 0.5);
  const face = adjustBars(barsOf('2026-09-01', [100, 10]), { events: [['2026-09-02', 0.1]] });
  assert.deepEqual(face.map(b => b.c), [10, 10]);
  assert.deepEqual(adjustBars([], ex), []);
});

test('L9 係數涵蓋：視窗內有一筆除息但係數表涵蓋起點晚於視窗 ⇒ 不 ok、exGapBars>0；有完整係數時帶值較低（缺係數會讓帶值偏高）', () => {
  const closes = [...linear(30, 100, 0), ...linear(10, 98, 0)];   // 第 31 根除息 f＝0.98（除息前 100、除息後 98）
  const bars = barsOf('2026-06-01', closes, 3);
  const exDate = bars[30].date;
  const full = { events: [[exDate, 0.98]], coverFrom: '2026-01-01', coverTo: '2026-12-31' };
  const late = { events: [], coverFrom: bars[31].date, coverTo: '2026-12-31' };
  const cov = exCoverageOf(late, bars[0].date, bars[bars.length - 1].date, bars.map(b => b.date));
  assert.equal(cov.ok, false); assert.equal(cov.exGapBars, 31);
  assert.deepEqual(exCoverageOf(full, bars[0].date, bars[bars.length - 1].date, bars.map(b => b.date)), { ok: true, exGapBars: 0 });
  assert.deepEqual(exCoverageOf(EMPTY_EX_TABLE, '2026-06-01', '2026-10-02'), { ok: false, exGapBars: 1 });
  const withEx = lineInputsOf(bars, '2026-06-01', null, full);
  const noEx = lineInputsOf(bars, '2026-06-01', null, late);
  assert.ok(noEx.atrBand.price > withEx.atrBand.price, `${noEx.atrBand.price} > ${withEx.atrBand.price}`);
  assert.equal(noEx.exGapBars, 31); assert.equal(withEx.exGapBars, 0);
});

test('L10 官方日 K 歸檔歸屬（A3）：4 碼走 chipArchive；5～6 碼與英文字尾 ETF、興櫃要歸檔通過驗證才算可用', () => {
  for (const c of ['00878', '006208', '00632R', '00958B']) {
    assert.equal(barArchiveOf(c), 'etf', c);
    assert.equal(hasOfficialBars(c), false, c);
    assert.equal(hasOfficialBars(c, { verifiedArchives: ['etf'] }), true, c);
  }
  for (const c of ['2330', '0050']) { assert.equal(barArchiveOf(c), 'chip'); assert.equal(hasOfficialBars(c), true); }
  assert.equal(barArchiveOf('6589', 'emerging'), 'emerging');
  assert.equal(hasOfficialBars('6589', { market: 'emerging' }), false);
  assert.equal(hasOfficialBars('6589', { market: 'emerging', verifiedArchives: new Set(['emerging']) }), true);
  assert.equal(barArchiveOf('030001'), null);   // 權證不在範圍
  assert.deepEqual(BAR_ARCHIVES, { chip: 'chipArchive', etf: 'etfDailyArchive', emerging: 'emergingDailyArchive' });
  const none = lineInputsOf([], '2026-09-01', null, EMPTY_EX_TABLE, { dataDate: '2026-10-02' });
  assert.equal(none.noOfficialBars, true); assert.equal(none.dataDate, '2026-10-02');
  const r = resolveStop({ position: aggregatePositions([{ id: 'x', code: '00878', buyPrice: 20, quantity: 1, buyDate: '2026-09-01' }])[0],
    ex: EMPTY_EX_TABLE, lines: none, latestCanonicalYmd: '2026-10-02', nowMs: 1, tradeDate: '2026-10-02' });
  assert.equal(r.noOfficialBars, true); assert.equal(r.linesStale, false); assert.equal(r.stop, 18.4); assert.equal(r.stopSource, 'cost');
});

// ── M：持有期最高收盤、保本、追蹤 ───────────────────────────────────────────

test('M1 holdHighClose：含買進當日收盤、不含買進前；缺日（休市日曆）、早於歸檔起點、視窗晚於買進日 ⇒ complete=false', () => {
  const bars = barsOf('2026-09-01', [120, 100, 101, 105, 103]);
  const h = holdHighClose(bars, bars[1].date);
  assert.deepEqual(h, { price: 105, dataDate: bars[4].date, complete: true, from: bars[1].date });
  assert.equal(holdHighClose(bars, bars[1].date, { isTradingDay: isTD }).complete, true);
  const gap = [bars[0], bars[1], bars[3], bars[4]];
  assert.equal(holdHighClose(gap, bars[1].date, { isTradingDay: isTD }).complete, false);
  assert.equal(holdHighClose(bars, '2023-01-02').complete, false);
  assert.equal(holdHighClose(bars, '2026-08-20').complete, false);
  assert.equal(holdHighClose(bars, '2026-12-01'), null);
  assert.equal(holdHighClose(bars, null), null);
});

test('M2 保本邊界：最高收盤＝還原成本×1.10 啟動、×1.0999 不啟動；保本線＝ceilTick(還原成本)；追蹤 ×1.20、ceilTick(最高收盤 − 3×ATR14)', () => {
  assert.deepEqual(profitLines(100, 110, 2), { beLine: 100, trailLine: null });
  assert.deepEqual(profitLines(100, 109.99, 2), { beLine: null, trailLine: null });
  assert.deepEqual(profitLines(56.9, 62.59, 1), { beLine: 56.9, trailLine: null });
  assert.deepEqual(profitLines(56.93, 70, 1), { beLine: 57, trailLine: 67 });
  assert.deepEqual(profitLines(100, 120, 4), { beLine: 100, trailLine: 108 });
  assert.deepEqual(profitLines(100, 120, null), { beLine: 100, trailLine: null });
  assert.deepEqual(profitLines(null, 120, 4), { beLine: null, trailLine: null });
});

test('M5／M6 純函式與增量：連續 30 天每天餵一根 ＝ 一次重算；中間有除權息 f＝0.9 也相同；同一天重餵不變', () => {
  const closes = linear(30, 100, 0.7).map((c, i) => (i % 7 === 3 ? c + 4 : c));
  const raw = barsOf('2026-07-01', closes);
  const exDay = raw[17].date;
  const rawEx = raw.map((b, i) => (i >= 17 ? { ...b, o: b.o * 0.9, h: b.h * 0.9, l: b.l * 0.9, c: b.c * 0.9 } : b));
  for (const [series, ex] of [[raw, { events: [] }], [rawEx, { events: [[exDay, 0.9]] }]]) {
    const first = series[0].date;
    let hh = holdHighClose(adjustBars(series.slice(0, 1), ex), first);
    for (let i = 1; i < series.length; i++) hh = stepHoldHigh(hh, series[i], ex.events);
    const once = holdHighClose(adjustBars(series, ex), first);
    assert.ok(Math.abs(hh.price - once.price) < 1e-9, `${hh.price} vs ${once.price}`);
    assert.equal(hh.dataDate, once.dataDate);
    assert.deepEqual(stepHoldHigh(hh, series[series.length - 1], ex.events), hh);
    assert.deepEqual(holdHighClose(adjustBars(series, ex), first), once);   // 重算結果相同（重啟不失效）
  }
  assert.equal(stepHoldHigh(null, raw[0], []), null);
  assert.equal(holdHighClose(barsOf('2023-07-03', [10, 11]), '2023-07-03').complete, false);   // 早於 2023-07-17
});

test('lineInputsOf：持有期起點相同 ⇒ 以 stepHoldHigh 增量；起點改變 ⇒ 重算；上一版比視窗還舊 ⇒ complete=false', () => {
  const bars = barsOf('2026-06-01', linear(40, 100, 0.5));
  const first = bars[5].date;
  const a = lineInputsOf(bars.slice(0, 39), first, null, { events: [], coverFrom: '2022-07-01', coverTo: '2026-12-31' });
  const b = lineInputsOf(bars, first, a.holdHigh, { events: [], coverFrom: '2022-07-01', coverTo: '2026-12-31' });
  assert.equal(b.holdHigh.price, bars[39].c); assert.equal(b.holdHigh.from, first); assert.equal(b.holdHigh.complete, true);
  assert.equal(b.dataDate, bars[39].date); assert.equal(b.barsFrom, bars[0].date);
  assert.ok(b.atrBand.price > 0); assert.ok(b.atr14 > 0); assert.equal(b.noOfficialBars, false);
  const moved = lineInputsOf(bars, bars[10].date, a.holdHigh, { events: [], coverFrom: '2022-07-01', coverTo: '2026-12-31' });
  assert.equal(moved.holdHigh.from, bars[10].date);
  const old = { price: 999, dataDate: '2026-05-01', complete: true, from: first };
  const c = lineInputsOf(bars, first, old, { events: [], coverFrom: '2022-07-01', coverTo: '2026-12-31' });
  assert.equal(c.holdHigh.price, 999); assert.equal(c.holdHigh.complete, false);
});

// ── K66′：前端暫算（停損簿上線前） ─────────────────────────────────────────

test('K66′ 前端暫算＝max(成本線, floorTick(持股分析 ATR 帶))；今天買進只有成本線；改傳今日 ⇒ 套帶；不判 linesStale；兩個呼叫者同值', () => {
  const p = aggregatePositions([{ id: 'a', code: '2317', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }])[0];
  const lines = frontLinesOf({ ratingBand: 95.37, prevTradingYmd: '2026-10-02' });
  assert.deepEqual(lines.atrBand, { price: 95.3, dataDate: '2026-10-02' });
  assert.equal(lines.close, null); assert.equal(lines.barsFrom, null);
  const call = () => resolveStop({ position: p, ex: EMPTY_EX_TABLE, prev: null, lines, bandRatchet: false, nowMs: 1, tradeDate: '2026-10-05' });
  const r1 = call(), r2 = call();
  assert.equal(r1.stop, 95.3); assert.equal(r1.stopSource, 'atrBand'); assert.equal(r1.linesStale, false);
  assert.deepEqual(r1, r2);
  const today = aggregatePositions([{ id: 'b', code: '2317', buyPrice: 100, quantity: 1, buyDate: '2026-10-05' }])[0];
  assert.equal(resolveStop({ position: today, ex: EMPTY_EX_TABLE, lines, bandRatchet: false, nowMs: 1, tradeDate: '2026-10-05' }).stop, 92);
  const alt = frontLinesOf({ ratingBand: 95.37, prevTradingYmd: '2026-10-05' });   // 若裁定買進當天也套帶（A1 已裁定不套，留作對照）
  assert.equal(resolveStop({ position: today, ex: EMPTY_EX_TABLE, lines: alt, bandRatchet: false, nowMs: 1, tradeDate: '2026-10-05' }).stop, 95.3);
  const low = frontLinesOf({ ratingBand: 80, prevTradingYmd: '2026-10-02' });
  assert.equal(resolveStop({ position: p, ex: EMPTY_EX_TABLE, lines: low, bandRatchet: false, nowMs: 1, tradeDate: '2026-10-05' }).stop, 92);
  assert.equal(frontLinesOf({ ratingBand: null, prevTradingYmd: '2026-10-02' }), null);
  assert.equal(frontLinesOf({ ratingBand: 95, prevTradingYmd: null }), null);
  assert.equal(STOP_PARAMS.bandRatchet, true);
});

test('§2A 閘門 ⑦（2026-10-05 審查）：ETF 停止買賣後的結構斷點沒有係數 ⇒ lineInputsOf 記 exGapBars（fail-closed）；有係數、非 ETF、沒有休市日曆 ⇒ 不記', () => {
  // 00631L 型：停止買賣 3 個交易日後恢復，收盤由 200 變 50（1 拆 4，係數表沒有這件事件）
  const days = tradingDays('2026-08-03', 32);
  const closes = days.map((_, i) => (i < 20 ? 200 + (i % 3) : 50 + (i % 3) * 0.25));
  const bars = days.map((d, i) => ({ date: d, o: closes[i], h: closes[i] + 1, l: closes[i] - 1, c: closes[i], v: 1000 }))
    .filter((_, i) => i < 17 || i >= 20);   // i=17..19 停止買賣（沒有日 K）
  const ex = { events: [], coverFrom: '2026-01-01', coverTo: '2026-12-31' };
  assert.equal(uncoveredBreakBars(bars, ex, isTD), 17, '斷點之前 17 根沒還原');
  const L = lineInputsOf(bars, '2026-08-03', null, ex, { isEtf: true, isTradingDay: isTD });
  assert.equal(L.exGapBars, 17);
  // 係數表有分割事件（恢復買賣日 0.25）⇒ 已涵蓋
  const exSplit = { ...ex, events: [[days[20], 0.25]] };
  assert.equal(uncoveredBreakBars(bars, exSplit, isTD), 0);
  assert.equal(lineInputsOf(bars, '2026-08-03', null, exSplit, { isEtf: true, isTradingDay: isTD }).exGapBars, 0);
  // 非 ETF 不套這道（4 碼股票的減資等事件由係數表與漲跌幅限制處理）；沒給休市日曆無法判斷停止買賣 ⇒ 0
  assert.equal(lineInputsOf(bars, '2026-08-03', null, ex, { isEtf: false, isTradingDay: isTD }).exGapBars, 0);
  assert.equal(uncoveredBreakBars(bars, ex, null), 0);
  // 連續交易日裡的大幅變動不是停止買賣斷點
  const cont = days.slice(0, 22).map((d, i) => ({ date: d, c: i < 20 ? 200 : 120 }));
  assert.equal(uncoveredBreakBars(cont, ex, isTD), 0);
  assert.deepEqual(STRUCT_BREAK, { lo: 0.7, hi: 1.43 });
});
