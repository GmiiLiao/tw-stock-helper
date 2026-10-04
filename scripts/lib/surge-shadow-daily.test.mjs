// node --test scripts/lib/surge-shadow-daily.test.mjs
// 起漲影子每日流程的決策邏輯：下一交易日（補假）、期限／缺口、對答案、除權息補抓、研究程序偵測、鎖。
// 休市日案例與 scripts/surge-lab/a35_shadow_test.py 的 test_next_trading_day_* 同一組（兩種語言實作同一條規則）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  envLeak, makeCalendar, nextTradingDay, isTradingDay, tradingDaysBetween, taipeiNow, planDays, scorePlan, exrightPlan,
  exrightRank, parsePs, foreignResearchProcs, lockVerdict, mergeMissed, rocToIso,
} from './surge-shadow-daily.mjs';
import { basisOf } from '../surge-lab/a35_shadow_meta.mjs';

// 官方休市表原文（openapi holidaySchedule 2026 年節錄；含「交易日標記」與「結算交割日」陷阱）
const MIRROR_ROWS = [
  { Name: '中華民國開國紀念日', Date: '1150101' },
  { Name: '國曆新年開始交易日', Date: '1150102' },
  { Name: '農曆春節前最後交易日', Date: '1150211' },
  { Name: '市場無交易，僅辦理結算交割作業', Date: '1150212' },
  { Name: '國慶日', Date: '1151009' },
  { Name: '國慶日', Date: '1151010' },
  { Name: '臺灣光復暨金門古寧頭大捷紀念日', Date: '1151025' },
  { Name: '臺灣光復暨金門古寧頭大捷紀念日', Date: '1151026' },
  { Name: '行憲紀念日', Date: '1151225' },
];
const FS_DOC = { holidays: ['2026-01-01', '2026-02-12', '2026-10-09', '2026-10-26', '2026-12-25'], coverYear: 2026, official: ['2026-01-01'] };
const CAL = makeCalendar(null, MIRROR_ROWS);

test('民國日期轉換與交易日標記分類', () => {
  assert.equal(rocToIso('1151009'), '2026-10-09');
  assert.equal(rocToIso('115109'), null);
  assert.ok(CAL.holidays.has('2026-02-12'), '「市場無交易，僅辦理結算交割作業」是休市');
  assert.ok(!CAL.holidays.has('2026-01-02') && !CAL.holidays.has('2026-02-11'), '開始／最後交易日是交易日標記');
  assert.deepEqual([...CAL.covered], [2026]);
});

test('下一交易日：跳過週末與補假（10-09、10-26），不猜下一個平日', () => {
  for (const cal of [CAL, makeCalendar(FS_DOC, null), makeCalendar(FS_DOC, MIRROR_ROWS)]) {
    assert.equal(nextTradingDay('2026-10-02', cal), '2026-10-05');
    assert.equal(nextTradingDay('2026-10-08', cal), '2026-10-12');
    assert.equal(nextTradingDay('2026-10-23', cal), '2026-10-27');
    assert.equal(nextTradingDay('2026-12-24', cal), '2026-12-28');
  }
  assert.equal(nextTradingDay('2025-12-31', CAL), '2026-01-02');            // 01-01 休市、01-02 是「開始交易日」
  assert.throws(() => nextTradingDay('2026-12-31', CAL), /未涵蓋 2027/);     // 日曆沒有 2027 ⇒ 不猜
  assert.throws(() => nextTradingDay('2026-10-02', null), /沒有休市日曆/);
  assert.equal(makeCalendar(null, null), null);
  assert.equal(makeCalendar({ holidays: [] }, []), null);
});

