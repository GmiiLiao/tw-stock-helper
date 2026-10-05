// stock-intraday Yahoo 後備 memoize 單元測試：node --test scripts/lib/intraday-yahoo.test.mjs
// 不連網：fetchChart 是假的（計數＋回固定樣本）；memoize 用真正的 src/lib/singleflight.ts（route 實際用的那支）。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTRADAY_CODE_RE, YAHOO_TRUNK_TTL_MS, YAHOO_TRUNK_NEGATIVE_TTL_MS, YAHOO_TRUNK_MAX_STALE_MS,
  taipeiHHmm, parseYahooChart, fetchYahooTrunk, createYahooTrunkReader, yahooTrunkKey,
} from './intraday-yahoo.mjs';

// route 實際注入的 memoize（src/lib/singleflight.ts；無 import、只有可剝除的型別註記，Node 25 內建型別剝除可直接載入）。
// 以 import.meta.url 組路徑做動態 import：check-imports 只認 .mjs/.js/.json 字面值 specifier；檔案不存在時本測試直接失敗，不會靜默略過。
const { memoize } = await import(new URL('../../src/lib/singleflight.ts', import.meta.url).href);

// 2026-10-05 台北 hh:mm → epoch 秒
const S = (h, m) => Date.UTC(2026, 9, 5, h - 8, m, 0) / 1000;

const chart = (closes, { prev = 100, vols } = {}) => ({
  timestamp: closes.map((_, i) => S(9, i)),
  indicators: { quote: [{ close: closes, volume: vols ?? closes.map(() => 1000) }] },
  meta: { chartPreviousClose: prev },
});

/** 假 Yahoo：依 symbol 回樣本或 null，並記錄每次呼叫 */
function fakeYahoo(table) {
  const calls = [];
  const fetchChart = async symbol => { calls.push(symbol); await Promise.resolve(); return table[symbol] ?? null; };
  return { calls, fetchChart };
}

test('代號白名單：股票、ETF、權證、特別股、槓反可過；路徑字元與過長擋下', () => {
  for (const ok of ['2330', '6969', '0050', '006208', '00631L', '2881A', '030001']) assert.ok(INTRADAY_CODE_RE.test(ok), ok);
  for (const bad of ['', '233', '2330.TW', '../2330', '2330/x', '2330?a=1', '23301234', 'TAIEX', ' 2330', '2330 ']) assert.ok(!INTRADAY_CODE_RE.test(bad), JSON.stringify(bad));
});

test('taipeiHHmm 與主機時區無關', () => {
  assert.equal(taipeiHHmm(S(9, 0)), '09:00');
  assert.equal(taipeiHHmm(S(13, 30)), '13:30');
  assert.equal(taipeiHHmm(Date.UTC(2026, 9, 4, 16, 5) / 1000), '00:05');   // 台北隔日 00:05
});

test('parseYahooChart：略過 null 收盤、量缺值記 0、prevClose 依序後備（與 route 舊版同）', () => {
  const r = parseYahooChart({
    timestamp: [S(9, 0), S(9, 1), S(9, 2)],
    indicators: { quote: [{ close: [101, null, 102], volume: [5, 6, null] }] },
    meta: { previousClose: 99 },
  });
  assert.equal(r.prevClose, 99);
  assert.deepEqual(r.ticks.map(t => [t.timeStr, t.close, t.volume]), [['09:00', 101, 5], ['09:02', 102, 0]]);
  assert.equal(parseYahooChart({ ...chart([101]), meta: {} }).prevClose, 101);   // 沒 meta 用第一筆
  assert.equal(parseYahooChart({ timestamp: [], meta: {} }).prevClose, 0);
  const empty = parseYahooChart({ meta: { chartPreviousClose: 88 } });   // 盤前：有 result 沒分時
  assert.equal(empty.prevClose, 88);
  assert.equal(empty.ticks.length, 0);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.ticks) && Object.isFrozen(r.ticks[0]));
});

test('fetchYahooTrunk：.TW／.TWO 並行各一次，上市優先、上櫃後備、都沒有回 null', async () => {
  const y = fakeYahoo({ '2330.TW': chart([600]), '2330.TWO': chart([1]), '6488.TWO': chart([300]) });
  assert.equal((await fetchYahooTrunk('2330', y.fetchChart)).ticks[0].close, 600);
  assert.equal((await fetchYahooTrunk('6488', y.fetchChart)).ticks[0].close, 300);
  assert.equal(await fetchYahooTrunk('9999', y.fetchChart), null);
  assert.deepEqual(y.calls.sort(), ['2330.TW', '2330.TWO', '6488.TW', '6488.TWO', '9999.TW', '9999.TWO'].sort());
});

