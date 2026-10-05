// AI 停損規範 stop-v1 共用純函式 單元測試：node --test scripts/lib/ai-stoploss.test.mjs
// 編號對應實作計畫 warroom/stoploss/impl-plan.md §5 測試清單（只涵蓋 ai-stoploss.mjs 已實作的函式）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STOP_PARAMS, STOP_SPEC_VERSION, EMPTY_EX_TABLE, STOP_FACT_KINDS,
  isEtfCode, tickOf, roundTick, onTick, limitPrices,
  aggregatePositions, exTableFor, adjustedCost, classifyLotChange, legacyPushStop, resolveStop,
  judgeSegment, segmentJudges, isTodayTrade, isSetToday, evaluateTouch, stopDistance,
  advanceEpisode, settleEpisode, stopFactText,
} from './ai-stoploss.mjs';
import { warSegmentAt } from './warroom-session.mjs';

// 2026-10-05（週一）台北 hh:mm:ss → epoch ms（以 UTC 建構，與執行環境時區無關）
const T = (h, m, s = 0, day = 5) => Date.UTC(2026, 9, day, h - 8, m, s);
const TODAY = '2026-10-05';
const OPEN = T(9, 0);

const lot = (id, buyPrice, qty, buyDate = '2026-09-01') => ({ id, buyPrice, qty, buyDate });
const pos = (lots, code = '2317') => {
  const qty = lots.reduce((s, l) => s + l.qty, 0);
  return { code, name: '', qty, avgCost: lots.reduce((s, l) => s + l.buyPrice * l.qty, 0) / qty,
    firstDate: lots[0]?.buyDate ?? null, lastBuyDate: lots[lots.length - 1]?.buyDate ?? null, lots };
};
const exOf = (events, coverFrom = '2022-07-01', coverTo = TODAY) => ({ events, coverFrom, coverTo });
const NO_EX = exOf([]);
const resolve = (position, ex = NO_EX, prev = null, extra = {}) =>
  resolveStop({ position, ex, prev, nowMs: T(10, 0), tradeDate: TODAY, ...extra });
const prevOf = (r, position) => ({
  stop: r.stop, stopVersion: r.stopVersion, lots: position.lots, exApplied: r.exApplied,
  selfAdjusted: r.selfAdjusted, startedAt: r.startedAt, tradeDate: r.tradeDate,
});

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

// ── A. 檔位與漲跌停 ──────────────────────────────────────────────────────────

test('A1 個股檔位邊界', () => {
  const cases = [[9.99, 0.01], [10, 0.05], [49.95, 0.05], [50, 0.1], [99.9, 0.1], [100, 0.5], [499.5, 0.5], [500, 1], [999, 1], [1000, 5]];
  for (const [p, t] of cases) assert.equal(tickOf(p), t, String(p));
});

test('A2 ETF 檔位與代號判定（英文字尾釘住 daemon 現行判定：非 ETF·待核實 §15-1）', () => {
  assert.equal(tickOf(49.99, true), 0.01);
  assert.equal(tickOf(50, true), 0.05);
  assert.equal(isEtfCode('0050'), true);
  assert.equal(isEtfCode('00878'), true);
  assert.equal(isEtfCode('006208'), true);
  assert.equal(isEtfCode('2330'), false);
  for (const c of ['00632R', '00958B', '00400A']) assert.equal(isEtfCode(c), false, c);
  assert.equal(onTick(103.55, true), true);   // ETF ≥50 檔位 0.05
  assert.equal(onTick(103.55, false), false); // 用個股表會誤判
});

// ⚠ 規範與實作計畫的範例「52.348 → 52.35」只在 ETF 檔位表（≥50 元 0.05）成立；個股 50–100 元檔位是 0.1 ⇒ 52.4。
//   這裡照交易所／daemon _tickOf 的檔位表（SKILL §3.2「向上取到合法檔位」），兩種都釘住。
test('A3 取檔：向上、向下、浮點誤差（個股 52.348 → 52.4；ETF → 52.35）', () => {
  assert.equal(roundTick(52.348, 1), 52.4);
  assert.equal(roundTick(52.3328, 1), 52.4);
  assert.equal(roundTick(52.348, 1, true), 52.35);
  assert.equal(roundTick(52.3328, 1, true), 52.35);
  assert.equal(roundTick(47.348, 1), 47.35);
  assert.equal(roundTick(52.4, 1), 52.4);              // 已在檔位上不再進一檔
  assert.equal(roundTick(80 * 0.92, 1), 73.6);         // 73.60000000000001
  assert.equal(roundTick(52.348, -1), 52.3);
  assert.equal(roundTick(88.32, 1), 88.4);
  assert.equal(roundTick(9.995, 1), 10);
  assert.ok(Number.isNaN(roundTick(0, 1)));
  assert.equal(onTick(24.02), false);
  assert.equal(onTick(24.05), true);
});

