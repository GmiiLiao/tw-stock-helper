// 與官方鏡像／chipArchive 抽樣比對 單元測試：node --test scripts/finmind/validate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { getSpec } from './datasets.mjs';
import { groupPaths, openGroup, appendMember, finalizeGroup, closeGroup, readJson } from './store.mjs';
import { createAgg, compareKbar, compareTick, compareBroker, comparePriceLimit, compareDividend, compareMarketValue, checkStructural, validateDataset, validationOk, overallStatus } from './validate.mjs';

const feed = (kind, rows) => { const a = createAgg(kind); rows.forEach(r => a.add(r)); return a.result(); };
const close = new Map([['2330', { close: 2585, lots: 15562, open: 2565, high: 2585, low: 2560 }], ['6129', { close: 14.3, lots: 276, open: 14.5, high: 14.6, low: 14.25 }]]);
const quotes = new Map([['2330', { market: 'tse', shares: 16941183, close: 2585 }], ['6129', { market: 'otc', shares: 276765, close: 14.3, issued: 180574120, nextUp: 15.7, nextDown: 12.9 }]]);
const bar = (code, minute, o, h, l, c, v) => ({ date: '2026-10-07', minute, stock_id: code, open: o, high: h, low: l, close: c, volume: v });

test('分 K 彙總成日 K：開＝第一根開、高低＝極值、收＝最後一根收、量加總；與 chipArchive 比價格完全相同才算對', () => {
  const agg = feed('kbar', [bar('2330', '09:00:00', 2565, 2570, 2560, 2570, 15000), bar('2330', '13:30:00', 2585, 2585, 2580, 2585, 562),
    bar('6129', '09:00:00', 14.5, 14.6, 14.25, 14.3, 276), bar('9999', '09:00:00', 1, 1, 1, 1, 1)]);
  assert.deepEqual(agg.get('2330'), { open: 2565, high: 2585, low: 2560, close: 2585, vol: 15562, n: 2 });
  const r = compareKbar(agg, { close, quotes });
  assert.equal(r.checked, 2); assert.equal(r.matched, 2); assert.equal(r.status, 'pass'); assert.equal(r.missingOfficial, 1);
  assert.equal(r.volOk, 2); assert.equal(r.volRatioMedian, 1);
  assert.deepEqual(r.byCategory, { stock4: { checked: 2, matched: 2 } });
  const bad = compareKbar(feed('kbar', [bar('2330', '09:00:00', 2565, 2570, 2560, 2575, 1)]), { close, quotes });
  assert.equal(bad.status, 'fail'); assert.equal(bad.mismatches[0].code, '2330');
});

test('逐筆：最後一筆成交價＝收盤；量（張）加總', () => {
  const t = (code, Time, p, v) => ({ date: '2026-10-07', stock_id: code, deal_price: p, volume: v, Time, TickType: 1 });
  const agg = feed('tick', [t('2330', '13:30:00.000', 2585, 562), t('2330', '09:00:00.100', 2565, 15000)]);
  assert.deepEqual(agg.get('2330'), { close: 2585, vol: 15562, n: 2 });
  assert.equal(compareTick(agg, { close, quotes }).status, 'pass');
});

test('分點：每檔買進合計、賣出合計都要接近官方成交股數（2% 內，MI_INDEX 股數或 chipArchive 張數×1000 其一）', () => {
  const b = (code, broker, buy, sell) => ({ date: '2026-10-07', stock_id: code, securities_trader_id: broker, price: 1, buy, sell });
  const agg = feed('broker', [b('2330', '1020', 10000000, 9000000), b('2330', '9A00', 6941183, 7941183), b('6129', '1020', 276765, 272000)]);
  assert.deepEqual(agg.get('2330'), { buy: 16941183, sell: 16941183, n: 2 });
  const r = compareBroker(agg, { close, quotes });
  assert.equal(r.checked, 2); assert.equal(r.matched, 2); assert.equal(r.status, 'pass');
  const half = compareBroker(feed('broker', [b('2330', '1020', 8000000, 8000000)]), { close, quotes });
  assert.equal(half.status, 'fail');
});

