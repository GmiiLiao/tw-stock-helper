// 盤中戰情 v2 指揮列／大盤脈動／一級警示帶 純函式 單元測試：node --test scripts/lib/warroom-top.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePulse, normalizePattern, normalizeHeartbeat, normalizeHotLag, normalizeTaifex,
  dangerMet, stepDanger, initialDangerState, parseDangerState,
  nearStopList,
  isIndicativeMinute, eventFromDaemonAlert, sortLevel1, severityRank,
} from './warroom-top.mjs';

const T = (h, m, s = 0, day = 5) => Date.UTC(2026, 9, day, h - 8, m, s);

test('marketPulse：照 daemon 欄位轉出，平盤＝有效−漲−跌；缺欄位回 null 不補 0', () => {
  const p = normalizePulse({
    updatedAt: T(10, 42), marketNow: true, countsBasis: 'live',
    counts: { limitUp: 31, limitDown: 4, up: 1012, down: 598, counted: 1797, live: 1700 },
    level: { key: 'good', label: '偏多', luExp: 44, ldExp: 3, luActualVsExp: 0.7 },
    twii: { chg: 0.6, volLots: 6_543_210, prevDayVolLots: 14_331_403, volVsPrevFullDay: 0.46 }, otc: { chg: 0.94 },
  });
  assert.equal(p.asOf, T(10, 42));
  assert.deepEqual(p.counts, { limitUp: 31, limitDown: 4, up: 1012, down: 598, flat: 187, counted: 1797, live: 1700 });
  assert.equal(p.level.luExp, 44);
  assert.equal(p.volLots, 6_543_210);
  assert.equal(p.prevDayVolLots, 14_331_403);
  assert.equal(p.volVsPrevFullDay, 0.46);
  assert.equal(p.basis, 'live');
  // 期望比值（luActualVsExp）不帶出（critique H1：盤中比全日系統性偏低）
  assert.equal('luActualVsExp' in p.level, false);

  const bare = normalizePulse({ updatedAt: T(10, 0) });
  assert.equal(bare.counts, null);
  assert.equal(bare.level, null);
  assert.equal(bare.volLots, null);
  assert.equal(normalizePulse(null), null);
});

test('marketPulse 單位修正（開盤感應器 v2.1 §10）：舊文件 value＝t00 m÷1000＝千張 ⇒ 換成張；成交金額估值與量÷值的比值不讀', () => {
  // 10/05 收盤：m＝14,331,403 張 ⇒ 舊 value 14,331.4（被誤標成「億」）
  const legacy = normalizePulse({ updatedAt: T(13, 31), twii: { chg: 1.2, value: 14331.4, prevValue: 10645, valueVsPrevFullDay: 1.35 } });
  assert.equal(legacy.volLots, 14_331_400);
  assert.equal(legacy.prevDayVolLots, null);
  assert.equal(legacy.volVsPrevFullDay, null);
  for (const k of ['value', 'prevValue', 'valueVsPrevFullDay']) assert.equal(k in legacy, false);
});

test('盤型只認今天的 live；其餘回 null', () => {
  const doc = { live: { date: '2026-10-05', pattern: 'flatDown', at: T(11, 0) } };
  assert.deepEqual(normalizePattern(doc, '2026-10-05'), { key: 'flatDown', label: '開平殺盤', date: '2026-10-05', at: T(11, 0) });
  assert.equal(normalizePattern(doc, '2026-10-06'), null);
  assert.equal(normalizePattern({ env: {} }, '2026-10-05'), null);
});

test('心跳不外露主機名與模型；hotLag 與台指淨未平倉照欄位', () => {
  const hb = normalizeHeartbeat({ active: true, lastHeartbeat: T(10, 41, 38), host: 'mac', model: 'x' });
  assert.deepEqual(hb, { lastHeartbeat: T(10, 41, 38), active: true });
  assert.deepEqual(normalizeHotLag({ hotLag: { at: T(10, 0), p50: 24, p90: 57, freshPct: 12 } }), { at: T(10, 0), p50: 24, p90: 57, freshPct: 12 });
  assert.equal(normalizeHotLag({ at: 1 }), null);
  const tx = normalizeTaifex({ updatedAt: T(16, 30, 0, 2), date: '20261002', basisVersion: 'txf-foreign-oi-v2', foreignTxfNetOI: -80304, putCallRatio: 98.5 });
  assert.deepEqual(tx, { date: '20261002', foreignTxfNetOI: -80304, putCallRatio: 98.5, asOf: T(16, 30, 0, 2) });
  assert.equal(normalizeTaifex({ date: 'bad', foreignTxfNetOI: null }).date, null);
  // 2026-10-08：沒有 basisVersion 的舊文件，foreignTxfNetOI 其實是外資 23 種期貨「交易」口數淨額合計（錯值）⇒ 不當未平倉，回 null；P/C 照舊
  const old = normalizeTaifex({ updatedAt: T(16, 30, 0, 2), date: '20261002', foreignTxfNetOI: -3862, putCallRatio: 80.84 });
  assert.equal(old.foreignTxfNetOI, null);
  assert.equal(old.putCallRatio, 80.84);
  assert.equal(old.date, '20261002');
});

