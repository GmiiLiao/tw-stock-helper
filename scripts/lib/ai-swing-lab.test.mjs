// AI 實驗·波段持有 單元測試：node --test scripts/lib/ai-swing-lab.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPool, parsePicks, horizonOutcome, poolBaseline, swingStats, SWING_COST_PCT } from './ai-swing-lab.mjs';
import { createAiSwingLab } from './ai-swing-runner.mjs';

// 130 個交易日：1111 每日 +1 元（開＝前收），2222 持平 50
const mkDays = (n = 130) => Array.from({ length: n }, (_, i) => ({
  date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
  m: { 1111: [100 + i, 1000, 99 + i, 100.5 + i, 98.5 + i], 2222: [50, 1000, 50, 50.5, 49.5] },
}));

test('horizonOutcome：D+1 開盤買、第 h 個交易日收盤賣、扣成本；未到期回 null', () => {
  const days = mkDays(); const D = days[10].date;
  const o = horizonOutcome(days, D, '1111', 5);
  assert.equal(o.entryDate, days[11].date);
  assert.equal(o.entryPx, 110);            // D+1 開盤＝99+11
  assert.equal(o.exitDate, days[15].date); // 進場日算第 1 天
  assert.equal(o.exitPx, 115);
  assert.equal(o.net, +((115 / 110 - 1) * 100 - SWING_COST_PCT).toFixed(2));
  assert.equal(horizonOutcome(days, days[125].date, '1111', 5), null, '尚未到期');
});

test('poolBaseline：整池等權', () => {
  const days = mkDays(); const b = poolBaseline(days, days[10].date, ['1111', '2222'], 5);
  assert.equal(b.n, 2);
  assert.ok(b.avg > 0);
});

test('parsePicks：池外代號剔除、去重、最多 5 檔；格式錯回 null', () => {
  const pool = new Set(['1111', '2222']);
  const p = parsePicks('```json\n{"picks":[{"code":"1111","confidence":80,"horizon":"20日","reason":"r","risk":"k"},{"code":"9999"},{"code":"1111"}],"note":"n"}\n```', pool);
  assert.equal(p.picks.length, 1);
  assert.equal(p.picks[0].horizon, 20);
  assert.equal(p.rejected, 2);
  assert.equal(parsePicks('我推薦 1111', pool), null);
});

test('buildPool：排除處置股、合併兩榜來源', () => {
  const pool = buildPool({ swingPicks: { items: [{ code: '1111', name: 'A', tier: 2, price: 10 }, { code: '3333', name: 'C', tier: 1 }] }, swingHold: { combo: { items: [{ code: '1111', name: 'A', rank: 3, boards: 2, gains: {} }, { code: '2221', name: '大甲', rank: 1 }] } }, disp: new Set(['2221', '3333']) });
  assert.deepEqual(pool.map(c => c.code), ['1111']);
  assert.equal(pool[0].sources.length, 2);
});

test('swingStats：選股 vs 整池超額——一律未扣成本；舊紀錄（只有 net／avg）加回當時扣掉的 0.4425', () => {
  const s = swingStats([{ outcomes: { 5: { picks: [{ net: 3 }, { net: -1 }], pool: { avg: 0.5 } } } }]);
  assert.equal(s[5].avg, 1.44); assert.equal(s[5].poolAvg, 0.94); assert.equal(s[5].excess, 0.5); assert.equal(s[20].n, 0);
  const n = swingStats([{ outcomes: { 5: { picks: [{ ret: 3, net: 2.56 }, { ret: -1, net: -1.44 }], pool: { avgRet: 0.5, avg: 0.06 } } } }]);
  assert.equal(n[5].avg, 1); assert.equal(n[5].poolAvg, 0.5); assert.equal(n[5].excess, 0.5); assert.equal(n[5].win, 50);
});

