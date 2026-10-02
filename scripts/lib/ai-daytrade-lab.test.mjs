// 當沖 AI 實驗單元測試：node --test scripts/lib/ai-daytrade-lab.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDecision, settle, labStats, parseReview, factsOf } from './ai-daytrade-lab.mjs';
import { createAiDaytradeLab } from './ai-daytrade-runner.mjs';

test('parseDecision：JSON 夾在文字中也抓得到；格式錯回 null（不猜）', () => {
  assert.deepEqual(parseDecision('好的\n{"decision":"take","lots":3,"confidence":72,"reason":"龍一放量","risk":"大盤轉弱"}'), { decision: 'take', lots: 3, confidence: 72, reason: '龍一放量', risk: '大盤轉弱' });
  assert.equal(parseDecision('{"decision":"take","lots":"2","confidence":60}').lots, 2, '字串數字可');
  for (const bad of [0, -1, 1.5, '"abc"', null]) assert.equal(parseDecision(`{"decision":"take","lots":${bad},"confidence":60}`).lots, null, `張數 ${bad} 無效 ⇒ null（不猜）`);
  assert.equal(parseDecision('{"decision":"skip","confidence":"40"}').decision, 'skip');
  assert.equal(parseDecision('我覺得可以做'), null);
  assert.equal(parseDecision('{"decision":"maybe"}'), null);
});

test('settle：AI 成交價與規則出場價算 AI 淨報酬；不做的只記規則反事實', () => {
  const filled = settle({ side: 'long', status: 'filled', fillPx: 41.05, d: 0.95 }, { exit: { t: 1, px: 42, reason: '達 3R' }, netR: 1.8, mfeR: 3 });
  assert.equal(filled.ruleNetR, 1.8);
  assert.ok(filled.aiNetR > 0 && filled.aiNetR < 1.8, '晚進場 0.05 元＋成本，AI R 應小於規則 R');
  const skipped = settle({ side: 'short', status: 'skipped', decision: 'skip' }, { exit: { t: 1, px: 39, reason: '結構停損' }, netR: -1.1 });
  assert.equal(skipped.ruleNetR, -1.1);
  assert.equal(skipped.aiNetR, undefined);
});

test('labStats：做／不做／錯過分開算', () => {
  const s = labStats([
    { side: 'long', status: 'filled', decision: 'take', ruleNetR: 1, aiNetR: 0.8 },
    { side: 'long', status: 'skipped', decision: 'skip', ruleNetR: -1 },
    { side: 'short', status: 'missed', decision: 'take', ruleNetR: 0.5 },
  ]);
  assert.equal(s.all.taken.n, 1); assert.equal(s.all.taken.aiAvgR, 0.8);
  assert.equal(s.all.skipped.ruleAvgR, -1);
  assert.equal(s.all.missed, 1);
  assert.equal(s.long.allRule.n, 2);
});

test('parseReview：最多 3 條改進；對錯由程式判定（不採 AI 的 worked/failed）', () => {
  const r = parseReview('{"summary":"x","worked":["a"],"improvements":["1","2","3","4"]}');
  assert.equal(r.improvements.length, 3);
  assert.equal(r.worked, undefined);
  const f = factsOf([{ side: 'short', code: '2', name: 'x', type: 'ORB', status: 'skipped', decision: 'skip', ruleNetR: 1.3 }, { side: 'long', code: '1', name: 'y', type: 'ORB', status: 'filled', aiNetR: -1 }]);
  assert.equal(f.worked.length, 0);
  assert.equal(f.failed.length, 2);
  assert.match(f.failed[0], /錯失獲利/);
});

