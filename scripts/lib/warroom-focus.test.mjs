// 盤中戰情 v2「A2 時段焦點」單元測試：node --test scripts/lib/warroom-focus.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOCUS_WINDOW, focusPartActive, encodeGateRows, decodeGateRows, gateRsLabel } from './warroom-focus-codec.mjs';
import {
  FOCUS_LIMITS, parseJsonField, prevTradingYmd, buildQueue, buildAsia, yVolLookup, buildGateRows,
  dayPos, unrealizedNetR, buildDaytrade, withDayPos, buildTail,
} from './warroom-focus.mjs';
import { DESK_PARAMS } from './daytrade-setups.mjs';

// 2026-10-05（週一）台北 hh:mm → epoch ms
const T = (h, m, s = 0) => Date.UTC(2026, 9, 5, h - 8, m, s);

test('提供時窗：左閉右開、非交易日一律不提供', () => {
  assert.equal(focusPartActive('script', 8 * 60 + 59, true), true);
  assert.equal(focusPartActive('script', 9 * 60, true), false);
  assert.equal(focusPartActive('gates', 9 * 60, true), true);
  assert.equal(focusPartActive('gates', 9 * 60 + 59.9, true), true);
  assert.equal(focusPartActive('gates', 10 * 60, true), false);
  assert.equal(focusPartActive('daytrade', 13 * 60 + 44, true), true);
  assert.equal(focusPartActive('daytrade', 13 * 60 + 45, true), false);
  assert.equal(focusPartActive('tail', 12 * 60 + 44, true), false);
  assert.equal(focusPartActive('tail', 12 * 60 + 45, true), true);
  assert.equal(focusPartActive('gates', 9 * 60 + 10, false), false);
  assert.equal(focusPartActive('nope', 600, true), false);
  assert.equal(FOCUS_WINDOW.gates.label, '09:00–10:00');
});

test('開盤三關欄式編碼：來回一致、排序、去重、缺值保留', () => {
  const rows = [
    { code: '3017', ratio: 71.4, chg: 4.33, vw: 1 },
    { code: '2317', ratio: 38.2, chg: -1.85, vw: 0 },
    { code: '2330', ratio: null, chg: 1.17, vw: null },
    { code: '2317', ratio: 99, chg: 9, vw: 1 },          // 重複 ⇒ 只留第一筆
    { code: '0050', ratio: 10, chg: 1, vw: 1 },          // 4 碼仍收（篩 00 是 buildGateRows 的事）
    { code: 'abcd', ratio: 10, chg: 1, vw: 1 },          // 非代號丟掉
    { code: '1101', ratio: 10, chg: NaN, vw: 1 },        // 沒漲跌丟掉
  ];
  const wire = encodeGateRows(rows);
  assert.equal(wire.n, 4);
  const m = decodeGateRows(wire);
  assert.deepEqual([...m.keys()], ['0050', '2317', '2330', '3017']);
  assert.deepEqual(m.get('2317'), { ratio: 38, chg: -1.85, vw: 0 });
  assert.deepEqual(m.get('2330'), { ratio: null, chg: 1.17, vw: null });
  assert.deepEqual(m.get('3017'), { ratio: 71, chg: 4.33, vw: 1 });
});

test('開盤三關解碼：欄長不一致或代號不遞增 ⇒ 空 Map（不猜）', () => {
  assert.equal(decodeGateRows(null).size, 0);
  assert.equal(decodeGateRows({ d: '2317,13', r: '38', c: '-185,117', w: '01' }).size, 0);
  assert.equal(decodeGateRows({ d: '2317,0', r: '38,40', c: '-185,117', w: '01' }).size, 0);
  assert.equal(decodeGateRows({ d: '2317,x', r: '38,40', c: '-185,117', w: '01' }).size, 0);
  assert.equal(decodeGateRows({ d: '', r: '', c: '', w: '' }).size, 0);
});

