// node --test scripts/lib/surge-shadow-daily.test.mjs
// 起漲影子每日流程的決策邏輯：下一交易日（補假）、期限／缺口、對答案、除權息補抓、研究程序偵測、鎖。
// 休市日案例與 scripts/surge-lab/a35_shadow_test.py 的 test_next_trading_day_* 同一組（兩種語言實作同一條規則）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  envLeak, makeCalendar, nextTradingDay, isTradingDay, tradingDaysBetween, taipeiNow, planDays, scorePlan, exrightPlan,
  exrightRank, parsePs, foreignResearchProcs, lockVerdict, mergeMissed, rocToIso, modelInputsStatus, pruneNonTrading, effectiveTarget,
  mergePriceEvents,
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
  const ready = { date: '2026-10-05', found: true, ready: true, missing: [], canonical: true, inputsReady: true, inputsMissing: [] };
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
  const day = { date: '2026-10-08', found: true, ready: true, missing: [], canonical: true, inputsReady: true };
  for (const nowTw of ['2026-10-08T21:00', '2026-10-09T10:00', '2026-10-12T08:44']) {
    const p = planDays({ days: [day], cal: CAL, nowTw, hasList: () => false });
    assert.deepEqual(p.produce, [{ date: '2026-10-08', nextTD: '2026-10-12', deadline: '2026-10-12T08:45' }], nowTw);
  }
  const late = planDays({ days: [day], cal: CAL, nowTw: '2026-10-12T08:45', hasList: () => false });
  assert.equal(late.missed[0].reason, '期限前未產生（協調器未執行或失敗）');
});

test('planDays：PIPELINE_START 之前不算、日曆不涵蓋就列錯誤', () => {
  const p = planDays({ days: [{ date: '2026-10-01', ready: true, canonical: true, inputsReady: true }, { date: '2026-12-31', ready: true, canonical: true, inputsReady: true }], cal: CAL, nowTw: '2026-12-31T18:00', hasList: () => false });
  assert.equal(p.produce.length, 0);
  assert.equal(p.errors.length, 1); assert.match(p.errors[0].error, /2027/);
});

test('scorePlan：沒對過或封印不同、且目標日收盤到齊才對答案', () => {
  const forward = [{ scoringDay: '2026-10-02', targetDay: '2026-10-05', sha256: 'a' }, { scoringDay: '2026-10-05', targetDay: '2026-10-06', sha256: 'c' }];
  assert.deepEqual(scorePlan({ forward, scoreSha: new Map(), closeReady: new Set(['2026-10-05']) }), [{ scoringDay: '2026-10-02', targetDay: '2026-10-05', sealedTargetDay: '2026-10-05' }]);
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
  assert.deepEqual(basisOf('2026-10-05', undefined), { date: '2026-10-05', found: false, ready: false, missing: ['文件不存在'], basis: null, inputsReady: false, inputsMissing: ['文件不存在'], inputCounts: null });
  assert.equal(b.inputsReady, false, '只有收盤＋法人＝模型輸入未到齊');
  assert.deepEqual(b.inputsMissing, ['上市資券', '上櫃資券', '上市借券', '上櫃借券', '上市當沖']);
});

// 17:30 那一輪的典型歸檔：收盤＋法人已到，資券／借券／當沖 19:45～21:49 才進來
const FULL_INPUTS = {
  marginJson: JSON.stringify(Object.fromEntries(['2330', '2317', '6274', '8069'].map(c => [c, [100, 5]]))),
  lendingJson: JSON.stringify({ 2330: 12, 2317: 0, 6274: 0, 5483: 3 }),
  dayTradeJson: JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(1101 + i), 1]))),
};
test('模型輸入閘：資券／借券兩市＋上市當沖都到才算到齊（與 daemon 寫入端同一組樣本）', () => {
  assert.deepEqual(modelInputsStatus(FULL_INPUTS), { ready: true, missing: [], counts: { margin: 4, lending: 4, dayTrade: 101 } });
  assert.deepEqual(modelInputsStatus({ ...FULL_INPUTS, marginJson: JSON.stringify({ 2330: [1, 1] }) }).missing, ['上櫃資券']);
  assert.deepEqual(modelInputsStatus({ ...FULL_INPUTS, lendingJson: JSON.stringify({ 6274: 1, 8069: 2 }) }).missing, ['上市借券'],
    '2026-08-12／09-17 實況：借券只有上櫃那半');
  assert.equal(modelInputsStatus({ ...FULL_INPUTS, lendingJson: JSON.stringify({ 2330: 0, 6274: 0 }) }).ready, true, '借券餘額 0 也算有資料');
  assert.deepEqual(modelInputsStatus({ ...FULL_INPUTS, dayTradeJson: JSON.stringify({ 2330: 5 }) }).missing, ['上市當沖']);
  assert.deepEqual(modelInputsStatus({ ...FULL_INPUTS, marginJson: '{壞掉' }).missing, ['上市資券', '上櫃資券']);
  assert.equal(modelInputsStatus(null).missing.length, 5);
});