test('A4 漲跌停：參考價 100 → 110／90；ETF；參考價缺或無漲跌幅限制 ⇒ null', () => {
  assert.deepEqual(limitPrices(100), { up: 110, down: 90 });
  assert.deepEqual(limitPrices(33.33), { up: 36.65, down: 30 });
  assert.deepEqual(limitPrices(48.33, true), { up: 53.15, down: 43.5 });
  assert.equal(limitPrices(null), null);
  assert.equal(limitPrices(0), null);
  assert.equal(limitPrices(100, false, true), null);
});

// ── B. 彙總與過渡期 ──────────────────────────────────────────────────────────

test('B5 部位彙總：張數相加、均價＝Σ買價×張÷Σ張、保留首次出現順序、帶每筆 id 與正規化買進日', () => {
  const rows = aggregatePositions([
    { id: 'a', code: '2317', name: '鴻海', buyPrice: 200, quantity: 1, buyDate: '2026-09-01' },
    { id: 'b', code: '2330', name: '台積電', buyPrice: 1000, quantity: 0.5, buyDate: '2026/9/2' },
    { id: 'c', code: '2317', name: '鴻海', buyPrice: 230, quantity: 2, buyDate: '2026-10-05' },
  ]);
  assert.deepEqual(rows.map(r => r.code), ['2317', '2330']);
  const hon = rows[0];
  assert.equal(hon.qty, 3);
  assert.equal(hon.avgCost, 220);
  assert.equal(hon.firstDate, '2026-09-01');
  assert.equal(hon.lastBuyDate, '2026-10-05');
  assert.deepEqual(hon.lots, [
    { id: 'a', buyPrice: 200, qty: 1, buyDate: '2026-09-01' },
    { id: 'c', buyPrice: 230, qty: 2, buyDate: '2026-10-05' },
  ]);
  assert.equal(rows[1].lots[0].buyDate, '2026-09-02');
});

test('B8 彙總略過買價或張數不是正數的列（daemon :3235 現行會算進均價——S5 切換時統一）', () => {
  const rows = aggregatePositions([
    { id: 'z', code: '2317', buyPrice: 0, quantity: 1 },
    { id: 'y', code: '2317', buyPrice: 100, quantity: -1 },
    { code: '2603', buyPrice: 150, quantity: 1 },
    null,
    { code: '', buyPrice: 1, quantity: 1 },
  ]);
  assert.deepEqual(rows.map(r => r.code), ['2603']);
  assert.equal(rows[0].lots[0].id, '2603#2');   // 沒有 id 的列以「代號#序號」補
  assert.equal(rows[0].firstDate, null);
  assert.deepEqual(aggregatePositions(undefined), []);
});

test('B6 legacyPushStop＝daemon 停損推播算式（AI 停損 >0 優先，否則均價×0.92 取 0.01）', () => {
  assert.deepEqual(legacyPushStop(220, 205.5), { price: 205.5, source: 'ai' });
  assert.deepEqual(legacyPushStop(220, 0), { price: 202.4, source: 'cost' });
  assert.deepEqual(legacyPushStop(220, null), { price: 202.4, source: 'cost' });
  assert.deepEqual(legacyPushStop(220, NaN), { price: 202.4, source: 'cost' });
  assert.deepEqual(legacyPushStop(33.33, undefined), { price: +(33.33 * 0.92).toFixed(2), source: 'cost' });
  assert.equal(legacyPushStop(0, 100), null);
});

test('B7 原始碼釘住：daemon 停損推播與停損紀律的錨點字串仍在（改了就要同步 legacyPushStop 與規範）', () => {
  const daemon = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ai-daemon.mjs'), 'utf8');
  assert.ok(daemon.includes('const stop = a.stopLoss > 0 ? a.stopLoss : +(avg * 0.92).toFixed(2);'), '推播停損錨點');
  assert.ok(daemon.includes("if (price <= stop) { type = 'stop';"), '推播 if 鏈');
  assert.ok(daemon.includes('const stop = +Math.max(a.stopLoss > 0 ? a.stopLoss : 0, avg * 0.92).toFixed(2);'), '停損紀律錨點');
});

// ── C. 還原成本與 resolveStop ──────────────────────────────────────────────

test('C9 成本線＝ceilTick(還原成本×0.92)：100 → 92.0；56.90 → 52.4（個股）／52.35（ETF）', () => {
  const a = resolve(pos([lot('a', 100, 1)]));
  assert.equal(a.stop, 92);
  assert.equal(a.costLine, 92);
  assert.equal(a.versionReason, 'init');
  assert.equal(a.stopVersion, 1);
  assert.equal(a.specVersion, STOP_SPEC_VERSION);
  assert.equal(a.line, 'stop');
  assert.equal(a.basisText, '成本線·還原成本 100.00 −8%');
  assert.equal(resolve(pos([lot('a', 56.9, 1)])).stop, 52.4);
  assert.equal(resolve(pos([lot('a', 56.9, 1)], '00878')).stop, 52.35);
  // 沒有係數表（前端退回）：依據文字標「未含除權息調整」，不判 exUnknown
  const p = resolve(pos([lot('a', 56.9, 1)]), EMPTY_EX_TABLE);
  assert.equal(p.basisText, '成本線·買進均價 56.90 −8%·未含除權息調整');
  assert.equal(p.exUnknown, false);
});

