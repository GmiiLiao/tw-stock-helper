// 停損 v1.1 影子試算純函式（scripts/lib/stop-shadow-core.mjs）：node --test scripts/lib/stop-shadow-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodePosition, decodePosition, encodeBook, decodeBook, applyBookPatch, samePositions, barsFromCloseDocs, concatBars,
  exFetchRange, exItemsMerge, legacyOf, compareShadowDay, bookAuditCounts, dayAuditCounts, closeTargetOf, premarketDue,
  taipeiMs, eventMinAtMs, noBarsStub, logKeyOf, SHADOW_PHASE, officialBarsVerdict,
} from './stop-shadow-core.mjs';
import { STOP_SPEC_VERSION } from './ai-stoploss-base.mjs';

const HOL = new Set(['2026-10-09', '2026-10-10']);
const isTD = ymd => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !HOL.has(ymd); };
const hasNestedArray = v => (Array.isArray(v) ? v.some(x => Array.isArray(x) || hasNestedArray(x)) : (v && typeof v === 'object' ? Object.values(v).some(hasNestedArray) : false));

test('停損簿編碼：ex.events 與 eventSeen 的巢狀陣列轉物件（Firestore 不收巢狀陣列）、undefined 去除；解碼還原成 plan* 的形狀', () => {
  const p = {
    stop: 92, ex: { events: [['2026-07-15', 0.962]], coverFrom: '2022-07-01', coverTo: '2026-10-05' },
    eventSeen: [['2330:C16a', '2026-10-05', '2026-10-09']], lots: [{ id: 'a', buyPrice: 100, qty: 1, buyDate: '2026-09-01' }],
    selfAdjusted: { a: ['2026-07-15'] }, legacy: undefined,
  };
  const enc = encodePosition(p);
  assert.equal(hasNestedArray(enc), false);
  assert.ok(!('legacy' in enc));
  assert.deepEqual(enc.ex.events, [{ d: '2026-07-15', f: 0.962 }]);
  const dec = decodePosition(JSON.parse(JSON.stringify(enc)));
  assert.deepEqual(dec.ex.events, [['2026-07-15', 0.962]]);
  assert.deepEqual(dec.eventSeen, [['2330:C16a', '2026-10-05', '2026-10-09']]);
  // 2026-10-07 N4：身分記憶第 4 格＝事件日期（有值才帶）⇒ d；舊的三格照解
  const p4 = { ...p, eventSeen: [['2330:C16a', '2026-10-07', '2026-10-14', '2026-10-07'], ['2317:C17', '2026-10-05', '2026-10-09']] };
  const enc4 = encodePosition(p4);
  assert.equal(hasNestedArray(enc4), false);
  assert.deepEqual(enc4.eventSeen, [{ k: '2330:C16a', e: '2026-10-07', x: '2026-10-14', d: '2026-10-07' }, { k: '2317:C17', e: '2026-10-05', x: '2026-10-09' }]);
  assert.deepEqual(decodePosition(JSON.parse(JSON.stringify(enc4))).eventSeen, p4.eventSeen);
  assert.deepEqual(decodePosition({ eventSeen: [{ k: 'a', e: '2026-10-05', x: '2026-10-09', d: 5 }, { k: 'b', e: 1, x: '2026-10-09' }] }).eventSeen, [['a', '2026-10-05', '2026-10-09']]);
  const book = decodeBook(JSON.parse(JSON.stringify(encodeBook({ positions: { 2330: p }, nextEpisodeId: 3 }))));
  assert.deepEqual(book.positions['2330'].ex.events, [['2026-07-15', 0.962]]);
  assert.equal(decodeBook(null), null);
});

test('applyBookPatch：一律 phase shadow、specVersion stop-v1.1；null＝出清刪除；不改輸入', () => {
  const book = Object.freeze({ phase: 'live', specVersion: 'stop-v1', nextEpisodeId: 4, positions: Object.freeze({ 2330: { stop: 1 }, 2317: { stop: 2 } }) });
  const next = applyBookPatch(book, { 2317: null, 2454: { stop: 3 } }, { dataDate: '2026-10-05' });
  assert.equal(next.phase, SHADOW_PHASE);
  assert.equal(next.specVersion, STOP_SPEC_VERSION);
  assert.deepEqual(Object.keys(next.positions).sort(), ['2330', '2454']);
  assert.equal(next.nextEpisodeId, 4);
  assert.equal(book.positions['2317'].stop, 2);
  assert.equal(samePositions(book, applyBookPatch(book, {}, {})), true);
  assert.equal(samePositions(book, next), false);
});

