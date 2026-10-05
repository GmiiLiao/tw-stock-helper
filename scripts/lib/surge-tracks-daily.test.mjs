// node --test scripts/lib/surge-tracks-daily.test.mjs
// T1 分軌前向影子每日流程的決策邏輯：總開關、官方漲停價鏡像就緒、凍結／等待／缺口（理由）、待評分、要不要刷新面板。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCalendar } from './surge-shadow-daily.mjs';
import {
  parseForwardConfig, prevTradingDay, mirrorRowOk, mirrorLimitStatus, tracksPlan, pendingScores, tracksNeedData, nthTradingDayAfter,
  TRACKS_CORE_RE, TRACKS_GAP_RE, TRACKS_SCORE_RE, SCORE_STAGES,
} from './surge-tracks-daily.mjs';
import { FOREIGN_PATTERNS } from './surge-shadow-daily.mjs';

const CAL = makeCalendar({ holidays: ['2026-10-09', '2026-10-26'], coverYear: 2026 }, null);
const ok = key => ({ status: 'ok', echo: key, final: true });
const day = (date, over = {}) => ({ date, found: true, ready: true, missing: [], nonOfficialOtcClose: false, ...over });
const none = () => false;
const mirrorAll = () => ({ ok: true, missing: [] });

test('總開關：enabled 必須是 true 且有 startDay；讀不到就停用', () => {
  assert.deepEqual(parseForwardConfig(null), { enabled: false, startDay: null, error: '讀不到 tracks/forward_config.json（視為停用）' });
  assert.equal(parseForwardConfig({ enabled: false, startDay: '2026-10-06' }).enabled, false);
  assert.equal(parseForwardConfig({ enabled: true, startDay: null }).enabled, false);
  assert.match(parseForwardConfig({ enabled: true, startDay: '10/06' }).error, /startDay/);
  assert.deepEqual(parseForwardConfig({ enabled: true, startDay: '2026-10-06' }), { enabled: true, startDay: '2026-10-06', error: null });
  assert.equal(parseForwardConfig({ enabled: 'true', startDay: '2026-10-06' }).enabled, false);   // 只接受布林 true
});

test('前一交易日與 n 個交易日之後（跳過週末與補假）', () => {
  assert.equal(prevTradingDay('2026-10-05', CAL), '2026-10-02');
  assert.equal(prevTradingDay('2026-10-12', CAL), '2026-10-08');          // 10-09 補假
  assert.equal(nthTradingDayAfter('2026-10-05', 4, CAL), '2026-10-12');   // 10-06、07、08、12
});

test('鏡像列：ok＋回聲＝鍵＋未標 final＝false 才算數；上櫃看前一交易日', () => {
  assert.equal(mirrorRowOk(ok('2026-10-05'), '2026-10-05'), true);
  assert.equal(mirrorRowOk({ status: 'ok', echo: '2026-10-02', final: true }, '2026-10-05'), false);
  assert.equal(mirrorRowOk({ status: 'ok', echo: '2026-10-05', final: false }, '2026-10-05'), false);
  assert.equal(mirrorRowOk({ status: 'empty', echo: '2026-10-05' }, '2026-10-05'), false);
  const rows = { twse: { '2026-10-05': ok('2026-10-05') }, tpex: { '2026-10-02': ok('2026-10-02') } };
  assert.deepEqual(mirrorLimitStatus(rows, '2026-10-05', '2026-10-02'), { ok: true, missing: [] });
  assert.deepEqual(mirrorLimitStatus(rows, '2026-10-06', '2026-10-05').missing, ['上市 TWT84U(2026-10-06)', '上櫃 dailyQuotes(2026-10-05)']);
});

test('沒有 startDay（停用）⇒ 不做任何事', () => {
  const p = tracksPlan({ days: [day('2026-10-05')], cal: CAL, nowTw: '2026-10-05T23:00', start: null, hasCore: none, hasGap: none, mirrorOf: mirrorAll });
  assert.deepEqual(p.produce, []); assert.deepEqual(p.missed, []);
});

test('期限前：收盤到齊＋鏡像就緒 ⇒ 凍結；任一未齊 ⇒ 等待（理由具體）', () => {
  const base = { cal: CAL, nowTw: '2026-10-05T22:40', start: '2026-10-05', hasCore: none, hasGap: none };
  let p = tracksPlan({ ...base, days: [day('2026-10-05')], mirrorOf: mirrorAll });
  assert.deepEqual(p.produce, [{ date: '2026-10-05', nextTD: '2026-10-06', deadline: '2026-10-06T09:00' }]);
  p = tracksPlan({ ...base, days: [day('2026-10-05')], mirrorOf: () => ({ ok: false, missing: ['上市 TWT84U(2026-10-05)'] }) });
  assert.match(p.waiting[0].why, /官方漲停價鏡像未到：上市 TWT84U/);
  p = tracksPlan({ ...base, days: [day('2026-10-05', { ready: false, missing: ['上櫃收盤'] })], mirrorOf: mirrorAll });
  assert.match(p.waiting[0].why, /上櫃收盤/);
  p = tracksPlan({ ...base, days: [day('2026-10-05', { nonOfficialOtcClose: true })], mirrorOf: mirrorAll });
  assert.match(p.waiting[0].why, /第三方補洞/);
  assert.equal(p.produce.length, 0);
});

