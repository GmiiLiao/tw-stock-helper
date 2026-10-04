// AI 實驗鏈重覆執行／凍結語意（2026-10-04；WM-SCAN G4-19／G2-20／G2-24／G2-30／G2-31／G4-23／G4-25）
//   node --test scripts/lib/ai-lab-rerun.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiSwingLab } from './ai-swing-runner.mjs';
import { createAiDaytradeLab } from './ai-daytrade-runner.mjs';
import { classifyLabMembers, learnMemberEligibility } from './ai-lab-member.mjs';
import { decisionSamples } from './ai-lab-learn.mjs';
import { setAttentionCalibration } from './attention-risk.mjs';
import { ATTENTION_CAL_FIXTURE } from './attention-calibration.fixture.mjs';

setAttentionCalibration(ATTENTION_CAL_FIXTURE);

const mkDays = (n = 130) => Array.from({ length: n }, (_, i) => ({
  date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
  m: { 1111: [100 + i, 1000, 99 + i, 100.5 + i, 98.5 + i], 2222: [50, 1000, 50, 50.5, 49.5] },
}));
function fakeDb(init = {}, { throwOn = () => false } = {}) {
  const store = { ...init };
  const ref = (c, id) => ({ id, async get() { if (throwOn(`${c}/${id}`)) throw new Error('unavailable'); return { exists: `${c}/${id}` in store, data: () => store[`${c}/${id}`] }; },
    async set(v) { store[`${c}/${id}`] = JSON.parse(JSON.stringify(v)); }, async update(v) { store[`${c}/${id}`] = { ...(store[`${c}/${id}`] || {}), ...v }; } });
  return { store, collection: c => ({ doc: id => ref(c, id), orderBy: () => ({ limit: () => ({ async get() { return { docs: Object.keys(store).filter(k => k.startsWith(c + '/') && k.split('/').length === 2).sort().reverse().map(k => ({ ...ref(c, k.split('/')[1]), ref: ref(c, k.split('/')[1]), data: () => store[k] })) }; } }) }) }) };
}
const days = mkDays(); const D = days[10].date;
const boards = () => ({ 'swingPicks/latest': { dataDate: D, mode: 'close', items: [{ code: '1111', name: 'A', tier: 1, price: 110 }] }, 'swingHold/latest': { dataDate: D, combo: { items: [] } } });
const OK = '{"picks":[{"code":"1111","confidence":70,"horizon":"5","reason":"r","risk":"k"}],"note":"ok"}';
const base = (db, extra = {}) => ({ db, log: () => {}, dir: mkdtempSync(join(tmpdir(), 'rerun-')), getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({ 1111: '電子' }), loadDays: async () => days, ...extra });
// D＝2026-01-11；決策時窗終點（下一個交易日 08:30）設在 D+1 08:30；時鐘以台北時間指定
const clockAt = tw => () => Date.parse(`${tw}:00+08:00`);
const DEADLINE = '2026-01-12T08:30';

test('G4-19 Ollama 連不上：不計入 3 次額度，時窗內一直重試；最後一次仍連不上才以「Ollama 未回應」凍結', async () => {
  const db = fakeDb(boards()); let calls = 0; let now = '2026-01-11T17:10';
  const lab = createAiSwingLab(base(db, { askOllamaEx: async () => { calls++; return { text: null, kind: 'connect', detail: 'ECONNREFUSED' }; }, clock: () => clockAt(now)() }));
  for (let i = 0; i < 6; i++) assert.equal(await lab.pick({ forDay: D, deadline: DEADLINE }), false, `第 ${i + 1} 次：時窗內不凍結`);
  assert.equal(db.store[`aiSwingLab/${D}`], undefined);
  now = '2026-01-12T08:15';   // 最後一輪（retryMin 20 分鐘內就到 08:30）
  assert.equal(await lab.pick({ forDay: D, deadline: DEADLINE }), true);
  const doc = db.store[`aiSwingLab/${D}`];
  assert.equal(doc.failure.kind, 'ollama-unreachable'); assert.equal(doc.failure.cause, 'connect'); assert.equal(doc.failure.infraFails, 7);
  assert.match(doc.note, /Ollama 未回應（連線失敗/); assert.doesNotMatch(doc.note, /無法解析/, '原因不可寫錯成「回覆無法解析」');
  assert.equal(doc.picks.length, 0);
  assert.equal(calls, 7);
});