test('第二關相對大盤：與 daemon buildTriGateLive 同口徑（跟風優先於自己強）', () => {
  assert.deepEqual(gateRsLabel(4, 3.5), { rs: 0.5, label: '跟風' });     // 漲 ≥3 但 RS <1
  assert.deepEqual(gateRsLabel(3, 0.5), { rs: 2.5, label: '自己強' });
  assert.deepEqual(gateRsLabel(1.2, -1), { rs: 2.2, label: '自己強' });
  assert.deepEqual(gateRsLabel(0.5, 0.2), { rs: 0.3, label: '中性' });
  assert.equal(gateRsLabel(null, 0.2), null);
  assert.equal(gateRsLabel(1, undefined), null);
});

test('前一交易日：跳過週末與休市日；格式錯回 null', () => {
  const holidays = new Set(['2026-10-02']);
  const isT = ymd => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !holidays.has(ymd); };
  assert.equal(prevTradingYmd('2026-10-05', isT), '2026-10-01');   // 週一 ⇒ 跳過週末與 10/02
  assert.equal(prevTradingYmd('2026-10-07', isT), '2026-10-06');
  assert.equal(prevTradingYmd('2026/10/05', isT), null);
  assert.equal(prevTradingYmd('2026-10-05', () => false, 5), null);
});

test('parseJsonField：壞字串回 null', () => {
  assert.deepEqual(parseJsonField('{"a":1}'), { a: 1 });
  assert.equal(parseJsonField('{bad'), null);
  assert.equal(parseJsonField(''), null);
  assert.equal(parseJsonField(42), null);
});

test('搶漲停排隊：只取前 N 檔、缺欄位為 null、資料日原樣帶出', () => {
  const doc = { date: '2026-10-05', n: 12, updatedAt: T(8, 42), items: Array.from({ length: 12 }, (_, i) => ({ code: String(6100 + i), name: `股${i}`, queueLots: 1000 - i, chg: 0, limitPrice: 50 + i })) };
  doc.items.unshift({ code: 'bad' });
  const q = buildQueue(doc);
  assert.equal(q.date, '2026-10-05');
  assert.equal(q.total, 12);
  assert.equal(q.items.length, FOCUS_LIMITS.queue);
  assert.deepEqual(q.items[0], { code: '6100', name: '股0', lots: 1000, chg: 0, limit: 50 });
  assert.deepEqual(buildQueue({ items: [{ code: '1101' }] }).items[0], { code: '1101', name: '1101', lots: null, chg: null, limit: null });
  assert.equal(buildQueue(null), null);
});

test('日韓早盤：欄位對照與補跑／分歧旗標', () => {
  const a = buildAsia({ date: '2026-10-05', jp: { chg: 0.62 }, kr: { chg: -0.3 }, sox: 1.4, delayMin: 21, lateCatchup: false, split: '⚠日韓分歧' });
  assert.deepEqual(a, { date: '2026-10-05', jp: 0.62, kr: -0.3, sox: 1.4, delayMin: 21, late: false, split: true });
  assert.deepEqual(buildAsia({ date: 'x', lateCatchup: true }), { date: null, jp: null, kr: null, sox: null, delayMin: null, late: true, split: false });
});

test('盤前新聞判別已移到 board.news（warroom-news.premarketNewsRows）：focus 不再匯出 buildNewsLite', async () => {
  const focus = await import('./warroom-focus.mjs');
  assert.equal(focus.buildNewsLite, undefined);
  const news = await import('./warroom-news.mjs');
  assert.equal(typeof news.premarketNewsRows, 'function');
});

test('開盤三關 live：累計量÷昨量、只收 4 碼普通股、VWAP 未知不猜', () => {
  const quotes = {
    2317: { live: true, price: 371.5, changePercent: -1.85, volume: 19_100_000, vwap: 375 },
    3017: { live: true, price: 1685, changePercent: 4.33, volume: 1_420_000, vwap: 1650 },
    2330: { live: true, price: 2585, changePercent: 1.17, volume: 5_000_000, vwap: null },
    6488: { live: false, price: 512, changePercent: 0, volume: 0 },       // 今日無真成交 ⇒ 不列
    '0050': { live: true, price: 200, changePercent: 1, volume: 1_000_000 },   // ETF ⇒ 不列
    '00878': { live: true, price: 20, changePercent: 1, volume: 1_000_000 },
  };
  const yVol = yVolLookup({ 2317: [370, 50_000], 3017: [1600, 2_000], 2330: [2550, 0] });
  const m = decodeGateRows(buildGateRows({ quotes, yVol }));
  assert.deepEqual([...m.keys()], ['2317', '2330', '3017']);
  assert.deepEqual(m.get('2317'), { ratio: 38, chg: -1.85, vw: 0 });
  assert.deepEqual(m.get('3017'), { ratio: 71, chg: 4.33, vw: 1 });
  assert.deepEqual(m.get('2330'), { ratio: null, chg: 1.17, vw: null });   // 昨量 0 ⇒ 缺；vwap 缺 ⇒ 未知
});

