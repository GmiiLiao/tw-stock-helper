// 起漲影子名單後台文件測試：node --test scripts/lib/surge-shadow-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDayDoc, buildIndexDoc, daySummary, dayDocId, DAY_ID_RE, forwardFreezeOk, forwardTotals, historyConsistency, normalizeScore, SHADOW_LISTS } from './surge-shadow-report.mjs';

const SHA = 'a'.repeat(64);
const entry = (rank, code, extra = {}) => ({ rank, code, name: `股${code}`, market: 'tse', close: 51.234, chgPct: 9.98926, score: 2.9918921, limitUpAtS: false, luStreakAtS: 0, oneWordLockAtS: false, closeAtHigh: true, vol20Lots: 2208.25, ...extra });
const frozen = (over = {}) => ({
  schema: 'a35.shadow.v1', kind: 'frozen-forward', scoringDay: '2026-10-02', targetDay: '2026-10-05', sha256: SHA,
  generatedAt: '2026-10-04T04:08:21+08:00', modelHash: 'm'.repeat(64),
  training: { cutoffDate: '2026-09-29', lastLabelDate: '2026-09-30', retrain: 'daily', fitRows: 10, positives: 2 },
  universe: { pool: 861, poolByMarket: { tse: 581, otc: 280, '?': 0 }, alreadyLimitUpInPool: 40 },
  marketContext: { all: { nLimitUp: 55 } },
  site: { dataDate: '2026-10-02', codes: ['1111', '2222'], ranksTop120: { 1111: 1, 3333: 7 }, bList: [{ code: '2222', est: 36 }], writtenAt: 'x', canonicalAt: 'y', source: 's', overlapWithOverallTop30: 1 },
  lists: Object.fromEntries(SHADOW_LISTS.map(([k]) => [k, [entry(1, '1111'), entry(2, '3333', { limitUpAtS: true })]])),
  ...over,
});
const score = (over = {}) => ({
  frozenSha256: SHA, truth: { nLimitUp: 55, nBuyableLimitUp: 51 }, baseRatePool: { all: { n: 858, hit: 38, rate: 0.044 } },
  lists: { overallTop30: { 10: { n: 10, hit: 3, buy: 2 }, 30: { n: 30, hit: 8, buy: 5 } }, site_top10: { 10: { n: 10, hit: 2, buy: 1 } }, site_top30: { 30: { n: 30, hit: 6, buy: 4 } } },
  hits: { overallTop30: [{ code: '1111', lu: true, buyable: false }, { code: '3333', lu: false, buyable: false }], site_top30: [{ rank: 1, code: '1111', lu: true, buyable: false, limitUpAtS: false }] },
  marketContext: { targetDay: { all: { nLimitUp: 55 } } }, warnings: ['w1', 3],
  ...over,
});

test('未對答案的日文件：六個子榜都在、數字四捨五入、站上名次對上、結果欄為 null', () => {
  const d = buildDayDoc(frozen());
  assert.equal(d.schema, 'surgeShadow.day.v1');
  assert.deepEqual(Object.keys(d.lists), SHADOW_LISTS.map(([k]) => k));
  const r = d.lists.overallTop30[0];
  assert.equal(r.close, 51.23); assert.equal(r.chgPct, 9.99); assert.equal(r.score, 2.992); assert.equal(r.vol20Lots, 2208);
  assert.equal(r.siteRank, 1); assert.equal(d.lists.overallTop30[1].siteRank, 7);
  assert.equal(r.lu, null); assert.equal(r.buyable, null);
  assert.equal(d.outcome, null);
  assert.equal(d.training.trainCutoff, '2026-09-29');
  assert.equal(d.universe.poolByMarket.otc, 280);
});