test('planDays：收盤＋法人到齊、pred 定版但資券／借券／當沖未到 ⇒ 17:30 等待、過期限記缺口', () => {
  const day = { date: '2026-10-05', found: true, ready: true, missing: [], canonical: true, inputsReady: false, inputsMissing: ['上市資券', '上櫃資券'] };
  let p = planDays({ days: [day], cal: CAL, nowTw: '2026-10-05T17:30', hasList: () => false });
  assert.equal(p.produce.length, 0); assert.match(p.waiting[0].why, /模型輸入未到齊：上市資券、上櫃資券/);
  p = planDays({ days: [{ ...day, inputsReady: true }], cal: CAL, nowTw: '2026-10-05T22:40', hasList: () => false });
  assert.equal(p.produce.length, 1);
  p = planDays({ days: [day], cal: CAL, nowTw: '2026-10-06T08:45', hasList: () => false });
  assert.match(p.missed[0].reason, /模型輸入未到齊（上市資券、上櫃資券）/);
  p = planDays({ days: [{ ...day, inputsReady: undefined }], cal: CAL, nowTw: '2026-10-05T22:40', hasList: () => false });
  assert.equal(p.produce.length, 0, '沒有判斷結果（undefined）不算到齊');
});

test('planDays：期限前被研究程序擋下的缺口註明原因', () => {
  const day = { date: '2026-10-05', found: true, ready: true, missing: [], canonical: true, inputsReady: true };
  const p = planDays({ days: [day], cal: CAL, nowTw: '2026-10-06T09:00', hasList: () => false, blocks: ['2026-10-05T12:00', '2026-10-05T22:40', '2026-10-06T07:05', '2026-10-06T08:50'] });
  assert.match(p.missed[0].reason, /研究程序占用共用快取（preflight 擋下 2 輪，最後 2026-10-06T07:05）/);
});

test('臨時休市（颱風假）：整天沒歸檔、之後有歸檔 ⇒ 疑似休市（不是缺口）；日曆補上後剔除；對答案改用現在的日曆', () => {
  // 10-06 颱風假（封印 10-05 名單時日曆還沒有它）
  const days = [
    { date: '2026-10-05', found: true, ready: true, canonical: true, inputsReady: true },
    { date: '2026-10-06', found: false, ready: false, missing: ['文件不存在'], canonical: false },
    { date: '2026-10-07', found: true, ready: true, canonical: true, inputsReady: true },
  ];
  const hasList = d => d === '2026-10-05';
  let p = planDays({ days: days.slice(0, 2), cal: CAL, nowTw: '2026-10-07T10:00', hasList });
  assert.equal(p.missed.length, 0); assert.match(p.waiting[0].why, /整天沒有歸檔/, '之後還沒有歸檔：先等');
  p = planDays({ days, cal: CAL, nowTw: '2026-10-08T09:00', hasList });
  assert.deepEqual(p.suspected.map(x => x.scoringDay), ['2026-10-06']); assert.equal(p.missed.map(x => x.scoringDay).join(), '2026-10-07');
  const cal2 = makeCalendar({ ...FS_DOC, holidays: [...FS_DOC.holidays, '2026-10-06'] }, MIRROR_ROWS);
  assert.deepEqual(pruneNonTrading([{ scoringDay: '2026-10-06' }, { scoringDay: '2026-10-07' }], cal2).map(x => x.scoringDay), ['2026-10-07']);
  const f = { scoringDay: '2026-10-05', targetDay: '2026-10-06', sha256: 'z' };
  assert.equal(effectiveTarget(f, CAL), '2026-10-06', '日曆還沒補上：照封印等');
  assert.equal(effectiveTarget(f, cal2), '2026-10-07', '日曆補上臨時休市：改等下一個交易日');
  assert.equal(effectiveTarget({ scoringDay: '2026-12-31', targetDay: '2027-01-04' }, CAL), '2027-01-04', '日曆算不出：退回封印');
  const sp = scorePlan({ forward: [f], scoreSha: new Map(), closeReady: new Set(['2026-10-07']), targetOf: x => effectiveTarget(x, cal2) });
  assert.deepEqual(sp, [{ scoringDay: '2026-10-05', targetDay: '2026-10-07', sealedTargetDay: '2026-10-06' }]);
  assert.deepEqual(scorePlan({ forward: [f], scoreSha: new Map(), closeReady: new Set(['2026-10-07']) }), [], '只看封印的 targetDay 會永遠等不到');
});