// ── 執行器整合：假 Firestore、假 Ollama、假工作台日誌 ──
// 嚴格假物件（2026-09-28·WM-SCAN G3-09）：真 Firestore 拒收任何層級的 undefined
// （2026-09-24 daytradeAlerts 956 次寫入失敗的原因）。假物件不拒收＝測試綠、線上紅，所以這裡照真的丟錯。
function assertNoUndefined(v, path = '') {
  if (v === undefined) throw new Error(`Cannot use "undefined" as a Firestore value${path ? ` (found in field "${path}")` : ''}`);
  if (Array.isArray(v)) v.forEach((x, i) => assertNoUndefined(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) assertNoUndefined(v[k], path ? `${path}.${k}` : k);
}
function fakeDb() {
  const store = {};
  const ref = id => ({
    id, async get() { return { exists: id in store, data: () => store[id] }; },
    async set(v) { assertNoUndefined(v); store[id] = v; }, async update(v) { assertNoUndefined(v); store[id] = { ...store[id], ...v }; },
  });
  return { store, collection: () => ({ doc: ref, orderBy: () => ({ limit: () => ({ async get() { return { docs: Object.keys(store).map(k => ({ ...ref(k), data: () => store[k] })) }; } }) }) }) };
}
const T = Date.parse('2026-09-24T01:30:00Z');   // 09:30
const row = { m: { c: 41, chg: 3, vwap: 40.5, vwapDev: 1.2 }, warnings: [], score: { total: 60, knownMax: 80, tier: null, parts: {}, missing: ['新聞催化品質'], market: [], stock: [], entry: [] } };
const trade = (t, code) => ({ type: 'ORB', why: 'x', t, entry: 41, stop: 40.05, d: 0.95, costR: 0.19, targets: [41.95, 42.9, 43.85] });
const OK_RULES = () => ({ disposition: false, elig: 1 });   // 非處置、可雙向當沖

test('執行器：做 → 以即時價成交 → 出場結算 → 盤後凍結寫第二大腦（寫一次）', async () => {
  const realNow = Date.now; Date.now = () => T + 70_000;   // 固定時鐘：原本依賴真實時間，盤中以後跑就變成「錯過」
  try {
  const db = fakeDb(); const dir = mkdtempSync(join(tmpdir(), 'ailab-'));
  const lab = createAiDaytradeLab({ db, askOllama: async p => (/檢討|教練/.test(p) ? '{"summary":"ok","improvements":["b"]}' : '{"decision":"take","lots":6,"confidence":70,"reason":"r","risk":"k"}'),
    log: () => {}, getQuote: () => ({ price: 41.05 }), dir, model: 'm', deskVersion: 'v', evidence: null, getRules: OK_RULES });
  const id = 'long:1111:ORB:' + T;
  lab.consider({ side: 'long', code: '1111', name: '測', row, trade: trade(T), id }, '2026-09-24', T + 70_000);
  await new Promise(r => setTimeout(r, 10));
  const engine = { journalEntry: x => (x === id ? { exit: { t: T + 600_000, px: 42.9, reason: '達 2R' }, netR: 1.2, mfeR: 2 } : null) };
  lab.tick('2026-09-24', engine);
  assert.equal(await lab.finalize('2026-09-24', engine), true);
  const doc = db.store['2026-09-24'];
  assert.equal(doc.records[0].status, 'filled');
  assert.equal(doc.records[0].fillPx, 41.05);
  assert.ok(doc.records[0].aiNetR > 0);
  assert.equal(doc.review.summary, 'ok');
  assert.ok(existsSync(join(dir, '2026-09-24.md')) && existsSync(join(dir, '2026-09-24.json')));
  const frozenAt = doc.frozenAt;
  await lab.finalize('2026-09-24', engine);
  assert.equal(db.store['2026-09-24'].frozenAt, frozenAt, '凍結後不再覆寫');
  assert.match(readFileSync(join(dir, '2026-09-24.md'), 'utf8'), /當沖 AI 實驗 2026-09-24/);
  const L = doc.records[0].ledger;
  // AI 決定 6 張（v4：不設單筆上限，剩餘額度內由 AI 決定）⇒ 41.05 元 × 6000 股＝246,300 元，占用額度
  assert.equal(doc.records[0].shares, 6000); assert.equal(doc.records[0].lotsAsked, 6);
  assert.deepEqual(doc.limit, { limit: 1_000_000, used: 246300, left: 753700 });
  assert.equal(L.buy.at, T + 70_000); assert.equal(L.buy.px, 41.05); assert.equal(L.buy.amount, 246300);
  assert.equal(L.sell.px, 42.9); assert.equal(L.sell.at, T + 600_000 + 60_000);
  assert.equal(L.noLookahead, true);
  assert.equal(L.pnlTwd, 257400 - 246300 - 350 - 366 - 386);
  assert.equal(doc.account.initial, 500000);
  assert.equal(doc.account.equity, 500000 + L.pnlTwd);
  } finally { Date.now = realNow; }
});

test('執行器：剩餘額度不夠 1 張 ⇒ 記額度不足、不問 AI、不成交', async () => {
  const db = fakeDb(); const realNow = Date.now; Date.now = () => T + 70_000;
  try {
    let asked = 0; const logs = [];
    const lab = createAiDaytradeLab({ db, askOllama: async () => { asked++; return '{"decision":"take","lots":1,"confidence":60,"reason":"r","risk":"k"}'; }, log: (...x) => logs.push(x.join(' ')), getQuote: () => ({ price: 1200 }), dir: mkdtempSync(join(tmpdir(), 'ailab-')), model: 'm', deskVersion: 'v', evidence: null, getRules: OK_RULES });
    lab.consider({ side: 'long', code: '5555', name: '貴', row, trade: { ...trade(T), entry: 1200 }, id: 'x' }, '2026-09-24', T + 70_000);
    assert.ok(logs.some(l => /5555貴 .*→ no-limit（今日交易額度已用完.*未送 AI）/.test(l)), '額度擋下也寫日誌（使用者：日誌無聲看起來像停機）');
    await new Promise(r => setTimeout(r, 5));
    await lab.writeLive(true);
    const rec = db.store.live.records[0];
    assert.equal(rec.status, 'no-limit');
    assert.match(rec.reason, /額度/);
    assert.equal(asked, 0, '額度不夠就不送 AI');
    assert.equal(db.store.live.account.cash, 500000);
  } finally { Date.now = realNow; }
});

test('執行器：回覆逾 3 分鐘＝錯過不成交；不限筆數，每日額度用完（平倉不回補）當天不再交易', async () => {
  const db = fakeDb(); const dir = mkdtempSync(join(tmpdir(), 'ailab-'));
  let clock = 0; const realNow = Date.now; Date.now = () => clock;
  try {
    const lab = createAiDaytradeLab({ db, askOllama: async () => '{"decision":"take","lots":3,"confidence":50,"reason":"r","risk":"k"}', log: () => {}, getQuote: () => ({ price: 41 }), dir, model: 'm', deskVersion: 'v', evidence: null, getRules: OK_RULES });
    clock = T + 60_000 + 4 * 60_000;   // 觸發 K 收完後 4 分鐘才回覆
    lab.consider({ side: 'long', code: '2222', name: '慢', row, trade: trade(T), id: 'a' }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 5));
    // 每筆成交後立刻出場——額度只算進場價金、平倉不回補：每筆 3 張×41 元＝123,000 ⇒ 8 筆 984,000，第 9 筆剩 16,000 不夠 1 張
    const eng = { journalEntry: id => ({ exit: { t: T, px: 41, reason: '結構停損' }, netR: -1, fills: [] }) };
    for (let k = 0; k < 9; k++) { clock = T + k * 60_000 + 70_000; lab.consider({ side: 'long', code: `3${k}`, name: 'q', row, trade: trade(T + k * 60_000), id: `b${k}` }, '2026-09-24', T + k * 60_000 + 70_000); await new Promise(r => setTimeout(r, 2)); lab.tick('2026-09-24', eng); }
    await lab.writeLive(true);
    const recs = db.store.live.records;
    assert.equal(recs.find(r => r.id === 'a').status, 'missed');
    assert.equal(recs.filter(r => r.status === 'filled').length, 8, '舊版做多 5 筆上限已取消');
    assert.equal(recs.filter(r => r.status === 'no-limit').length, 1);
    assert.equal(db.store.live.limit.left, 16000);
  } finally { Date.now = realNow; }
});