test('過了下一交易日 09:00 ⇒ 缺口（不產生），理由依序：歸檔→補洞→鏡像→研究程序占用→協調器未執行', () => {
  const base = { cal: CAL, nowTw: '2026-10-06T09:00', start: '2026-10-05', hasCore: none, hasGap: none };
  const r = (d, mirrorOf = mirrorAll, blocks = []) => tracksPlan({ ...base, days: [d], mirrorOf, blocks }).missed[0]?.reason;
  assert.match(r(day('2026-10-05', { ready: false, missing: ['上市法人'] })), /收盤歸檔未到齊（上市法人）/);
  assert.match(r(day('2026-10-05', { nonOfficialOtcClose: true })), /第三方/);
  assert.match(r(day('2026-10-05'), () => ({ ok: false, missing: ['上市 TWT84U(2026-10-05)'] })), /鏡像未到/);
  assert.match(r(day('2026-10-05'), mirrorAll, ['2026-10-05T22:40', '2026-10-06T07:05']), /研究程序占用.*2 輪.*07:05/);
  assert.match(r(day('2026-10-05')), /協調器未執行或失敗/);
  assert.match(r(day('2026-10-05', { found: null })), /歸檔狀態不明/);
  const before = tracksPlan({ ...base, nowTw: '2026-10-06T08:59', days: [day('2026-10-05')], mirrorOf: mirrorAll });
  assert.equal(before.produce.length, 1);
});

test('已有凍結檔或缺口記錄 ⇒ 完成（只寫一次）；startDay 之前不看', () => {
  const p = tracksPlan({ days: [day('2026-10-02'), day('2026-10-05'), day('2026-10-06')], cal: CAL, nowTw: '2026-10-08T23:00', start: '2026-10-05',
    hasCore: d => d === '2026-10-05', hasGap: d => d === '2026-10-06', mirrorOf: mirrorAll });
  assert.deepEqual(p.done, ['2026-10-05', '2026-10-06']);
  assert.deepEqual(p.missed, []);
});

test('整天沒有歸檔、之後已有歸檔 ⇒ 疑似臨時休市（不是缺口）；之後還沒歸檔 ⇒ 等待', () => {
  const days = [day('2026-10-05', { found: false, ready: false }), day('2026-10-06')];
  const p = tracksPlan({ days, cal: CAL, nowTw: '2026-10-07T23:00', start: '2026-10-05', hasCore: d => d === '2026-10-06', hasGap: none, mirrorOf: mirrorAll });
  assert.equal(p.suspected[0].date, '2026-10-05');
  assert.equal(p.missed.length, 0);
  const q = tracksPlan({ days: [day('2026-10-05', { found: false, ready: false })], cal: CAL, nowTw: '2026-10-07T23:00', start: '2026-10-05', hasCore: none, hasGap: none, mirrorOf: mirrorAll });
  assert.match(q.waiting[0].why, /臨時休市/);
});

test('日曆未涵蓋的年份 ⇒ 記錯誤，不猜', () => {
  const p = tracksPlan({ days: [day('2026-12-31')], cal: CAL, nowTw: '2026-12-31T23:00', start: '2026-10-05', hasCore: none, hasGap: none, mirrorOf: mirrorAll });
  assert.match(p.errors[0].error, /未涵蓋 2027/);
});

test('待評分：依序 y→c5→c10，到期才算；要不要刷新面板', () => {
  const have = new Set(['2026-10-05|y']);
  // s＝10-05 ⇒ t＝10-06；c5 到期＝t 之後第 4 個交易日＝10-13（10-09 補假）
  const pend = pendingScores({ frozenDays: ['2026-10-05', '2026-10-06'], hasScore: (d, s) => have.has(`${d}|${s}`), cal: CAL, today: '2026-10-13' });
  assert.deepEqual(pend, [{ day: '2026-10-05', stage: 'c5', due: '2026-10-13' }, { day: '2026-10-06', stage: 'y', due: '2026-10-08' }]);
  assert.deepEqual(pendingScores({ frozenDays: ['2026-10-05'], hasScore: (d, s) => have.has(`${d}|${s}`), cal: CAL, today: '2026-10-12' }), []);
  assert.deepEqual(pendingScores({ frozenDays: ['2026-10-06'], hasScore: () => false, cal: CAL, today: '2026-10-07' }), []);
  assert.equal(tracksNeedData({ produce: [], pending: pend, panelLast: '2026-10-13' }), false);
  assert.equal(tracksNeedData({ produce: [], pending: pend, panelLast: '2026-10-08' }), true);
  assert.equal(tracksNeedData({ produce: [], pending: pend, panelLast: null }), true);
  assert.equal(tracksNeedData({ produce: [{}], pending: [], panelLast: '2026-12-31' }), true);
  assert.deepEqual(SCORE_STAGES.map(x => x[0]), ['y', 'c5', 'c10']);
});

test('檔名規則不與 a35 的凍結檔撞名；手動跑的 a37 會擋下協調器', () => {
  assert.ok(TRACKS_CORE_RE.test('tracks_fwd_2026-10-05.json') && !TRACKS_CORE_RE.test('shadow_2026-10-05.json'));
  assert.ok(TRACKS_GAP_RE.test('tracks_fwd_gap_2026-10-05.json') && !TRACKS_CORE_RE.test('tracks_fwd_gap_2026-10-05.json'));
  assert.deepEqual('tracks_fwd_score_2026-10-05_c10.json'.match(TRACKS_SCORE_RE).slice(1), ['2026-10-05', 'c10']);
  assert.ok(!/^shadow_(\d{4}-\d{2}-\d{2})\.json$/.test('tracks_fwd_2026-10-05.json'));     // a35 FROZEN_RE 不會讀到
  assert.ok(FOREIGN_PATTERNS.some(re => re.test('/Library/.../python3 a37_tracks_fwd.py daily --plan x')));
});