test('priceEvents 累積：視窗內以 daemon 為準、視窗前的舊事件保留、讀不到沿用舊檔', () => {
  const ev = (code, date, factor = 1.1) => ({ code, date, factor });
  const prev = { window: { from: '2026-05-20', to: '2026-10-02' }, items: [ev('1111', '2026-05-26'), ev('2222', '2026-08-01'), ev('3333', '2026-09-01')] };
  const cur = { window: { from: '2026-05-27', to: '2026-10-05' }, fetchedAt: 9, items: [ev('2222', '2026-08-01', 1.2), ev('4444', '2026-10-05')] };
  const m = mergePriceEvents(prev, cur);
  assert.deepEqual(m.doc.items.map(e => [e.code, e.factor]), [['1111', 1.1], ['2222', 1.2], ['4444', 1.1]], '05-26 滾出視窗仍保留；3333 在視窗內被 daemon 撤銷');
  assert.equal(m.kept, 1); assert.equal(m.dropped, 1); assert.equal(m.added, 1);
  assert.equal(m.doc.accumulated.from, '2026-05-20'); assert.equal(m.doc.fetchedAt, 9);
  const again = mergePriceEvents(m.doc, { ...cur, window: { from: '2026-06-02', to: '2026-10-06' } });
  assert.ok(again.doc.items.some(e => e.code === '1111'), '累積檔再合併仍保留');
  const stale = mergePriceEvents(prev, null);
  assert.equal(stale.staleIfError, true); assert.equal(stale.doc, prev);
  assert.deepEqual(mergePriceEvents(null, cur).doc.items.length, 2);
  const nowin = mergePriceEvents(prev, { items: [ev('3333', '2026-09-01', 2)] });
  assert.deepEqual(nowin.doc.items.map(e => [e.code, e.factor]), [['1111', 1.1], ['2222', 1.1], ['3333', 2]], '沒有視窗：聯集、同鍵新值覆蓋');
});

test('協調器參數：--cache 正式執行必須 --no-publish；演練輸出不可指到正式 out/；--now 只限 dry-run', () => {
  const script = fileURLToPath(new URL('../surge-lab/a35_shadow_daily.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH } });
  let r = run('--cache', '/nonexistent-cache');
  assert.equal(r.status, 1); assert.match(r.stderr, /--cache 正式執行只能搭配 --no-publish/);
  r = run('--cache', '/nonexistent-cache', '--no-publish', '--out', fileURLToPath(new URL('../surge-lab/out', import.meta.url)));
  assert.equal(r.status, 1); assert.match(r.stderr, /演練輸出不可指到正式 out/);
  r = run('--now', '2026-10-05T17:30');
  assert.equal(r.status, 1); assert.match(r.stderr, /--now 只能搭配 --dry-run/);
  r = run('--out', '/tmp/x');
  assert.equal(r.status, 1); assert.match(r.stderr, /--out 只能搭配 --dry-run 或演練/);
});

test('researchWaitUntil：只有 06:00～08:30 開跑的那輪（07:05）遇研究程序才等，等到當天 08:30；其他時段不等（2026-10-09）', async () => {
  const { researchWaitUntil, RESEARCH_WAIT } = await import('./surge-shadow-daily.mjs');
  assert.equal(researchWaitUntil('2026-10-10T07:05'), '2026-10-10T08:30');
  assert.equal(researchWaitUntil('2026-10-10T06:00'), '2026-10-10T08:30');
  assert.equal(researchWaitUntil('2026-10-10T08:29'), '2026-10-10T08:30');
  for (const t of ['2026-10-10T08:30', '2026-10-10T08:45', '2026-10-10T05:59', '2026-10-09T17:30', '2026-10-09T19:30', '2026-10-09T21:00', '2026-10-09T23:10', '2026-10-09T23:50']) assert.equal(researchWaitUntil(t), null, t);
  for (const bad of [null, undefined, '', '07:05', 'x']) assert.equal(researchWaitUntil(bad), null);
  assert.equal(RESEARCH_WAIT.pollMs, 120000);
});
