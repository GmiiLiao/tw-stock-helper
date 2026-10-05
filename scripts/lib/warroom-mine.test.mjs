// 盤中戰情 v2·A1 我的部位與持股停損（規範 v1）純函式 單元測試：node --test scripts/lib/warroom-mine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePositions } from './ai-stoploss.mjs';
import {
  grossPnl, lastCloseOf, dayPnlOf, sumDayPnl, mergeTradedBefore, taipeiAt,
  judgeQuoteOf, provisionalStop, warStopView, stopJudgeText,
  parseStopEpisodes, serializeStopEpisodes, stepStopEpisodes, stopLevel1Events, stopSeededEvent, stopEventId, stopSuspectEvents,
} from './warroom-mine.mjs';

const T = (h, m, s = 0, day = 5) => Date.UTC(2026, 9, day, h - 8, m, s);
const TODAY = '2026-10-05';
const PREV = '2026-10-02';

// ── 部位損益（自 warroom-stop.test.mjs 移來） ────────────────────────────────

test('毛額損益：(現價−均價)÷均價、金額＝差價×張×1000', () => {
  const g = grossPnl(220, 3, 231);
  assert.equal(g.amount, 33000);
  assert.equal(+g.pct.toFixed(4), 5);
  assert.equal(grossPnl(220, 0, 231), null);
});

test('昨收：今日有真成交用 prevClose；否則報價本身就是最後收盤', () => {
  assert.equal(lastCloseOf({ source: 'mis_realtime', price: 381, prevClose: 378.5 }), 378.5);
  assert.equal(lastCloseOf({ source: 'stock_day_all', price: 378.5, prevClose: 370 }), 378.5);
  assert.equal(lastCloseOf(null), null);
});

test('今日損益：今天買的用買價當基準，其餘用昨收；金額要 ×1000（張→股）', () => {
  const lots = [
    { qty: 1, buyPrice: 200, buyDate: '2026-09-01' },
    { qty: 2, buyPrice: 230, buyDate: TODAY },
  ];
  const r = dayPnlOf(lots, { price: 232, prevClose: 228 }, TODAY);
  assert.equal(r.amount, 8000);   // 1 張 (232−228)×1000 ＋ 2 張今天買 (232−230)×2000
  assert.equal(r.base, 228 * 1000 + 230 * 2000);
  assert.equal(dayPnlOf(lots, { price: 0, prevClose: 228 }, TODAY), null);
  const s = sumDayPnl([r, null, { amount: -2000, base: 100000 }]);
  assert.equal(s.counted, 2);
  assert.equal(s.amount, 6000);
  assert.equal(sumDayPnl([]), null);
});

test('收盤競價前最後一筆真成交：只收 mis_realtime 且揭示早於 13:25；無變化回原物件', () => {
  const cutoff = taipeiAt(TODAY, 13, 25);
  assert.equal(new Date(cutoff).toISOString(), '2026-10-05T05:25:00.000Z');
  const q1 = {
    2317: { price: 371.5, revealAt: cutoff - 30_000, source: 'mis_realtime' },
    2330: { price: 2585, revealAt: cutoff + 5_000, source: 'mis_realtime' },
    6488: { price: 512, revealAt: null, source: 'stock_day_all' },
  };
  const a = mergeTradedBefore({}, q1, cutoff);
  assert.deepEqual(a, { 2317: { price: 371.5, revealAt: cutoff - 30_000 } });
  assert.equal(mergeTradedBefore(a, q1, cutoff), a);
  assert.equal(mergeTradedBefore(a, { 2317: { price: 372, revealAt: cutoff - 10_000, source: 'mis_realtime' } }, cutoff)[2317].price, 372);
  assert.equal(mergeTradedBefore(a, { 2317: { price: 360, revealAt: cutoff - 60_000, source: 'mis_realtime' } }, cutoff), a);
  assert.ok(Number.isNaN(taipeiAt('bad', 13, 25)));
});