test('漲跌停：上市比 TWT84U 當日、上櫃比前一交易日 dailyQuotes 的次日漲跌停；無漲跌幅限制的略過', () => {
  const rows = [{ stock_id: '2330', limit_up: 2840, limit_down: 2330, reference_price: 2585 }, { stock_id: '6129', limit_up: 15.7, limit_down: 12.9 },
    { stock_id: '00411A', limit_up: 0, limit_down: 0 }];
  const twt84u = new Map([['2330', { up: 2840, ref: 2585, down: 2330 }]]);
  const otcPrev = new Map([['6129', { nextUp: 15.7, nextDown: 12.9 }], ['00411A', { nextUp: 9999.95, nextDown: 0.01 }]]);
  const r = comparePriceLimit(rows, { twt84u, otcPrev });
  assert.equal(r.checked, 2); assert.equal(r.matched, 2); assert.equal(r.status, 'pass');
  assert.equal(comparePriceLimit(rows, { twt84u: null, otcPrev: null }).status, 'no-official');
  // 官方無漲跌幅的哨兵值：ETF 9999.95、≥1000 元檔位 5 的個股是 9995（2645 2023-03-15 實測）⇒ 都要略過
  const sentinel = comparePriceLimit([{ stock_id: '2645', limit_up: 98.4, limit_down: 80.6 }], { twt84u: new Map([['2645', { up: 9995, down: 0.01 }]]), otcPrev: null });
  assert.equal(sentinel.checked, 0);
});

test('除權息：官方 TWT49U＋exDailyQ 每一檔都要在 FinMind 找到、前收與參考價相同；兩邊都空＝一致但不算通過', () => {
  const official = new Map([['00940', { before: 13.3, after: 13.24 }], ['2947', { before: 62.6, after: 61.6 }]]);
  const rows = [{ stock_id: '00940', before_price: 13.3, after_price: 13.24 }, { stock_id: '2947', before_price: 62.6, after_price: 61.6 }];
  assert.equal(compareDividend(rows, { official }).status, 'pass');
  assert.equal(compareDividend(rows.slice(0, 1), { official }).status, 'fail');
  assert.equal(compareDividend([], { official: new Map() }).status, 'agree-empty');
  assert.equal(compareDividend(rows, { official: null }).status, 'no-official');
});

test('市值：上櫃以收盤×發行股數驗（2% 內）', () => {
  const r = compareMarketValue([{ stock_id: '6129', market_value: 14.3 * 180574120 }, { stock_id: '2330', market_value: 1 }], { quotes });
  assert.equal(r.checked, 1); assert.equal(r.status, 'pass');
});

test('結構檢查：0 列（非 emptyOk）、缺欄位、日期不符都算失敗', () => {
  const spec = getSpec('TaiwanStockMarginMaintenance');
  assert.equal(checkStructural(spec, { date: '2026-10-07' }, { rows: 0, cols: null, badDates: 0 }).status, 'fail');
  assert.equal(checkStructural(spec, { date: '2026-10-07' }, { rows: 5, cols: ['date', 'stock_id'], badDates: 0 }).status, 'fail');
  assert.equal(checkStructural(spec, { date: '2026-10-07' }, { rows: 5, cols: ['date', 'stock_id', 'margin_maintenance'], badDates: 1 }).status, 'fail');
  assert.equal(checkStructural(spec, { date: '2026-10-07' }, { rows: 5, cols: ['date', 'stock_id', 'margin_maintenance'], badDates: 0 }).status, 'pass');
  assert.equal(checkStructural(getSpec('TaiwanStockDividendResult'), { date: '2026-10-07' }, { rows: 0, cols: null, badDates: 0 }).status, 'pass');
});