test('C10 逐筆還原：除息前 100＋除息後 96、f＝0.96 ⇒ 還原成本 96（不是 94.08），成本線 88.4', () => {
  const ex = exOf([['2026-07-15', 0.96]]);
  const position = pos([lot('a', 100, 1, '2026-07-01'), lot('b', 96, 1, '2026-08-01')]);
  const c = adjustedCost(position, ex);
  assert.equal(+c.adjCost.toFixed(6), 96);
  assert.deepEqual(c.applied, ['2026-07-15']);
  assert.equal(resolve(position, ex).stop, 88.4);
  // 買在除息日當天＝已是除息後價格，不再乘
  assert.equal(adjustedCost(pos([lot('a', 100, 1, '2026-07-15')]), ex).adjCost, 100);
});

test('C11 除權息：上一版 54.40、f＝0.962 ⇒ ceilTick(52.3328)＝52.4（ETF 52.35）、exAdjust（停損唯一允許下移的情況）', () => {
  const position = pos([lot('a', 57, 1, '2026-07-01')]);
  const prev = { stop: 54.4, stopVersion: 3, lots: position.lots, exApplied: [], selfAdjusted: {}, startedAt: T(9, 5, 0, 1), tradeDate: '2026-10-01' };
  const etf = resolve(pos([lot('a', 57, 1, '2026-07-01')], '00878'), exOf([['2026-10-05', 0.962]]), prev);
  assert.equal(etf.stop, 52.35);
  const r = resolve(position, exOf([['2026-10-05', 0.962]]), prev);
  assert.equal(r.stop, 52.4);
  assert.equal(r.versionReason, 'exAdjust');
  assert.equal(r.stopVersion, 4);
  assert.deepEqual(r.exApplied, ['2026-10-05']);
  assert.deepEqual(r.rejected, []);
  // 同一事件再算一次：已套用，不再乘
  const again = resolve(position, exOf([['2026-10-05', 0.962]]), prevOf(r, position));
  assert.equal(again.stop, 52.4);
  assert.equal(again.versionReason, null);
});

test('C12 面額變更 f＝0.1 經係數表 ⇒ 成本與停損 ×0.1；使用者把同筆改成買價÷10、張數×10 ⇒ selfAdjust、不重乘、不判攤平或成本更正', () => {
  const ex = exOf([['2026-09-20', 0.1]]);
  const before = pos([lot('a', 100, 1, '2026-09-01')]);
  const prev0 = { stop: 92, stopVersion: 1, lots: before.lots, exApplied: [], selfAdjusted: {}, startedAt: T(9, 0, 0, 1), tradeDate: '2026-09-01' };
  const r1 = resolve(before, ex, prev0);
  assert.equal(r1.stop, 9.2);
  assert.equal(r1.versionReason, 'exAdjust');
  const after = pos([lot('a', 10, 10, '2026-09-01')]);
  const cls = classifyLotChange(before.lots, after.lots, ex);
  assert.deepEqual(cls.changes, ['selfAdjust']);
  assert.deepEqual(cls.selfAdjusted, { a: ['2026-09-20'] });
  const r2 = resolve(after, ex, prevOf(r1, before));
  assert.equal(r2.stop, 9.2);
  assert.equal(r2.versionReason, null);
  assert.equal(+r2.adjCost.toFixed(6), 10);  // 使用者在 daemon 套用事件之前就自行調整（同一輪才認出）：停損仍依係數帶下來，不會停在 92 而一設定就觸及
  const same = resolve(after, ex, prev0);
  assert.equal(same.stop, 9.2);
  assert.equal(same.versionReason, 'exAdjust');
  assert.deepEqual(same.exApplied, ['2026-09-20']);
});

test('C13 攤平：100×1 再 80×1（新 id）⇒ 均價 90，停損維持 92.0，line 仍是 stop', () => {
  const p0 = pos([lot('a', 100, 1)]);
  const r0 = resolve(p0);
  const p1 = pos([lot('a', 100, 1), lot('b', 80, 1, '2026-09-10')]);
  const r1 = resolve(p1, NO_EX, prevOf(r0, p0));
  assert.deepEqual(r1.lotChanges, ['buy']);
  assert.equal(r1.costLine, 82.8);
  assert.equal(r1.stop, 92);
  assert.equal(r1.line, 'stop');
  assert.equal(r1.versionReason, null);
  assert.equal(r1.stopVersion, r0.stopVersion);
});