// ── 停損（規範 v1·前端暫算） ───────────────────────────────────────────────

const quote = (over = {}) => ({
  price: 93, open: 95, high: 96, low: 91.5, volume: 1_200_000, prevClose: 95, revealAt: T(10, 42), fetchedAt: T(10, 42, 20),
  source: 'mis_realtime', ...over,
});
const P = (holdings) => aggregatePositions(holdings)[0];
const view = (over = {}) => warStopView({
  position: P([{ id: 'a', code: '2317', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }]),
  quote: quote(), calcPrice: 93, nowMs: T(10, 43), todayYmd: TODAY, tradingDay: true, ...over,
});

test('judgeQuoteOf：只有今日即時報價帶 liveAt（抓取時刻優先），收盤／種子價不帶', () => {
  assert.equal(judgeQuoteOf(quote()).liveAt, T(10, 42, 20));
  assert.equal(judgeQuoteOf(quote({ fetchedAt: null })).liveAt, T(10, 42));
  const seed = judgeQuoteOf(quote({ source: 'stock_day_all', revealAt: null, fetchedAt: null }));
  assert.equal(seed.live, false); assert.equal(seed.liveAt, null);
  assert.equal(judgeQuoteOf(null), null);
});

test('暫算停損＝成本線（買進均價 −8% 向上取檔），依據標「未含除權息調整」；A1、Z2、抽屜共用', () => {
  const r = provisionalStop(P([{ id: 'a', code: '2317', buyPrice: 56.9, quantity: 1 }]), 55);
  assert.equal(r.stop, 52.4);
  assert.equal(r.basisText, '成本線·買進均價 56.90 −8%·未含除權息調整');
  assert.equal(provisionalStop(P([{ id: 'a', code: '00878', buyPrice: 56.9, quantity: 1 }]), 55).stop, 52.35);
});

test('A1：今日 low 觸及 ⇒ hit、原因句寫今日最低與停損（事實句）', () => {
  const v = view();
  assert.equal(v.stop, 92);
  assert.equal(v.level, 'hit');
  assert.equal(v.touch.kind, 'touch');
  assert.equal(v.reason, '今日最低 91.5 觸及停損 92.0·現價 93.0');
  assert.equal(v.distPct, 1.1);
  assert.match(v.title, /^停損 92\.0（規範 stop-v1·成本線·買進均價 100\.00 −8%·未含除權息調整·前端暫算/);
});

test('A1：開盤即跳過停損 ⇒ 跳空事實句照實記開盤價與跳過幅度', () => {
  const v = view({ quote: quote({ open: 88, low: 87.5, price: 89 }), calcPrice: 89 });
  assert.equal(v.touch.kind, 'gap');
  assert.equal(v.reason, '開盤 88.0，已低於停損 92.0（差 4.3%）');
});

test('A1：逼近（≤2%，無 ATR）⇒ near；遠 ⇒ ok；沒有現價 ⇒ level null', () => {
  const n = view({ quote: quote({ low: 92.5, price: 93.5 }), calcPrice: 93.5 });
  assert.equal(n.level, 'near');
  assert.equal(n.reason, '逼近停損·距 1.6%');
  const ok = view({ quote: quote({ low: 99, price: 100 }), calcPrice: 100 });
  assert.equal(ok.level, 'ok'); assert.equal(ok.reason, null);
  assert.equal(view({ quote: null, calcPrice: null }).level, null);
});

test('A1：試撮與收盤競價窗不判定；價格在停損下只描述事實並註明不判定', () => {
  const pre = view({ nowMs: T(8, 45), quote: quote({ source: 'stock_day_all', fetchedAt: null, revealAt: null, price: 91 }), calcPrice: 91, priceLabel: '昨收' });
  assert.equal(pre.touch.notJudged, 'segment');
  assert.equal(pre.level, 'hit');
  assert.equal(pre.reason, '昨收 91.0 在停損 92.0 下（開盤前·不判定）');
  const auc = view({ nowMs: T(13, 26), quote: quote({ low: 92.5, price: 91.5 }), calcPrice: 92.5 });
  assert.equal(auc.touch.notJudged, 'segment');
  assert.equal(auc.level, 'near');
});