test('持股重大利空已移出 pulse（改由 board.news＋warroom-news 判定）：不再匯出 newsTopFromDoc', async () => {
  const top = await import('./warroom-top.mjs');
  assert.equal(top.newsTopFromDoc, undefined);
  assert.equal(top.MAJOR_NEGATIVE_STRENGTH, undefined);
  const news = await import('./warroom-news.mjs');
  assert.equal(typeof news.majorBearOf, 'function');
});

test('大盤危險單拍條件：跌停 ≥10 且 ≥ 漲停×1.5', () => {
  assert.equal(dangerMet({ limitUp: 9, limitDown: 41 }), true);
  assert.equal(dangerMet({ limitUp: 0, limitDown: 1 }), false);    // 09:01 的 1:0 不算（critique 可用性 #4）
  assert.equal(dangerMet({ limitUp: 10, limitDown: 14 }), false);   // 14 < 15
  assert.equal(dangerMet({ limitUp: 10, limitDown: 15 }), true);
  assert.equal(dangerMet(null), false);
});

test('大盤危險要連續 2 拍（不同 updatedAt）才發；同一份重送不推進；09:10 前不判', () => {
  const bad = { limitUp: 9, limitDown: 41 };
  let s = initialDangerState('2026-10-05');
  let r = stepDanger(s, { asOf: T(9, 5), counts: bad });
  assert.equal(r.fired, false); assert.equal(r.state.streak, 0);
  r = stepDanger(r.state, { asOf: T(11, 17, 30), counts: bad });
  assert.equal(r.fired, false); assert.equal(r.state.streak, 1);
  const same = stepDanger(r.state, { asOf: T(11, 17, 30), counts: bad });
  assert.equal(same.state.streak, 1);   // 同一拍重送
  r = stepDanger(r.state, { asOf: T(11, 18, 0), counts: bad });
  assert.equal(r.fired, true); assert.equal(r.state.active, true); assert.equal(r.state.seq, 1);
  s = r.state;
  r = stepDanger(s, { asOf: T(11, 18, 30), counts: bad });
  assert.equal(r.fired, false);   // 持續中不重發
  r = stepDanger(r.state, { asOf: T(11, 19, 0), counts: { limitUp: 20, limitDown: 5 } });
  assert.equal(r.state.active, true);   // 一拍不成立還不解除
  r = stepDanger(r.state, { asOf: T(11, 19, 30), counts: { limitUp: 20, limitDown: 5 } });
  assert.equal(r.state.active, false);
  // 30 分鐘內再成立不重發；之後可再發
  r = stepDanger(r.state, { asOf: T(11, 20, 0), counts: bad });
  r = stepDanger(r.state, { asOf: T(11, 20, 30), counts: bad });
  assert.equal(r.fired, false);
  r = stepDanger(r.state, { asOf: T(11, 48, 30), counts: bad });
  assert.equal(r.fired, true); assert.equal(r.state.seq, 2);
});

test('收盤競價（13:25 起）凍結狀態：不新發也不解除；換日重置', () => {
  const bad = { limitUp: 9, limitDown: 41 };
  let r = stepDanger(null, { asOf: T(13, 24, 0), counts: bad });
  r = stepDanger(r.state, { asOf: T(13, 26, 0), counts: bad });
  assert.equal(r.fired, false); assert.equal(r.state.streak, 1);
  const next = stepDanger(r.state, { asOf: T(10, 0, 0, 6), counts: bad });
  assert.equal(next.state.ymd, '2026-10-06'); assert.equal(next.state.streak, 1);
});

test('本機危險狀態：日期不符或形狀不對一律重置', () => {
  assert.deepEqual(parseDangerState({ ymd: '2026-10-04', active: true }, '2026-10-05'), initialDangerState('2026-10-05'));
  const p = parseDangerState({ ymd: '2026-10-05', active: true, seq: 2, lastFire: 5, lastAsOf: -3, streak: 'x' }, '2026-10-05');
  assert.equal(p.active, true); assert.equal(p.seq, 2); assert.equal(p.lastAsOf, 0); assert.equal(p.streak, 0);
});