test('C14 FIFO 部分賣出：剩下批次重算成本線、棘輪保留；同 id 張數減少判 sell 不是 edit', () => {
  const p0 = pos([lot('a', 100, 1), lot('b', 80, 1, '2026-09-10')]);
  const prev = { stop: 92, stopVersion: 2, lots: p0.lots, exApplied: [], selfAdjusted: {}, startedAt: 1, tradeDate: '2026-09-10' };
  const r = resolve(pos([lot('b', 80, 1, '2026-09-10')]), NO_EX, prev);
  assert.equal(r.costLine, 73.6);
  assert.equal(r.stop, 92);
  assert.equal(r.versionReason, null);
  assert.equal(r.stopVersion, 2);
  const cls = classifyLotChange([lot('a', 100, 2), lot('b', 80, 1)], [lot('a', 100, 1), lot('b', 80, 1)], NO_EX);
  assert.deepEqual(cls.changes, ['sell']);
});

test('C15 高價加碼（新 id、均價上升）⇒ 停損上調、ratchet', () => {
  const p0 = pos([lot('a', 100, 1)]);
  const r0 = resolve(p0);
  const r1 = resolve(pos([lot('a', 100, 1), lot('b', 130, 1, '2026-10-05')]), NO_EX, prevOf(r0, p0), { nowMs: T(10, 30) });
  assert.equal(r1.stop, 106);   // 均價 115 ×0.92＝105.8 → 檔位 0.5 向上取
  assert.equal(r1.versionReason, 'ratchet');
  assert.equal(r1.stopVersion, 2);
  assert.equal(r1.startedAt, T(10, 30));
});

test('C16 成本更正只認「同一 id 被改」；同 id 張數增加視同加碼；刪除重建視為賣出再買進、棘輪不歸零', () => {
  const p0 = pos([lot('a', 100, 1), lot('b', 100, 1)]);
  const prev = { stop: 99, stopVersion: 5, lots: p0.lots, exApplied: [], selfAdjusted: {}, startedAt: 1, tradeDate: '2026-09-01' };
  const edited = resolve(pos([lot('a', 90, 1), lot('b', 100, 1)]), NO_EX, prev);
  assert.equal(edited.versionReason, 'costCorrection');
  assert.equal(edited.stop, 87.4);   // 均價 95 ×0.92＝87.4（50–100 元檔位 0.1）
  assert.deepEqual(classifyLotChange(p0.lots, [lot('a', 100, 1, '2026-09-02'), lot('b', 100, 1)], NO_EX).changes, ['edit']);
  const more = classifyLotChange(p0.lots, [lot('a', 100, 3), lot('b', 100, 1)], NO_EX);
  assert.deepEqual(more.changes, ['buy']);
  const rebuilt = resolve(pos([lot('c', 90, 1), lot('b', 100, 1)]), NO_EX, prev);
  assert.deepEqual(rebuilt.lotChanges.sort(), ['buy', 'sell']);
  assert.equal(rebuilt.stop, 99);
  assert.equal(rebuilt.versionReason, null);
});

test('C17 自檢例外：init／costCorrection／exAdjust 造成的下降不記 loosen；棘輪下 v1 沒有一般下降路徑', () => {
  const p0 = pos([lot('a', 100, 1)]);
  const prev = { stop: 95, stopVersion: 1, lots: p0.lots, exApplied: [], selfAdjusted: {}, startedAt: 1, tradeDate: '2026-09-01' };
  const corr = resolve(pos([lot('a', 80, 1)]), NO_EX, prev);
  assert.equal(corr.versionReason, 'costCorrection');
  assert.equal(corr.stop, 73.6);
  assert.deepEqual(corr.rejected, []);
  const ex = resolve(p0, exOf([['2026-09-15', 0.9]]), prev);
  assert.equal(ex.versionReason, 'exAdjust');
  assert.equal(ex.stop, 85.5);
  assert.deepEqual(ex.rejected, []);
  const sold = resolve(pos([lot('b', 50, 1)]), NO_EX, prev);   // 換成低價批次：成本線 46，停損維持 95
  assert.equal(sold.stop, 95);
  assert.ok(!sold.rejected.some(r => r.code === 'loosen'));
});

test('C18 成本可疑：現價÷還原成本 <0.25 或 >5 ⇒ suspect（停損照算）', () => {
  assert.equal(resolve(pos([lot('a', 100, 1)]), NO_EX, null, { lastPrice: 3 }).suspect, true);
  assert.equal(resolve(pos([lot('a', 100, 1)]), NO_EX, null, { lastPrice: 600 }).suspect, true);
  assert.equal(resolve(pos([lot('a', 100, 1)]), NO_EX, null, { lastPrice: 80 }).suspect, false);
  assert.equal(resolve(pos([lot('a', 100, 1)]), NO_EX, null, { lastPrice: 3 }).stop, 92);
});