test('G4-19 看不懂才計次：連線失敗穿插不吃額度，第 3 次看不懂才凍結並寫 unparseable', async () => {
  const db = fakeDb(boards()); const seq = ['connect', 'bad', 'timeout', 'bad', 'http', 'bad'];
  const lab = createAiSwingLab(base(db, { askOllamaEx: async () => { const k = seq.shift(); return k === 'bad' ? { text: '看不懂', kind: 'ok' } : { text: null, kind: k }; }, clock: clockAt('2026-01-11T18:00') }));
  const res = []; for (let i = 0; i < 6; i++) res.push(await lab.pick({ forDay: D, deadline: DEADLINE }));
  assert.deepEqual(res, [false, false, false, false, false, true]);
  assert.equal(db.store[`aiSwingLab/${D}`].failure.kind, 'unparseable');
  assert.equal(db.store[`aiSwingLab/${D}`].failure.attempts, 3);
  assert.match(db.store[`aiSwingLab/${D}`].note, /3 次皆無法解析/);
});

test('G4-19 手動重新決策：只覆蓋失敗凍結、新結果須成功；成功的決策永不覆蓋；過時窗不做', async () => {
  const db = fakeDb({ ...boards(), [`aiSwingLab/${D}`]: { date: D, picks: [], review: { holdings: [], sells: [] }, note: 'Ollama 未回應…', failure: { kind: 'ollama-unreachable' }, frozenAt: 1 } });
  let reply = { text: null, kind: 'connect' };
  const lab = createAiSwingLab(base(db, { askOllamaEx: async () => reply, clock: clockAt('2026-01-12T07:00') }));
  assert.equal(await lab.pick({ forDay: D, deadline: DEADLINE }), true, '一般排程：已有凍結檔＝完成');
  assert.equal(await lab.pick({ forDay: D, deadline: DEADLINE, redecide: true, retryMin: 0 }), false, '重新決策仍連不上 ⇒ 不覆蓋');
  assert.equal(db.store[`aiSwingLab/${D}`].frozenAt, 1);
  reply = { text: OK, kind: 'ok' };
  assert.equal(await lab.pick({ forDay: D, deadline: DEADLINE, redecide: true, retryMin: 0 }), true);
  const doc = db.store[`aiSwingLab/${D}`];
  assert.equal(doc.picks[0].code, '1111'); assert.equal(doc.failure, undefined);
  assert.equal(doc.redecided.replaced.failure.kind, 'ollama-unreachable'); assert.ok(doc.redecided.at);
  reply = { text: '{"picks":[],"note":"另一個"}', kind: 'ok' };
  assert.equal(await lab.pick({ forDay: D, deadline: DEADLINE, redecide: true, retryMin: 0 }), 'kept', '回報「未覆蓋」而不是完成');
  assert.equal(db.store[`aiSwingLab/${D}`].picks[0].code, '1111', '成功的決策不被重新決策覆蓋');
  const late = createAiSwingLab(base(fakeDb(boards()), { askOllamaEx: async () => ({ text: OK, kind: 'ok' }), clock: clockAt('2026-01-12T08:31') }));
  assert.equal(await late.pick({ forDay: D, deadline: DEADLINE }), 'expired', '過了下一交易日 08:30 不再決策（不在開盤後才下單）');
});

test('G2-31 資料日冪等：榜單資料日不是本輪應處理的日子就不動作（午夜那輪不會吃掉傍晚的選股）', async () => {
  const db = fakeDb(boards()); let calls = 0;
  const lab = createAiSwingLab(base(db, { askOllamaEx: async () => { calls++; return { text: OK, kind: 'ok' }; } }));
  assert.equal(await lab.pick({ forDay: days[11].date }), false, '今天 17:00 後應處理新資料日，榜單仍是昨天的 ⇒ 等');
  assert.equal(calls, 0);
  assert.equal(await lab.pick({ forDay: D }), true);
});