// 嚴格假物件（2026-09-28·WM-SCAN G3-09）：真 Firestore 拒收任何層級的 undefined
// （2026-09-24 daytradeAlerts 956 次寫入失敗的原因）。假物件不拒收＝測試綠、線上紅，所以這裡照真的丟錯。
function assertNoUndefined(v, path = '') {
  if (v === undefined) throw new Error(`Cannot use "undefined" as a Firestore value${path ? ` (found in field "${path}")` : ''}`);
  if (Array.isArray(v)) v.forEach((x, i) => assertNoUndefined(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) assertNoUndefined(v[k], path ? `${path}.${k}` : k);
}
function fakeDb(init = {}) {
  const store = { ...init };
  const ref = (c, id) => ({ id, async get() { return { exists: `${c}/${id}` in store, data: () => store[`${c}/${id}`] }; }, async set(v) { assertNoUndefined(v); store[`${c}/${id}`] = v; }, async update(v) {
    assertNoUndefined(v);
    const cur = { ...(store[`${c}/${id}`] || {}) };
    for (const k in v) { if (k.includes('.')) { const [a, b] = k.split('.'); cur[a] = { ...(cur[a] || {}), [b]: v[k] }; } else cur[k] = v[k]; }
    store[`${c}/${id}`] = cur;
  } });
  return { store, collection: c => ({ doc: id => ref(c, id), orderBy: () => ({ limit: () => ({ async get() { return { docs: Object.keys(store).filter(k => k.startsWith(c + '/')).sort().reverse().map(k => ({ ...ref(c, k.split('/')[1]), ref: ref(c, k.split('/')[1]), data: () => store[k] })) }; } }) }) }) };
}

test('執行器：兩榜資料日不同不選；同日才選、凍結一次、寫第二大腦；結算到期才寫且不重算', async () => {
  const days = mkDays(); const D = days[10].date;
  const db = fakeDb({ 'swingPicks/latest': { dataDate: D, mode: 'close', items: [{ code: '1111', name: 'A', tier: 3, price: 110 }] }, 'swingHold/latest': { dataDate: days[9].date, combo: { items: [] } } });
  const dir = mkdtempSync(join(tmpdir(), 'swing-'));
  let calls = 0;
  const lab = createAiSwingLab({ db, log: () => {}, dir, askOllama: async () => { calls++; return '{"picks":[{"code":"1111","confidence":70,"horizon":"5","reason":"起漲⭐⭐⭐","risk":"破底"}],"note":"ok"}'; },
    getModelInfo: async () => ({ name: 'gemma4:latest', digest: 'abc' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days });
  assert.equal(await lab.pick(), false, '資料日不同');
  db.store['swingHold/latest'] = { dataDate: D, combo: { items: [{ code: '2222', name: 'B', rank: 1, boards: 3, gains: {} }] } };
  assert.equal(await lab.pick(), true);
  const doc = db.store[`aiSwingLab/${D}`];
  assert.equal(doc.model.name, 'gemma4:latest');
  assert.equal(doc.picks[0].code, '1111');
  assert.equal(doc.picks[0].reason, '起漲⭐⭐⭐');
  assert.equal(doc.pool.length, 2);
  assert.ok(existsSync(join(dir, `${D}.md`)));
  await lab.pick(); assert.equal(calls, 1, '凍結後不再問');
  assert.ok(await lab.settle() >= 1);
  const o = db.store[`aiSwingLab/${D}`].outcomes;
  assert.ok(o[5] && o[60] && o[120] === undefined, '120 日未到期不寫');
  const at5 = o[5].settledAt;
  await lab.settle();
  assert.equal(db.store[`aiSwingLab/${D}`].outcomes[5].settledAt, at5, '已結算不重算');
  assert.ok(readdirSync(dir).some(f => f.endsWith('-結算.md')));
});

test('執行器：回覆無法解析會重試，第 3 次才以失敗凍結', async () => {
  const days = mkDays(); const D = days[10].date;
  const db = fakeDb({ 'swingPicks/latest': { dataDate: D, mode: 'close', items: [{ code: '1111', name: 'A', tier: 1 }] }, 'swingHold/latest': { dataDate: D, combo: { items: [] } } });
  const lab = createAiSwingLab({ db, log: () => {}, dir: mkdtempSync(join(tmpdir(), 'swing-')), askOllama: async () => '看不懂', getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days });
  assert.equal(await lab.pick(), false);
  assert.equal(await lab.pick(), false);
  assert.equal(await lab.pick(), true);
  assert.equal(db.store[`aiSwingLab/${D}`].picks.length, 0);
  assert.match(db.store[`aiSwingLab/${D}`].note, /無法解析/);
});

test('執行器：處置名單取不到（null）不選股、不凍結，稍後重試（WM-SCAN G2-07）', async () => {
  const days = mkDays(); const D = days[10].date;
  const db = fakeDb({ 'swingPicks/latest': { dataDate: D, mode: 'close', items: [{ code: '1111', name: 'A', tier: 1 }] }, 'swingHold/latest': { dataDate: D, combo: { items: [] } } });
  let calls = 0; let risk = null;
  const lab = createAiSwingLab({ db, log: () => {}, dir: mkdtempSync(join(tmpdir(), 'swing-')), askOllama: async () => { calls++; return '{"picks":[],"note":"ok"}'; }, getModelInfo: async () => ({ name: 'm' }), getRisk: async () => risk, getIndustry: async () => ({}), loadDays: async () => days });
  assert.equal(await lab.pick(), false);
  assert.equal(calls, 0, '名單缺席不問 Ollama');
  assert.equal(db.store[`aiSwingLab/${D}`], undefined, '不凍結');
  risk = { disp: new Set(), attention: new Set() };
  assert.equal(await lab.pick(), true);
  assert.equal(calls, 1);
});

test('波段交易單：09:00 開盤買、13:30 收盤賣、一般稅 0.3%、先選後買查核', async () => {
  const { swingLedger } = await import('./ai-swing-lab.mjs');
  const days = mkDays(); const D = days[10].date;
  const o = horizonOutcome(days, D, '1111', 5);
  const L = swingLedger(o, Date.parse(`${D}T20:00:00+08:00`));
  assert.equal(L.buy.at, Date.parse(`${days[11].date}T09:00:00+08:00`));
  assert.equal(L.sell.at, Date.parse(`${days[15].date}T13:30:00+08:00`));
  assert.equal(L.buy.amount, 110000); assert.equal(L.sell.amount, 115000);
  assert.equal(L.sell.tax, 345);
  assert.equal(L.pnlTwd, 115000 - 110000 - 156 - 163 - 345);
  assert.equal(L.noLookahead, true);
  assert.equal(swingLedger(o, Date.parse(`${days[12].date}T10:00:00+08:00`)).noLookahead, false, '買進後才決定＝作弊，必須標出');
});

test('波段帳戶：不設單檔上限、可用現金依當天選股數平均分配、貴股用零股、低於 1 萬不建倉；帳戶由記錄重算（獲利可再投入）', async () => {
  const { sizePicks, swingAccount } = await import('./ai-swing-lab.mjs');
  const ps = sizePicks([{ code: 'A', priceAtDecision: 50, horizon: 10 }, { code: 'B', priceAtDecision: 1500, horizon: null }, { code: 'C', priceAtDecision: 30 }], 150000);
  assert.equal(ps[0].position.shares, 998);             // 15 萬÷3 檔＝5 萬；1 張 5 萬＋手續費 71 超出預算 ⇒ 零股 998 股
  assert.equal(ps[1].position.shares, 33);              // 剩 10 萬÷2＝5 萬、1 張 150 萬 ⇒ 零股 33 股
  assert.equal(ps[1].position.exitH, 20);               // 未指定 ⇒ 20 日
  assert.equal(ps[2].position.shares, 1000);            // 剩 50,500 全給最後一檔／30 元 ⇒ 1 張
  const one = sizePicks([{ code: 'A', priceAtDecision: 50 }], 500000);
  assert.equal(one[0].position.shares, 9000, '只選 1 檔 ⇒ 可用現金全部投入（無單檔上限）；10 張＋手續費超過 50 萬 ⇒ 9 張');
  assert.equal(one[0].position.estCost, 450000 + 641, '估計成本含買進手續費');
  const poor = sizePicks([{ code: 'A', priceAtDecision: 50 }, { code: 'B', priceAtDecision: 50 }], 15000);
  assert.equal(poor[0].position.shares, 0);             // 7,500 < 單筆最低 1 萬 ⇒ 不建倉
  assert.match(poor[0].position.reason, /資金不足/);
  assert.equal(poor[1].position.shares, 299, '前一檔沒買，錢留給下一檔（15,000 扣手續費後／50 元＝299 股零股）');
  // 帳戶（v3 主動操作）：A 被 AI 賣出、已成交賺 3,000；B 仍持有（成本 33×1500）——只用已寫入的成交記錄
  const docs = [
    { date: '2026-01-02', picks: ps.slice(0, 2), buyFills: { A: { date: '2026-01-03', at: 1, px: 50 }, B: { date: '2026-01-03', at: 1, px: 1500 } } },
    { date: '2026-01-09', picks: [], review: { sells: [{ code: 'A', key: '2026-01-02_A', reason: 'x' }] }, sellFills: { '2026-01-02_A': { date: '2026-01-10', at: 2, px: 53.2, ledger: { pnlTwd: 3000 } } } },
  ];
  const a = swingAccount(docs, '2026-02-01');
  assert.equal(a.realized, 3000); assert.equal(a.openCost, 49570, '33×1500＋手續費 70'); assert.equal(a.cash, 500000 + 3000 - 49570, '已實現獲利併入可用現金供後續選股');
  assert.equal(swingAccount(docs, '2026-01-02').equity, 500000, '只算決策日以前的記錄');
});

test('帳戶快照：持有清單以最新收盤計市值、未進場標待進場、結算清單列交易單', async () => {
  const { swingAccountSnapshot } = await import('./ai-swing-lab.mjs');
  const days = mkDays(20);
  const docs = [
    { date: days[5].date, picks: [{ code: '1111', name: 'A', position: { shares: 1000, exitH: 60, estCost: 105000 } }], outcomes: {} },
    { date: days[19].date, picks: [{ code: '2222', name: 'B', position: { shares: 2000, exitH: 20, estCost: 100000 } }], outcomes: {} },
  ];
  const s = swingAccountSnapshot(docs, days);
  const a = s.holdings.find(h => h.code === '1111');
  assert.equal(a.entryPx, 105); assert.equal(a.lastPx, 119);
  assert.equal(a.cost, 105149, '含買進手續費'); assert.equal(a.unrealized, 119000 - 169 - 357 - 105149, '淨未實現＝市值－賣出手續費－證交稅－含費成本');
  assert.equal(s.holdings.find(h => h.code === '2222').status.startsWith('待進場'), true);
  assert.equal(s.account.openCost, 105149);
  assert.equal(s.account.reservedBuys, 100000, '待進場列委託保留');
});

test('每日戰績：同資料日覆蓋不重複、當日損益＝總值變化', async () => {
  const { upsertHistory } = await import('./ai-swing-lab.mjs');
  const snap = (date, cash, mkt) => ({ dataDate: date, account: { initial: 500000, cash, realized: 0 }, holdings: [{ entryPx: 10, entryDate: date, cost: 100000, mktValue: mkt, unrealized: mkt - 100000 }], closed: [] });
  let h = upsertHistory([], snap('2026-09-25', 400000, 100000));
  assert.equal(h[0].total, 500000); assert.equal(h[0].dayPnl, 0);
  h = upsertHistory(h, snap('2026-09-26', 400000, 105000));
  assert.equal(h[1].dayPnl, 5000); assert.equal(h[1].cumRetPct, 1);
  h = upsertHistory(h, snap('2026-09-26', 400000, 103000));
  assert.equal(h.length, 2); assert.equal(h[1].dayPnl, 3000);
});

test('執行器 v3：AI 檢視持股賣出換股——賣單與買單凍結、賣出回收款可買新股、結算補記成交、快照列已賣出', async () => {
  const { swingAccountSnapshot } = await import('./ai-swing-lab.mjs');
  const days = mkDays(); const D0 = days[5].date, D = days[20].date;
  const db = fakeDb({
    [`aiSwingLab/${D0}`]: { date: D0, frozenAt: Date.parse(`${D0}T18:00:00+08:00`), picks: [{ code: '1111', name: 'A', reason: '起漲', priceAtDecision: 104, position: { shares: 4000, estCost: 416000 } }], outcomes: {} },
    'swingPicks/latest': { dataDate: D, mode: 'close', items: [{ code: '2222', name: 'B', tier: 2, price: 50 }] },
    'swingHold/latest': { dataDate: D, combo: { items: [] } },
  });
  let prompt = '';
  const lab = createAiSwingLab({ db, log: () => {}, dir: mkdtempSync(join(tmpdir(), 'swing-')),
    askOllama: async p => { prompt = p; return '{"sells":[{"code":"1111","reason":"漲多獲利了結"}],"picks":[{"code":"2222","confidence":60,"horizon":"20","reason":"換股","risk":"r"}],"note":"換股"}'; },
    getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days.slice(0, 21) });
  assert.equal(await lab.pick(), true);
  assert.match(prompt, /現有持股 1 檔/); assert.match(prompt, /1111 A/);
  const doc = db.store[`aiSwingLab/${D}`];
  assert.equal(doc.review.sells[0].code, '1111');
  assert.equal(doc.review.sells[0].key, `${D0}_1111`);
  assert.ok(doc.cashForBuys > 500000, '賣出估計回收款（含獲利）併入買進資金');
  assert.ok(doc.picks[0].position.shares >= 10000, '可用現金全數給 2222（50 元 ⇒ 至少 10 張）');
  // 下一交易日到了：結算補記成交
  const lab2 = createAiSwingLab({ db, log: () => {}, dir: mkdtempSync(join(tmpdir(), 'swing-')), askOllama: async () => '{}', getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days.slice(0, 22) });
  await lab2.settle();
  assert.equal(db.store[`aiSwingLab/${D0}`].buyFills['1111'].px, 105);
  assert.equal(db.store[`aiSwingLab/${D}`].sellFills[`${D0}_1111`].px, 120, 'D 的下一交易日開盤 99+21');
  assert.equal(db.store[`aiSwingLab/${D}`].buyFills['2222'].px, 50);
  const snap = swingAccountSnapshot(Object.keys(db.store).filter(k => k.startsWith('aiSwingLab/')).map(k => db.store[k]), days.slice(0, 22));
  assert.equal(snap.closed.length, 1); assert.equal(snap.closed[0].sellReason, '漲多獲利了結');
  assert.equal(snap.holdings.map(h => h.code).join(), '2222');
  assert.ok(db.store['aiLabAccounts/swing'].closed.length === 1, '帳戶快照寫入');
});

test('執行器：開盤即時成交——09:00 後以即時開盤價成交並當下記錄（來源 live-open、記錄時刻）；報價未齊且未到 09:30 不成交；盤後結算不改寫', async () => {
  const days = mkDays(); const D0 = days[5].date, today = days[6].date;
  const db = fakeDb({
    [`aiSwingLab/${D0}`]: { date: D0, frozenAt: Date.parse(`${D0}T18:00:00+08:00`), picks: [{ code: '1111', name: 'A', priceAtDecision: 104, position: { shares: 1000, budget: 110000 } }, { code: '2222', name: 'B', priceAtDecision: 50, position: { shares: 1000, budget: 51000 } }], outcomes: {} },
  });
  const lab = createAiSwingLab({ db, log: () => {}, dir: mkdtempSync(join(tmpdir(), 'swing-')), askOllama: async () => '{}', getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days.slice(0, 6) });
  const openAt = Date.parse(`${today}T09:00:40+08:00`);
  const live = { 1111: { price: 105.5, open: 105, high: 106, low: 104.5, volume: 5e5, liveAt: openAt, revealAt: openAt - 5000, hasLive: true } };
  assert.equal(await lab.executeOpen(today, c => live[c], { now: openAt, deadline: false }), false, '2222 尚無開盤價、未到 09:30 ⇒ 不成交');
  assert.equal(db.store[`aiSwingLab/${D0}`].buyFills, undefined);
  live[2222] = { price: 50.5, open: 50, high: 51, low: 49.8, volume: 3e5, liveAt: openAt + 30000, revealAt: openAt + 25000, hasLive: true };
  assert.equal(await lab.executeOpen(today, c => live[c], { now: openAt + 60000, deadline: false }), true);
  const bf = db.store[`aiSwingLab/${D0}`].buyFills;
  assert.equal(bf['1111'].px, 105); assert.equal(bf['1111'].source, 'live-open'); assert.equal(bf['1111'].shares, 1000);
  assert.equal(bf['1111'].recordedAt, openAt + 60000, '成交當下即記錄');
  assert.equal(bf['2222'].quoteAt, openAt + 25000);
  assert.equal(db.store['aiLabAccounts/swing'].holdings.find(h => h.code === '1111').status, '持有中', '開盤後帳戶立即反映');
  // 盤後結算：歸檔含今日（官方開盤 99+6=105）——已記錄的成交不改寫
  const lab2 = createAiSwingLab({ db, log: () => {}, dir: mkdtempSync(join(tmpdir(), 'swing-')), askOllama: async () => '{}', getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days.slice(0, 7) });
  await lab2.settle();
  assert.equal(db.store[`aiSwingLab/${D0}`].buyFills['1111'].source, 'live-open');
});

test('執行器：09:30 仍無開盤價的買單作廢（開盤未成交），不在盤後補', async () => {
  const days = mkDays(); const D0 = days[5].date, today = days[6].date;
  const db = fakeDb({ [`aiSwingLab/${D0}`]: { date: D0, frozenAt: 1, picks: [{ code: '2222', name: 'B', priceAtDecision: 50, position: { shares: 1000, budget: 51000 } }], outcomes: {} } });
  const lab = createAiSwingLab({ db, log: () => {}, dir: mkdtempSync(join(tmpdir(), 'swing-')), askOllama: async () => '{}', getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days.slice(0, 6) });
  assert.equal(await lab.executeOpen(today, () => null, { now: Date.parse(`${today}T09:30:10+08:00`), deadline: true }), true);
  const f = db.store[`aiSwingLab/${D0}`].buyFills['2222'];
  assert.equal(f.failed, true); assert.match(f.reason, /開盤/);
});

test('執行器：經驗庫已驗證特徵標在候選旁寫進 prompt（觀察中不寫）', async () => {
  const days = mkDays(); const D = days[80].date;
  const db = fakeDb({ 'swingPicks/latest': { dataDate: D, mode: 'close', items: [{ code: '1111', name: 'A', tier: 2, price: 180 }] }, 'swingHold/latest': { dataDate: D, combo: { items: [] } } });
  const rule = (id, feature, bucket, status) => ({ id, feature, bucket, status, kind: 'risk', label: `${feature} ${bucket}`, n: 100, mean: -1, win: 30, restMean: 0.1, t: -3 });
  const learned = { swing: { rules: [rule('streak=≥5日', 'streak', '≥5日', 'validated'), rule('maAbove=3條', 'maAbove', '3條', 'observing')] } };
  let prompt = '';
  const lab = createAiSwingLab({ db, log: () => {}, dir: mkdtempSync(join(tmpdir(), 'swing-')), askOllama: async p => { prompt = p; return '{"sells":[],"picks":[],"note":"x"}'; },
    getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days.slice(0, 81), getLearned: () => learned });
  assert.equal(await lab.pick(), true);
  assert.match(prompt, /1111 A.*經驗庫：⚠風險：streak ≥5日/);
  assert.doesNotMatch(prompt, /maAbove 3條/, '觀察中不進 AI');
  assert.deepEqual(db.store[`aiSwingLab/${D}`].pool[0].lessonIds, ['streak=≥5日'], '凍結檔記錄套用了哪些經驗');
});