test('C19 上一版不合法 ⇒ prevInvalid、從成本線重算；上一版高於現價（觸及進行中）照常採用', () => {
  const p0 = pos([lot('a', 100, 1)]);
  for (const bad of [NaN, 0, -1, 92.03]) {
    const r = resolve(p0, NO_EX, { stop: bad, stopVersion: 4, lots: p0.lots, exApplied: [], startedAt: 1, tradeDate: '2026-09-01' });
    assert.equal(r.stop, 92, String(bad));
    assert.equal(r.versionReason, 'init');
    assert.equal(r.stopVersion, 5);
    assert.equal(r.rejected[0].code, 'prevInvalid');
  }
  const held = resolve(p0, NO_EX, { stop: 95, stopVersion: 2, lots: p0.lots, exApplied: [], startedAt: 1, tradeDate: '2026-09-01' }, { lastPrice: 90 });
  assert.equal(held.stop, 95);
  assert.deepEqual(held.rejected, []);
});

test('C20 exUnknown：買進日早於係數表涵蓋起點（或沒有買進日）', () => {
  assert.equal(adjustedCost(pos([lot('a', 100, 1, '2022-01-03')]), NO_EX).exUnknown, true);
  assert.equal(adjustedCost(pos([lot('a', 100, 1, '2023-01-03')]), NO_EX).exUnknown, false);
  assert.equal(adjustedCost(pos([lot('a', 100, 1, null)]), NO_EX).exUnknown, true);
  assert.equal(adjustedCost(pos([lot('a', 100, 1, '2022-01-03')]), EMPTY_EX_TABLE).exUnknown, false);
});

test('C21 版本日由呼叫端傳入（非交易日＝最後交易日）原樣寫入', () => {
  const r = resolveStop({ position: pos([lot('a', 100, 1)]), ex: NO_EX, nowMs: T(11, 0, 0, 10), tradeDate: '2026-10-09' });
  assert.equal(r.tradeDate, '2026-10-09');
  assert.equal(r.startedAt, T(11, 0, 0, 10));
});

test('C22 不可變：輸入深凍結後呼叫不丟錯、不被改動；成本缺 ⇒ stop null', () => {
  const position = deepFreeze(pos([lot('a', 100, 1), lot('b', 80, 1)]));
  const ex = deepFreeze(exOf([['2026-09-15', 0.95]]));
  const prev = deepFreeze({ stop: 92, stopVersion: 1, lots: [lot('a', 100, 1)], exApplied: [], selfAdjusted: {}, startedAt: 1, tradeDate: '2026-09-01' });
  const r = resolve(position, ex, prev, { lastPrice: 90 });
  assert.ok(r.stop > 0);
  assert.equal(position.lots.length, 2);
  const none = resolve({ code: '2317', name: '', qty: 0, avgCost: 0, firstDate: null, lastBuyDate: null, lots: [] });
  assert.equal(none.stop, null);
  assert.equal(none.basisText, '成本資料缺');
});

test('exTableFor：只取該代號、涵蓋區間內、依日期排序、同日只取第一筆', () => {
  const t = exTableFor('2330', [
    { date: '2026-09-10', code: '2330', factor: 0.99 },
    { date: '2026-03-10', code: '2330', factor: 0.98 },
    { date: '2026-09-10', code: '2330', factor: 0.5 },
    { date: '2021-03-10', code: '2330', factor: 0.9 },
    { date: '2026-05-10', code: '2317', factor: 0.9 },
  ], { from: '2022-07-01', to: TODAY });
  assert.deepEqual(t.events.map(e => [...e]), [['2026-03-10', 0.98], ['2026-09-10', 0.99]]);
  assert.equal(t.coverFrom, '2022-07-01');
});

// ── D. 時段與觸發 ────────────────────────────────────────────────────────────

test('D23 judgeSegment 與 warroom-session.warSegmentAt 逐點相同；open／mid／tail／closing 才判定', () => {
  const pts = [[8, 29, 59], [8, 30, 0], [8, 54, 59], [8, 55, 0], [8, 59, 59], [9, 0, 0], [9, 29, 59], [9, 30, 0],
    [12, 44, 59], [12, 45, 0], [13, 24, 59], [13, 25, 0], [13, 29, 59], [13, 30, 0], [13, 44, 59], [13, 45, 0]];
  for (const [h, m, s] of pts) assert.equal(judgeSegment(T(h, m, s), true), warSegmentAt(T(h, m, s), true));
  assert.equal(judgeSegment(T(10, 0), false), 'nontrading');
  const judging = ['pre', 'preclear', 'open', 'mid', 'tail', 'auction', 'closing', 'after', 'nontrading'].filter(segmentJudges);
  assert.deepEqual(judging, ['open', 'mid', 'tail', 'closing']);
});

const live = (over = {}) => ({ price: 93, open: 95, high: 96, low: 91.5, volume: 1200, live: true, liveAt: T(10, 42), revealAt: T(10, 42), ...over });
const judge = (over = {}) => evaluateTouch({ stop: 92, quote: live(), nowMs: T(10, 43), todayYmd: TODAY, tradingDay: true, ...over });

test('D24 今日 low ≤ 停損、live、今天、有量 ⇒ touched／touch／basis low', () => {
  const r = judge();
  assert.equal(r.status, 'touched');
  assert.equal(r.kind, 'touch');
  assert.equal(r.basis, 'low');
  assert.equal(r.triggerPx, 91.5);
  assert.equal(r.segment, 'mid');
});