test('G2-30 凍結閘門：資料未到齊不凍結、不問 Ollama', async () => {
  const db = fakeDb(boards()); let calls = 0; let gate = { ready: false, missing: ['收盤歸檔缺上櫃收盤'] };
  const logs = [];
  const lab = createAiSwingLab(base(db, { log: (...x) => logs.push(x.join(' ')), askOllamaEx: async () => { calls++; return { text: OK, kind: 'ok' }; }, getFreezeGate: async () => gate }));
  assert.equal(await lab.pick(), false); assert.equal(calls, 0);
  assert.ok(logs.some(l => /上櫃收盤/.test(l)));
  gate = { ready: true, missing: [] };
  assert.equal(await lab.pick(), true);
});

test('G2-24 輸入讀取失敗：稍後重試（最多 2 輪），之後照常決策並標記缺哪些輸入；文件不存在只標記', async () => {
  let fail = true;
  const db = fakeDb(boards(), { throwOn: k => fail && k === 'newsVerdict/latest' });
  const lab = createAiSwingLab(base(db, { askOllamaEx: async () => ({ text: OK, kind: 'ok' }) }));
  assert.equal(await lab.pick(), false); assert.equal(await lab.pick(), false);
  assert.equal(await lab.pick(), true);
  const m = db.store[`aiSwingLab/${D}`].inputsMissing;
  assert.ok(m.some(x => /新聞判讀（unavailable/.test(x)));
  assert.ok(m.some(x => /市況（marketWind\/latest 不存在/.test(x)));
});

test('G4-25 會員決策檔帶結構化設定快照', async () => {
  const db = fakeDb(boards());
  const lab = createAiSwingLab(base(db, { askOllamaEx: async () => ({ text: OK, kind: 'ok' }),
    account: { colPath: 'aiSwingMembers/u1/days', snapPath: 'aiSwingMembers/u1/state/account', files: false, research: false,
      getSettings: async () => ({ initial: 0, flows: [{ date: days[0].date, amount: 300000 }], goal: 10, goalDays: 20, goalStartDate: days[0].date, feeDiscount: 0.28 }) } }));
  assert.equal(await lab.pick(), true);
  const doc = db.store[`aiSwingMembers/u1/days/${D}`] || Object.entries(db.store).find(([k]) => k.endsWith(D) && k.startsWith('aiSwingMembers'))?.[1];
  assert.deepEqual(doc.settings, { asOf: D, capital: 300000, flowsN: 1, goal: 10, goalDays: 20, goalStartDate: days[0].date, feeDiscount: 0.28 });
});

// ── 當沖 ──
const T = Date.parse('2026-09-24T01:30:00Z');
const row = { m: { c: 41 }, warnings: [], score: { total: 60, knownMax: 80, tier: null, parts: {}, missing: [], market: [], stock: [], entry: [] } };
const trade = t => ({ type: 'ORB', why: 'x', t, entry: 41, stop: 40.05, d: 0.95, costR: 0.19, targets: [41.95] });
function dtDb() {
  const store = {}; let liveFail = false, alertsFail = false;
  const ref = id => ({ id, async get() { if ((id === 'live' && liveFail) || (id === 'alerts' && alertsFail)) throw new Error('unavailable'); return { exists: id in store, data: () => store[id] }; },
    async set(v) { store[id] = JSON.parse(JSON.stringify(v)); } });
  const db = { store, collection: name => ({ doc: id => ref(name === 'daytradeAlerts' && id === 'live' ? 'alerts' : id), orderBy: () => ({ limit: () => ({ async get() { return { docs: [] }; } }) }) }) };
  return { db, store, setLiveFail: v => { liveFail = v; }, setAlertsFail: v => { alertsFail = v; } };
}