test('A1：今天買進的部位＝今日新設停損，前端沒有真成交旗標 ⇒ 今日不判定觸及（只描述價格在停損下）', () => {
  const v = view({ position: P([{ id: 'a', code: '2317', buyPrice: 100, quantity: 1, buyDate: TODAY }]), calcPrice: 91.5, quote: quote({ price: 91.5 }) });
  assert.equal(v.setToday, true);
  assert.equal(v.touch.notJudged, 'noTodayTrade');
  assert.equal(v.reason, '現價 91.5 在停損 92.0 下（今日新設停損：前端沒有真成交旗標，今日不判定觸及）');
});

test('快看抽屜今日判定列：觸及／未觸及／不判定原因', () => {
  assert.equal(stopJudgeText(view()), '今日已觸及停損（只認今日成交更新的最低價）');
  assert.equal(stopJudgeText(view({ quote: quote({ low: 99, price: 100 }), calcPrice: 100 })), '今日未觸及停損');
  assert.equal(stopJudgeText(view({ nowMs: T(13, 27) })), '收盤競價中·不判定');
  assert.equal(stopJudgeText(view({ nowMs: T(14, 0) })), '盤後不即時判定');
  assert.equal(stopJudgeText(null), '');
});

test('A1：成本可疑（現價÷成本 <0.25）⇒ 停損照算但不上色，原因句標警示暫停', () => {
  const v = view({ position: P([{ id: 'a', code: '2317', buyPrice: 3000, quantity: 1 }]), calcPrice: 93 });
  assert.equal(v.level, 'ok');
  assert.match(v.reason, /^成本資料可疑（現價為成本的 0\.03 倍）·本檔停損警示暫停$/);
});

// ── Z2 本機事件表 ────────────────────────────────────────────────────────────

const touched = (over = {}) => view(over).touch;
const notTouched = () => view({ quote: quote({ low: 99, price: 100 }), calcPrice: 100 }).touch;
const row = (over = {}) => ({ code: '2317', stop: 92, touch: touched(), at: T(10, 42), prevClose: 95, prevYmd: PREV, ...over });
const EMPTY = parseStopEpisodes(null);
const names = new Map([['2317', '鴻海'], ['2330', '台積電']]);

test('第一次觸及 ⇒ 一級一次；同日下一輪、重新整理後（讀回本機表）不重發', () => {
  const a = stepStopEpisodes(EMPTY, [row()], { todayYmd: TODAY, nowMs: T(10, 43) });
  assert.deepEqual(a.sendLevel1, ['2317']);
  assert.equal(a.changed, true);
  const ev = stopLevel1Events(a.state, names, TODAY);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].id, stopEventId('2317', 1, 1));
  assert.equal(ev[0].level, 1);
  assert.equal(ev[0].text, '2317 鴻海 觸停損（今日最低觸及）·規範 v1 成本線·前端暫算（未含除權息調整）');
  assert.equal(/92|91/.test(ev[0].text), false);   // 不寫個人停損價
  const b = stepStopEpisodes(a.state, [row()], { todayYmd: TODAY, nowMs: T(10, 50) });
  assert.deepEqual(b.sendLevel1, []); assert.equal(b.changed, false);
  const reloaded = parseStopEpisodes(JSON.parse(JSON.stringify(serializeStopEpisodes(a.state))));
  assert.deepEqual(reloaded, a.state);
  assert.deepEqual(stepStopEpisodes(reloaded, [row()], { todayYmd: TODAY, nowMs: T(11, 0) }).sendLevel1, []);
});