test('分批出場交易單只能整張：3 張 1R 賣 1 張、其餘保本出場；1 張不拆（舊版 333 股是零股）；AI R 由交易單回推', async () => {
  const { ledgerOf, planExits } = await import('./sim-ledger.mjs');
  const exits = planExits({ fills: [{ k: 0, px: 41.95, at: 2000 }], exitAt: 3000, exitPx: 41, shares: 3000 });
  assert.deepEqual(exits.map(e => e.shares), [1000, 2000]);
  const L = ledgerOf({ side: 'long', entry: { at: 1000, px: 41 }, exits, dayTrade: true, decidedAt: 1000, shares: 3000 });
  assert.equal(L.legs.length, 3);
  assert.equal(L.sell.amount, Math.round(41.95 * 1000) + Math.round(41 * 2000));
  assert.equal(L.pnlTwd, L.sell.amount - L.buy.amount - L.costTwd);
  assert.ok(L.legs.every(l => l.shares % 1000 === 0), '每一腿都是整張');
  assert.deepEqual(planExits({ fills: [{ k: 0, px: 41.95, at: 2000 }], exitAt: 3000, exitPx: 41 }).map(e => e.shares), [1000], '1 張：1R 不拆、整張在最後出場');
  const r = settle({ side: 'long', status: 'filled', fillPx: 41, fillAt: 1000, decidedAt: 1000, d: 0.95 }, { exit: { t: 2940, px: 41, reason: '回到成本（保本停損）' }, netR: 0.2, fills: [{ k: 0, px: 41.95, at: 2000 }] });
  assert.equal(r.ledger.legs.length, 2);
  assert.equal(r.aiNetR, +(r.ledger.pnlTwd / (0.95 * 1000)).toFixed(2));
  const cf = settle({ side: 'long', status: 'skipped', decision: 'skip', triggerPx: 41, triggerAt: 1000, d: 0.95 }, { exit: { t: 2940, px: 42, reason: '達 1R' }, netR: 1 });
  assert.equal(cf.cfLedger.shares, 1000, '反事實以 1 張計（只比較方向與 R，不代表 AI 會下的張數）');
});

