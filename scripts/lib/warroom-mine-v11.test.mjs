// 盤中戰情 v2·A1／Z2 停損 stop-v1.1：前端暫算（成本線＋持股分析 ATR 帶）、停損簿生效模式、ATR 帶換值與本機事件表 單元測試
//   node --test scripts/lib/warroom-mine-v11.test.mjs
// 規範 .claude/skills/tw-ai-stoploss/SKILL.md §3.6 最後一列、「生效範圍」、§13.2 A1／A2／A7；實作計畫 §3.1–§3.2。非投資建議。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePositions, stopFactText } from './ai-stoploss.mjs';
import {
  provisionalStop, warStopView, warStopResOf, stopJudgeText, FRONT_BAND_NOTE,
  parseStopEpisodes, serializeStopEpisodes, stepStopEpisodes, stopLevel1Events, taipeiAt,
} from './warroom-mine.mjs';
import { parseStopBookDoc } from './warroom-stopbook.mjs';

const T = (h, m, s = 0, day = 5) => Date.UTC(2026, 9, day, h - 8, m, s);
const TODAY = '2026-10-05';
const PREV = '2026-10-02';
const quote = (over = {}) => ({
  price: 96, open: 97, high: 97.5, low: 95, volume: 1_200_000, prevClose: 97, revealAt: T(10, 42), fetchedAt: T(10, 42, 20),
  source: 'mis_realtime', ...over,
});
const P = (holdings) => aggregatePositions(holdings)[0];
const LOT = { id: 'a', code: '2317', name: '鴻海', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' };
const POS = P([LOT]);
const ctxOf = (over = {}) => ({ bands: { 2317: 94.37 }, bandStatus: 'ok', prevYmd: PREV, book: null, ...over });
const view = (over = {}) => warStopView({
  position: POS, quote: quote(), calcPrice: 96, nowMs: T(10, 43), todayYmd: TODAY, tradingDay: true, ctx: ctxOf(), ...over,
});
const names = new Map([['2317', '鴻海']]);
const rowFrom = (pos, v, over = {}) => ({
  code: pos.code, stop: v.stop, floor: v.res.floorStop, source: v.res.stopSource, touch: v.touch, at: T(10, 42),
  prevClose: 97, prevYmd: PREV, lots: pos.lots, reason: v.res.versionReason, suspect: v.res.suspect, ...over,
});

// ── 前端暫算（停損簿生效前） ─────────────────────────────────────────────────

test('前端暫算＝max(成本線, 持股分析 ATR 帶向下取檔)；資料日＝前一交易日；帶不棘輪（來源標籤不寫只升不降）', () => {
  const r = provisionalStop(POS, 96, T(10, 43), TODAY, null, { ratingBand: 94.37, prevYmd: PREV });
  assert.equal(r.stop, 94.3);
  assert.equal(r.costLine, 92);
  assert.equal(r.lines.bandLine, 94.3);
  assert.equal(r.stopSource, 'atrBand');
  assert.equal(r.sourceDate, PREV);
  assert.equal(r.basisText, 'ATR 帶·10/02 設定');
  assert.equal(r.floorStop, 92);
  // 帶低於成本線 ⇒ 成本線
  const low = provisionalStop(POS, 96, T(10, 43), TODAY, null, { ratingBand: 90.12, prevYmd: PREV });
  assert.equal(low.stop, 92); assert.equal(low.stopSource, 'cost');
  // 沒有帶 ⇒ 與 v1 相同（只有成本線）
  assert.equal(provisionalStop(POS, 96, T(10, 43), TODAY, null, {}).stop, 92);
});

test('口徑字樣與規範 wording.md「前端暫算」列同字；A1 標明生效線、未含除權息調整', () => {
  assert.ok(stopFactText('provisional', { withBand: true, stop: 94.3 }).includes(FRONT_BAND_NOTE));
  const v = view();
  assert.equal(v.mode, 'front');
  assert.equal(v.stop, 94.3);
  assert.equal(v.source, 'ATR 帶');
  assert.equal(v.modeNote, FRONT_BAND_NOTE);
  assert.equal(v.exAdjusted, false);
  assert.equal(v.title, '停損 94.3（ATR 帶·10/02 設定）·規範 stop-v1.1·暫算·成本線與 ATR 帶取高·未含除權息調整；ATR 帶未棘輪');
  assert.equal(v.reason, '逼近停損（ATR 帶）·距 1.8%');
  const hit = view({ quote: quote({ low: 94, price: 96 }) });
  assert.equal(hit.reason, '今日最低 94.0 觸及停損 94.3（ATR 帶·10:42 揭示）·現價 96.0·持有損益 −4.0%（未含費稅）');
});

test('ATR 帶觸及時部位仍可能獲利：原因句寫「持有仍獲利」（第 3 項落實）', () => {
  const pos = P([{ ...LOT, buyPrice: 90 }]);
  const v = view({ position: pos, quote: quote({ low: 94, price: 95 }), calcPrice: 95 });
  assert.equal(v.stop, 94.3);
  assert.equal(v.level, 'hit');
  assert.match(v.reason, /^今日最低 94\.0 觸及停損 94\.3（ATR 帶·10:42 揭示）·現價 95\.0·持有仍獲利 \+5\.6%（未含費稅）$/);
});

test('沒有套到 ATR 帶時照實寫原因：今天買進、讀不到、讀取中、沒有這檔', () => {
  const today = view({ position: P([{ ...LOT, buyDate: TODAY }]), quote: quote({ low: 95.5 }) });
  assert.equal(today.stop, 92);
  assert.equal(today.modeNote, '暫算·未套 ATR 帶（今日買進，隔一個交易日起套用）·未含除權息調整');
  assert.equal(view({ ctx: ctxOf({ bands: {}, bandStatus: 'error' }) }).modeNote, '暫算·未含 ATR 帶（持股分析讀不到）·未含除權息調整');
  assert.equal(view({ ctx: ctxOf({ bands: {}, bandStatus: 'loading' }) }).modeNote, '暫算·未含 ATR 帶（持股分析讀取中）·未含除權息調整');
  assert.equal(view({ ctx: ctxOf({ bands: {}, bandStatus: 'ok' }) }).modeNote, '暫算·未含 ATR 帶（持股分析沒有這檔的 ATR 帶）·未含除權息調整');
  assert.equal(view({ ctx: null }).stop, 92);
  assert.equal(view({ position: P([{ ...LOT, buyDate: undefined }]) }).modeNote, '暫算·未套 ATR 帶（買進日缺）·未含除權息調整');
});

test('ATR 帶不棘輪：帶下移停損跟著下移（bandDown），帶消失回成本線；成本線仍只升不降（floor 存本機）', () => {
  const v0 = view({ quote: quote({ low: 99, price: 100 }), calcPrice: 100 });
  const s0 = stepStopEpisodes(parseStopEpisodes(null), [rowFrom(POS, v0)], { todayYmd: TODAY, nowMs: T(10, 43) }).state;
  assert.equal(s0.byCode['2317'].stop, 94.3);
  assert.equal(s0.byCode['2317'].floor, 92);
  // 隔日帶下移到 93.5
  const v1 = warStopView({
    position: POS, quote: quote({ low: 99, price: 100, revealAt: T(9, 30, 0, 6), fetchedAt: T(9, 30, 5, 6) }), calcPrice: 100,
    nowMs: T(9, 31, 0, 6), todayYmd: '2026-10-06', tradingDay: true, entry: s0.byCode['2317'],
    ctx: ctxOf({ bands: { 2317: 93.58 }, prevYmd: TODAY }),
  });
  assert.equal(v1.stop, 93.5);
  assert.equal(v1.res.versionReason, 'bandDown');
  // 帶消失 ⇒ 回到成本線 92（不是沿用 94.3）
  const v2 = warStopView({
    position: POS, quote: quote({ low: 99, price: 100 }), calcPrice: 100, nowMs: T(10, 43), todayYmd: TODAY, tradingDay: true,
    entry: s0.byCode['2317'], ctx: ctxOf({ bands: {} }),
  });
  assert.equal(v2.stop, 92);
});

test('v1 舊表（沒有 floor）換到 v1.1：帶值加入 ⇒ lineRaise，事件延續、不重發一級', () => {
  const old = { v: 1, nextId: 2, byCode: { 2317: {
    stop: 92, ver: 1, settledYmd: PREV, lots: [{ id: 'a', buyPrice: 100, qty: 1, buyDate: '2026-09-01' }], startedAt: 0, tradeDate: '',
    ep: { id: 1, stopVersion: 1, kind: 'touch', triggerAt: T(10, 0, 0, 2), triggerPx: 91.5, skipPct: null, firstDate: PREV, lastDate: PREV, closesBelow: 1, seeded: false, hold: null, level1Sent: true },
  } } };
  const st = parseStopEpisodes(old);
  assert.equal(st.byCode['2317'].floor, null);
  const v = view({ entry: st.byCode['2317'], quote: quote({ low: 91, price: 91.5 }), calcPrice: 91.5 });
  assert.equal(v.stop, 94.3);
  assert.equal(v.res.versionReason, 'lineRaise');
  assert.equal(v.setToday, false);   // 帶值開盤起就適用 ⇒ 照常以今日最低價判定
  const s = stepStopEpisodes(st, [rowFrom(POS, v, { prevClose: 91.8 })], { todayYmd: TODAY, nowMs: T(10, 43) });
  assert.deepEqual(s.sendLevel1, []);
  assert.equal(s.state.byCode['2317'].ep.id, 1);
  assert.equal(s.state.byCode['2317'].ver, 2);
});

test('ATR 帶換值在盤中才被本裝置偵測到 ⇒ 記為開盤前生效，之後各輪仍照今日最低價判定（不當成今日新設停損）', () => {
  const v0 = view({ ctx: ctxOf({ bands: {} }), quote: quote({ low: 99, price: 100 }), calcPrice: 100, nowMs: T(8, 50) });
  const s0 = stepStopEpisodes(parseStopEpisodes(null), [rowFrom(POS, v0, { prevClose: null, prevYmd: null })], { todayYmd: TODAY, nowMs: T(8, 50) }).state;
  assert.equal(s0.byCode['2317'].stop, 92);
  // 10:00 持股分析才讀到帶值 ⇒ 換版
  const v1 = view({ entry: s0.byCode['2317'], quote: quote({ low: 99, price: 100 }), calcPrice: 100, nowMs: T(10, 0) });
  assert.equal(v1.res.versionReason, 'lineRaise');
  const s1 = stepStopEpisodes(s0, [rowFrom(POS, v1)], { todayYmd: TODAY, nowMs: T(10, 0) }).state;
  assert.equal(s1.byCode['2317'].startedAt, taipeiAt(TODAY, 9, 0) - 1);
  assert.equal(s1.byCode['2317'].tradeDate, TODAY);
  // 10:30 跌破帶值 ⇒ 照常判定觸及並發一級，來源寫 ATR 帶
  const v2 = view({ entry: s1.byCode['2317'], nowMs: T(10, 43), quote: quote({ low: 94, price: 96 }) });
  assert.equal(v2.setToday, false);
  assert.equal(v2.touch.status, 'touched');
  const s2 = stepStopEpisodes(s1, [rowFrom(POS, v2)], { todayYmd: TODAY, nowMs: T(10, 43) });
  assert.deepEqual(s2.sendLevel1, ['2317']);
  assert.equal(s2.state.byCode['2317'].ep.stopSource, 'atrBand');
  const ev = stopLevel1Events(s2.state, names, TODAY);
  assert.equal(ev[0].text, '2317 鴻海 觸停損（ATR 帶·今日最低觸及）·單一裝置·暫算');
  assert.equal(/94|95/.test(ev[0].text), false);   // 不寫個人停損價
  // 重新整理讀回：形狀一致、不重發
  const reloaded = parseStopEpisodes(JSON.parse(JSON.stringify(serializeStopEpisodes(s2.state))));
  assert.deepEqual(reloaded, s2.state);
  const v3 = view({ entry: reloaded.byCode['2317'], nowMs: T(10, 50), quote: quote({ low: 94, price: 96 }) });
  const s3 = stepStopEpisodes(reloaded, [rowFrom(POS, v3)], { todayYmd: TODAY, nowMs: T(10, 50) });
  assert.deepEqual(s3.sendLevel1, []); assert.equal(s3.changed, false);
});

test('非交易日偵測到 ATR 帶換值 ⇒ 版本日＝最後交易日、時刻＝偵測時刻（不拿前一交易日收盤補判）', () => {
  const v0 = view({ ctx: ctxOf({ bands: {} }), quote: quote({ low: 99, price: 100 }), calcPrice: 100, nowMs: T(10, 0, 0, 2), todayYmd: PREV });
  const s0 = stepStopEpisodes(parseStopEpisodes(null), [rowFrom(POS, v0, { prevYmd: '2026-10-01' })], { todayYmd: PREV, nowMs: T(10, 0, 0, 2) }).state;
  const sat = Date.UTC(2026, 9, 3, 2, 0);
  const v1 = warStopView({ position: POS, quote: null, calcPrice: 96, nowMs: sat, todayYmd: '2026-10-03', tradingDay: false, entry: s0.byCode['2317'], ctx: ctxOf() });
  const s1 = stepStopEpisodes(s0, [rowFrom(POS, v1, { prevClose: null, prevYmd: null })], { todayYmd: '2026-10-03', nowMs: sat, versionYmd: PREV }).state;
  assert.equal(s1.byCode['2317'].tradeDate, PREV);
  assert.equal(s1.byCode['2317'].startedAt, sat);
  // 週一：前一交易日（週五）收盤 94.0 ≤ 新停損 94.3，但新版是週五收盤後才生效 ⇒ 不補判
  const mon = warStopView({ position: POS, quote: quote({ low: 99, price: 100, revealAt: T(9, 5), fetchedAt: T(9, 5) }), calcPrice: 100, nowMs: T(9, 6), todayYmd: TODAY, tradingDay: true, entry: s1.byCode['2317'], ctx: ctxOf() });
  const s2 = stepStopEpisodes(s1, [rowFrom(POS, mon, { prevClose: 94, prevYmd: PREV })], { todayYmd: TODAY, nowMs: T(9, 6) });
  assert.deepEqual(s2.sendLevel1, []);
  assert.deepEqual(s2.late, []);
});

test('持股變動（盤中加碼）仍算今日新設停損 ⇒ 今日不拿累計最低價判定', () => {
  const v0 = view({ quote: quote({ low: 99, price: 100 }), calcPrice: 100, nowMs: T(8, 50) });
  const s0 = stepStopEpisodes(parseStopEpisodes(null), [rowFrom(POS, v0, { prevClose: null, prevYmd: null })], { todayYmd: TODAY, nowMs: T(8, 50) }).state;
  const more = P([LOT, { ...LOT, id: 'b', buyPrice: 120, quantity: 1, buyDate: '2026-09-15' }]);
  const v1 = view({ position: more, entry: s0.byCode['2317'], nowMs: T(11, 0) });
  assert.equal(v1.res.versionReason, 'ratchet');
  assert.equal(v1.setToday, true);
  assert.equal(v1.touch.notJudged, 'noTodayTrade');
});

// ── 停損簿（stopBooks/{uid}） ────────────────────────────────────────────────

const bp = (over = {}) => ({
  qty: 1, avgCost: 100, firstDate: '2026-09-01', lots: [{ id: 'a', buyPrice: 100, qty: 1, buyDate: '2026-09-01' }],
  ex: { events: [], coverFrom: '2026-06-01', coverTo: PREV }, exApplied: [], selfAdjusted: {}, adjCost: 100, adjDate: PREV,
  exPending: false, exUnconfirmed: false, exUnknown: false,
  stop: 95.5, baseStop: 95.5, floorStop: 92, bandHold: 95.5, line: 'stop', basis: 'system', basisText: 'ATR 帶·10/02 設定·只升不降',
  costLine: 92, stopSource: 'atrBand', sourceDate: PREV, floorSource: 'cost', floorSourceDate: '2026-09-01', bandSourceDate: PREV,
  lines: { costLine: 92, bandLine: 95.5, beLine: null, trailLine: null, eventLine: null },
  lineInputs: {
    dataDate: PREV, close: 99, atr14: 2.1, barsFrom: '2026-06-03', atrBand: { price: 95.5, dataDate: PREV },
    holdHigh: { price: 104, dataDate: '2026-09-20', complete: true }, exGapBars: 0, noOfficialBars: false,
  },
  linesStale: false, stopVersion: 4, versionReason: 'lineRaise', startedAt: Date.parse('2026-10-02T16:50:00+08:00'), tradeDate: PREV,
  atr14: 2.1, atrPct: 2.12, suspect: false, events: [], eventSeen: [], eventKeys: [],
  holdHigh: { price: 104, dataDate: '2026-09-20', complete: true }, noOfficialBars: false, exGapBars: 0, episode: null, ticked: true, legacy: null,
  ...over,
});
const bookOf = (over = {}, pos = bp()) => parseStopBookDoc({
  specVersion: 'stop-v1.1', phase: 'live', dataDate: PREV, updatedAt: T(16, 50, 0, 2), positions: { 2317: pos }, nextEpisodeId: 3, ...over,
});

test('停損簿生效且快照一致 ⇒ 直接用停損簿這一版；逼近改用 ≤1 ATR；標明已還原除權息與資料日', () => {
  const ctx = ctxOf({ book: bookOf() });
  const v = view({ ctx, quote: quote({ low: 97.4, price: 97.6 }), calcPrice: 97.6 });
  assert.equal(v.mode, 'book');
  assert.equal(v.stop, 95.5);
  assert.equal(v.source, 'ATR 帶');
  assert.equal(v.exAdjusted, true);
  assert.equal(v.level, 'near');   // 距 2.15%（>2%）但 ≤1 ATR
  assert.equal(v.atrMultiple, 1);
  assert.equal(v.reason, '逼近停損（ATR 帶）·距 2.2%（1.0 ATR）');
  assert.equal(v.modeNote, '停損簿 stop-v1.1·與推播同一口徑·資料日 10/02');
  assert.match(v.title, /^停損 95\.5（ATR 帶·10\/02 設定·只升不降）·規範 stop-v1\.1·停損簿 stop-v1\.1/);
});

test('停損簿過期、快照不符、沒有這檔 ⇒ 帶停損簿原料暫算，標「暫算·待 daemon 確認（原因）」', () => {
  const stale = view({ ctx: ctxOf({ book: bookOf({ dataDate: '2026-09-30' }, bp({ lineInputs: { ...bp().lineInputs, dataDate: '2026-09-30', atrBand: { price: 95.5, dataDate: '2026-09-30' } } })) }) });
  assert.equal(stale.mode, 'bookCalc');
  assert.equal(stale.stop, 95.5);   // 棘輪沿用停損簿的上一版
  assert.equal(stale.modeNote, '暫算·待 daemon 確認（停損簿資料日 09/30）');
  const more = P([LOT, { ...LOT, id: 'b', buyPrice: 90, quantity: 1, buyDate: '2026-10-05' }]);
  const lots = view({ position: more, ctx: ctxOf({ book: bookOf() }) });
  assert.equal(lots.mode, 'bookCalc');
  assert.equal(lots.stop, 95.5);   // 攤平不下移
  assert.equal(lots.modeNote, '暫算·待 daemon 確認（持股與停損簿逐筆快照不符）');
  const missing = view({ ctx: ctxOf({ book: bookOf({ positions: {} }) }) });
  assert.equal(missing.mode, 'bookCalc');
  assert.equal(missing.stop, 92);
  assert.equal(missing.modeNote, '暫算·待 daemon 確認（停損簿尚無此檔）');
});

test('停損簿生效但該檔 noOfficialBars（ETF／興櫃歸檔驗證前）⇒ 沿用現行推播口徑（有持股分析帶就用，否則成本 −8%）', () => {
  const etf = P([{ id: 'e', code: '00878', name: '國泰永續高股息', buyPrice: 21, quantity: 1, buyDate: '2026-09-01' }]);
  const book = parseStopBookDoc({ specVersion: 'stop-v1.1', phase: 'live', dataDate: PREV, positions: { '00878': { noOfficialBars: true, stop: 19.32 } } });
  const withBand = warStopView({ position: etf, quote: quote({ price: 20.5, low: 20.4, open: 20.6, high: 20.7 }), calcPrice: 20.5, nowMs: T(10, 43), todayYmd: TODAY, tradingDay: true, ctx: ctxOf({ bands: { '00878': 20.15 }, book }) });
  assert.equal(withBand.mode, 'legacy');
  assert.equal(withBand.stop, 20.15);
  assert.equal(withBand.source, 'ATR 帶');
  assert.equal(withBand.modeNote, 'ETF／興櫃官方日 K 歸檔驗證前·沿用現行推播口徑（ATR 帶，否則成本 −8%）');
  const noBand = warStopResOf(etf, 20.5, { ctx: ctxOf({ bands: {}, book }) });
  assert.equal(noBand.res.stop, 19.32);   // 21×0.92
  assert.equal(noBand.res.stopSource, 'cost');
});

test('停損簿這一版是今天盤中生效的 ⇒ 今日不判定觸及（前端沒有真成交旗標）', () => {
  const v = view({ ctx: ctxOf({ book: bookOf({}, bp({ tradeDate: TODAY, startedAt: T(10, 0) })) }), quote: quote({ low: 95, price: 96 }) });
  assert.equal(v.setToday, true);
  assert.equal(v.touch.notJudged, 'noTodayTrade');
  assert.equal(stopJudgeText(v), '今日新設停損：前端沒有真成交旗標，今日不判定觸及');
});

test('影子期停損簿不生效：A1 照前端暫算（不讀影子值）', () => {
  const v = view({ ctx: ctxOf({ book: bookOf({ phase: 'shadow' }) }) });
  assert.equal(v.mode, 'front');
  assert.equal(v.stop, 94.3);
  const wrongVer = view({ ctx: ctxOf({ book: bookOf({ specVersion: 'stop-v1' }) }) });
  assert.equal(wrongVer.mode, 'front');
});

test('畫面與 Z2 文字只描述事實：v1.1 各模式的原因句、提示、口徑註記都不含禁用詞（SKILL §9）', async () => {
  const { scanForbidden } = await import('./ai-stoploss.mjs');
  const { STOP_JUDGE_NOTE_FRONT, STOP_JUDGE_NOTE_LIVE } = await import('./warroom-mine.mjs');
  const views = [
    view(), view({ quote: quote({ low: 94, price: 96 }) }), view({ quote: quote({ open: 93, low: 92.5, price: 93 }), calcPrice: 93 }),
    view({ ctx: ctxOf({ bands: {}, bandStatus: 'error' }) }), view({ position: P([{ ...LOT, buyDate: TODAY }]) }),
    view({ ctx: ctxOf({ book: bookOf() }), quote: quote({ low: 97.4, price: 97.6 }), calcPrice: 97.6 }),
    view({ ctx: ctxOf({ book: bookOf({ dataDate: '2026-09-30' }) }) }),
  ];
  const texts = views.flatMap(v => [v.reason ?? '', v.title, v.modeNote, stopJudgeText(v)]);
  const st = stepStopEpisodes(parseStopEpisodes(null), [rowFrom(POS, views[1])], { todayYmd: TODAY, nowMs: T(10, 43) }).state;
  texts.push(...stopLevel1Events(st, names, TODAY).map(e => e.text), STOP_JUDGE_NOTE_FRONT, STOP_JUDGE_NOTE_LIVE);
  for (const t of texts) assert.deepEqual(scanForbidden(t), [], t);
});

test('v1 舊表換到 v1.1 的切換當天：前一交易日收盤已在新停損（ATR 帶）下 ⇒ seeded 二級彙總、不逐檔發一級（盤前或盤中第一次判定都一樣）', () => {
  const old = { v: 1, nextId: 1, byCode: { 2317: {
    stop: 92, ver: 1, settledYmd: '2026-10-01', ep: null, lots: [{ id: 'a', buyPrice: 100, qty: 1, buyDate: '2026-09-01' }], startedAt: 0, tradeDate: '',
  } } };
  const st = parseStopEpisodes(old);
  // 盤前（沒有前一交易日收盤）先換版
  const pre = view({ entry: st.byCode['2317'], quote: quote({ source: 'stock_day_all', fetchedAt: null, revealAt: null, price: 93.8 }), calcPrice: 93.8, nowMs: T(8, 50) });
  assert.equal(pre.stop, 94.3);
  const s0 = stepStopEpisodes(st, [rowFrom(POS, pre, { prevClose: null, prevYmd: null })], { todayYmd: TODAY, nowMs: T(8, 50) }).state;
  assert.equal(s0.byCode['2317'].settledYmd, '');
  // 開盤：前一交易日收盤 93.8 ≤ 94.3，今日最低 93.5 也在下 ⇒ seeded，不發一級
  const live = view({ entry: s0.byCode['2317'], quote: quote({ low: 93.5, price: 93.9, revealAt: T(9, 1), fetchedAt: T(9, 1, 5) }), calcPrice: 93.9, nowMs: T(9, 2) });
  const s1 = stepStopEpisodes(s0, [rowFrom(POS, live, { prevClose: 93.8 })], { todayYmd: TODAY, nowMs: T(9, 2) });
  assert.deepEqual(s1.sendLevel1, []);
  assert.deepEqual(s1.seeded, ['2317']);
  assert.deepEqual(s1.late, []);
  // 盤中才第一次打開（同一輪拿到前一交易日收盤）也一樣
  const mid = view({ entry: st.byCode['2317'], quote: quote({ low: 93.5, price: 93.9 }), calcPrice: 93.9 });
  const s2 = stepStopEpisodes(st, [rowFrom(POS, mid, { prevClose: 93.8 })], { todayYmd: TODAY, nowMs: T(10, 43) });
  assert.deepEqual(s2.sendLevel1, []);
  assert.deepEqual(s2.seeded, ['2317']);
  // 切換之後（floor 已寫入）照常：隔日收盤回到停損×1.02 之上結束事件，再觸及才發一級
  assert.equal(s2.state.byCode['2317'].floor, 92);
});