test('跨日：前一交易日收盤 ≤ 停損×1.02 ⇒ 事件延續不重發；> ×1.02 ⇒ 結束，再觸及是新事件', () => {
  const a = stepStopEpisodes(EMPTY, [row({ prevYmd: '2026-10-01' })], { todayYmd: '2026-10-02', nowMs: T(10, 43, 0, 2) }).state;
  assert.equal(a.byCode['2317'].settledYmd, '2026-10-01');
  const keep = stepStopEpisodes(a, [row({ prevClose: 93.8, prevYmd: '2026-10-02' })], { todayYmd: TODAY, nowMs: T(9, 5) });
  assert.deepEqual(keep.sendLevel1, []);
  const ended = stepStopEpisodes(a, [row({ prevClose: 93.85, prevYmd: '2026-10-02' })], { todayYmd: TODAY, nowMs: T(9, 5) });
  assert.deepEqual(ended.sendLevel1, ['2317']);
  assert.equal(ended.state.byCode['2317'].ep.id, 2);
  assert.equal(ended.state.byCode['2317'].ep.firstDate, TODAY);
});

/** warStopView 的結果 → 本機事件表一列（與 TopAlertEngine.stopRowsOf 同欄位） */
const rowFrom = (pos, v, over = {}) => ({
  code: pos.code, stop: v.stop, touch: v.touch, at: T(10, 42), prevClose: 103, prevYmd: PREV, lots: pos.lots,
  reason: v.res.versionReason, suspect: v.res.suspect, ...over,
});

test('盤中 FIFO 賣出上調停損 ⇒ 以本裝置偵測時刻推定今日新設，當日不拿累計最低價發一級；隔日起照常判定', () => {
  const A = { id: 'A', code: '2317', buyPrice: 80, quantity: 1, buyDate: '2026-06-01' };
  const B = { id: 'B', code: '2317', buyPrice: 110, quantity: 1, buyDate: '2026-09-01' };
  const q0 = quote({ open: 105, high: 106, low: 100, price: 104 });
  const both = P([A, B]);
  const v0 = view({ position: both, quote: q0, calcPrice: 104, nowMs: T(10, 0) });
  assert.equal(v0.stop, 87.4);
  assert.equal(v0.touch.status, 'ok');
  const s0 = stepStopEpisodes(EMPTY, [rowFrom(both, v0)], { todayYmd: TODAY, nowMs: T(10, 0) }).state;
  // 11:00 依 FIFO 賣掉 A ⇒ 停損上調到 101.5；今日最低 100 可能發生在換版之前
  const onlyB = P([B]);
  const v1 = view({ position: onlyB, quote: q0, calcPrice: 104, nowMs: T(11, 0), entry: s0.byCode['2317'] });
  assert.equal(v1.stop, 101.5);
  assert.equal(v1.res.versionReason, 'ratchet');
  assert.equal(v1.setToday, true);
  assert.equal(v1.touch.notJudged, 'noTodayTrade');
  assert.equal(v1.level, 'ok');   // 現價 104 在停損上方；今日最低 100 不拿來判（可能早於換版）
  const s1 = stepStopEpisodes(s0, [rowFrom(onlyB, v1)], { todayYmd: TODAY, nowMs: T(11, 0) });
  assert.deepEqual(s1.sendLevel1, []);
  assert.equal(s1.state.byCode['2317'].ver, 2);
  assert.equal(s1.state.byCode['2317'].startedAt, T(11, 0));
  assert.equal(s1.state.byCode['2317'].tradeDate, TODAY);
  // 重新整理後讀回本機表：同一個停損、仍是今日新設
  const reloaded = parseStopEpisodes(JSON.parse(JSON.stringify(serializeStopEpisodes(s1.state))));
  const v1b = view({ position: onlyB, quote: q0, calcPrice: 104, nowMs: T(11, 30), entry: reloaded.byCode['2317'] });
  assert.equal(v1b.stop, 101.5);
  assert.equal(v1b.setToday, true);
  assert.deepEqual(stepStopEpisodes(reloaded, [rowFrom(onlyB, v1b)], { todayYmd: TODAY, nowMs: T(11, 30) }).sendLevel1, []);
  // 隔日：開盤前已生效的版本用今日最低價判定
  const v2 = view({
    position: onlyB, quote: quote({ open: 103, high: 104, low: 100, price: 102, revealAt: T(9, 30, 0, 6), fetchedAt: T(9, 30, 10, 6) }),
    calcPrice: 102, nowMs: T(9, 31, 0, 6), todayYmd: '2026-10-06', entry: s1.state.byCode['2317'],
  });
  assert.equal(v2.setToday, false);
  assert.equal(v2.touch.status, 'touched');
});