test('D25 開盤 ≤ 停損 ⇒ gap、skipPct 照實記（不另報 touch）', () => {
  const r = judge({ quote: live({ open: 88, low: 87.5 }) });
  assert.equal(r.kind, 'gap');
  assert.equal(r.triggerPx, 88);
  assert.equal(r.skipPct, 4.35);   // (92−88)/92×100
});

test('D26 種子價（沒有 liveAt、昨日開高低）⇒ noTodayTrade（09:00 首輪誤觸案例）', () => {
  const seed = { price: 90, open: 91, high: 92, low: 89, volume: 5000, live: false };
  assert.equal(judge({ quote: seed, nowMs: T(9, 0, 30) }).notJudged, 'noTodayTrade');
  assert.equal(judge({ quote: live({ liveAt: T(13, 0, 0, 2) }) }).notJudged, 'noTodayTrade');   // 前一交易日殘留
  assert.equal(judge({ quote: live({ volume: 0 }) }).notJudged, 'noTodayTrade');
  assert.equal(isTodayTrade(live({ live: false, settled: true }), TODAY), true);   // 收盤後沿用的今日最後即時價
  assert.equal(isTodayTrade(live({ live: false }), TODAY), false);
});

test('D27 現價 ≤ 停損但 low > 停損（五檔買一）⇒ 不是 touched', () => {
  const r = judge({ quote: live({ price: 91.9, low: 92.1 }) });
  assert.notEqual(r.status, 'touched');
});

test('D28 low＝0、不在檔位上、低於已知跌停價 ⇒ badLow', () => {
  assert.equal(judge({ quote: live({ low: 0 }) }).notJudged, 'badLow');
  assert.equal(judge({ quote: live({ low: 91.53 }) }).notJudged, 'badLow');
  assert.equal(judge({ quote: live({ low: 89 }), refPrice: 100 }).notJudged, 'badLow');
});

test('D29 收盤競價窗不判定；closing 的 settled 報價 low ≤ 停損 ⇒ kind close', () => {
  assert.equal(judge({ nowMs: T(13, 26) }).notJudged, 'segment');
  assert.equal(judge({ nowMs: T(8, 45) }).notJudged, 'segment');
  const r = judge({ nowMs: T(13, 31), quote: live({ live: false, settled: false, liveAt: T(13, 30, 5) }) });
  assert.equal(r.status, 'touched');
  assert.equal(r.kind, 'close');
});

test('D30 exPending 暫停；exUnconfirmed／exUnknown 觸及成立但 hold；成本可疑 ⇒ suspectCost', () => {
  assert.equal(judge({ exPending: true }).notJudged, 'exPending');
  const u = judge({ exUnconfirmed: true });
  assert.equal(u.status, 'touched'); assert.equal(u.hold, 'exUnconfirmed');
  const k = judge({ exUnknown: true });
  assert.equal(k.status, 'touched'); assert.equal(k.hold, 'exUnknown');
  assert.equal(judge({ suspect: true }).notJudged, 'suspectCost');
  assert.equal(judge({ stop: 0 }).notJudged, 'noStop');
});

test('D31 跌停事實：low＝跌停價 ⇒「今日在跌停價…有成交」；開＝高＝低＝跌停 ⇒「今日未曾高於跌停價」；參考價缺不寫', () => {
  const a = judge({ quote: live({ low: 90, open: 94 }), refPrice: 100 });
  assert.ok(a.facts.includes('今日在跌停價 90.0 有成交'));
  const b = judge({ quote: live({ low: 90, open: 90, high: 90, price: 90 }), refPrice: 100 });
  assert.ok(b.facts.includes('今日未曾高於跌停價'));
  assert.equal(b.kind, 'gap');
  const c = judge({ quote: live({ low: 90, open: 94 }), refPrice: null });
  assert.ok(!c.facts.some(f => f.includes('跌停')));
  const d = judge({ quote: live({ low: 90, open: 94 }), refPrice: 100, noLimit: true });
  assert.ok(!d.facts.some(f => f.includes('跌停')));
});

test('D32 報價舊 400 秒但是今天的 low ≤ 停損 ⇒ 仍 touched，facts 帶報價延遲', () => {
  const r = judge({ quote: live({ revealAt: T(10, 36), liveAt: T(10, 36) }), nowMs: T(10, 42, 40) });
  assert.equal(r.status, 'touched');
  assert.equal(r.staleSec, 400);
  assert.ok(r.facts.some(f => f.startsWith('報價延遲 7 分（最後揭示 10:36）')));
});

test('D33 處置股：low ≤ 停損即 touched（不要求量增加），facts 帶撮合揭露', () => {
  const r = judge({ disposition: true });
  assert.equal(r.status, 'touched');
  assert.ok(r.facts.some(f => f.startsWith('處置中')));
});

