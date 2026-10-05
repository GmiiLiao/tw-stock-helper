// 盤中戰情 v2 異動流／族群／漲停順序流 單元測試：node --test scripts/lib/warroom-feeds.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normYmd, taipeiMsOf, fmtPctText, parseJsonField, buildThemeIndex, pickFactSentence, tidySubject, buildSectorRows, sectorChgOf,
  flowSummaryOf, sectorSummary, orderSectorRows, buildLimitFlow, surgeEvents, limitTouchEvents, consensusEvents,
  mopsEvents, mergeServerEvents, fillNames, mergeFeedGroups, pinMineFirst, FEED_EVENT_CAP,
  queueEvents, newsTimeTag,
} from './warroom-feeds.mjs';

// 2026-10-05（週一）台北 hh:mm:ss → epoch ms
const T = (h, m, s = 0) => Date.UTC(2026, 9, 5, h - 8, m, s);
const YMD = '2026-10-05';

const SEED = [
  { key: 'optical', name: '光通訊/矽光子', segs: [{ role: '族群', codes: ['4979', '3450', '3363', '3081'] }] },
  { key: 'pcb', name: 'PCB', segs: [{ role: '族群', codes: ['3037', '2368', '2367'] }] },
  { key: 'aiServer', name: 'AI伺服器鏈', segs: [{ role: '上游', codes: ['2330'] }, { role: '下游', codes: ['2368', '3017'] }] },
];

test('日期工具：YYYYMMDD 正規化、台北 hh:mm 轉 epoch、壞格式回 null', () => {
  assert.equal(normYmd('20261005'), YMD);
  assert.equal(normYmd(YMD), YMD);
  assert.equal(normYmd('2026/10/05'), null);
  assert.equal(taipeiMsOf(YMD, '10:41'), T(10, 41));
  assert.equal(taipeiMsOf(YMD, '9:03'), T(9, 3));
  assert.equal(taipeiMsOf(YMD, '25:00'), null);
  assert.equal(taipeiMsOf('bad', '10:00'), null);
  assert.equal(fmtPctText(1.8), '+1.80%');
  assert.equal(fmtPctText(-0.5), '−0.50%');
  assert.equal(fmtPctText(0), '0.00%');
  assert.equal(fmtPctText('x'), null);
  assert.deepEqual(parseJsonField('{"a":1}'), { a: 1 });
  assert.equal(parseJsonField('{壞掉'), null);
});

test('題材對照：custom 同 key 覆蓋 seed 並保留順序、新 key 接在後面；一檔可屬多題材', () => {
  const idx = buildThemeIndex(SEED, [
    { key: 'pcb', name: 'PCB載板', segs: [{ codes: ['3037', '8046', 'bad'] }] },
    { key: 'cpo', name: 'CPO', segs: [{ codes: ['3363'] }] },
    { key: '', segs: [] },
  ]);
  assert.deepEqual(idx.themes.map((t) => t.key), ['optical', 'pcb', 'aiServer', 'cpo']);
  assert.deepEqual(idx.themes[1], { key: 'pcb', name: 'PCB載板', codes: ['3037', '8046'] });
  assert.deepEqual(idx.byCode['3363'], ['optical', 'cpo']);
  assert.deepEqual(idx.byCode['2368'], ['aiServer']);   // seed 的 pcb 已被 custom 覆蓋，不再含 2368
});

test('AI 摘要只取第一句不含指令字樣的事實句；全是指令句就回 null', () => {
  assert.equal(pickFactSentence('資金集中散熱與光通訊，航運偏弱。操作上勿追高弱勢股。'), '資金集中散熱與光通訊，航運偏弱。');
  assert.equal(pickFactSentence('建議留意追價風險。今日為結構行情，資金集中 PCB。'), '今日為結構行情，資金集中 PCB。');
  assert.equal(pickFactSentence('宜謹慎。勿追高。'), null);
  // 2026-10-05 實際敘事：一句話裡事實子句在前、指令子句在後 ⇒ 只留事實子句
  assert.equal(pickFactSentence('資金集中於權值結構性行情，操作上建議關注結構性強勢族群，避免追逐弱勢股。'), '資金集中於權值結構性行情。');
  assert.equal(pickFactSentence('偏多，建議追高。'), null);   // 事實子句太短（<6 字）不硬湊
  assert.equal(pickFactSentence(''), null);
  assert.equal(pickFactSentence(null), null);
  const long = '資金'.repeat(60);
  assert.equal(pickFactSentence(long).length, 80);
});