test('文件內不得出現 undefined（Firestore 會拒寫）', () => {
  const walk = (v, p) => { assert.notEqual(v, undefined, `undefined at ${p}`); if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`); };
  walk(buildDayDoc(frozen({ site: {}, training: {}, universe: {} })), 'doc');
  walk(buildDayDoc(frozen(), score()), 'doc');
});

test('已對答案：逐檔標記只來自對應子榜的 hits；沒有 hits 的子榜保持 null', () => {
  const d = buildDayDoc(frozen(), score());
  assert.equal(d.lists.overallTop30[0].lu, true);
  assert.equal(d.lists.overallTop30[1].lu, false);
  assert.equal(d.lists.freshTop30[0].lu, null, '舊版對答案檔只有 overallTop30 的逐檔結果');
  assert.equal(d.outcome.nLimitUp, 55);
  assert.equal(d.outcome.siteTop30[0].code, '1111');
  assert.deepEqual(d.outcome.warnings, ['w1']);
});

test('對答案檔封印不符 ⇒ 丟錯，不把別份名單的結果貼上來', () => {
  assert.throws(() => buildDayDoc(frozen(), score({ frozenSha256: 'b'.repeat(64) })), /frozenSha256/);
});

test('凍結檔格式錯誤 ⇒ 丟錯', () => {
  assert.throws(() => buildDayDoc(frozen({ schema: 'x' })), /schema/);
  assert.throws(() => buildDayDoc(frozen({ kind: 'weird' })), /種類/);
  assert.throws(() => buildDayDoc(frozen({ sha256: 'short' })), /sha256/);
  assert.throws(() => buildDayDoc(frozen({ scoringDay: '2026/10/02' })), /格式/);
});

test('合併檔的 days[] 一列與單日檔正規化成同一形狀', () => {
  const a = normalizeScore(score());
  const b = normalizeScore({ frozenSha256: SHA, nLimitUp: 55, nBuyableLimitUp: 51, lists: {}, hits: {}, marketContext: { targetDay: null } });
  assert.equal(a.nLimitUp, b.nLimitUp); assert.equal(a.nBuyableLimitUp, b.nBuyableLimitUp);
  assert.equal(normalizeScore(null), null);
});

test('前向合計只算「事前凍結且已對答案」的日子，歷史回推不混入', () => {
  const fwd = daySummary(buildDayDoc(frozen(), score()));
  const pending = daySummary(buildDayDoc(frozen({ scoringDay: '2026-10-05', targetDay: '2026-10-06' })));
  const hist = daySummary(buildDayDoc(frozen({ kind: 'historical-would-have-been', scoringDay: '2026-10-01', targetDay: '2026-10-02' }), score()));
  const t = forwardTotals([fwd, pending, hist]);
  assert.equal(t.days, 2); assert.equal(t.scored, 1);
  assert.deepEqual(t.top10, { n: 10, hit: 3, buy: 2 });
  assert.deepEqual(t.site30, { n: 30, hit: 6, buy: 4 });
});

test('文件 id：事前凍結與歷史回推分開前綴，格式錯誤丟錯', () => {
  assert.equal(dayDocId('frozen-forward', '2026-10-02'), 'fwd-2026-10-02');
  assert.equal(dayDocId('historical-would-have-been', '2026-10-01'), 'hist-2026-10-01');
  assert.ok(DAY_ID_RE.test('fwd-2026-10-02')); assert.ok(!DAY_ID_RE.test('fwd-2026-10-02/../x'));
  assert.throws(() => dayDocId('weird', '2026-10-02'));
  assert.equal(daySummary(buildDayDoc(frozen())).id, 'fwd-2026-10-02');
});

test('日期清單由新到舊；歷史區塊只帶指定格子', () => {
  const s1 = daySummary(buildDayDoc(frozen({ scoringDay: '2026-09-30', targetDay: '2026-10-01' })));
  const s2 = daySummary(buildDayDoc(frozen()));
  const pooled = { pooled: { days: 54, blockDays: 5, lists: { 'overallTop30@10': { n: 540, hit: 148, buy: 112, precision: 0.2741, precisionWilson: [0.23, 0.31], precisionBlock: [0.19, 0.34], buyable: 0.2074 }, 'other@10': { n: 1 } } }, days: [{ scoringDay: '2026-07-16' }, { scoringDay: '2026-10-01' }], context: { byLimitUpTercile: [] } };
  const ix = buildIndexDoc([s1, s2], pooled, '2026-10-04T14:00:00+08:00');
  assert.deepEqual(ix.days.map(d => d.scoringDay), ['2026-10-02', '2026-09-30']);
  assert.deepEqual(Object.keys(ix.history.lists), ['overallTop30@10']);
  assert.equal(ix.history.from, '2026-07-16'); assert.equal(ix.history.to, '2026-10-01');
  assert.equal(buildIndexDoc([], null, 'x').history, null);
  assert.equal(ix.historyStatus, 'ok');
});

test('事前凍結時間閘：目標日 09:00 前凍結才算；之後或缺時間一律不算', () => {
  assert.equal(forwardFreezeOk(frozen()), true);                                                   // 10-04 04:08 < 10-05 09:00
  assert.equal(forwardFreezeOk(frozen({ generatedAt: '2026-10-05T08:59:59+08:00' })), true);
  assert.equal(forwardFreezeOk(frozen({ generatedAt: '2026-10-05T09:00:00+08:00' })), false);
  assert.equal(forwardFreezeOk(frozen({ generatedAt: '2026-10-05T15:30:00+08:00' })), false);
  assert.equal(forwardFreezeOk(frozen({ generatedAt: null })), false);
});

test('歷史合併統計與目前名單封印集合不一致 ⇒ mismatch，且索引不帶合併統計', () => {
  const pooled = { pooled: { days: 2, lists: { 'overallTop30@10': { n: 20, hit: 5 } } }, days: [{ scoringDay: '2026-09-29', frozenSha256: 'a' }, { scoringDay: '2026-09-30', frozenSha256: 'b' }] };
  assert.equal(historyConsistency([{ scoringDay: '2026-09-29', sha256: 'a' }, { scoringDay: '2026-09-30', sha256: 'b' }], pooled).status, 'ok');
  const m = historyConsistency([{ scoringDay: '2026-09-29', sha256: 'a' }, { scoringDay: '2026-09-30', sha256: 'B2' }], pooled);
  assert.equal(m.status, 'mismatch'); assert.deepEqual(m.onlyInPooled, ['2026-09-30']); assert.deepEqual(m.onlyInLists, ['2026-09-30']);
  assert.equal(historyConsistency([], null).status, 'missing');
  const ix = buildIndexDoc([], pooled, 'x', 'mismatch');
  assert.equal(ix.history, null); assert.equal(ix.historyStatus, 'mismatch');
});

test('日文件 id 重複 ⇒ 丟錯', () => {
  const s = daySummary(buildDayDoc(frozen()));
  assert.throws(() => buildIndexDoc([s, { ...s }], null, 'x'), /重複/);
});