test('官方日 K：closeJson [收,量張,開,高,低] → 升冪 DayBar；開盤 0 記 null；只留指定代號；合併同日以後者為準', () => {
  const docs = [
    { date: '2026-10-05', closeJson: JSON.stringify({ 2330: [101, 5, 0, 102, 99], 2317: [50, 1, 50, 51, 49] }) },
    { date: '2026-10-02', closeJson: JSON.stringify({ 2330: [100, 4, 99, 101, 98] }) },
  ];
  const b = barsFromCloseDocs(docs, new Set(['2330']));
  assert.deepEqual(Object.keys(b), ['2330']);
  assert.deepEqual(b['2330'].map(x => x.date), ['2026-10-02', '2026-10-05']);
  assert.equal(b['2330'][1].o, null);
  assert.equal(b['2330'][1].h, 102);
  const m = concatBars([{ date: '2026-10-01', c: 1 }, { date: '2026-10-02', c: 2 }], [{ date: '2026-10-02', c: 3 }]);
  assert.deepEqual(m.map(x => x.c), [1, 3]);
});

test('除權息係數：歷史檔＋其後連續區間；區間沒抓到 ⇒ 涵蓋停在歷史檔 to（fail-closed）；priceEvents 同檔同日以官方為準', () => {
  const history = { from: '2022-07-01', to: '2026-09-30', items: [['2026-07-15', '2330', 0.98]] };
  assert.deepEqual(exFetchRange(history, '2026-10-05'), { from: '2026-10-01', to: '2026-10-05' });
  assert.equal(exFetchRange(history, '2026-09-30'), null);
  const r = exItemsMerge({
    history, recent: [['2026-10-02', '2317', 0.97]], recentRange: { from: '2026-10-01', to: '2026-10-05' },
    priceFactors: { 2317: [{ date: '2026-10-02', factor: 0.5 }], 1101: [{ date: '2026-08-01', factor: 0.9 }] },
  });
  assert.deepEqual(r.cover, { from: '2022-07-01', to: '2026-10-05' });
  assert.equal(r.items.filter(x => x.code === '2317').length, 1);
  assert.equal(r.items.find(x => x.code === '2317').factor, 0.97);
  assert.ok(r.items.some(x => x.code === '1101' && x.factor === 0.9));
  const failed = exItemsMerge({ history, recent: null, recentRange: null });
  assert.equal(failed.cover.to, '2026-09-30');
  const gap = exItemsMerge({ history, recent: [['2026-10-12', '2330', 0.9]], recentRange: { from: '2026-10-11', to: '2026-10-12' } });
  assert.equal(gap.cover.to, '2026-09-30', '不連續的區間不採用');
});

test('legacyOf＝舊推播（有帶用帶）、舊紀律（max(帶, 成本×0.92)）、持股分析帶', () => {
  assert.deepEqual(legacyOf(100, 95), { push: 95, discipline: 95, ratingBand: 95 });
  assert.deepEqual(legacyOf(100, 90), { push: 90, discipline: 92, ratingBand: 90 });
  assert.deepEqual(legacyOf(100, null), { push: 92, discipline: 92, ratingBand: null });
});

test('compareShadowDay：同一天舊制實際送出 vs v1.1 若切換會送出（命中與漏網兩向）', () => {
  const day = {
    legacySent: [{ type: 'stop', code: '2330' }, { type: 'stop', code: '2317' }, { type: 'trailing', code: '2454' }, { type: 'discipline', code: '2330' }],
    wouldPush: [{ type: 'stop', code: '2330', stopSource: 'atrBand' }, { type: 'stop', code: '3008', stopSource: 'trail' }],
    wouldDigest: { codes: ['2330', '1101'] },
  };
  const c = compareShadowDay(day);
  assert.deepEqual(c.stop, { both: ['2330'], legacyOnly: ['2317'], v11Only: ['3008'] });
  assert.deepEqual(c.discipline, { both: ['2330'], legacyOnly: [], v11Only: ['1101'] });
  assert.deepEqual(c.trailingLegacy, ['2454']);
  assert.deepEqual(c.v11ProfitLine, ['3008']);
  assert.deepEqual(compareShadowDay(null).stop, { both: [], legacyOnly: [], v11Only: [] });
});

test('公開計數只有數字、不含代號', () => {
  const books = [{ positions: {
    2330: { stopSource: 'atrBand', stop: 100, tradeDate: '2026-10-05', versionReason: 'lineRaise', lines: { bandLine: 100 }, legacy: { push: 98, ratingBand: 100 }, episode: { seeded: true } },
    '00878': { noOfficialBars: true },
    '00631L': { stopSource: 'atrBand', stop: 39, lineInputs: { archive: 'etf' }, linesStale: true, episode: { seeded: false } },
  } }];
  const b = bookAuditCounts(books, '2026-10-05');
  assert.equal(b.users, 1); assert.equal(b.positions, 3); assert.equal(b.noOfficialBars, 1);
  assert.equal(b.bySource.atrBand, 1, '本機官方鏡像供給的 ETF 不混進主計數（R8 分開統計）');
  assert.deepEqual(b.officialArchive, { etf: { positions: 1, bySource: { atrBand: 1 }, linesStale: 1, exGap: 0, episodes: 1 } });
  assert.equal(b.linesStale, 0); assert.equal(b.versionToday.lineRaise, 1); assert.equal(b.band.same, 1);
  assert.equal(b.stopVsLegacyPush.higher, 1); assert.equal(b.episodes.seeded, 1);
  const d = dayAuditCounts([{ wouldPush: [{ type: 'stop', sub: 'touch', code: '2330', pnlPct: 3 }], legacySent: [{ type: 'stop', code: '2330' }] }]);
  assert.equal(d.wouldPush.touch, 1); assert.equal(d.wouldPushInProfit, 1); assert.equal(d.compare.stopBoth, 1);
  assert.ok(!JSON.stringify({ b, d }).includes('2330'));
  assert.ok(!JSON.stringify(b).includes('00631L'));
});