test('成本更正（同一筆被編輯）⇒ 棘輪歸零、停損可下移並換版；盤中更正當日不判定', () => {
  const wrong = P([{ id: 'a', code: '2317', buyPrice: 150, quantity: 1, buyDate: '2026-09-01' }]);
  const pre = view({ position: wrong, nowMs: T(8, 50) });
  assert.equal(pre.stop, 138);
  const s0 = stepStopEpisodes(EMPTY, [rowFrom(wrong, pre, { prevClose: null, prevYmd: null })], { todayYmd: TODAY, nowMs: T(8, 50) }).state;
  const fixed = P([{ id: 'a', code: '2317', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }]);
  const v = view({ position: fixed, nowMs: T(10, 0), entry: s0.byCode['2317'] });
  assert.equal(v.stop, 92);
  assert.equal(v.res.versionReason, 'costCorrection');
  assert.equal(v.setToday, true);
  const s1 = stepStopEpisodes(s0, [rowFrom(fixed, v)], { todayYmd: TODAY, nowMs: T(10, 0) });
  assert.deepEqual(s1.sendLevel1, []);
  assert.equal(s1.state.byCode['2317'].ver, 2);
  assert.equal(s1.state.byCode['2317'].stop, 92);
});

test('攤平或 FIFO 賣出使均價下降 ⇒ 停損不下移、不換版，進行中的觸及事件不重發（隔日延續）', () => {
  const one = P([{ id: 'a', code: '2330', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }]);
  const v0 = view({ position: one });
  const s0 = stepStopEpisodes(EMPTY, [rowFrom(one, v0, { prevClose: 95 })], { todayYmd: TODAY, nowMs: T(10, 43) });
  assert.deepEqual(s0.sendLevel1, ['2330']);
  // 同日攤平 86 一張：成本線 85.6，但停損維持 92
  const two = P([
    { id: 'a', code: '2330', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' },
    { id: 'b', code: '2330', buyPrice: 86, quantity: 1, buyDate: TODAY },
  ]);
  const v1 = view({ position: two, quote: quote({ low: 85.5, price: 86 }), calcPrice: 86, nowMs: T(11, 0), entry: s0.state.byCode['2330'] });
  assert.equal(v1.stop, 92);
  assert.equal(v1.res.versionReason, null);
  const s1 = stepStopEpisodes(s0.state, [rowFrom(two, v1, { prevClose: 95 })], { todayYmd: TODAY, nowMs: T(11, 0) });
  assert.deepEqual(s1.sendLevel1, []);
  assert.equal(s1.state.byCode['2330'].ver, 1);
  // 隔日：前收 87 ≤ 92×1.02 ⇒ 事件延續；今日再觸及也不重發
  const v2 = view({
    position: two, quote: quote({ low: 85, price: 86, revealAt: T(9, 30, 0, 6), fetchedAt: T(9, 30, 10, 6) }), calcPrice: 86,
    nowMs: T(9, 31, 0, 6), todayYmd: '2026-10-06', entry: s1.state.byCode['2330'],
  });
  assert.equal(v2.stop, 92);
  assert.equal(v2.touch.status, 'touched');
  const s2 = stepStopEpisodes(s1.state, [rowFrom(two, v2, { prevClose: 87, prevYmd: TODAY })], { todayYmd: '2026-10-06', nowMs: T(9, 31, 0, 6) });
  assert.deepEqual(s2.sendLevel1, []);
  assert.equal(s2.state.byCode['2330'].ep.id, s0.state.byCode['2330'].ep.id);
  // FIFO 賣掉高價那筆使均價下降：停損一樣不下移
  const hi = P([{ id: 'h', code: '2330', buyPrice: 120, quantity: 1, buyDate: '2026-06-01' }, { id: 'l', code: '2330', buyPrice: 80, quantity: 1, buyDate: '2026-09-01' }]);
  const vh = view({ position: hi, quote: quote({ low: 99, price: 100 }), calcPrice: 100 });
  const sh = stepStopEpisodes(EMPTY, [rowFrom(hi, vh)], { todayYmd: TODAY, nowMs: T(10, 43) }).state;
  const lo = P([{ id: 'l', code: '2330', buyPrice: 80, quantity: 1, buyDate: '2026-09-01' }]);
  assert.equal(view({ position: lo, quote: quote({ low: 99, price: 100 }), calcPrice: 100, entry: sh.byCode['2330'] }).stop, vh.stop);
});

test('本機有記錄、前一交易日收盤 ≤ 停損卻沒有事件（本裝置漏判）⇒ late 事件發一級；切換當天、收盤後才換版的不補判', () => {
  const a = stepStopEpisodes(EMPTY, [row({ touch: notTouched(), prevClose: 95, prevYmd: '2026-10-01' })], { todayYmd: '2026-10-02', nowMs: T(10, 0, 0, 2) }).state;
  assert.equal(a.byCode['2317'].ep, null);
  const b = stepStopEpisodes(a, [row({ touch: notTouched(), prevClose: 91, prevYmd: PREV })], { todayYmd: TODAY, nowMs: T(9, 5) });
  assert.deepEqual(b.sendLevel1, ['2317']);
  assert.deepEqual(b.late, ['2317']);
  assert.equal(b.state.byCode['2317'].ep.kind, 'late');
  assert.equal(stopLevel1Events(b.state, names, TODAY)[0].text, '2317 鴻海 觸停損（前一交易日收盤後補判·本裝置）·規範 v1 成本線·前端暫算（未含除權息調整）');
  assert.deepEqual(stepStopEpisodes(b.state, [row({ touch: notTouched(), prevClose: 91, prevYmd: PREV })], { todayYmd: TODAY, nowMs: T(9, 10) }).sendLevel1, []);
  // 這一版是前一交易日收盤後才換的（例：晚上改了持股）⇒ 前一交易日收盤不能拿來比
  const after = { ...a, byCode: { 2317: { ...a.byCode['2317'], startedAt: Date.parse('2026-10-02T20:00:00+08:00'), tradeDate: '2026-10-02' } } };
  assert.deepEqual(stepStopEpisodes(after, [row({ touch: notTouched(), prevClose: 91, prevYmd: PREV })], { todayYmd: TODAY, nowMs: T(9, 5) }).sendLevel1, []);
  // 表在開盤前建立、這一檔第一次拿到前一交易日收盤 ⇒ 仍算切換當天：seeded、不發一級
  const pre = stepStopEpisodes(EMPTY, [row({ touch: notTouched(), prevClose: null, prevYmd: null })], { todayYmd: TODAY, nowMs: T(8, 40) }).state;
  const live = stepStopEpisodes(pre, [row({ touch: notTouched(), prevClose: 91, prevYmd: PREV })], { todayYmd: TODAY, nowMs: T(9, 1) });
  assert.deepEqual(live.sendLevel1, []);
  assert.deepEqual(live.seeded, ['2317']);
});

test('英文字尾 ETF：最低價檢查暫用 ETF 檔位（不會因個股檔位表而永遠不判定），提示標檔位待核實與未經回測', () => {
  const pos = P([{ id: 'e', code: '00631L', buyPrice: 250, quantity: 1, buyDate: '2026-09-01' }]);
  const v = view({ position: pos, quote: quote({ open: 231, high: 232, low: 227.85, price: 228.4 }), calcPrice: 228.4 });
  assert.equal(v.stop, 230);
  assert.equal(v.touch.status, 'touched');
  assert.equal(v.level, 'hit');
  assert.match(v.title, /英文字尾 ETF：檔位待核實.*此類未經本站回測/);
  assert.match(view({ position: P([{ id: 'e', code: '00878', buyPrice: 20, quantity: 1, buyDate: '2026-09-01' }]), quote: quote({ low: 19.9, price: 19.95 }), calcPrice: 19.95 }).title, /ETF：此類未經本站回測/);
});

test('成本資料可疑：每檔每日一則二級（id 含日期），文字不寫成本、比值與停損價', () => {
  const evs = stopSuspectEvents(['2317', '2317', '9999'], names, TODAY, T(10, 0));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].id, `stopSuspect:${TODAY}:2317`);
  assert.equal(evs[0].level, 2);
  assert.equal(evs[0].kind, 'mine');
  assert.equal(evs[0].text, '2317 鴻海 成本資料可疑（現價與買進均價相差過大）·本檔停損警示暫停·規範 v1');
  assert.equal(/\d+\.\d|倍/.test(evs[0].text), false);
});