test('G2-20 重啟時讀 live 失敗：不從零開始覆寫 live、不以殘缺記錄凍結；接回後以 id 合併', async () => {
  const realNow = Date.now; Date.now = () => T + 70_000;
  try {
    const { db, store, setLiveFail } = dtDb();
    store.live = { date: '2026-09-24', records: [{ id: 'old1', status: 'filled', decidedAt: 1, exitAt: 2 }, { id: 'old2', status: 'skipped', decidedAt: 1 }] };
    setLiveFail(true);
    const lab = createAiDaytradeLab({ db, askOllama: async p => (/檢討|教練/.test(p) ? '{"summary":"ok","improvements":[]}' : '{"decision":"skip","confidence":50,"reason":"r","risk":"k"}'), log: () => {}, getQuote: () => ({ price: 41 }), dir: mkdtempSync(join(tmpdir(), 'dt-')), model: 'm', deskVersion: 'v', evidence: null, getRules: () => ({ disposition: false, elig: 1 }) });
    assert.equal(await lab.restore('2026-09-24'), false);
    lab.consider({ side: 'long', code: '1111', name: 'x', row, trade: trade(T), id: 'new1' }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 5));
    await lab.writeLive(true);
    assert.equal(store.live.records.length, 2, 'live 讀不到時不寫（舊版會以 1 筆蓋掉 2 筆）');
    assert.equal(await lab.finalize('2026-09-24', null), false, '未接回不凍結');
    assert.equal(store['2026-09-24'], undefined);
    setLiveFail(false);
    assert.equal(await lab.finalize('2026-09-24', null), true);
    assert.deepEqual(store['2026-09-24'].records.map(r => r.id), ['old1', 'old2', 'new1'], '接回後合併，不遺失重啟前的記錄');
    assert.equal(store['2026-09-24'].incomplete, undefined);
  } finally { Date.now = realNow; }
});

test('G2-20 時窗最後一輪仍讀不回 live：凍結並明確標記可能殘缺', async () => {
  const { db, store, setLiveFail } = dtDb(); setLiveFail(true);
  const lab = createAiDaytradeLab({ db, askOllama: async () => null, log: () => {}, getQuote: () => null, dir: mkdtempSync(join(tmpdir(), 'dt-')), model: 'm', deskVersion: 'v', evidence: null });
  assert.equal(await lab.finalize('2026-09-24', null, { lastChance: true }), true);
  assert.match(store['2026-09-24'].incomplete.reason, /可能殘缺/);
});

test('G4-19 當沖檢討：Ollama 連不上不凍結（時窗內重試），最後一輪才記「Ollama 未回應」；看不懂第 3 次才記缺', async () => {
  const realNow = Date.now; Date.now = () => T + 70_000;
  try {
    const { db, store } = dtDb(); let review = { text: null, kind: 'connect' };
    const lab = createAiDaytradeLab({ db, askOllama: async () => '{"decision":"skip","confidence":50,"reason":"r","risk":"k"}',
      askOllamaEx: async p => (/檢討|教練/.test(p) ? review : { text: '{"decision":"skip","confidence":50,"reason":"r","risk":"k"}', kind: 'ok' }),
      log: () => {}, getQuote: () => ({ price: 41 }), dir: mkdtempSync(join(tmpdir(), 'dt-')), model: 'm', deskVersion: 'v', evidence: null, getRules: () => ({ disposition: false, elig: 1 }) });
    lab.consider({ side: 'long', code: '1111', name: 'x', row, trade: trade(T), id: 'a' }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 5));
    for (let i = 0; i < 4; i++) assert.equal(await lab.finalize('2026-09-24', null), false);
    assert.equal(await lab.finalize('2026-09-24', null, { lastChance: true }), true);
    assert.equal(store['2026-09-24'].review, null);
    assert.equal(store['2026-09-24'].reviewFailure.kind, 'ollama-unreachable');
    assert.match(store['2026-09-24'].reviewNote, /Ollama 未回應/);
    // 看不懂：第 3 次才凍結
    const d2 = dtDb(); review = { text: '看不懂', kind: 'ok' };
    const lab2 = createAiDaytradeLab({ db: d2.db, askOllama: async () => null, askOllamaEx: async p => (/檢討|教練/.test(p) ? review : { text: '{"decision":"skip","confidence":50,"reason":"r","risk":"k"}', kind: 'ok' }),
      log: () => {}, getQuote: () => ({ price: 41 }), dir: mkdtempSync(join(tmpdir(), 'dt-')), model: 'm', deskVersion: 'v', evidence: null, getRules: () => ({ disposition: false, elig: 1 }) });
    lab2.consider({ side: 'long', code: '1111', name: 'x', row, trade: trade(T), id: 'a' }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual([await lab2.finalize('2026-09-24', null), await lab2.finalize('2026-09-24', null), await lab2.finalize('2026-09-24', null)], [false, false, true]);
    assert.equal(d2.store['2026-09-24'].reviewFailure.kind, 'unparseable');
  } finally { Date.now = realNow; }
});