test('族群列：觸及漲停家數用題材成分股 ∩ 今日漲停流；對照缺時退回 leaders；flow 資料日不符給 null', () => {
  const idx = buildThemeIndex(SEED, null);
  const wind = { themes: [
    { key: 'optical', name: '光通訊/矽光子', wChg: 4.95, medChg: 3.1, leaders: [{ code: '4979' }] },
    { key: 'unknown', name: '新題材', medChg: -0.4, leaders: [{ code: '1101' }, { code: 'x' }] },
    { name: '缺 key' },
  ] };
  const rows = buildSectorRows(wind, idx, new Set(['4979', '3363', '1101']));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].touched, 2);
  assert.deepEqual(rows[1].codes, ['1101']);
  assert.equal(rows[1].touched, 1);
  assert.equal(sectorChgOf(rows[0]), 4.95);
  assert.equal(sectorChgOf(rows[1]), -0.4);   // 沒有 wChg 退回中位數
  assert.equal(buildSectorRows(wind, idx, null)[0].touched, null);
});

test('族群摘要：有合格 AI 句用 AI（附產出時間），否則用確定性的流入／流出前列', () => {
  const rows = [
    { name: 'A', wChg: 3, medChg: null, codes: [] }, { name: 'B', wChg: 1, medChg: null, codes: [] },
    { name: 'C', wChg: 2, medChg: null, codes: [] }, { name: 'D', wChg: -1, medChg: null, codes: [] },
  ];
  assert.equal(flowSummaryOf(rows), '資金流入前列：A、C；流出前列：D');
  assert.deepEqual(sectorSummary({ narrative: { text: '勿追。資金集中 A。', at: T(10, 30) } }, rows), { text: '資金集中 A。', asOf: T(10, 30), ai: true });
  assert.deepEqual(sectorSummary({ narrative: { text: '勿追高。', at: T(10, 30) } }, rows), { text: '資金流入前列：A、C；流出前列：D', asOf: null, ai: false });
  assert.equal(sectorSummary(null, []), null);
});

test('族群排序：持股族群置頂；名額不足時保留最弱 2 列（流出也看得到）', () => {
  const mk = (name, wChg, codes = []) => ({ key: name, name, wChg, medChg: null, valueShare: null, strong: null, members: null, touched: null, codes });
  const rows = [mk('a', 5), mk('b', 4), mk('c', 3), mk('d', 2), mk('e', 1), mk('f', -1), mk('g', -2), mk('h', -3), mk('mine', -0.5, ['2317'])];
  const out = orderSectorRows(rows, new Set(['2317']), 6);
  assert.deepEqual(out.map((r) => r.name), ['mine', 'a', 'b', 'c', 'g', 'h']);
  assert.equal(out[0].mine, true);
  assert.equal(out[1].mine, false);
  assert.deepEqual(orderSectorRows(rows.slice(0, 3), [], 8).map((r) => r.name), ['a', 'b', 'c']);
  assert.equal(orderSectorRows(rows, new Set(['2317']), null).length, 9);
});