test('逼近停損（規範 stop-v1 暫算：成本線＝均價 −8% 向上取檔；不再用 AI 停損）：在停損下或距停損 ≤2%，沒有現價、成本可疑不列', () => {
  const holdings = [
    { code: '2317', name: '鴻海', buyPrice: 100, quantity: 1 },   // 停損 92.0
    { code: '3231', name: '緯創', buyPrice: 100, quantity: 1 },   // 停損 92.0（舊制 AI 停損 95 不再採用）
    { code: '2330', name: '台積電', buyPrice: 100, quantity: 1 },
    { code: '6488', name: '環球晶', buyPrice: 100, quantity: 1 },
    { code: '2603', name: '長榮', buyPrice: 1000, quantity: 1 },  // 成本可疑（現價÷成本 0.09）
  ];
  const list = nearStopList(holdings, { 2317: 93.5, 3231: 94, 2330: 91, 2603: 90 });
  assert.deepEqual(list.map(x => x.code), ['2330', '2317']);
  assert.equal(list[0].distPct, -1.1);
  assert.equal(list[1].distPct, 1.6);
  // 同代號兩筆：均價 (100×1＋110×3)/4＝107.5 → ×0.92＝98.9；現價 100 距 1.1%
  const multi = nearStopList([
    { code: '2317', name: '鴻海', buyPrice: 100, quantity: 1 },
    { code: '2317', name: '鴻海', buyPrice: 110, quantity: 3 },
  ], { 2317: 100 });
  assert.deepEqual(multi, [{ code: '2317', name: '鴻海', distPct: 1.1 }]);
  assert.deepEqual(nearStopList(holdings, null), []);
  // 帶本機事件表（棘輪的上一版 95，與 A1、Z2 同一份）⇒ 停損不回落到成本線 92
  const book = { 2317: { stop: 95, ver: 2, settledYmd: '', ep: null, lots: [{ id: '2317#0', buyPrice: 100, qty: 1, buyDate: null }], startedAt: 0, tradeDate: '' } };
  assert.deepEqual(nearStopList([holdings[0]], { 2317: 96 }), []);
  assert.deepEqual(nearStopList([holdings[0]], { 2317: 96 }, book), [{ code: '2317', name: '鴻海', distPct: 1 }]);
});

test('試撮窗：08:30–09:00、13:25–13:30', () => {
  assert.equal(isIndicativeMinute(8 * 60 + 30), true);
  assert.equal(isIndicativeMinute(8 * 60 + 59.9), true);
  assert.equal(isIndicativeMinute(9 * 60), false);
  assert.equal(isIndicativeMinute(13 * 60 + 25), true);
  assert.equal(isIndicativeMinute(13 * 60 + 30), false);
});

test('daemon 警示 → 事件：舊制停損推播（停損、紀律）一律二級並標明算法不同；文字不帶停損價；自設價定義與非今日略過', () => {
  const stop = { code: '2317', name: '鴻海', type: 'stop', price: 91, threshold: 92, pnlPct: -9, message: '⛔ 2317 鴻海 觸及停損 92（現價 91）', at: T(10, 41, 52) };
  const e = eventFromDaemonAlert(stop, '2026-10-05');
  assert.equal(e.level, 2); assert.equal(e.kind, 'mine'); assert.equal(e.text, '2317 鴻海 觸及停損·舊制推播（停損算法不同）');
  assert.equal(/92|91/.test(e.text), false);
  const disc = eventFromDaemonAlert({ ...stop, type: 'discipline' }, '2026-10-05');
  assert.equal(disc.level, 2); assert.equal(disc.text, '2317 鴻海 停損觸發後未處理·舊制推播（停損算法不同）');
  const pre = eventFromDaemonAlert({ ...stop, at: T(8, 40) }, '2026-10-05');
  assert.equal(pre.level, 2); assert.match(pre.text, /試撮時段/);
  const other = eventFromDaemonAlert({ ...stop, type: 'exit' }, '2026-10-05');
  assert.equal(other.level, 2); assert.equal(other.kind, 'mine'); assert.equal(other.text, '2317 鴻海 爆量下殺');
  assert.equal(eventFromDaemonAlert({ id: 'a-1', code: '2330', name: '台積電', type: 'PRICE_ABOVE', value: 1000, triggered: false, createdAt: 1 }, '2026-10-05'), null);
  assert.equal(eventFromDaemonAlert({ ...stop, at: T(10, 0, 0, 4) }, '2026-10-05'), null);
});