test('合流＋TTL：同代號 50 個併發只打一組（2 次），30 秒內不再打，過期才重抓', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 5, 2, 0, 0) });
  const y = fakeYahoo({ '2317.TW': chart([150, 151]) });
  const read = createYahooTrunkReader({ memoize, fetchChart: y.fetchChart });
  const rs = await Promise.all(Array.from({ length: 50 }, () => read('2317')));
  assert.equal(y.calls.length, 2);
  assert.ok(rs.every(r => r && r.ticks.length === 2 && r === rs[0]));   // 同一份快取物件
  mock.timers.tick(YAHOO_TRUNK_TTL_MS - 1);
  await read('2317'); await read('2317');
  assert.equal(y.calls.length, 2);
  mock.timers.tick(1);
  await read('2317');
  assert.equal(y.calls.length, 4);
});

test('鍵以代號區分：不同代號各自一組，不互相污染', async () => {
  const y = fakeYahoo({ '2454.TW': chart([1000]), '3008.TW': chart([2000]) });
  const read = createYahooTrunkReader({ memoize, fetchChart: y.fetchChart });
  const [a, b] = await Promise.all([read('2454'), read('3008')]);
  assert.equal(a.ticks[0].close, 1000);
  assert.equal(b.ticks[0].close, 2000);
  assert.equal(y.calls.length, 4);
  assert.notEqual(yahooTrunkKey('2454'), yahooTrunkKey('3008'));
});

test('負快取：兩個市場都取不到 ⇒ 回 null，30 秒冷卻內不重打，冷卻後才再試', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 5, 2, 0, 0) });
  const y = fakeYahoo({});
  const read = createYahooTrunkReader({ memoize, fetchChart: y.fetchChart });
  assert.equal(await read('6969'), null);
  assert.equal(y.calls.length, 2);
  for (let i = 0; i < 10; i++) { mock.timers.tick(2_000); assert.equal(await read('6969'), null); }   // 每 2 秒回源一次（CDN hot 層）
  assert.equal(y.calls.length, 2);
  mock.timers.tick(YAHOO_TRUNK_NEGATIVE_TTL_MS);
  await read('6969');
  assert.equal(y.calls.length, 4);
});

test('上游丟錯也走負快取（不會每個請求都重打）', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 5, 2, 0, 0) });
  let calls = 0;
  const read = createYahooTrunkReader({ memoize, fetchChart: async () => { calls++; throw new Error('boom'); } });
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(await read('1101'), null);
    assert.equal(await read('1101'), null);
  } finally { console.warn = warn; }
  assert.equal(calls, 2);   // 第一次的 .TW＋.TWO，第二次在冷卻期內不打
});

test('降級：成功後 Yahoo 暫時失敗 ⇒ 1 分鐘內沿用上一份主幹；超過上限回 null（改只用 daemon 分時）', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 5, 2, 0, 0) });
  const table = { '2603.TW': chart([200]) };
  const y = fakeYahoo(table);
  const read = createYahooTrunkReader({ memoize, fetchChart: y.fetchChart });
  const first = await read('2603');
  assert.equal(first.ticks[0].close, 200);
  delete table['2603.TW'];                      // Yahoo 開始失敗
  mock.timers.tick(YAHOO_TRUNK_TTL_MS);         // TTL 到期 → 重抓失敗 → 降級回舊值（年齡 30 秒 ≤ 60 秒）
  assert.equal(await read('2603'), first);
  mock.timers.tick(YAHOO_TRUNK_MAX_STALE_MS);   // 冷卻過後再失敗、舊值已 90 秒 > 60 秒
  assert.equal(await read('2603'), null);
});

test('代號不合法直接回 null，不打上游、不進快取', async () => {
  const y = fakeYahoo({});
  const read = createYahooTrunkReader({ memoize, fetchChart: y.fetchChart });
  for (const bad of ['', '../x', '2330.TW', 'AAAA', undefined]) assert.equal(await read(bad), null);
  assert.equal(y.calls.length, 0);
});