test('漲停順序流：依時間排序、主題材依風向分數挑、第 3 家族群成形、近 5 日板數不冒充連板', () => {
  const idx = buildThemeIndex(SEED, null);
  const lu = {
    flowDate: YMD,
    flow: [
      { code: '4979', name: '華星光', time: '10:41', ind: '光電業' },
      { code: '3363', name: '上詮', time: '10:27', ind: '光電業' },
      { code: '3081', name: '聯亞', time: '10:12', ind: '半導體業' },
      { code: '2368', name: '金像電', time: '09:58', ind: '電子零組件業' },
      { code: '6187', name: '萬潤', time: '09:15', ind: '其他電子業' },
      { code: '6187', name: '重複', time: '09:20' },
      { code: 'x', time: '09:00' },
    ],
    bList: [{ code: '4979', luCnt5: 1 }, { code: '3363', luCnt5: 2 }],
  };
  const flow = buildLimitFlow(lu, idx, ['pcb', 'aiServer', 'optical']);
  assert.equal(flow.total, 5);
  assert.deepEqual(flow.rows.map((r) => r.code), ['6187', '2368', '3081', '3363', '4979']);
  assert.equal(flow.rows[0].at, T(9, 15));
  const by = Object.fromEntries(flow.rows.map((r) => [r.code, r]));
  assert.equal(by['6187'].groupKind, 'industry');
  assert.equal(by['6187'].group, '其他電子業');
  assert.equal(by['6187'].groupRank, null);
  assert.equal(by['2368'].group, 'PCB');   // 2368 同屬 pcb 與 aiServer ⇒ 依風向分數順序（pcb 在前）挑主題材
  assert.equal(buildLimitFlow(lu, idx, ['aiServer', 'pcb']).rows.find((r) => r.code === '2368').group, 'AI伺服器鏈');
  assert.equal(by['3081'].groupRank, 1);
  assert.equal(by['3363'].groupRank, 2);
  assert.equal(by['4979'].groupRank, 3);
  assert.equal(by['4979'].formed, true);
  assert.equal(by['3081'].formed, false);
  assert.equal(by['3081'].inFormedGroup, true);
  assert.equal(by['2368'].inFormedGroup, false);
  assert.equal(by['4979'].boards, '首板');
  assert.equal(by['3363'].boards, '5日2板');
  assert.equal(by['3081'].boards, null);
  assert.deepEqual(buildLimitFlow(null, idx, null), { flowDate: null, rows: [], total: 0 });
});

test('首觸漲停事件：只收今日漲停流；文字寫第幾家與題材第幾家（族群成形另標）', () => {
  const idx = buildThemeIndex(SEED, null);
  const flow = buildLimitFlow({ flowDate: YMD, flow: [
    { code: '3081', name: '聯亞', time: '10:12' }, { code: '3363', name: '上詮', time: '10:27' },
    { code: '4979', name: '華星光', time: '10:41' }, { code: '6187', name: '萬潤', time: '09:15', ind: '其他電子業' },
  ] }, idx, null);
  const ev = limitTouchEvents(flow, YMD);
  const e = ev.find((x) => x.code === '4979');
  assert.equal(e.id, `s:limitTouch:4979:${T(10, 41)}`);
  assert.equal(e.text, '第 4 家·光通訊/矽光子 第 3 家·族群成形');
  assert.equal(ev.find((x) => x.code === '6187').text, '第 1 家·其他電子業');
  assert.equal(e.side, 'long');
  assert.deepEqual(limitTouchEvents(flow, '2026-10-06'), []);
});

test('爆量事件：只收今日文件、本輪前 N 檔＋歸檔最大，方向依 dir、id 穩定可去重', () => {
  const latest = { date: YMD, updatedAt: T(10, 40, 5), items: [
    { code: '3037', name: '欣興', chg: 1.8, surgeLots: 1245, rateX: 6.2, dir: 'up' },
    { code: '6446', name: '藥華藥', chg: -3.1, surgeLots: 800, rateX: 4.8, dir: 'down' },
    { code: '2330', name: '台積電', chg: 0.5, surgeLots: 600, rateX: 0, dir: 'up' },
  ] };
  const archive = { date: YMD, itemsJson: JSON.stringify({
    3037: { code: '3037', name: '欣興', chg: 1.8, surgeLots: 1245, rateX: 6.2, dir: 'up', at: T(10, 40, 5) },
    2603: { code: '2603', name: '長榮', chg: -1.2, surgeLots: 3000, rateX: 3, dir: 'down', at: T(9, 31) },
  }) };
  const ev = surgeEvents(latest, archive, YMD, { perCycle: 2 });
  assert.equal(ev.length, 4);
  assert.equal(ev[0].kind, 'surgeUp');
  assert.equal(ev[0].text, '量增 1,245 張·每分量 ×6.2·+1.80%');
  assert.equal(ev[1].kind, 'surgeDown');
  assert.equal(ev[1].side, 'short');
  const merged = mergeServerEvents([ev]);
  assert.equal(merged.length, 3);   // 3037 本輪與歸檔同一刻 ⇒ 同 id 去重
  assert.equal(surgeEvents({ ...latest, date: '2026-10-02' }, null, YMD).length, 0);
  assert.equal(surgeEvents(latest, null, YMD)[2].text, '量增 600 張·+0.50%');   // 沒有均量（rateX 0）就不寫倍數
});