test('seeded：前一交易日收盤已 ≤ 停損、本機沒有事件 ⇒ 不發一級，改一則二級彙總', () => {
  const a = stepStopEpisodes(EMPTY, [row({ prevClose: 91 }), row({ code: '2330', stop: 500, touch: notTouched(), prevClose: 480 })], { todayYmd: TODAY, nowMs: T(9, 1) });
  assert.deepEqual(a.sendLevel1, []);
  assert.deepEqual(a.seeded.sort(), ['2317', '2330']);
  const s = stopSeededEvent(a.state, names, TODAY);
  assert.equal(s.level, 2);
  assert.equal(s.kind, 'mine');
  assert.equal(s.text, '已在停損下（前一交易日收盤低於停損）：2317 鴻海、2330 台積電·本次不逐檔發一級·規範 v1');
  assert.deepEqual(stepStopEpisodes(a.state, [row({ prevClose: 91 })], { todayYmd: TODAY, nowMs: T(10, 0) }).sendLevel1, []);
});

test('沒有觸及、沒有前一交易日資料 ⇒ 不開事件；持股未載入（空清單）⇒ 保留舊表不清掉', () => {
  const a = stepStopEpisodes(EMPTY, [row({ touch: notTouched(), prevClose: null, prevYmd: null })], { todayYmd: TODAY, nowMs: T(10, 0) });
  assert.equal(a.state.byCode['2317'].ep, null);
  const b = stepStopEpisodes(a.state, [], { todayYmd: TODAY, nowMs: T(10, 1) });
  assert.equal(b.state, a.state); assert.equal(b.changed, false);
});

test('本機事件表讀回：形狀不對一律丟；nextId 不得小於既有事件序號', () => {
  assert.deepEqual(parseStopEpisodes({ v: 2 }), { nextId: 1, byCode: {} });
  const p = parseStopEpisodes({
    v: 1, nextId: 1,
    byCode: {
      2317: { stop: 92, ver: 1, settledYmd: 'x', ep: { id: 5, stopVersion: 1, kind: 'touch', triggerAt: T(10, 0), firstDate: TODAY, lastDate: TODAY, level1Sent: true } },
      bad: { stop: 1, ver: 1 },
      2330: { stop: -1, ver: 1 },
      2603: { stop: 50, ver: 1, ep: { id: 'x' } },
    },
  });
  assert.deepEqual(Object.keys(p.byCode).sort(), ['2317', '2603']);
  assert.equal(p.byCode['2317'].settledYmd, '');
  assert.equal(p.byCode['2603'].ep, null);
  assert.equal(p.nextId, 6);
});
