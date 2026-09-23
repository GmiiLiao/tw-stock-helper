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

function fakeDb(init = {}) {
  const store = { ...init };
  const ref = (c, id) => ({ id, async get() { return { exists: `${c}/${id}` in store, data: () => store[`${c}/${id}`] }; }, async set(v) { store[`${c}/${id}`] = v; }, async update(v) {
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