test('開盤三關 frozen：用 09:30 定格的漲跌與前 30 分量，VWAP 仍看即時', () => {
  const quotes = { 2317: { live: true, price: 380, changePercent: 0.5, volume: 30_000_000, vwap: 376 } };
  const frozenBy = { 2317: [-1.2, 20_000], 3017: [3.1, 1_500], '0050': [1, 10] };
  const m = decodeGateRows(buildGateRows({ quotes, yVol: yVolLookup({ 2317: [0, 50_000], 3017: [0, 3_000] }), frozenBy }));
  assert.deepEqual(m.get('2317'), { ratio: 40, chg: -1.2, vw: 1 });
  assert.deepEqual(m.get('3017'), { ratio: 50, chg: 3.1, vw: null });
  assert.equal(m.has('0050'), false);
});

test('日內位置：與撿尾盤同口徑（無振幅＝1）', () => {
  assert.equal(dayPos({ price: 110, high: 120, low: 100 }), 0.5);
  assert.equal(dayPos({ price: 110, high: 110, low: 110 }), 1);
  assert.equal(dayPos({ price: 0, high: 1, low: 1 }), null);
  assert.equal(dayPos(null), null);
});

test('成立中淨 R：與 daytrade-setups 出場算法同（分批加權後扣成本）', () => {
  const split = DESK_PARAMS.split;
  const plan = { entry: 100, d: 2, costR: 0.15, hit: [false, false, false] };
  assert.equal(unrealizedNetR(plan, 103, 'long', split), 1.35);           // 1.5R − 0.15
  assert.equal(unrealizedNetR({ ...plan, hit: [true, false, false] }, 103, 'long', split), +((1 / 3) * 1 + (2 / 3) * 1.5 - 0.15).toFixed(2));
  assert.equal(unrealizedNetR(plan, 98, 'short', split), 0.85);           // 空：跌 2 ＝ +1R
  assert.equal(unrealizedNetR({ ...plan, d: 0 }, 103, 'long', split), null);
  assert.equal(unrealizedNetR({ ...plan, costR: null }, 103, 'long', split), null);
  assert.equal(unrealizedNetR(plan, null, 'long', split), null);
});

function dtDoc() {
  const now = T(10, 42);
  const row = (code, st, extra = {}) => ({ code, name: `名${code}`, st, m: { c: 105, chg: 2.1 }, plan: { type: 'ORB', t: T(9, 52), entry: 100, stop: 98, trail: 98, d: 2, costR: 0.15, hit: [false, false, false], netR: null }, watch: [], ...extra });
  return {
    now,
    doc: {
      date: '2026-10-05', at: now,
      long: [
        row('3037', { phase: 'on', since: T(9, 52) }),
        row('2368', { phase: 'on', since: T(10, 18) }),
        row('2344', { phase: 'stop', since: T(9, 30), stopAt: T(10, 35), stopPx: 97 }, { plan: { type: 'ORB', entry: 100, stop: 98, netR: -1.08, exit: { reason: '結構停損' } } }),
        row('2603', { phase: 'stop', since: T(9, 10), stopAt: T(10, 0), stopPx: 99 }, { watch: [{ type: 'ORB', trigger: 101, stop: 99 }] }),   // 出場逾 15 分＋有等待 ⇒ wait
        row('1513', null, { watch: [{ type: '突破回踩', trigger: 101, stop: null }] }),   // 停損未寫定 ⇒ 不算 wait
        row('6446', null, { watch: [{ type: 'ORB', trigger: 101, stop: 99 }] }),
        { code: 'bad' },
      ],
      short: [],
    },
  };
}