test('執行器：帳戶起點讀取失敗不凍結（G2-19）；無記錄時分清工作台有無運行（G4-11）', async () => {
  const db = fakeDb(); let fail = true;
  const col = db.collection;
  db.collection = name => { const c = col(name); return { ...c, orderBy: () => ({ limit: () => ({ async get() { if (fail) throw new Error('unavailable'); return { docs: [] }; } }) }) }; };
  const lab = createAiDaytradeLab({ db, askOllama: async () => null, log: () => {}, getQuote: () => null, dir: mkdtempSync(join(tmpdir(), 'ailab-')), model: 'm', deskVersion: 'v', evidence: null });
  assert.equal(await lab.finalize('2026-09-24', null), false);
  assert.equal(db.store['2026-09-24'], undefined, '不凍結');
  fail = false;
  assert.equal(await lab.finalize('2026-09-24', null), true);
  assert.match(db.store['2026-09-24'].reviewNote, /無盤中紀錄/);
});

test('決策 prompt（v3，使用者 09-30 選 B）：交易員角色、以帳戶獲利為目標；不得有「沒有把握就不做」之類偏向放棄的引導', async () => {
  const { buildDecisionPrompt, AI_LAB_VERSION } = await import('./ai-daytrade-lab.mjs');
  const row = { m: { c: 41, chg: 3, vwap: 40.5, vwapDev: 1.2 }, warnings: [], score: { total: 60, knownMax: 80, tier: null, parts: {}, missing: [], market: [], stock: [], entry: [] } };
  const p = buildDecisionPrompt({ side: 'long', code: '1111', name: '測', row, trade: { type: 'ORB', why: 'x', entry: 41, stop: 40, d: 1, costR: 0.2, targets: [42, 43, 44] }, limit: 1_000_000, used: 123000, left: 877000, maxN: 21, cash: 512345,
    evidence: { long: { all: { teN: 120, teWin: 38, teR: -0.33 } } }, now: Date.parse('2026-09-30T01:30:00Z') });
  assert.match(p, /交易員/); assert.match(p, /帳戶獲利/);
  assert.doesNotMatch(p, /沒有把握就不做|紀律審核員|扣成本後為負/);
  assert.match(p, /n=120/, '歷史數據仍如實揭露');
  assert.match(p, /交易額度 1,000,000.*已用 123,000.*剩餘 877,000/); assert.match(p, /最多 21 張/); assert.match(p, /用完當天就不能再交易/);
  assert.match(p, /手續費.*證交稅/); assert.match(p, /"lots"/);
  assert.doesNotMatch(p, /額度已用 \d+\/\d+/, '舊的筆數額度不再出現');
  assert.equal(AI_LAB_VERSION, 'ai-dt-lab-v4');
});

