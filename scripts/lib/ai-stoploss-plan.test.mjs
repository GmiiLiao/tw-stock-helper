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
