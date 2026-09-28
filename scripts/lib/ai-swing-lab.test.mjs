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

test('swingStats：選股 vs 整池超額', () => {
  const s = swingStats([{ outcomes: { 5: { picks: [{ net: 3 }, { net: -1 }], pool: { avg: 0.5 } } } }]);
  assert.equal(s[5].avg, 1); assert.equal(s[5].excess, 0.5); assert.equal(s[20].n, 0);
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

test('波段帳戶：單筆上限 10 萬、貴股用零股、錢用完記資金不足；帳戶由記錄重算', async () => {
  const { sizePicks, swingAccount } = await import('./ai-swing-lab.mjs');
  const ps = sizePicks([{ code: 'A', priceAtDecision: 50, horizon: 10 }, { code: 'B', priceAtDecision: 1500, horizon: null }, { code: 'C', priceAtDecision: 30 }], 150000);
  assert.equal(ps[0].position.shares, 2000);            // 10 萬／50 元 ⇒ 2 張
  assert.equal(ps[1].position.shares, 33);              // 剩 5 萬、1 張 150 萬 ⇒ 零股 33 股
  assert.equal(ps[1].position.exitH, 20);               // 未指定 ⇒ 20 日
  assert.equal(ps[2].position.shares, 0);               // 剩 500 元 < 單筆最低 1 萬 ⇒ 不建倉
  assert.match(ps[2].position.reason, /資金不足/);
  // 帳戶：A 已在 10 日出場賺 3,000；B 未到期（成本 33×1500）
  const docs = [{ date: '2026-01-02', picks: ps.slice(0, 2), outcomes: { 5: { picks: [{ code: 'B', entryPx: 1500 }] }, 10: { picks: [{ code: 'A', ledger: { pnlTwd: 3000 } }] } } }];
  const a = swingAccount(docs, '2026-02-01');
  assert.equal(a.realized, 3000); assert.equal(a.openCost, 49500); assert.equal(a.cash, 500000 + 3000 - 49500);
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
  assert.equal(a.entryPx, 105); assert.equal(a.lastPx, 119); assert.equal(a.unrealized, 14000);
  assert.equal(s.holdings.find(h => h.code === '2222').status.startsWith('待進場'), true);
  assert.equal(s.account.openCost, 105000 + 100000);
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