test('執行器：當沖觸發符合經驗庫已驗證特徵 ⇒ prompt 附【經驗庫】、記錄 lessons', async () => {
  const realNow = Date.now; Date.now = () => T + 70_000;
  try {
    const db = fakeDb(); let prompt = '';
    const learned = { 'dt-long': { rules: [{ id: 'type=ORB', feature: 'type', bucket: 'ORB', status: 'validated', kind: 'risk', label: '型態 ORB', n: 40, mean: -0.6, win: 30, restMean: 0.1, t: -2.5 }] } };
    const lab = createAiDaytradeLab({ db, askOllama: async p => { prompt = p; return '{"decision":"skip","confidence":50,"reason":"r","risk":"k"}'; }, log: () => {}, getQuote: () => ({ price: 41 }), dir: mkdtempSync(join(tmpdir(), 'ailab-')), model: 'm', deskVersion: 'v', evidence: null, getLearned: () => learned, getRules: OK_RULES });
    const id = 'long:1111:ORB:' + T;
    lab.consider({ side: 'long', code: '1111', name: '測', row, trade: { ...trade(T), minute: 575 }, id, ctxInfo: { regime: '多頭' } }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 10));
    assert.match(prompt, /【經驗庫】[\s\S]*⚠風險：型態 ORB/);
  } finally { Date.now = realNow; }
});

test('執行器 v4：處置股／非當沖標的／做空不可先賣／名單取不到 ⇒ 不交易、不問 AI，記原因', async () => {
  const realNow = Date.now; Date.now = () => T + 70_000;
  try {
    const db = fakeDb(); let asked = 0;
    const rules = { D: { disposition: true, elig: 1 }, N: { disposition: false, elig: 0 }, L: { disposition: false, elig: 2 }, U: { disposition: false, elig: null } };
    const lab = createAiDaytradeLab({ db, askOllama: async () => { asked++; return '{"decision":"take","lots":1,"confidence":60,"reason":"r","risk":"k"}'; }, log: () => {}, getQuote: () => ({ price: 41 }), dir: mkdtempSync(join(tmpdir(), 'ailab-')), model: 'm', deskVersion: 'v', evidence: null, getRules: c => rules[c] });
    lab.consider({ side: 'long', code: 'D', name: '處置', row, trade: trade(T), id: 'd' }, '2026-09-24', T + 70_000);
    lab.consider({ side: 'long', code: 'N', name: '非當沖', row, trade: trade(T), id: 'n' }, '2026-09-24', T + 70_000);
    lab.consider({ side: 'short', code: 'L', name: '僅先買', row, trade: trade(T), id: 'l' }, '2026-09-24', T + 70_000);
    lab.consider({ side: 'long', code: 'U', name: '名單缺', row, trade: trade(T), id: 'u' }, '2026-09-24', T + 70_000);
    lab.consider({ side: 'long', code: 'X', name: '沒給規則', row, trade: trade(T), id: 'x' }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 5));
    await lab.writeLive(true);
    const st = Object.fromEntries(db.store.live.records.map(r => [r.id, r]));
    for (const id of ['d', 'n', 'l', 'u', 'x']) assert.equal(st[id].status, 'ineligible', id);
    assert.match(st.d.reason, /處置/); assert.match(st.n.reason, /非現股當沖/); assert.match(st.l.reason, /不可先賣後買/); assert.match(st.u.reason, /資格名單取不到/); assert.match(st.x.reason, /取不到/);
    assert.equal(asked, 0);
  } finally { Date.now = realNow; }
});