test('雷達新進共識：上榜 ≤3 分鐘且出現在 ≥2 個策略榜；事件時間＝首次上榜', () => {
  const up = T(10, 40);
  const radar = { date: YMD, updatedAt: up, strategies: { ignite: { name: '起漲偵測' }, volSurge: { name: '爆量長紅' } }, groups: {
    ignite: [{ code: '3037', name: '欣興', firstSeen: up - 2 * 60_000 }, { code: '2368', name: '金像電', firstSeen: up - 10 * 60_000 }, { code: '1101', name: '台泥', firstSeen: up - 60_000 }],
    volSurge: [{ code: '3037', name: '欣興', firstSeen: up - 2 * 60_000 }, { code: '2368', name: '金像電', firstSeen: up - 10 * 60_000 }],
  } };
  const ev = consensusEvents(radar, YMD);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].code, '3037');
  assert.equal(ev[0].at, up - 2 * 60_000);
  assert.equal(ev[0].text, '新進 ★（起漲偵測＋爆量長紅）');
  assert.deepEqual(consensusEvents({ ...radar, date: '2026-10-02' }, YMD), []);
});

test('搶漲停排隊：只在 daemon 自報的提醒窗內且為今日文件；依委買張數取前 N；id 每檔當日固定；文案寫尚未成交上去', () => {
  const doc = {
    updatedAt: T(9, 11, 30), date: YMD, inWindow: true, windowEnd: '09:15', n: 3,
    items: [
      { code: '8046', name: '南電', queueLots: 1940, limitPrice: 300 },
      { code: '6187', name: '萬潤', queueLots: 2860, limitPrice: 500 },
      { code: 'X1', name: '壞代號', queueLots: 9999 },
      { code: '5274', name: '信驊', queueLots: 0 },
    ],
  };
  const ev = queueEvents(doc, YMD, { cap: 2 });
  assert.deepEqual(ev.map((e) => e.code), ['6187', '8046']);
  assert.equal(ev[0].id, `s:queue:6187:${YMD}`);
  assert.equal(ev[0].at, T(9, 11, 30));
  assert.equal(ev[0].kind, 'queue');
  assert.equal(ev[0].side, 'long');
  assert.equal(ev[0].text, '漲停排隊 2,860 張·尚未成交上去（至 09:15）');
  // 下一輪 updatedAt 變了，id 不變（前端以 id 去重＝每檔當日一則）
  assert.equal(queueEvents({ ...doc, updatedAt: T(9, 12) }, YMD)[0].id, ev[0].id);
  // 張數缺：不捏造張數
  assert.equal(queueEvents(doc, YMD, { cap: 4 }).find((e) => e.code === '5274').text, '漲停排隊·尚未成交上去（至 09:15）');
  // 提醒窗外、非今日、壞文件 ⇒ 不產生
  assert.deepEqual(queueEvents({ ...doc, inWindow: false }, YMD), []);
  assert.deepEqual(queueEvents({ ...doc, date: '2026-10-02' }, YMD), []);
  assert.deepEqual(queueEvents(null, YMD), []);
});

test('新聞判別時間標記：前一日標日期、今天 09:00 前標盤前、盤中不標', () => {
  const now = T(10, 42);
  assert.equal(newsTimeTag(T(10, 0) - 14 * 3_600_000, now), '（10/04）');
  assert.equal(newsTimeTag(T(8, 31), now), '（盤前）');
  assert.equal(newsTimeTag(T(10, 25), now), '');
  assert.equal(newsTimeTag(Number.NaN, now), '');
});