test('逼近停損 stop-v1.1：帶同一份 ctx（持股分析 ATR 帶）與 A1 同一個停損；停損簿生效時逼近改用 ≤1 ATR', () => {
  const h = [{ id: 'a', code: '2317', name: '鴻海', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }];
  const ctx = { bands: { 2317: 94.37 }, bandStatus: 'ok', prevYmd: '2026-10-02', book: null };
  // 成本線 92 時 96 不算逼近；帶 94.3 時距 1.8% ⇒ 逼近
  assert.deepEqual(nearStopList(h, { 2317: 96 }), []);
  assert.deepEqual(nearStopList(h, { 2317: 96 }, null, { ctx, todayYmd: '2026-10-05' }), [{ code: '2317', name: '鴻海', distPct: 1.8 }]);
  const book = {
    phase: 'live', specVersion: 'stop-v1.1', dataDate: '2026-10-02', updatedAt: 1,
    positions: { 2317: { lots: [{ id: 'a', buyPrice: 100, qty: 1, buyDate: '2026-09-01' }], stop: 95.5, stopVersion: 3, stopSource: 'atrBand', atr14: 2.1, adjCost: 100 } },
  };
  // 距 2.15%（>2%）但 ≤1 ATR ⇒ 逼近
  assert.deepEqual(nearStopList(h, { 2317: 97.6 }, null, { ctx: { ...ctx, book }, todayYmd: '2026-10-05' }), [{ code: '2317', name: '鴻海', distPct: 2.2 }]);
});

test('daemon 警示 → 事件（停損簿生效後 stopLive）：requireAck 的觸停損＝一級、id 用警示 id、文字寫來源不寫停損價；舊分支與紀律彙總二級', () => {
  const live = {
    id: 'stop:2317:v5:e3', requireAck: true, type: 'stop', sub: 'gap', code: '2317', name: '鴻海', stopSource: 'atrBand', sourceDate: '2026-10-02',
    price: 94, threshold: 95.5, message: '2317 鴻海 開盤 94.0，已低於停損 95.5（ATR 帶，差 1.6%）', at: T(9, 1),
  };
  const e = eventFromDaemonAlert(live, '2026-10-05', { stopLive: true });
  assert.deepEqual(e, { id: 'stop:2317:v5:e3', at: T(9, 1), kind: 'stopLoss', level: 1, code: '2317', mine: true, text: '2317 鴻海 觸停損（ATR 帶·開盤即低於停損）' });
  assert.equal(/95|94/.test(e.text), false);
  // 停損簿生效前（沒帶 stopLive）：同一則仍降二級舊制
  assert.equal(eventFromDaemonAlert(live, '2026-10-05').level, 2);
  // 生效後舊格式的觸停損（ETF／興櫃舊分支代號）
  const legacy = eventFromDaemonAlert({ code: '00878', name: '國泰永續高股息', type: 'stop', message: 'x', at: T(10, 0) }, '2026-10-05', { stopLive: true });
  assert.equal(legacy.level, 2);
  assert.equal(legacy.text, '00878 國泰永續高股息 觸及停損·沿用現行推播口徑（ETF／興櫃官方日 K 歸檔驗證前）');
  const digest = eventFromDaemonAlert({ id: 'discipline:2026-10-05', type: 'discipline', code: '2317', name: '鴻海 等 2 檔', message: 'x', at: T(9, 5) }, '2026-10-05', { stopLive: true });
  assert.equal(digest.level, 2);
  assert.equal(digest.text, '2317 鴻海 等 2 檔 停損紀律彙總');
  assert.equal(eventFromDaemonAlert({ id: 'stopInfo:2317:eventTighten:x', type: 'stopInfo', code: '2317', name: '鴻海', message: 'x', at: T(9, 0) }, '2026-10-05', { stopLive: true }).text, '2317 鴻海 停損資訊');
});

test('一級排序依嚴重度再依時間（不是單純依時間）', () => {
  const list = sortLevel1([
    { kind: 'majorNegative', at: 5 }, { kind: 'stopLoss', at: 1 }, { kind: 'marketDanger', at: 0 }, { kind: 'stopLoss', at: 3 },
  ]);
  assert.deepEqual(list.map(x => `${x.kind}@${x.at}`), ['marketDanger@0', 'stopLoss@3', 'stopLoss@1', 'majorNegative@5']);
  assert.ok(severityRank('other') > severityRank('majorNegative'));
});