test('D34 isSetToday：今天 10:30 生效 true；08:46 生效 false；上週五版本日週一 false', () => {
  assert.equal(isSetToday({ tradeDate: TODAY, startedAt: T(10, 30) }, TODAY, OPEN), true);
  assert.equal(isSetToday({ tradeDate: TODAY, startedAt: T(8, 46) }, TODAY, OPEN), false);
  assert.equal(isSetToday({ tradeDate: '2026-10-02', startedAt: T(20, 0, 0, 4) }, TODAY, OPEN), false);
});

test('D35 setToday：只認 liveAt > startedAt 的真成交價；處置、13:24–13:35、沒有 realTrade 旗標 ⇒ 不判', () => {
  const base = { setToday: true, startedAt: T(10, 30) };
  const above = judge({ ...base, quote: live({ realTrade: true, price: 93, low: 91.5 }) });
  assert.notEqual(above.status, 'touched');   // low 可能發生在生效前
  const hit = judge({ ...base, quote: live({ realTrade: true, price: 91.5 }) });
  assert.equal(hit.status, 'touched'); assert.equal(hit.basis, 'trade');
  assert.ok(hit.facts.includes('依成交價判定（今日新設停損）'));
  assert.equal(judge({ ...base, quote: live({ realTrade: true, price: 91.5, liveAt: T(10, 20) }) }).notJudged, 'noTodayTrade');
  assert.equal(judge({ ...base, disposition: true, quote: live({ realTrade: true, price: 91.5 }) }).notJudged, 'noTodayTrade');
  assert.equal(judge({ ...base, nowMs: T(13, 31), quote: live({ realTrade: true, price: 91.5, liveAt: T(13, 30, 30) }) }).notJudged, 'noTodayTrade');
  assert.equal(judge({ ...base, quote: live({ price: 91.5 }) }).notJudged, 'noTodayTrade');   // 前端報價沒有 realTrade
});

test('D37 stopDistance：(現價−停損)÷現價；ATR 倍數；逼近用 ATR，沒有 ATR 時 ≤2%', () => {
  const d = stopDistance(92, 93.5, null);
  assert.equal(+d.pct.toFixed(4), +(1.5 / 93.5 * 100).toFixed(4));
  assert.equal(d.near, true);
  assert.equal(stopDistance(92, 94, null).near, false);    // 2.13%
  assert.equal(stopDistance(92, 94, 2.5).near, true);      // 0.8 ATR
  assert.equal(stopDistance(92, 94, 2.5).atrMultiple, 0.8);
  assert.equal(stopDistance(92, 92, null).near, false);    // 已在停損價：不算逼近（另由觸及判定）
  assert.equal(stopDistance(92, 0, null), null);
  assert.equal(judge({ quote: live({ low: 92.5, price: 93.5 }) }).status, 'near');
  assert.equal(judge({ quote: live({ low: 95, price: 97 }) }).status, 'ok');
});

// ── E. 事件 ──────────────────────────────────────────────────────────────────

const touchOf = (over = {}) => ({ ...judge(), ...over });
const notTouched = () => judge({ quote: live({ low: 95, price: 97 }) });
const adv = (prev, over = {}) => advanceEpisode(prev, { touch: touchOf(), stopVersion: 1, versionReason: null, todayYmd: TODAY, nowMs: T(10, 42), nextId: 7, ...over });

test('E38 第一次觸及 ⇒ 新事件、發一級；同日第二輪、隔天仍在停損下 ⇒ 不是新事件', () => {
  const a = adv(null);
  assert.equal(a.isNew, true); assert.equal(a.sendLevel1, true);
  assert.equal(a.episode.id, 7); assert.equal(a.episode.firstDate, TODAY); assert.equal(a.episode.level1Sent, true);
  const b = adv(a.episode, { nowMs: T(11, 0) });
  assert.equal(b.isNew, false); assert.equal(b.sendLevel1, false);
  const c = adv(a.episode, { todayYmd: '2026-10-06', nowMs: T(9, 5, 0, 6) });
  assert.equal(c.isNew, false); assert.equal(c.episode.lastDate, '2026-10-06');
  assert.deepEqual(adv(null, { touch: notTouched() }), { episode: null, isNew: false, sendLevel1: false });
});

test('E39 官方收盤 > 停損×1.02 ⇒ 事件結束、之後再觸及是新事件；收盤介於停損與 ×1.02 ⇒ 延續', () => {
  const ep = adv(null).episode;
  assert.deepEqual(settleEpisode(ep, { officialClose: 93.85, stop: 92, dateYmd: TODAY }), { episode: null, ended: true });
  const keep = settleEpisode(ep, { officialClose: 93.8, stop: 92, dateYmd: TODAY });
  assert.equal(keep.ended, false); assert.equal(keep.episode.closesBelow, 0);
  const below = settleEpisode(ep, { officialClose: 91, stop: 92, dateYmd: TODAY });
  assert.equal(below.episode.closesBelow, 1);
  assert.equal(settleEpisode(ep, { officialClose: 99, stop: 92, dateYmd: '2026-10-02' }).ended, false);   // 早於事件起始日不計
  const again = adv(null, { nextId: 8 });
  assert.equal(again.episode.id, 8); assert.equal(again.sendLevel1, true);
});