test('新聞判別事件改由 warroom-news 產生：這裡只轉出同一支時間標記（不再有 newsEvents）', async () => {
  const feeds = await import('./warroom-feeds.mjs');
  const news = await import('./warroom-news.mjs');
  assert.equal(feeds.newsTimeTag, news.newsTimeTag);
  assert.equal(feeds.newsEvents, undefined);
  assert.equal(feeds.NEWS_MAX_AGE_MS, undefined);
});

test('公告標題：中文字之間的換行空白拿掉、英數之間保留', () => {
  assert.equal(tidySubject('因本公司有價證券於集中交易市場達公 布注意交易資訊標 準，故公布'), '因本公司有價證券於集中交易市場達公布注意交易資訊標準，故公布');
  assert.equal(tidySubject('公告 115年 9 月 營收'), '公告 115年 9 月營收');
  assert.equal(tidySubject(null), '');
});

test('重訊：只收今日索引；事件只列今日有動靜的代號，index 給每檔最新一則（截短）', () => {
  const doc = { date: YMD, items: [
    { code: '2382', name: '廣達', subject: '公告本公司 9 月營收', at: T(10, 33, 48) },
    { code: '2382', name: '廣達', subject: '舊的一則', at: T(8, 0) },
    { code: '1101', name: '台泥', subject: '董事會決議發放現金股利每股一元整整整整', at: T(10, 0) },
  ] };
  const { events, index } = mopsEvents(doc, YMD, new Set(['2382']), { subjectMax: 6 });
  assert.equal(events.length, 2);   // 同檔兩則公告都是事件（台泥不在今日動靜名單 ⇒ 不列）
  assert.equal(events[0].at, T(10, 33, 48));
  assert.equal(events[0].source, 'O');
  assert.equal(events[0].text, '公告本公司 9 月營收');
  assert.deepEqual(index['2382'], [T(10, 33, 48), '公告本公司 …']);
  assert.equal(index['1101'][1], '董事會決議發…');
  assert.deepEqual(mopsEvents({ ...doc, date: '2026-10-02' }, YMD, ['2382']), { events: [], index: {} });
});

test('合併：同 id 去重、新到舊、最多 40 則；名稱補齊', () => {
  const mk = (i) => ({ id: `s:mops:1101:${i}`, at: i, kind: 'mops', code: '1101', name: '1101', text: 't' });
  const many = Array.from({ length: 60 }, (_, i) => mk(i));
  const out = mergeServerEvents([many, [mk(59)]]);
  assert.equal(out.length, FEED_EVENT_CAP);
  assert.equal(out[0].at, 59);
  assert.equal(fillNames(out.slice(0, 1), new Map([['1101', '台泥']]))[0].name, '台泥');
});

test('同檔同類 10 分鐘合併：只併同代號同種類、相距最新一則 ≤10 分；沒有代號的不併', () => {
  const ev = [
    { id: 'a', at: T(10, 22), kind: 'surgeDown', code: '6446' },
    { id: 'b', at: T(10, 20), kind: 'surgeUp', code: '3037' },
    { id: 'c', at: T(10, 15), kind: 'surgeDown', code: '6446' },
    { id: 'd', at: T(10, 11), kind: 'surgeDown', code: '6446' },
    { id: 'e', at: T(10, 10), kind: 'info' },
    { id: 'f', at: T(10, 9), kind: 'info' },
  ];
  const g = mergeFeedGroups(ev);
  assert.deepEqual(g.map((x) => [x.head.id, x.count]), [['a', 2], ['b', 1], ['d', 1], ['e', 1], ['f', 1]]);
});

test('我的警示置頂：最近 15 分鐘內最多 3 則，其餘照時間', () => {
  const now = T(10, 42);
  const groups = [
    { head: { id: '1', at: T(10, 41), kind: 'surgeUp' }, count: 1 },
    { head: { id: '2', at: T(10, 40), kind: 'stopLoss', mine: true }, count: 1 },
    { head: { id: '3', at: T(10, 10), kind: 'stopLoss', mine: true }, count: 1 },
  ];
  assert.deepEqual(pinMineFirst(groups, now).map((g) => g.head.id), ['2', '1', '3']);
});