test('overallStatus：至少一天通過且沒有失敗才 pass；全部沒有官方可比＝insufficient', () => {
  assert.equal(overallStatus([{ status: 'pass' }, { status: 'no-official' }]), 'pass');
  assert.equal(overallStatus([{ status: 'pass' }, { status: 'fail' }]), 'fail');
  assert.equal(overallStatus([{ status: 'no-official' }, { status: 'agree-empty' }]), 'insufficient');
  assert.equal(overallStatus([]), 'insufficient');
});

test('validateDataset：讀落地的抽樣群組、比對、寫 _validation.json；validationOk 讀回', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fm-val-'));
  const spec = getSpec('TaiwanStockKBar');
  const p = groupPaths(root, spec.name, '2026-10-07');
  const g = openGroup(p);
  const gz = rows => gzipSync(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  appendMember(g, '2330', gz([bar('2330', '09:00:00', 2565, 2585, 2560, 2585, 15562)]), 1);
  closeGroup(g);   // 抽樣只抓了幾檔：群組仍是 .part，也要能驗
  const p2 = groupPaths(root, spec.name, '2023-03-15');
  const g2 = openGroup(p2); appendMember(g2, '2330', gz([{ ...bar('2330', '09:00:00', 1, 1, 1, 1, 1), date: '2023-03-15' }]), 1); finalizeGroup(g2);
  const ld = { closeFor: d => (d === '2026-10-07' ? close : null), officialQuotes: () => null, mirrorPayload: () => null };
  const res = await validateDataset({ spec, root, ld, days: ['2023-03-15', '2026-10-07'], now: () => Date.UTC(2026, 9, 8) });
  assert.equal(res.status, 'pass');
  assert.deepEqual(res.groups.map(x => [x.group, x.status]), [['2026-10-07', 'pass'], ['2023-03-15', 'no-official']]);
  const saved = readJson(join(root, spec.name, '_validation.json'));
  assert.equal(saved.status, 'pass'); assert.equal(saved.method, 'kbar');
  assert.match(saved.source, /研究用/);
  assert.equal(validationOk(root, spec), true);
  assert.equal(validationOk(root, getSpec('TaiwanStockPriceTick')), false);
});

test('分類：漲跌停只以 4 碼股當閘門，ETF 錯（FinMind 用錯檔位）照列在 byCategory；分點對 MI_INDEX 只容許偏低（不含鉅額）', async () => {
  const { categoryOf } = await import('./validate.mjs');
  assert.deepEqual(['2330', '00940', '01001T', '020000'].map(categoryOf), ['stock4', 'etf', 'other', 'other']);
  // 2026-10-08 試抓實測：4 碼的 0050～0057 是 ETF，不可算進 4 碼股閘門（FinMind 對它們用錯檔位）
  assert.deepEqual(['0050', '0056', '9945'].map(categoryOf), ['etf', 'etf', 'stock4']);
  const rows = [{ stock_id: '2330', limit_up: 2840, limit_down: 2330 }, { stock_id: '00400A', limit_up: 18.15, limit_down: 14.9 }];
  const twt84u = new Map([['2330', { up: 2840, down: 2330 }], ['00400A', { up: 18.17, down: 14.87 }]]);
  const r = comparePriceLimit(rows, { twt84u, otcPrev: null });
  assert.equal(r.status, 'pass'); assert.deepEqual(r.byCategory, { stock4: { checked: 1, matched: 1 }, etf: { checked: 1, matched: 0 } });
  const mi = new Map([['2330', { shares: 24080361 }]]);
  const b = createAgg('broker'); b.add({ stock_id: '2330', buy: 23553361, sell: 23553361 });   // 2023-03-15 實測：比 MI_INDEX 少 2.2%（鉅額）
  assert.equal(compareBroker(b.result(), { close: null, quotes: mi }).status, 'pass');
  const over = createAgg('broker'); over.add({ stock_id: '2330', buy: 24300000, sell: 24300000 });   // 比官方多 0.9%：不合理
  assert.equal(compareBroker(over.result(), { close: null, quotes: mi }).status, 'fail');
});