test('交易日區間與台北時間', () => {
  assert.deepEqual(tradingDaysBetween('2026-10-02', '2026-10-13', CAL), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-12', '2026-10-13']);
  assert.ok(!isTradingDay('2026-10-09', CAL) && !isTradingDay('2026-10-10', CAL) && isTradingDay('2026-10-12', CAL));
  assert.equal(taipeiNow(Date.UTC(2026, 9, 4, 13, 0)), '2026-10-04T21:00');
  assert.equal(taipeiNow(Date.UTC(2026, 9, 4, 16, 30)), '2026-10-05T00:30');
});

const has = set => d => set.has(d);
test('planDays：週日已有 10-02 名單 ⇒ 什麼都不做', () => {
  const p = planDays({ days: [{ date: '2026-10-02', ready: true, canonical: true }], cal: CAL, nowTw: '2026-10-04T21:00', hasList: has(new Set(['2026-10-02'])) });
  assert.deepEqual(p.done, ['2026-10-02']);
  assert.equal(p.produce.length + p.missed.length + p.waiting.length, 0);
});

test('planDays：到齊且 pred 定版 ⇒ 產生；未到齊 ⇒ 等待；過期限 ⇒ 缺口（只記一次）', () => {
  const base = { cal: CAL, hasList: has(new Set(['2026-10-02'])) };
  const ready = { date: '2026-10-05', ready: true, missing: [], canonical: true };
  let p = planDays({ ...base, days: [{ date: '2026-10-02', ready: true, canonical: true }, ready], nowTw: '2026-10-05T17:30' });
  assert.deepEqual(p.produce, [{ date: '2026-10-05', nextTD: '2026-10-06', deadline: '2026-10-06T08:45' }]);
  p = planDays({ ...base, days: [{ ...ready, ready: false, missing: ['上櫃收盤'] }], nowTw: '2026-10-05T17:30' });
  assert.equal(p.waiting.length, 1); assert.match(p.waiting[0].why, /上櫃收盤/);
  p = planDays({ ...base, days: [{ ...ready, canonical: false }], nowTw: '2026-10-05T19:30' });
  assert.match(p.waiting[0].why, /pred/);
  p = planDays({ ...base, days: [{ ...ready, ready: false, missing: ['上櫃收盤'] }], nowTw: '2026-10-06T08:45' });
  assert.equal(p.missed.length, 1); assert.equal(p.missed[0].targetDay, '2026-10-06'); assert.match(p.missed[0].reason, /上櫃收盤/);
  p = planDays({ ...base, days: [ready], nowTw: '2026-10-06T08:44' });
  assert.equal(p.produce.length, 1, '08:44 仍在期限內');
  p = planDays({ ...base, days: [ready], nowTw: '2026-10-06T09:30', missedBefore: new Set(['2026-10-05']) });
  assert.equal(p.missed.length, 0, '已記過的缺口不重記');
});

test('planDays：週四名單的期限在補假後的週一 08:45（不是週五）', () => {
  const day = { date: '2026-10-08', ready: true, missing: [], canonical: true };
  for (const nowTw of ['2026-10-08T21:00', '2026-10-09T10:00', '2026-10-12T08:44']) {
    const p = planDays({ days: [day], cal: CAL, nowTw, hasList: () => false });
    assert.deepEqual(p.produce, [{ date: '2026-10-08', nextTD: '2026-10-12', deadline: '2026-10-12T08:45' }], nowTw);
  }
  const late = planDays({ days: [day], cal: CAL, nowTw: '2026-10-12T08:45', hasList: () => false });
  assert.equal(late.missed[0].reason, '期限前未產生（協調器未執行或失敗）');
});

test('planDays：PIPELINE_START 之前不算、日曆不涵蓋就列錯誤', () => {
  const p = planDays({ days: [{ date: '2026-10-01', ready: true, canonical: true }, { date: '2026-12-31', ready: true, canonical: true }], cal: CAL, nowTw: '2026-12-31T18:00', hasList: () => false });
  assert.equal(p.produce.length, 0);
  assert.equal(p.errors.length, 1); assert.match(p.errors[0].error, /2027/);
});

test('scorePlan：沒對過或封印不同、且目標日收盤到齊才對答案', () => {
  const forward = [{ scoringDay: '2026-10-02', targetDay: '2026-10-05', sha256: 'a' }, { scoringDay: '2026-10-05', targetDay: '2026-10-06', sha256: 'c' }];
  assert.deepEqual(scorePlan({ forward, scoreSha: new Map(), closeReady: new Set(['2026-10-05']) }), [{ scoringDay: '2026-10-02', targetDay: '2026-10-05' }]);
  assert.deepEqual(scorePlan({ forward, scoreSha: new Map([['2026-10-02', 'a']]), closeReady: new Set(['2026-10-05']) }), []);
  assert.equal(scorePlan({ forward, scoreSha: new Map([['2026-10-02', 'b']]), closeReady: new Set(['2026-10-05', '2026-10-06']) }).length, 2);
  assert.deepEqual(scorePlan({ forward, scoreSha: new Map(), closeReady: new Set() }), []);
});

test('exrightPlan：缺檔先抓、不完整的近期日子重試、每輪上限', () => {
  assert.equal(exrightRank(null), -1); assert.equal(exrightRank({ items: [] }), 2);
  assert.equal(exrightRank({ error: 'x', twseOnly: true }), 1); assert.equal(exrightRank({ error: 'x' }), 0);
  const tradingDays = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05'];
  const files = new Map([['2026-10-01', { items: [] }], ['2026-10-02', { error: 'tpex', twseOnly: true }]]);
  assert.deepEqual(exrightPlan({ tradingDays, historyTo: '2026-09-30', files, upto: '2026-10-05', retryFrom: '2026-10-01' }), ['2026-10-05', '2026-10-02']);
  assert.deepEqual(exrightPlan({ tradingDays, historyTo: '2026-09-30', files, upto: '2026-10-05', retryFrom: '2026-10-05' }), ['2026-10-05']);
  assert.deepEqual(exrightPlan({ tradingDays, historyTo: '2026-09-30', files, upto: '2026-10-05', retryFrom: '2026-10-01', cap: 1 }), ['2026-10-05']);
  assert.deepEqual(exrightPlan({ tradingDays, historyTo: '2026-09-30', files, upto: '2026-10-01', retryFrom: '2026-09-30' }), []);
});

test('研究程序偵測：排除自己的子孫與非執行程式', () => {
  const ps = [
    '  100     1 node scripts/surge-lab/a35_shadow_daily.mjs',
    '  101   100 /Library/Frameworks/Python.framework/Versions/3.14/bin/python3 panel.py',
    '  102   101 python3 -c from multiprocessing',
    '  200     1 python3 cv_official.py --task lu1L',
    '  201     1 grep panel.py',
    '  202     1 /usr/bin/vim panel.py',
    '  203     1 /opt/homebrew/bin/node scripts/surge-lab/fetch_cache.mjs',
    '  204     1 node scripts/ai-daemon.mjs',
    '  205     1 bash retrain_official.sh',
  ].join('\n');
  const rows = parsePs(ps);
  assert.equal(rows.length, 9);
  assert.deepEqual(foreignResearchProcs(rows, 100).map(r => r.pid), [200, 203, 205]);
});

test('研究用環境變數、鎖、缺口合併', () => {
  assert.deepEqual(envLeak({ PATH: '/bin', SURGE_REVENUE: '' }), ['SURGE_REVENUE']);
  assert.deepEqual(envLeak({ PATH: '/bin', SURGE_CACHE: '/x' }), []);
  assert.equal(lockVerdict({ pid: 5 }, () => true), 'busy');
  assert.equal(lockVerdict({ pid: 5 }, () => false), 'stale');
  assert.equal(lockVerdict(null, () => true), 'stale');
  const m = mergeMissed([{ scoringDay: '2026-10-06', reason: 'a' }], [{ scoringDay: '2026-10-06', reason: 'b' }, { scoringDay: '2026-10-05', reason: 'c' }]);
  assert.deepEqual(m.map(x => [x.scoringDay, x.reason]), [['2026-10-05', 'c'], ['2026-10-06', 'a']]);
});

test('凍結檔 dataBasis：與定版閘門同一支判斷，並標出上櫃收盤的第三方補洞', () => {
  const close = Object.fromEntries(['2330', '2317', '2454', '2882', '6274', '8069', '3260', '5347', '3105'].map(c => [c, [10, 1, 10, 10, 10]]));
  const inst = { 2330: [1, 1], 6274: [1, 1] };
  const doc = { date: '2026-10-02', closeJson: JSON.stringify(close), instJson: JSON.stringify(inst), otcPending: false };
  const b = basisOf('2026-10-02', doc);
  assert.equal(b.ready, true); assert.equal(b.basis, '兩市官方'); assert.equal(b.nonOfficialOtcClose, false); assert.equal(b.nClose, 9);
  const y = basisOf('2026-10-02', { ...doc, gapFixSource: 'yahoo-chart' });
  assert.equal(y.nonOfficialOtcClose, true); assert.match(y.basis, /第三方/);
  const p = basisOf('2026-10-02', { ...doc, otcPending: true });
  assert.equal(p.ready, false); assert.deepEqual(p.missing, ['上櫃收盤']);
  assert.deepEqual(basisOf('2026-10-05', undefined), { date: '2026-10-05', found: false, ready: false, missing: ['文件不存在'], basis: null });
});
