// 當沖 s6「新聞催化品質」單元測試：node --test scripts/lib/daytrade-s6.test.mjs
//   2026-10-08 X1（jev-score-usage-spec 附錄 B）：daemon 的「已被預期」欄位寫「是／否／不確定」，
//   舊版比對 '已反映' ⇒「已反映降為 3 分」從未生效。改比對「是」並記 s6Version（X7 快取 5 分同版）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDesk } from './daytrade-setups.mjs';
import { scoreDesk, S6_VERSION, DESK_NEWS_TTL_MS } from './daytrade-score.mjs';

const T0 = Date.parse('2026-09-24T01:00:00Z');   // 台北 09:00
const bars = Array.from({ length: 12 }, (_, i) => ({ t: T0 + i * 60000, o: 100, h: 100.2, l: 99.8, c: 100, v: 1000 }));
const scan = scanDesk(bars, 'long', { prevClose: 99, prevHigh: 101, prevLow: 98 });
const stock = { market: 'tse', price: 100, chg: 1, valueTwd: 1e8, bid1: null, ask1: null, tick: 0.5, pace: null, prevHigh: 101, prevLow: 98 };
const s6Of = (side, news) => {
  const s = scoreDesk({ side, index: null, regime: null, breadth: null, sector: null, stock, news, scan, bars, vwap: 100, warnings: [] });
  return { item: s.stock.find(i => i.key === 's6'), s };
};

test('X1：順向利多且 daemon 寫「已被預期：是」⇒ 3 分（舊版比對「已反映」永不成立，給 5 分）', () => {
  assert.equal(s6Of('long', { label: '利多', certainty: '已確認', priced: '是', at: null }).item.score, 3);
});

test('X1：已被預期「否」「不確定」或缺值 ⇒ 順向仍 5 分', () => {
  for (const priced of ['否', '不確定', null]) assert.equal(s6Of('long', { label: '利多', certainty: '已確認', priced, at: null }).item.score, 5, String(priced));
});

test('傳聞 ⇒ 3 分；逆向 ⇒ 0；中性 ⇒ 2；做空鏡像（利空順向）', () => {
  assert.equal(s6Of('long', { label: '利多', certainty: '傳聞', priced: '否' }).item.score, 3);
  assert.equal(s6Of('long', { label: '利空', certainty: '已確認', priced: '否' }).item.score, 0);
  assert.equal(s6Of('long', { label: '中性', certainty: null, priced: null }).item.score, 2);
  assert.equal(s6Of('short', { label: '利空', certainty: '已確認', priced: '是' }).item.score, 3);
  assert.equal(s6Of('short', { label: '利空', certainty: '已確認', priced: '否' }).item.score, 5);
});

test('無判讀 ⇒ null（未知，不當 0）——行為不變', () => {
  const { item, s } = s6Of('long', null);
  assert.equal(item.score, null);
  assert.equal(s.tier, null);
});

test('證據字樣把「是」寫成「已反映」，不出現語意不明的「·是」', () => {
  const ev = s6Of('long', { label: '利多', certainty: '已確認', priced: '是' }).item.evidence;
  assert.ok(ev.includes('已反映'), ev);
  assert.ok(!/·是(·|$)/.test(ev), ev);
});

test('s6Version：輸出帶版本章（新舊分開）；快取 TTL 5 分鐘與版本同一處定義', () => {
  assert.match(S6_VERSION, /^s6-v2/);
  assert.equal(s6Of('long', null).s.s6Version, S6_VERSION);
  assert.equal(DESK_NEWS_TTL_MS, 5 * 60000);
});