test('當沖觀察：成立中依成立時間新到舊、剛出場在後；等待條件只計數', () => {
  const { now, doc } = dtDoc();
  const d = buildDaytrade(doc, { ymd: '2026-10-05', now });
  assert.equal(d.date, '2026-10-05');
  assert.deepEqual(d.long.rows.map(r => `${r.phase}:${r.code}`), ['on:2368', 'on:3037', 'stop:2344']);
  assert.equal(d.long.on, 2);
  assert.equal(d.long.stop, 1);
  assert.equal(d.long.wait, 2);
  assert.equal(d.long.monitored, 6);
  const on = d.long.rows[1];
  assert.equal(on.t, T(9, 52));
  assert.equal(on.entry, 100);
  assert.equal(on.stop, 98);
  assert.equal(on.netR, 2.35);           // (105−100)/2＝2.5R − 0.15
  assert.equal(on.reason, null);
  const out = d.long.rows[2];
  assert.equal(out.t, T(10, 35));
  assert.equal(out.netR, -1.08);
  assert.equal(out.reason, '結構停損');
  assert.equal(out.exitPx, 97);
  assert.deepEqual(d.short, { rows: [], on: 0, stop: 0, wait: 0, monitored: 0 });
});

test('當沖觀察：文件日期不是今天 ⇒ 不列任何個股；每側最多 N 列', () => {
  const { now, doc } = dtDoc();
  const old = buildDaytrade({ ...doc, date: '2026-10-02' }, { ymd: '2026-10-05', now });
  assert.equal(old.date, '2026-10-02');
  assert.equal(old.long.rows.length, 0);
  const many = { ...doc, long: Array.from({ length: 9 }, (_, i) => ({ code: String(2000 + i), st: { phase: 'on', since: T(9, 40 + i) }, m: { c: 1 }, plan: {} })) };
  assert.equal(buildDaytrade(many, { ymd: '2026-10-05', now }).long.rows.length, FOCUS_LIMITS.dtPerSide);
  assert.equal(buildDaytrade(null, { ymd: '2026-10-05', now }), null);
});

test('當沖列補日內位置：回新物件、不改原物件', () => {
  const { now, doc } = dtDoc();
  const d = buildDaytrade(doc, { ymd: '2026-10-05', now });
  const d2 = withDayPos(d, { 3037: { price: 110, high: 120, low: 100 } });
  assert.equal(d2.long.rows.find(r => r.code === '3037').pos, 0.5);
  assert.equal(d2.long.rows.find(r => r.code === '2368').pos, null);
  assert.equal(d.long.rows.find(r => r.code === '3037').pos, null);
});

test('撿尾盤：前 N 檔、鎖漲停計數、來源與法人日原樣帶出', () => {
  const buyable = Array.from({ length: 14 }, (_, i) => ({ code: String(3400 + i), name: ` 股${i} `, market: 'tse', price: 100 + i, chg: 3.5, pos: 0.9, volX: 1.8, fStreak: i % 3, char: i ? null : '炒作型' }));
  const t = buildTail({ tailPicks: { date: '2026-10-05', source: 'live', instDate: '2026-10-02', buyable, locked: [{ code: '4979' }], buyableTotal: 14, updatedAt: T(13, 4) } });
  assert.equal(t.date, '2026-10-05');
  assert.equal(t.source, 'live');
  assert.equal(t.instDate, '2026-10-02');
  assert.equal(t.total, 14);
  assert.equal(t.locked, 1);
  assert.equal(t.items.length, FOCUS_LIMITS.tail);
  assert.deepEqual(t.items[0], { code: '3400', name: '股0', market: 'tse', px: 100, chg: 3.5, pos: 0.9, volX: 1.8, fStreak: 0, char: '炒作型' });
  assert.equal(buildTail({}), null);
  assert.equal(buildTail({ tailPicks: { source: 'x' } }).source, null);
});