test('E40 停損因 ratchet 換版後又觸及 ⇒ 新事件；因 exAdjust 換版 ⇒ 沿用原事件', () => {
  const ep = adv(null).episode;
  const r = adv(ep, { stopVersion: 2, versionReason: 'ratchet', nextId: 9 });
  assert.equal(r.isNew, true); assert.equal(r.episode.id, 9); assert.equal(r.sendLevel1, true);
  const x = adv(ep, { stopVersion: 2, versionReason: 'exAdjust', nextId: 9 });
  assert.equal(x.isNew, false); assert.equal(x.episode.id, 7); assert.equal(x.episode.stopVersion, 2); assert.equal(x.sendLevel1, false);
});

test('E41 hold exUnconfirmed：開事件不發一級；確認後同一事件補發一次；exUnknown 永不發', () => {
  const u = adv(null, { touch: touchOf({ hold: 'exUnconfirmed' }) });
  assert.equal(u.isNew, true); assert.equal(u.sendLevel1, false); assert.equal(u.episode.level1Sent, false);
  const rel = adv(u.episode, { touch: touchOf({ hold: null }) });
  assert.equal(rel.sendLevel1, true); assert.equal(rel.episode.level1Sent, true); assert.equal(rel.episode.hold, null);
  assert.equal(adv(rel.episode, { touch: touchOf({ hold: null }) }).sendLevel1, false);
  const k = adv(null, { touch: touchOf({ hold: 'exUnknown' }) });
  assert.equal(k.sendLevel1, false);
  assert.equal(adv(k.episode, { touch: touchOf({ hold: null }) }).sendLevel1, false);
});

test('E44 seeded（第一次判定時已在停損下）：開事件但不發一級，之後同事件也不發', () => {
  const s = adv(null, { seeded: true, touch: notTouched() });
  assert.equal(s.isNew, true); assert.equal(s.sendLevel1, false);
  assert.equal(s.episode.seeded, true); assert.equal(s.episode.triggerPx, null);
  const t = adv(s.episode);
  assert.equal(t.isNew, false); assert.equal(t.sendLevel1, false);
  const s2 = adv(null, { seeded: true });
  assert.equal(s2.sendLevel1, false); assert.equal(s2.episode.triggerPx, 91.5);
});

// ── I. 文案 ──────────────────────────────────────────────────────────────────

const FORBIDDEN = ['建議', '請', '應', '必須', '立即', '即刻', '認賠', '勿', '不要', '續抱', '賣出', '出場', '出清', '鎖利',
  '面對決策', '檢視風險', '優先決策', '確認停損', '執行停損', '掛好停損單'];

test('I53 每種事實句都非空、不含禁用詞；紀律彙總字樣固定', () => {
  // 價格取 10–50 元（檔位 0.05、顯示 2 位）；50 元以上依檔位顯示 1 位（與站上 fmtPrice 同）
  const data = {
    stop: 47.35, low: 46.9, price: 47.8, open: 45.4, skipPct: 4.1, at: T(10, 42), basisText: '成本線·還原成本 51.47 −8%',
    distPct: 0.9, atrMultiple: 0.4, items: [{ code: '2330', n: 3, close: 46.1, stop: 47.35 }], date: '2026-07-15',
    factor: 0.962, from: 49.2, to: 47.35, label: '除息', coverFrom: '2022-07-01', ratio: 0.03, line: 105, hwm: 114.1, gainPct: 6.2,
    minutes: 6, codes: ['2330 台積電'], hasBook: false,
  };
  for (const kind of STOP_FACT_KINDS) {
    const s = stopFactText(kind, data);
    assert.ok(s.length > 0, kind);
    for (const w of FORBIDDEN) assert.ok(!s.includes(w), `${kind} 含禁用詞「${w}」：${s}`);
  }
  assert.equal(stopFactText('digest', data), '2330 事件第 3 個交易日（前一交易日收盤 46.10／停損 47.35）');
  assert.equal(stopFactText('touch', data), '今日最低 46.90 觸及停損 47.35（10:42 揭示）·現價 47.80');
  assert.equal(stopFactText('gap', data), '開盤 45.40，已低於停損 47.35（差 4.1%）');
  assert.equal(stopFactText('row', data), '停損 47.35（成本線·還原成本 51.47 −8%）｜距 0.9%（0.4 ATR）');
  assert.equal(stopFactText('provisional', data), '停損 47.35（暫算·未含除權息調整）');
  assert.equal(stopFactText('touch', { ...data, stop: 92, low: 91.5, price: 1050 }), '今日最低 91.5 觸及停損 92.0（10:42 揭示）·現價 1,050');
  assert.equal(stopFactText('nope', data), '');
  assert.equal(STOP_PARAMS.capPct, 8);
});