// ── 逐筆記錄也帶 s6Version（審查 2026-10-08）：文件層 params 不保證涵蓋當日全部條目（日內重啟會以新 params 覆寫當日 journal），
//   AI 交易員的逐筆記錄與經驗庫（ai-lab-learn dtFeatures）又只讀逐筆 score ⇒ 版本要跟著每一筆走，新舊 s6 才分得開。
import { createDaytradeEngine, createVwapBook, accVwap, vwapOf } from './daytrade-engine.mjs';
import { createAiDaytradeLab } from './ai-daytrade-runner.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('引擎日誌：候選與每一筆觸發／否決條目的 score 帶 s6Version', () => {
  const eng = createDaytradeEngine({ evidence: null }); const vb = createVwapBook(); const today = '2026-09-24';
  eng.setMonitor(today, ['1111'], ['1111']);
  eng.setContext({ index: { tse: { chg: 0.5, slope15: 0.1 }, otc: null }, regime: null, breadth: { up: 1, down: 1 }, sectorOf: () => null, prev: { 1111: [39.5, 1, 39, 45, 38] }, avg20: {}, news: {}, elapsedFrac: 0.2 });
  const px = m => (m < 10 ? 40 : m === 10 ? 40.4 : m === 11 ? 40.35 : 41);
  let vol = 0;
  for (let s = 0; s < 20 * 12; s++) {
    const m = Math.floor(s / 12), t = T0 + s * 5000; vol += m === 10 || m === 12 ? 60000 : 4000;
    const q = { code: '1111', name: 'x', price: px(m), change: px(m) - 39.5, changePercent: (px(m) / 39.5 - 1) * 100, high: 41.1, volume: vol, live: true, revealAt: t, market: 'tse' };
    accVwap(vb, '1111', q, today); eng.onQuotes(today, { 1111: q }, (c, v) => vwapOf(vb, c, v), {});
  }
  const j = eng.journalDoc(true);
  const cands = Object.values(JSON.parse(j.candidatesJson));
  const entries = Object.values(JSON.parse(j.entriesJson));
  assert.ok(cands.length > 0 && entries.length > 0, `候選 ${cands.length}、條目 ${entries.length}`);
  for (const c of cands) assert.equal(c.s6Version, S6_VERSION);
  for (const e of entries) assert.equal(e.score.s6Version, S6_VERSION);
});

test('AI 交易員逐筆記錄的 score 帶 s6Version；上游沒給（舊引擎）記 null，不寫 undefined', async () => {
  const written = {};
  const ref = id => ({ async get() { return { exists: id in written, data: () => written[id] }; }, async set(v) { written[id] = v; }, async update(v) { written[id] = { ...written[id], ...v }; } });
  const db = { collection: () => ({ doc: ref, orderBy: () => ({ limit: () => ({ async get() { return { docs: [] }; } }) }) }) };
  const lab = createAiDaytradeLab({ db, askOllama: async () => '{"decision":"skip","confidence":40,"reason":"r","risk":"k"}', log: () => {}, getQuote: () => null,
    dir: mkdtempSync(join(tmpdir(), 'ails6-')), model: 'm', deskVersion: 'v', evidence: null, getRules: () => ({ disposition: false, elig: 1 }) });
  const T = Date.parse('2026-09-24T01:30:00Z');   // 09:30（09:05–12:30 窗內）
  const trade = { type: 'ORB', why: 'x', t: T, entry: 41, stop: 40.05, d: 0.95, costR: 0.19, targets: [41.95, 42.9, 43.85] };
  const base = { m: { c: 41, chg: 3, vwap: 40.5, vwapDev: 1.2 }, warnings: [] };
  const sc = { total: 60, knownMax: 80, tier: null, parts: {}, missing: [], market: [], stock: [], entry: [] };
  const realNow = Date.now; Date.now = () => T + 70_000;
  try {
    lab.consider({ side: 'long', code: '1111', name: '新', row: { ...base, score: { ...sc, s6Version: S6_VERSION } }, trade, id: 'v2' }, '2026-09-24', T + 70_000);
    lab.consider({ side: 'long', code: '2222', name: '舊', row: { ...base, score: sc }, trade, id: 'v1' }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 10));
    await lab.writeLive(true);
  } finally { Date.now = realNow; }
  const recs = written.live?.records || [];
  assert.equal(recs.length, 2, JSON.stringify(Object.keys(written)));
  assert.equal(recs.find(r => r.id === 'v2').score.s6Version, S6_VERSION);
  assert.equal(recs.find(r => r.id === 'v1').score.s6Version, null);
});