test('G4-23 無記錄時讀工作台記錄失敗 ⇒ 「無法判定」，不寫成「可能未運行」', async () => {
  const { db, store, setAlertsFail } = dtDb(); setAlertsFail(true);
  const lab = createAiDaytradeLab({ db, askOllama: async () => null, log: () => {}, getQuote: () => null, dir: mkdtempSync(join(tmpdir(), 'dt-')), model: 'm', deskVersion: 'v', evidence: null });
  assert.equal(await lab.finalize('2026-09-24', null), true);
  assert.match(store['2026-09-24'].reviewNote, /無法判定/);
});

// ── 會員資格與經驗庫樣本 ──
test('G4-24 會員資格＝開通 API 的付費等級：體驗期到期／降級／帳號不存在 ⇒ 停用（資料保留）', () => {
  const users = { a: { level: 'premium' }, b: { level: 'registered' }, c: { level: 'superadmin' } };
  const r = classifyLabMembers([{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }, { uid: 'd' }], u => users[u] ?? null);
  assert.deepEqual(r.active, ['a', 'c']);
  assert.deepEqual(r.suspended.map(s => s.uid), ['b', 'd']);
  assert.match(r.suspended[0].reason, /非付費等級/); assert.equal(r.suspended[1].reason, '帳號不存在');
});

test('G4-21 經驗庫：取消開通或帳號刪除剔除；體驗期到期（仍開通）保留；樣本帶來源會員 uid', () => {
  const acc = { a: { swing: true }, b: { swing: false }, c: { swing: true } };
  const r = learnMemberEligibility(['a', 'b', 'c', 'd'], u => acc[u] ?? null, u => u !== 'c');
  assert.deepEqual(r.include, ['a']);
  assert.deepEqual(r.exclude, [{ uid: 'b', reason: '已取消開通' }, { uid: 'c', reason: '帳號已刪除' }, { uid: 'd', reason: '已取消開通' }]);
  // 兩位會員同一天買同一檔 ⇒ 一筆樣本、uids 兩位；實驗帳戶的樣本不帶 uids
  const ds = mkDays(80); const t = 70, d = ds[t].date;
  const doc = { date: d, picks: [{ code: '1111', position: { shares: 1000 } }], buyFills: { 1111: { px: 170 } } };
  const out = decisionSamples([{ src: '會員帳戶', docs: [doc], uid: 'u2' }, { src: '會員帳戶', docs: [doc], uid: 'u1' }], ds, () => 1.5);
  assert.equal(out.samples.length, 1); assert.deepEqual(out.samples[0].uids, ['u1', 'u2']);
  assert.equal(decisionSamples([{ src: '實驗帳戶', docs: [doc] }], ds, () => 1.5).samples[0].uids, undefined);
});