test('排程判定：收盤結算交易日 13:30 後＝今天、開盤前或非交易日＝前一交易日（補跑）、盤中不回頭；盤前刷新 08:46 起、09:00 後標 late', () => {
  const M = (h, m) => h * 60 + m;
  assert.equal(closeTargetOf({ todayYmd: '2026-10-05', minutes: M(16, 50), tradingDay: true, isTradingDay: isTD }), '2026-10-05');
  assert.equal(closeTargetOf({ todayYmd: '2026-10-05', minutes: M(10, 0), tradingDay: true, isTradingDay: isTD }), null);
  assert.equal(closeTargetOf({ todayYmd: '2026-10-06', minutes: M(7, 0), tradingDay: true, isTradingDay: isTD }), '2026-10-05');
  assert.equal(closeTargetOf({ todayYmd: '2026-10-10', minutes: M(10, 0), tradingDay: false, isTradingDay: isTD }), '2026-10-08');
  assert.equal(premarketDue({ todayYmd: '2026-10-05', minutes: M(8, 45), tradingDay: true, doneYmd: null }), null);
  assert.deepEqual(premarketDue({ todayYmd: '2026-10-05', minutes: M(8, 46), tradingDay: true, doneYmd: null }), { late: false });
  assert.deepEqual(premarketDue({ todayYmd: '2026-10-05', minutes: M(9, 20), tradingDay: true, doneYmd: null }), { late: true });
  assert.equal(premarketDue({ todayYmd: '2026-10-05', minutes: M(9, 20), tradingDay: true, doneYmd: '2026-10-05' }), null);
  assert.equal(premarketDue({ todayYmd: '2026-10-10', minutes: M(9, 0), tradingDay: false, doneYmd: null }), null);
  assert.equal(taipeiMs('2026-10-05', 9), Date.UTC(2026, 9, 5, 1, 0));
  assert.equal(eventMinAtMs('2026-10-12', isTD), Date.UTC(2026, 9, 8, 5, 30), '前一交易日（跨 10/9、10/10 休市與週末）13:30');
});

test('noBarsStub 與影子紀錄去重鍵', () => {
  assert.equal(noBarsStub('2026-10-05').noOfficialBars, true);
  assert.equal(logKeyOf('wouldPush', { id: 'stop:2330:v2:e1' }), 'stop:2330:v2:e1');
  assert.equal(logKeyOf('legacySent', { type: 'stop', code: '2330' }), 'stop:2330');
  assert.equal(logKeyOf('eventRecords', { code: '2330', key: '2330:C16a', outcome: 'applied', when: 'premarket', dayYmd: '2026-10-05' }), '2330:2330:C16a:applied:premarket:2026-10-05');
});

test('R8 本機官方鏡像讀取結果 → 能不能用（fail-closed）：閘門 ①②③ 通過、最後一天＝資料日且抓齊才 ok；不 ok 時寫明原因', () => {
  const bars = { '00631L': [{ date: '2026-10-05', c: 41.5 }] };
  const G = over => ({ barsByCode: bars, gates: { tailRun: 80, pendingTail: 0, minRun: 20, pass: true, lastDate: '2026-10-05', ...over } });
  assert.deepEqual(officialBarsVerdict(G({}), '2026-10-05'), { ok: true, reason: null, barsByCode: bars, tailRun: 80 });
  assert.equal(officialBarsVerdict(G({ lastDate: '2026-10-02' }), '2026-10-05').reason, '鏡像最後交易日 2026-10-02≠資料日 2026-10-05');
  assert.equal(officialBarsVerdict(G({ pendingTail: 1 }), '2026-10-05').reason, '資料日 2026-10-05 鏡像尚未抓齊');
  const short = officialBarsVerdict(G({ tailRun: 2, pass: false }), '2026-10-05');
  assert.deepEqual([short.ok, short.reason, short.tailRun], [false, '最近連續完整 2 個交易日（需 ≥20）', 2]);
  assert.equal(short.barsByCode, bars, '不 ok 也留著（只給興櫃身分比對）');
  assert.equal(officialBarsVerdict(null, '2026-10-05').ok, false);
  assert.equal(officialBarsVerdict({ barsByCode: bars }, '2026-10-05').reason, '讀取結果沒有閘門資訊');
});