test('執行器 v4：AI 要的張數超過剩餘額度 ⇒ 依額度裁成整張並註明；回覆缺張數 ⇒ 不成交', async () => {
  const realNow = Date.now; Date.now = () => T + 70_000;
  try {
    const db = fakeDb();
    const lab = createAiDaytradeLab({ db, askOllama: async () => '{"decision":"take","lots":30,"confidence":80,"reason":"r","risk":"k"}', log: () => {}, getQuote: () => ({ price: 41.05 }), dir: mkdtempSync(join(tmpdir(), 'ailab-')), model: 'm', deskVersion: 'v', evidence: null, getRules: OK_RULES });
    lab.consider({ side: 'long', code: '1111', name: '測', row, trade: trade(T), id: 'big' }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 5));
    // 已用 985,200、剩 14,800 ⇒ 下一個觸發連 1 張都不夠：不送 AI、記額度不足
    lab.consider({ side: 'long', code: '3333', name: '後', row, trade: trade(T), id: 'after' }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 5));
    await lab.writeLive(true);
    const st = Object.fromEntries(db.store.live.records.map(r => [r.id, r]));
    assert.equal(st.big.status, 'filled'); assert.equal(st.big.lotsAsked, 30);
    assert.equal(st.big.shares, 24000, '100 萬 ÷ 41,050 ⇒ 24 張');
    assert.match(st.big.sizeNote, /30 張.*24 張/);
    assert.equal(st.after.status, 'no-limit');
    // 另一個帳戶：AI 說做但沒給張數 ⇒ 不成交（不猜）
    const db2 = fakeDb();
    const lab2 = createAiDaytradeLab({ db: db2, askOllama: async () => '{"decision":"take","confidence":80,"reason":"r","risk":"k"}', log: () => {}, getQuote: () => ({ price: 41.05 }), dir: mkdtempSync(join(tmpdir(), 'ailab-')), model: 'm', deskVersion: 'v', evidence: null, getRules: OK_RULES });
    lab2.consider({ side: 'long', code: '2222', name: '缺', row, trade: trade(T), id: 'nolots' }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 5));
    await lab2.writeLive(true);
    const nl = db2.store.live.records[0];
    assert.equal(nl.status, 'error'); assert.match(nl.reason, /張數/);
  } finally { Date.now = realNow; }
});

test('執行器 v4：核准後的額度生效；現金超過額度 ⇒ AI 交易員發訊息申請提高（待審中不重複）', async () => {
  const realNow = Date.now; Date.now = () => T + 70_000;
  try {
    const db = fakeDb(); const msgs = [];
    db.store.daytradeLimit = { limit: 2_000_000 };
    db.store['2026-09-23'] = { date: '2026-09-23', records: [{ status: 'filled', ledger: { pnlTwd: 600000 } }] };   // 過去已實現 +60 萬 ⇒ 現金 110 萬
    const lab = createAiDaytradeLab({ db, askOllama: async p => (/檢討|教練/.test(p) ? '{"summary":"ok","improvements":[]}' : '{"decision":"take","lots":40,"confidence":70,"reason":"r","risk":"k"}'), log: () => {}, getQuote: () => ({ price: 41 }), dir: mkdtempSync(join(tmpdir(), 'ailab-')), model: 'm', deskVersion: 'v', evidence: null, getRules: OK_RULES, notifyOwner: async m => { msgs.push(m); return true; } });
    assert.equal(await lab.prepareDay('2026-09-24'), true);
    lab.consider({ side: 'long', code: '1111', name: '測', row, trade: trade(T), id: 'a' }, '2026-09-24', T + 70_000);
    await new Promise(r => setTimeout(r, 5));
    await lab.writeLive(true);
    assert.equal(db.store.live.records[0].shares, 40000, '額度 200 萬 ⇒ 40 張×41,000＝164 萬可成交');
    assert.equal(db.store.live.limit.limit, 2_000_000);
    // 額度 200 萬 > 現金 110 萬 ⇒ 不申請
    const eng = { journalEntry: () => ({ exit: { t: T + 600_000, px: 41, reason: '時間停損' }, netR: 0, fills: [] }) };
    await lab.finalize('2026-09-24', eng);
    assert.equal(msgs.length, 0); assert.equal(db.store.daytradeLimit.request, undefined);
    // 額度回到 100 萬（例：手動調降）、現金 110 萬 ⇒ 申請一次，待審中不重複
    db.store.daytradeLimit = { limit: 1_000_000 };
    const lab2 = createAiDaytradeLab({ db, askOllama: async () => '{"summary":"ok","improvements":[]}', log: () => {}, getQuote: () => null, dir: mkdtempSync(join(tmpdir(), 'ailab-')), model: 'm', deskVersion: 'v', evidence: null, getRules: OK_RULES, notifyOwner: async m => { msgs.push(m); return true; } });
    await lab2.finalize('2026-09-25', eng);
    assert.equal(msgs.length, 1); assert.match(msgs[0], /AI 交易員/); assert.match(msgs[0], /申請.*提高到 2,200,000/);
    assert.equal(db.store.daytradeLimit.request.status, 'pending'); assert.equal(db.store.daytradeLimit.limit, 1_000_000, '核准前不生效');
    await lab2.finalize('2026-09-26', eng);
    assert.equal(msgs.length, 1, '待審中不重複申請');
  } finally { Date.now = realNow; }
});