// ── 審查 M2／L3 ──
function txDb(init = {}) {
  const db = fakeDb(init); const col0 = db.collection;
  const withCreate = r => ({ ...r, async create(v) { const k = Object.keys(db.store).find(x => x.endsWith(`/${r.id}`) && x.startsWith(r._c)); if (`${r._c}/${r.id}` in db.store) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; } await r.set(v); } });
  db.collection = c => { const x = col0(c); return { ...x, doc: id => withCreate({ ...x.doc(id), _c: c }) }; };
  db.runTransaction = async fn => fn({ get: r => r.get(), set: (r, v) => { db.store[`${r._c}/${r.id}`] = JSON.parse(JSON.stringify(v)); } });
  return db;
}

test('L3 一般決策首次寫用 create：另一行程先寫了（成功版）⇒ 不覆蓋', async () => {
  const db = txDb(boards());
  const lab = createAiSwingLab(base(db, { askOllamaEx: async () => { db.store[`aiSwingLab/${D}`] = { date: D, note: '手動先寫的成功版', picks: [] }; return { text: OK, kind: 'ok' }; } }));
  assert.equal(await lab.pick(), true);
  assert.equal(db.store[`aiSwingLab/${D}`].note, '手動先寫的成功版', '檢查與寫入之間被插隊時不覆蓋');
});

test('L3 重新決策走 transaction：期間被寫成成功版 ⇒ 未覆蓋（kept）', async () => {
  const db = txDb({ ...boards(), [`aiSwingLab/${D}`]: { date: D, picks: [], failure: { kind: 'ollama-unreachable' }, frozenAt: 1 } });
  const lab = createAiSwingLab(base(db, { clock: clockAt('2026-01-12T07:00'), askOllamaEx: async () => { db.store[`aiSwingLab/${D}`] = { date: D, note: '期間的成功版', picks: [] }; return { text: OK, kind: 'ok' }; } }));
  assert.equal(await lab.pick({ forDay: D, deadline: DEADLINE, redecide: true, retryMin: 0 }), 'kept');
  assert.equal(db.store[`aiSwingLab/${D}`].note, '期間的成功版');
  const db2 = txDb({ ...boards(), [`aiSwingLab/${D}`]: { date: D, picks: [], failure: { kind: 'data-not-ready' }, frozenAt: 1 } });
  const lab2 = createAiSwingLab(base(db2, { clock: clockAt('2026-01-12T07:00'), askOllamaEx: async () => ({ text: OK, kind: 'ok' }) }));
  assert.equal(await lab2.pick({ forDay: D, deadline: DEADLINE, redecide: true, retryMin: 0 }), true, '資料未到齊的失敗凍結可在資料到齊後被重新決策取代');
  assert.equal(db2.store[`aiSwingLab/${D}`].redecided.replaced.failure.kind, 'data-not-ready');
});

test('M2 時窗最後一輪資料仍未到齊 ⇒ 寫 data-not-ready 失敗凍結並通知一次；之前只重試', async () => {
  const db = txDb(boards()); let now = '2026-01-11T20:00'; const notes = [];
  const lab = createAiSwingLab(base(db, { clock: () => clockAt(now)(), askOllamaEx: async () => ({ text: OK, kind: 'ok' }),
    getFreezeGate: async () => ({ ready: false, missing: ['收盤歸檔缺上櫃收盤'] }), onFreezeFailure: async x => notes.push(x) }));
  assert.equal(await lab.pick({ forDay: D, deadline: DEADLINE }), false);
  assert.equal(db.store[`aiSwingLab/${D}`], undefined);
  now = '2026-01-12T08:15';
  assert.equal(await lab.pick({ forDay: D, deadline: DEADLINE }), 'data-not-ready');
  const doc = db.store[`aiSwingLab/${D}`];
  assert.equal(doc.failure.kind, 'data-not-ready'); assert.deepEqual(doc.failure.missing, ['收盤歸檔缺上櫃收盤']); assert.equal(doc.picks.length, 0);
  assert.equal(notes.length, 1);
  assert.equal(await lab.pick({ forDay: D, deadline: DEADLINE, redecide: true, retryMin: 0 }), false, '重新決策時資料仍未到齊 ⇒ 不寫');
});
