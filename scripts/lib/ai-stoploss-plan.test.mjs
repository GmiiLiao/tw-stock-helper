// AI 停損規範 stop-v1.1·daemon 整合純函式（legacyBranchActive、planBookRefresh、planUserStopTick、planCloseSettle、
// planDisciplineDigest、mergeAlertsKeepUnacked）單元測試：node --test scripts/lib/ai-stoploss-plan.test.mjs
// 編號對應實作計畫 warroom/stoploss/v1.1/impl-plan.md §5 J 組。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  legacyBranchActive, mergeAlertsKeepUnacked, planBookRefresh, planUserStopTick, planCloseSettle, planDisciplineDigest,
  isSetToday, STOP_SPEC_VERSION, DISCIPLINE_TAIL, disciplineTailCount,
} from './ai-stoploss.mjs';

const T = (h, m, day = 5) => Date.UTC(2026, 9, day, h - 8, m);
const TODAY = '2026-10-05';
const OPEN = T(9, 0);
const HOLIDAYS = new Set(['2026-10-09']);
const isTD = ymd => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !HOLIDAYS.has(ymd); };

const H = (over = {}) => ({ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01', ...over });
const LI = (over = {}) => ({
  dataDate: '2026-10-02', close: 104, atr14: 2, barsFrom: '2026-06-01', atrBand: { price: 95, dataDate: '2026-10-02' },
  holdHigh: null, exGapBars: 0, noOfficialBars: false, ...over,
});
const EX = { events: [], coverFrom: '2022-07-01', coverTo: TODAY };
const EV = (over = {}) => ({ code: '2330', cls: 'C16a', label: '法律事件', sub: null, key: '2330:C16a', at: T(7, 10), targetDate: TODAY, tier: 'strong', weight: 0.9, ...over });
const Q = (over = {}) => ({ price: 95.5, open: 97, high: 98, low: 94.5, volume: 1000, live: true, liveAt: T(10, 42), revealAt: T(10, 42), realTrade: true, ...over });

function refresh(over = {}) {
  return planBookRefresh({
    holdings: [H()], book: null, exTables: { 2330: EX }, lineInputs: { 2330: LI() }, when: 'premarket',
    latestCanonicalYmd: '2026-10-02', nowMs: T(8, 46), tradeDate: TODAY, isTradingDay: isTD, ...over,
  });
}
const bookOf = (patch, base = null, extra = {}) => {
  const positions = { ...(base?.positions ?? {}) };
  for (const [k, v] of Object.entries(patch)) { if (v) positions[k] = v; else delete positions[k]; }
  return { specVersion: STOP_SPEC_VERSION, phase: 'live', dataDate: '2026-10-02', updatedAt: 1, positions, nextEpisodeId: base?.nextEpisodeId ?? 1, ...extra };
};
const tick = (book, over = {}) => planUserStopTick({
  uid: 'u1', holdings: [H()], book, quotes: { 2330: Q() }, nowMs: T(10, 43), openMs: OPEN, todayYmd: TODAY, tradingDay: true,
  dispositionCodes: new Set(), exState: {}, refPrices: { 2330: 104 }, dedupHas: () => false, isTradingDay: isTD, ...over,
});

test('J11 legacyBranchActive：沒有停損簿、phase 不是 live、specVersion 不是 stop-v1.1 ⇒ 舊分支照跑；live ⇒ 新分支', () => {
  assert.equal(legacyBranchActive(null), true);
  assert.equal(legacyBranchActive({ phase: 'shadow', specVersion: STOP_SPEC_VERSION }), true);
  assert.equal(legacyBranchActive({ phase: 'live', specVersion: 'stop-v1' }), true);
  assert.equal(legacyBranchActive({ phase: 'live', specVersion: STOP_SPEC_VERSION, positions: {} }), false);
});

test('J14 ETF／興櫃官方日 K 歸檔驗證前（noOfficialBars）：live 時該檔仍走舊分支；planUserStopTick 不判定、不發一級、不寫 episode', () => {
  const r = planBookRefresh({
    holdings: [H(), H({ id: 'e', code: '00878', name: '國泰永續高股息', buyPrice: 20 })], book: null,
    exTables: { 2330: EX, '00878': EX }, lineInputs: { 2330: LI(), '00878': { ...LI(), noOfficialBars: true, atrBand: null } },
    when: 'premarket', latestCanonicalYmd: '2026-10-02', nowMs: T(8, 46), tradeDate: TODAY, isTradingDay: isTD,
  });
  const book = bookOf(r.bookPatch);
  assert.equal(book.positions['00878'].noOfficialBars, true);
  assert.equal(book.positions['00878'].stop, 18.4);
  for (const c of ['00878']) assert.equal(legacyBranchActive(book, c), true);
  for (const c of ['2330']) assert.equal(legacyBranchActive(book, c), false);
  const t = tick(book, { holdings: [H(), H({ id: 'e', code: '00878', buyPrice: 20 })], quotes: { 2330: Q({ low: 96, price: 97 }), '00878': Q({ price: 17, low: 16.5, open: 18, high: 18.2 }) } });
  assert.deepEqual(t.pushAlerts, []);
  assert.ok(!('00878' in t.bookPatch));
});

test('J14b（2026-10-06 R8）組成線由本機官方鏡像供給（lineInputs.archive）但歸檔未驗證：影子期照判定（閘門 ⑥）；live 時舊分支照跑、v1.1 照算但不發任何警示；verifiedArchives 含該種類後才發', () => {
  const etf = H({ id: 'e', code: '00631L', name: '元大台灣50正2', buyPrice: 40 });
  const li = { ...LI({ close: 41.5, atr14: 0.8, atrBand: { price: 39, dataDate: '2026-10-02' } }), archive: 'etf' };
  const r = planBookRefresh({
    holdings: [etf], book: null, exTables: { '00631L': EX }, lineInputs: { '00631L': li },
    when: 'premarket', latestCanonicalYmd: '2026-10-02', nowMs: T(8, 46), tradeDate: TODAY, isTradingDay: isTD,
  });
  assert.equal(r.bookPatch['00631L'].noOfficialBars, false);
  assert.equal(r.bookPatch['00631L'].lineInputs.archive, 'etf', 'archive 標記存進停損簿（重啟、S5 都讀得到）');
  const q = { '00631L': Q({ price: 38.5, low: 38.2, open: 39.5, high: 39.8 }) };
  // 影子期：照 v1.1 判定（若切換會送的一級記在 wouldPush，供閘門 ⑥ 分開統計）
  const shadow = bookOf(r.bookPatch, null, { phase: 'shadow' });
  const ts = tick(shadow, { holdings: [etf], quotes: q, refPrices: { '00631L': 41.5 } });
  assert.equal(ts.pushAlerts.length, 1);
  // live、未驗證：舊分支照跑；v1.1 照算、照寫停損簿，但不發推播、二級文件，也不壓舊制的 take／reentry
  const live = bookOf(r.bookPatch);
  assert.equal(legacyBranchActive(live, '00631L'), true);
  assert.equal(legacyBranchActive(live, '00631L', { verifiedArchives: ['etf'] }), false);
  assert.equal(legacyBranchActive(live, '00631L', { verifiedArchives: new Set(['emerging']) }), true);
  const tl = tick(live, { holdings: [etf], quotes: q, refPrices: { '00631L': 41.5 } });
  assert.deepEqual([tl.pushAlerts, tl.dedupKeys, tl.docOnlyAlerts], [[], [], []]);
  assert.equal(tl.suppressOtherTypes.has('00631L'), false);
  assert.ok(tl.bookPatch['00631L']?.episode, '停損簿照常更新（影子統計延續）');
  const tv = tick(live, { holdings: [etf], quotes: q, refPrices: { '00631L': 41.5 }, verifiedArchives: ['etf'] });
  assert.equal(tv.pushAlerts.length, 1, '驗證並核可後（verifiedArchives 含 etf）才發');
  // 收盤補判與紀律彙總同口徑
  const settled = planCloseSettle({
    uid: 'u1', holdings: [etf], book: live, official: { '00631L': { open: 39.5, high: 39.8, low: 38.2, close: 38.6 } }, lineInputs: {},
    dateYmd: TODAY, openMs: OPEN, isTradingDay: isTD, nowMs: T(16, 50),
  });
  assert.deepEqual([settled.pushAlerts, settled.dedupKeys], [[], []]);
  const settledV = planCloseSettle({
    uid: 'u1', holdings: [etf], book: live, official: { '00631L': { open: 39.5, high: 39.8, low: 38.2, close: 38.6 } }, lineInputs: {},
    dateYmd: TODAY, openMs: OPEN, isTradingDay: isTD, nowMs: T(16, 50), verifiedArchives: ['etf'],
  });
  assert.equal(settledV.pushAlerts.length, 1, '同一份停損簿、驗證後收盤補判才發（上一行的空陣列不是空轉）');
  const ep = { id: 1, firstDate: '2026-10-02', lastDate: '2026-10-02', stopVersion: 1, triggerPx: 38.2, seeded: false, closesBelow: 1 };
  const withEp = bookOf({ '00631L': { ...live.positions['00631L'], episode: ep } });
  const dg = planDisciplineDigest({ uid: 'u1', book: withEp, holdings: [etf], prevCloses: { '00631L': 38 }, todayYmd: TODAY, isTradingDay: isTD, nowMs: T(9, 1) });
  assert.equal(dg.alert, null);
  const dv = planDisciplineDigest({ uid: 'u1', book: withEp, holdings: [etf], prevCloses: { '00631L': 38 }, todayYmd: TODAY, isTradingDay: isTD, nowMs: T(9, 1), verifiedArchives: ['etf'] });
  assert.deepEqual(dv.alert?.codes, ['00631L'], '同一份停損簿、驗證後才列入紀律彙總（上一行的 null 不是空轉）');
});

test('J12b（2026-10-06 審查）planCloseSettle：codes 只處理指定代號（其餘部位不在 bookPatch）；興櫃 noLimit 時跌幅超過 10% 照樣補判、沒有開盤價不判跳空', () => {
  const emg = H({ id: 'g', code: '7777', name: '興櫃股', buyPrice: 40 });
  const li = { ...LI({ close: 41.5, atr14: 0.8, atrBand: { price: 39, dataDate: '2026-10-02' } }), archive: 'emerging' };
  const r0 = planBookRefresh({
    holdings: [H(), emg], book: null, exTables: { 2330: EX, 7777: EX }, lineInputs: { 2330: LI(), 7777: li },
    when: 'premarket', latestCanonicalYmd: '2026-10-02', nowMs: T(8, 46), tradeDate: TODAY, isTradingDay: isTD,
  });
  const book = bookOf(r0.bookPatch, null, { phase: 'shadow' });
  assert.equal(book.positions['7777'].stop, 39);
  // 前收 41.5、今日最低 33（跌約 20%：有漲跌幅限制時是超出跌停的壞值）
  const settle = official => planCloseSettle({
    uid: 'u1', holdings: [H(), emg], book, official: { 7777: official }, lineInputs: {}, dateYmd: TODAY, openMs: OPEN, isTradingDay: isTD,
    refPrices: { 7777: 41.5 }, nowMs: T(16, 50), codes: ['7777'],
  });
  const r = settle({ open: null, high: 41, low: 33, close: 34, noLimit: true });
  assert.deepEqual(Object.keys(r.bookPatch), ['7777'], '2330 不動（不在 codes）');
  assert.equal(r.pushAlerts.length, 1);
  assert.deepEqual([r.pushAlerts[0].sub, r.pushAlerts[0].skipPct, r.pushAlerts[0].price], ['late', null, 34], '沒有開盤價不判跳空；損益用官方收盤');
  assert.equal(r.bookPatch['7777'].episode.closesBelow, 1);
  const limited = settle({ open: null, high: 41, low: 33, close: 34 });
  assert.equal(limited.pushAlerts.length, 0, '同一筆最低價在有漲跌幅限制時判為壞值、不補判（上一段不是空轉）');
  assert.ok('2330' in planCloseSettle({
    uid: 'u1', holdings: [H(), emg], book, official: {}, lineInputs: {}, dateYmd: TODAY, openMs: OPEN, isTradingDay: isTD, nowMs: T(16, 50),
  }).bookPatch, '沒傳 codes＝全部（同改動前）');
});

test('J13／J4 盤前刷新：事件收緊在 08:46 生效（版本不是 setToday）、停損簿含 events 與 lines；盤中持股變動的版本是 setToday', () => {
  const r = refresh({ newsEvents: [EV(), EV({ code: '2317', key: '2317:C16a' })] });
  const p = r.bookPatch['2330'];
  assert.equal(p.stop, 100.5); assert.equal(p.stopSource, 'event'); assert.equal(p.versionReason, 'init');
  assert.equal(p.events.length, 1); assert.equal(p.events[0].effectiveFrom, TODAY);
  assert.deepEqual(p.eventSeen.map(s => s[0]), ['2330:C16a']);
  assert.equal(p.lines.bandLine, 95); assert.equal(p.lines.eventLine, 100.5);
  assert.equal(isSetToday({ tradeDate: p.tradeDate, startedAt: p.startedAt }, TODAY, OPEN), false);
  assert.ok(r.docOnlyAlerts.some(a => a.type === 'stopInfo' && a.sub === 'eventTighten' && a.message.startsWith('停損收緊：100.5（事件收緊·10/05 法律事件·至 10/12')));
  assert.ok(r.eventRecords.some(x => x.outcome === 'applied' && x.code === '2330'));
  const book = bookOf(r.bookPatch);
  const intra = planBookRefresh({
    holdings: [H(), H({ id: 'b', buyPrice: 130, buyDate: TODAY })], book, when: 'intraday', latestCanonicalYmd: '2026-10-02',
    nowMs: T(10, 30), tradeDate: TODAY, isTradingDay: isTD,
  });
  const q = intra.bookPatch['2330'];
  assert.equal(q.versionReason, 'ratchet');   // 加碼使成本線上升（115×0.92＝105.8 → 106）
  assert.equal(q.stop, 106);
  assert.equal(isSetToday({ tradeDate: q.tradeDate, startedAt: q.startedAt }, TODAY, OPEN), true);
  // 出清的代號 ⇒ null
  const gone = planBookRefresh({ holdings: [], book, when: 'intraday', nowMs: T(11, 0), tradeDate: TODAY, isTradingDay: isTD });
  assert.deepEqual(gone.bookPatch, { 2330: null });
});

test('盤前除權息：停損 ×f、版本 exAdjust、二級 stopInfo（只寫文件）寫出前後停損與係數', () => {
  const book = bookOf(refresh().bookPatch);
  const r = planBookRefresh({
    holdings: [H()], book, exTables: { 2330: { events: [[TODAY, 0.962]], coverFrom: '2022-07-01', coverTo: TODAY } },
    when: 'premarket', latestCanonicalYmd: '2026-10-02', nowMs: T(8, 47), tradeDate: TODAY, isTradingDay: isTD,
  });
  const p = r.bookPatch['2330'];
  assert.equal(p.versionReason, 'exAdjust'); assert.equal(p.stop, 91.4);   // ceilTick(95×0.962＝91.39)
  const info = r.docOnlyAlerts.find(a => a.sub === 'exAdjust');
  assert.equal(info.message, '停損已依 10/05 除權息調整（係數 0.962）：95.0 → 91.4；成本同步調整為 96.20');
});

test('J1／J2 盤中觸及：一級 type stop 帶 id、requireAck、touchBasis、stopSource、sourceDate、pnlPct；同一事件不重發；本輪觸及的代號壓掉 take／reentry；stopInfo 不進推播', () => {
  const book = bookOf(refresh().bookPatch);
  const t = tick(book);
  assert.equal(t.pushAlerts.length, 1);
  const a = t.pushAlerts[0];
  assert.deepEqual(
    { id: a.id, requireAck: a.requireAck, type: a.type, sub: a.sub, touchBasis: a.touchBasis, stopSource: a.stopSource, sourceDate: a.sourceDate, pnlPct: a.pnlPct, threshold: a.threshold },
    { id: 'stop:2330:v1:e1', requireAck: true, type: 'stop', sub: 'touch', touchBasis: 'low', stopSource: 'atrBand', sourceDate: '2026-10-02', pnlPct: -4.5, threshold: 95 },
  );
  assert.equal(a.message, '⛔ 2330 台積電 今日最低 94.5 觸及停損 95.0（ATR 帶·10:42 揭示）·現價 95.5·持有損益 −4.5%（未含費稅）');
  assert.deepEqual(t.dedupKeys, ['u1:2330:stop:v1:e1']);
  assert.ok(t.suppressOtherTypes.has('2330'));
  assert.equal(t.nextEpisodeId, 2);
  assert.equal(t.bookPatch['2330'].episode.id, 1); assert.equal(t.bookPatch['2330'].ticked, true);
  for (const x of t.pushAlerts) assert.notEqual(x.type, 'stopInfo');
  // 下一輪（停損簿已寫回）：同一事件不重發
  const book2 = bookOf(t.bookPatch, book, { nextEpisodeId: t.nextEpisodeId });
  const t2 = tick(book2, { nowMs: T(10, 50) });
  assert.deepEqual(t2.pushAlerts, []);
  // 重啟後去重表仍在（alertDedup）：dedupHas 為真也不重發
  const t3 = tick(book, { dedupHas: k => k === 'u1:2330:stop:v1:e1' });
  assert.deepEqual(t3.pushAlerts, []); assert.deepEqual(t3.dedupKeys, []);
  // 沒觸及也沒變動 ⇒ 不寫停損簿（避免每輪寫入）
  const t4 = tick(book2, { quotes: { 2330: Q({ low: 96, price: 97 }) }, nowMs: T(11, 0) });
  assert.deepEqual(Object.keys(t4.bookPatch), []);
});

test('切換當天已在停損下（前一交易日收盤 ≤ 停損、尚未判定過）⇒ seeded：不逐檔發一級，改一則二級彙總', () => {
  const r = refresh({ lineInputs: { 2330: LI({ close: 91.5, atrBand: { price: 91, dataDate: '2026-10-02' } }) } });
  const book = bookOf(r.bookPatch);
  assert.equal(book.positions['2330'].stop, 92);
  const t = tick(book, { quotes: { 2330: Q({ low: 91.5, price: 92.5, open: 93 }) } });
  assert.deepEqual(t.pushAlerts, []);
  assert.equal(t.bookPatch['2330'].episode.seeded, true);
  const s = t.docOnlyAlerts.find(a => a.sub === 'seeded');
  assert.equal(s.id, `stopInfo:seeded:${TODAY}`);
  assert.equal(s.message, '已在停損下（前一交易日收盤低於停損）：2330 台積電·本次不逐檔發一級');
});

test('成本資料可疑（2026-10-07 線上查核 4746：均價 1562、收盤 48.30）：停損照算，但不列入「已在停損下」彙總與紀律彙總（本檔停損警示暫停）', () => {
  const hold = H({ code: '4746', name: '台耀', buyPrice: 1562 });
  const li = LI({ close: 48.3, atr14: 1.5, atrBand: { price: 45, dataDate: '2026-10-02' } });
  const r = refresh({ holdings: [hold], exTables: { 4746: EX }, lineInputs: { 4746: li }, lastPrices: { 4746: 48.3 } });
  const book = bookOf(r.bookPatch);
  assert.ok(book.positions['4746'].stop > 48.3, '停損照算（成本線遠高於現價）');
  const t = tick(book, { holdings: [hold], quotes: { 4746: Q({ price: 48.3, low: 48, open: 48.5, high: 49 }) }, refPrices: { 4746: 48.3 } });
  assert.equal(t.bookPatch['4746'].suspect, true);
  assert.deepEqual(t.pushAlerts, [], '不發一級');
  assert.ok(t.docOnlyAlerts.some(a => a.sub === 'suspect'), '二級「成本資料可疑·本檔停損警示暫停」');
  assert.equal(t.docOnlyAlerts.find(a => a.sub === 'seeded'), undefined, '不列入「已在停損下」彙總');
  const book2 = bookOf(t.bookPatch, book, { nextEpisodeId: t.nextEpisodeId });
  const d = planDisciplineDigest({ uid: 'u1', book: book2, holdings: [hold], prevCloses: { 4746: 48.3 }, todayYmd: '2026-10-06', isTradingDay: isTD, nowMs: T(9, 1, 6) });
  assert.equal(d.alert, null, '不列入紀律彙總');
  // 同一則彙總裡的其他持股照列
  const both = [H(), hold];
  const bk = bookOf({ ...bookOf(refresh().bookPatch).positions, 4746: book2.positions['4746'] });
  const t2 = tick(bk, { holdings: both, quotes: { 2330: Q(), 4746: Q({ price: 48.3, low: 48, open: 48.5, high: 49 }) }, refPrices: { 2330: 104, 4746: 48.3 } });
  const bk2 = bookOf(t2.bookPatch, bk, { nextEpisodeId: t2.nextEpisodeId });
  const d2 = planDisciplineDigest({ uid: 'u1', book: bk2, holdings: both, prevCloses: { 2330: 94, 4746: 48.3 }, todayYmd: '2026-10-06', isTradingDay: isTD, nowMs: T(9, 1, 6) });
  assert.deepEqual(d2.alert.codes, ['2330']);
});

test('盤中趟事件收緊：真成交價高於收緊線 ⇒ 套用（今日新設、以成交價判定）；成交價 ≤ 收緊線 ⇒ deferred，二級說明、不改停損', () => {
  const book = bookOf(refresh().bookPatch);
  const ok = tick(book, { intradayEvents: [EV({ pass: 'intraday' })], quotes: { 2330: Q({ price: 103, low: 101, open: 103.5, high: 104 }) }, nowMs: T(10, 30) });
  const p = ok.bookPatch['2330'];
  assert.equal(p.stop, 100.5); assert.equal(p.versionReason, 'eventTighten');
  assert.equal(isSetToday({ tradeDate: p.tradeDate, startedAt: p.startedAt }, TODAY, OPEN), true);
  assert.deepEqual(ok.pushAlerts, [], '今日新設：只認生效後的真成交價，103 > 100.5 不觸及');
  const def = tick(book, { intradayEvents: [EV({ pass: 'intraday' })], quotes: { 2330: Q({ price: 100, low: 99.5, open: 103.5, high: 104 }) }, nowMs: T(10, 30) });
  assert.equal(def.bookPatch['2330'].events[0].state, 'deferred');
  assert.equal(def.bookPatch['2330'].stop, 95);
  const info = def.docOnlyAlerts.find(a => a.sub === 'eventDeferred');
  assert.equal(info.message, '事件收緊未生效：成交價 100.0 已低於收緊線 100.5，改於今日收盤後依官方收盤重算');
});

test('J12 收盤班車順序：先以當天的停損補判（一級 sub late、損益用官方收盤）並結算事件，再產生隔日起適用的版本（lineRaise，事件延續）', () => {
  const book = bookOf(refresh().bookPatch);
  const r = planCloseSettle({
    uid: 'u1', holdings: [H()], book, official: { 2330: { open: 97, high: 98, low: 94.5, close: 96.5 } },
    lineInputs: { 2330: LI({ dataDate: TODAY, close: 96.5, atrBand: { price: 93, dataDate: TODAY } }) },
    dateYmd: TODAY, openMs: OPEN, isTradingDay: isTD, refPrices: { 2330: 104 }, nowMs: T(16, 50),
  });
  assert.equal(r.pushAlerts.length, 1);
  const a = r.pushAlerts[0];
  assert.equal(a.sub, 'late'); assert.equal(a.touchBasis, 'officialLow'); assert.equal(a.threshold, 95); assert.equal(a.pnlPct, -3.5);
  assert.equal(a.message, '⛔ 2330 台積電 收盤後補判：今日最低 94.5 低於停損 95.0（ATR 帶·盤中未即時判到）·持有損益 −3.5%（未含費稅）');
  assert.deepEqual(r.missedLive, ['2330']);
  const p = r.bookPatch['2330'];
  assert.equal(p.stop, 95, '帶降到 93、棘輪保留 95');
  assert.equal(p.lines.bandLine, 93); assert.equal(p.tradeDate, TODAY);
  assert.equal(p.episode.kind, 'late'); assert.equal(p.episode.closesBelow, 0);
  // 今天盤中已有事件 ⇒ 不補判
  const t = tick(book);
  const book2 = bookOf(t.bookPatch, book, { nextEpisodeId: t.nextEpisodeId });
  const r2 = planCloseSettle({ uid: 'u1', holdings: [H()], book: book2, official: { 2330: { open: 97, high: 98, low: 94.5, close: 96.5 } }, lineInputs: { 2330: LI({ dataDate: TODAY, close: 96.5 }) }, dateYmd: TODAY, openMs: OPEN, isTradingDay: isTD, nowMs: T(16, 50) });
  assert.deepEqual(r2.pushAlerts, []);
  // 帶上升 ⇒ lineRaise、事件延續（stopVersion 跟著換）
  const r3 = planCloseSettle({ uid: 'u1', holdings: [H()], book: book2, official: { 2330: { open: 97, high: 98, low: 94.5, close: 96.5 } }, lineInputs: { 2330: LI({ dataDate: TODAY, close: 99, atrBand: { price: 96, dataDate: TODAY } }) }, dateYmd: TODAY, openMs: OPEN, isTradingDay: isTD, nowMs: T(16, 50) });
  assert.equal(r3.bookPatch['2330'].versionReason, 'lineRaise');
  assert.equal(r3.bookPatch['2330'].episode.id, 1);
  assert.equal(r3.bookPatch['2330'].episode.stopVersion, r3.bookPatch['2330'].stopVersion);
  // 官方收盤 > 停損×1.02 ⇒ 事件結束
  const r4 = planCloseSettle({ uid: 'u1', holdings: [H()], book: book2, official: { 2330: { open: 97, high: 98, low: 94.5, close: 97 } }, lineInputs: { 2330: LI({ dataDate: TODAY }) }, dateYmd: TODAY, openMs: OPEN, isTradingDay: isTD, nowMs: T(16, 50) });
  assert.equal(r4.bookPatch['2330'].episode, null);
});

test('J15 收盤班車不處理到期（到期只在盤前刷新）；延後的事件收緊以今日官方收盤重算、次一交易日生效', () => {
  const pre = bookOf(refresh({ newsEvents: [EV()] }).bookPatch);
  const ov = pre.positions['2330'].events[0];
  const expiring = bookOf({ 2330: { ...pre.positions['2330'], events: [{ ...ov, expiresAfter: TODAY }] } });
  const r = planCloseSettle({ uid: 'u1', holdings: [H()], book: expiring, official: { 2330: { open: 103, high: 104, low: 101, close: 102 } }, lineInputs: { 2330: LI({ dataDate: TODAY, close: 102 }) }, dateYmd: TODAY, openMs: OPEN, isTradingDay: isTD, nowMs: T(16, 50) });
  assert.equal(r.bookPatch['2330'].events.length, 1);
  const next = planBookRefresh({ holdings: [H()], book: bookOf(r.bookPatch), when: 'premarket', latestCanonicalYmd: TODAY, nowMs: T(8, 46, 6), tradeDate: '2026-10-06', isTradingDay: isTD });
  assert.equal(next.bookPatch['2330'].events.length, 0);
  assert.equal(next.bookPatch['2330'].versionReason, 'eventExpire');
  assert.ok(next.docOnlyAlerts.some(a => a.sub === 'eventExpire'));
  // 延後層
  const book = bookOf(refresh().bookPatch);
  const def = tick(book, { intradayEvents: [EV({ pass: 'intraday' })], quotes: { 2330: Q({ price: 100, low: 99.5, open: 103.5, high: 104 }) }, nowMs: T(10, 30) });
  const book2 = bookOf(def.bookPatch, book);
  const c = planCloseSettle({ uid: 'u1', holdings: [H()], book: book2, official: { 2330: { open: 103.5, high: 104, low: 99.5, close: 101 } }, lineInputs: { 2330: LI({ dataDate: TODAY, close: 101 }) }, dateYmd: TODAY, openMs: OPEN, isTradingDay: isTD, nowMs: T(16, 50) });
  const o = c.bookPatch['2330'].events[0];
  assert.deepEqual([o.state, o.effectiveFrom, o.line], ['active', '2026-10-06', 97.9]);   // 101 − max(2, 3.03)
  assert.equal(c.bookPatch['2330'].stop, 97.9);
  assert.ok(c.docOnlyAlerts.some(a => a.sub === 'eventTighten'));
});

test('E9 紀律彙總：事件第 2 個交易日起、前一交易日收盤 ≤ 停損 ⇒ 每人每日一則（type discipline、照推播、結尾保留句一次）；已發過或收盤未定版 ⇒ 不發', () => {
  const book = bookOf(refresh().bookPatch);
  const t = tick(book);
  const book2 = bookOf(t.bookPatch, book, { nextEpisodeId: t.nextEpisodeId });
  const d = planDisciplineDigest({ uid: 'u1', book: book2, holdings: [H()], prevCloses: { 2330: 94 }, todayYmd: '2026-10-06', isTradingDay: isTD, nowMs: T(9, 1, 6) });
  assert.equal(d.dedupKey, 'u1:digest');
  assert.equal(d.alert.type, 'discipline'); assert.deepEqual(d.alert.codes, ['2330']); assert.equal(d.alert.requireAck, undefined);
  assert.equal(d.alert.message, `⛔ 停損後收盤仍在停損下：2330 台積電 事件第 2 個交易日（前一交易日收盤 94.0／停損 95.0·ATR 帶；觸及時 94.5，與前一交易日收盤差額約 −500 元） ${DISCIPLINE_TAIL}`);
  assert.equal(disciplineTailCount(d.alert.message), 1);
  assert.deepEqual(planDisciplineDigest({ uid: 'u1', book: book2, holdings: [H()], prevCloses: { 2330: 94 }, todayYmd: '2026-10-06', isTradingDay: isTD, dedupHas: () => true }), { alert: null, dedupKey: null });
  assert.equal(planDisciplineDigest({ uid: 'u1', book: book2, holdings: [H()], prevCloses: {}, todayYmd: '2026-10-06', isTradingDay: isTD }).alert, null);
  assert.equal(planDisciplineDigest({ uid: 'u1', book: book2, holdings: [H()], prevCloses: { 2330: 94 }, todayYmd: TODAY, isTradingDay: isTD }).alert, null, '第 1 天只有一級');
});

test('S5 切換當天 resetEpisodes：清掉影子期事件、第一輪 live 以 seeded 處理已在停損下的部位', () => {
  const book = bookOf(refresh().bookPatch);
  const t = tick(book);
  const shadowed = bookOf(t.bookPatch, book, { phase: 'shadow' });
  const sw = planBookRefresh({ holdings: [H()], book: shadowed, when: 'premarket', latestCanonicalYmd: TODAY, nowMs: T(8, 46, 6), tradeDate: '2026-10-06', isTradingDay: isTD, resetEpisodes: true });
  assert.equal(sw.bookPatch['2330'].episode, null); assert.equal(sw.bookPatch['2330'].ticked, false);
});

test('mergeAlertsKeepUnacked：新的在前、同 id 只留一則；超過上限優先保留未收到的一級', () => {
  const old = Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, type: 'take', message: String(i) }));
  const unacked = { id: 'stop:2330:v1:e1', type: 'stop', requireAck: true, message: 'x' };
  const acked = { id: 'stop:2317:v1:e2', type: 'stop', requireAck: true, ack: 1, message: 'y' };
  const merged = mergeAlertsKeepUnacked([...old.slice(0, 20), acked, ...old.slice(20), { ...unacked }], [{ id: 'n1', type: 'stopInfo' }], 40);
  assert.equal(merged.length, 40);
  assert.ok(merged.some(a => a.id === 'stop:2330:v1:e1'), '未收到的一級在第 41 位也保留');
  assert.equal(merged[0].id, 'n1');
  const dup = mergeAlertsKeepUnacked([{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }]);
  assert.deepEqual(dup, [{ id: 'a', v: 2 }]);
});
