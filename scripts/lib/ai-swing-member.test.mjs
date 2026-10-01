// 會員專屬 AI 波段帳戶 單元測試：node --test scripts/lib/ai-swing-member.test.mjs
// 2026-10-01 使用者：AI 實驗開放給高級會員（先開放波段），每位會員一位專屬 AI 交易員；投入資金變更視為加碼／提領。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portfolioState } from './ai-swing-portfolio.mjs';
import { rebuildHistory } from './ai-swing-history.mjs';
import { buildPickPrompt } from './ai-swing-lab.mjs';
import { createAiSwingLab } from './ai-swing-runner.mjs';

// 30 個交易日：1111 每日 +1 元（開＝前收），2222 持平 50
const mkDays = (n = 30) => Array.from({ length: n }, (_, i) => ({
  date: `2026-10-${String(1 + i).padStart(2, '0')}`,
  m: { 1111: [100 + i, 1000, 99 + i, 100.5 + i, 98.5 + i], 2222: [50, 1000, 50, 50.5, 49.5] },
}));
const at = (d, hm) => Date.parse(`${d}T${hm}:00+08:00`);
const buyDoc = (date, code, shares, px) => ({ date, frozenAt: at(date, '18:00'), picks: [{ code, name: code, reason: 'r', horizon: 20, priceAtDecision: px, position: { shares, budget: Math.round(shares * px * 1.05) } }] });

test('入金／提領：會員帳戶起始 0、以資金異動計現金；淨投入＝入金合計；成交依可用資金裁減；不給參數＝原 50 萬帳戶', () => {
  const days = mkDays();
  const flows = [{ date: days[0].date, amount: 300000 }, { date: days[5].date, amount: 200000 }, { date: days[8].date, amount: -100000 }];
  const docs = [buyDoc(days[2].date, '1111', 1000, 101)];
  const s = portfolioState(docs, days, null, { initial: 0, flows });
  assert.equal(s.lots[0].buy.px, 102); assert.equal(s.lots[0].shares, 1000);
  assert.equal(s.account.initial, 400000, '淨投入＝30 萬＋20 萬－10 萬');
  assert.equal(s.account.cash, 400000 - s.account.openCost);
  const s2 = portfolioState(docs, days, null, { initial: 0, flows: [{ date: days[0].date, amount: 50000 }] });
  assert.ok(s2.lots[0].shares > 0 && s2.lots[0].shares < 1000, '只投入 5 萬 ⇒ 依資金池裁減股數');
  assert.ok(s2.account.cash >= 0, '現金不為負');
  assert.equal(portfolioState(docs, days).account.initial, 500000, '實驗帳戶不受影響');
});

test('入金日期晚於日線（今天入金、今日尚未歸檔）也計入現金', () => {
  const s = portfolioState([], mkDays(5), null, { initial: 0, flows: [{ date: '2026-12-31', amount: 120000 }] });
  assert.equal(s.account.cash, 120000); assert.equal(s.account.initial, 120000);
});

test('每日戰績有資金異動：當日損益不含入金／提領；累積報酬為時間加權（加碼不灌水）', () => {
  const days = mkDays(9);
  const flows = [{ date: days[0].date, amount: 300000 }, { date: days[5].date, amount: 200000 }];
  const rows = rebuildHistory([buyDoc(days[2].date, '1111', 1000, 101)], days, [], { initial: 0, flows });
  const r5 = rows.find(r => r.date === days[5].date), r4 = rows.find(r => r.date === days[4].date);
  assert.equal(rows[0].date, days[2].date); assert.equal(rows[0].dayPnl, 0); assert.equal(rows[0].cumRetPct, 0);
  assert.equal(rows[0].flow, 300000, '首列含首筆入金');
  assert.equal(r5.flow, 200000);
  assert.ok(r5.total - r4.total > 199000, '總值含入金');
  assert.ok(r5.dayPnl > 0 && r5.dayPnl < 2000, `當日損益只算漲幅（${r5.dayPnl}）`);
  const last = rows.at(-1);
  assert.equal(last.netInvested, 500000);
  assert.ok(last.cumRetPct > 0 && last.cumRetPct < 2, `時間加權累積報酬（${last.cumRetPct}%），不是把 20 萬入金算成獲利`);
});

test('會員 prompt：帶入會員投入資金與獲利成長目標；實驗帳戶 prompt 不變', () => {
  const base = { date: '2026-10-01', pool: [], market: null, swingPicksMeta: {}, holdings: [], cash: 300000, equity: 300000 };
  const lab = buildPickPrompt(base);
  assert.match(lab, /管理一個模擬帳戶（起始 50 萬元）/); assert.match(lab, /資金池只有 50 萬＋已實現損益/);
  assert.doesNotMatch(lab, /獲利成長目標/);
  const mem = buildPickPrompt({ ...base, member: { capital: 300000, goal: 30, cumRetPct: 4.5 } });
  assert.match(mem, /會員投入資金 300,000 元/);
  assert.match(mem, /獲利成長目標：帳戶成長 30%（目前累積 \+4\.5%）/);
  assert.match(mem, /資金池只有 300,000 元＋已實現損益/);
  assert.doesNotMatch(mem, /起始 50 萬/);
});

// 假 Firestore（路徑式集合名，支援 a/b/c 子集合；拒收 undefined 同真 Firestore）
function assertNoUndefined(v, path = '') {
  if (v === undefined) throw new Error(`Cannot use "undefined" as a Firestore value (${path})`);
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
  const children = c => Object.keys(store).filter(k => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/')).sort().reverse();
  return { store, collection: c => ({ doc: id => ref(c, id), orderBy: () => ({ limit: () => ({ async get() { return { docs: children(c).map(k => ({ ...ref(c, k.slice(c.length + 1)), ref: ref(c, k.slice(c.length + 1)), data: () => store[k] })) }; } }) }) }) };
}

test('會員帳戶執行器：決策與快照寫在會員路徑、依會員資金定股數、prompt 帶目標；不寫第二大腦、不做研究結算、不碰實驗帳戶', async () => {
  const days = mkDays(); const D = days[10].date;
  const db = fakeDb({
    'swingPicks/latest': { dataDate: D, mode: 'close', items: [{ code: '2222', name: 'B', tier: 2, price: 50 }] },
    'swingHold/latest': { dataDate: D, combo: { items: [] } },
  });
  let prompt = '';
  const dir = mkdtempSync(join(tmpdir(), 'swing-m-'));
  const mk = n => createAiSwingLab({ db, log: () => {}, dir, askOllama: async p => { prompt = p; return '{"sells":[],"picks":[{"code":"2222","confidence":60,"horizon":"20","reason":"r","risk":"k"}],"note":"n"}'; },
    getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days.slice(0, n),
    account: { colPath: 'aiSwingMembers/u1/days', snapPath: 'aiSwingMembers/u1/state/account', files: false, research: false,
      getSettings: async () => ({ initial: 0, flows: [{ date: days[0].date, amount: 200000 }], goal: 25 }) } });
  assert.equal(await mk(11).pick(), true);
  const doc = db.store[`aiSwingMembers/u1/days/${D}`];
  assert.ok(doc, '決策寫在會員路徑');
  assert.equal(db.store[`aiSwingLab/${D}`], undefined, '不碰實驗帳戶的決策');
  assert.equal(db.store['aiLabAccounts/swing'], undefined, '不碰實驗帳戶的快照');
  assert.ok(doc.picks[0].position.shares > 0 && doc.picks[0].position.estCost <= 200000, '依會員 20 萬定股數');
  assert.match(prompt, /會員投入資金 200,000 元/); assert.match(prompt, /每 20 個交易日帳戶成長 25%/); assert.match(prompt, /第 1 期自下一個交易日起算/);
  assert.equal(readdirSync(dir).length, 0, '不寫第二大腦');
  assert.equal(db.store['aiSwingMembers/u1/state/account'].account.initial, 200000);
  assert.equal(db.store['aiSwingMembers/u1/state/account'].flowsIncluded, 1, '快照記下已計入幾筆資金異動（API 據此補上快照之後的入金／提領）');
  await mk(30).settle();
  assert.equal(db.store[`aiSwingMembers/u1/days/${D}`].buyFills['2222'].px, 50, '補記成交');
  assert.deepEqual(db.store[`aiSwingMembers/u1/days/${D}`].outcomes, {}, '會員帳戶不做研究結算');
});

test('會員帳戶執行器：淨投入為 0 且無持股 ⇒ 不選股、不呼叫 AI', async () => {
  const days = mkDays(); const D = days[10].date;
  const db = fakeDb({ 'swingPicks/latest': { dataDate: D, mode: 'close', items: [{ code: '2222', name: 'B', tier: 2, price: 50 }] }, 'swingHold/latest': { dataDate: D, combo: { items: [] } } });
  let asked = 0;
  const lab = createAiSwingLab({ db, log: () => {}, dir: null, askOllama: async () => { asked++; return '{}'; }, getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days.slice(0, 11),
    account: { colPath: 'aiSwingMembers/u2/days', snapPath: 'aiSwingMembers/u2/state/account', files: false, research: false, getSettings: async () => ({ initial: 0, flows: [], goal: null }) } });
  assert.equal(await lab.pick(), 'skip', '尚未入金＝跳過（daemon 據此在入金後重新排入）');
  assert.equal(asked, 0); assert.equal(db.store[`aiSwingMembers/u2/days/${D}`], undefined);
  await lab.writeAccount(null, {});
  assert.equal(db.store['aiSwingMembers/u2/state/account'], undefined, '尚未入金：不建 0 元帳戶快照（會員頁才會顯示引導而非 0 元卡片）');
});

test('會員 prompt：獲利期間進度（第幾期第幾日、本期報酬、上一期達標與否）；提醒風險控制優先', () => {
  const base = { date: '2026-10-01', pool: [], market: null, swingPicksMeta: {}, holdings: [], cash: 300000, equity: 300000 };
  const progress = { goal: 10, days: 20, startDate: '2026-09-01', period: 2, day: 3, daysLeft: 17, periodStart: '2026-09-29', periodRetPct: 1.5, cumRetPct: 12.3, progress: 15, lastPeriod: { n: 1, retPct: 10.8, achieved: true } };
  const mem = buildPickPrompt({ ...base, member: { capital: 300000, goal: 10, cumRetPct: 12.3, progress } });
  assert.match(mem, /每 20 個交易日帳戶成長 10%/);
  assert.match(mem, /目前第 2 期第 3\/20 個交易日、本期報酬 \+1\.5%、本期剩 17 個交易日；上一期 \+10\.8%（達標）；累積 \+12\.3%/);
  assert.match(mem, /風險控制優先/);
});

test('會員：決策用前一交易日收盤、但決策當下（隔日 07:30）才首次入金 ⇒ 仍決策並以入金定股數（審查 MEDIUM）', async () => {
  const days = mkDays(); const D = days[10].date;   // 2026-10-11 收盤；入金日 10-12 早上
  const db = fakeDb({ 'swingPicks/latest': { dataDate: D, mode: 'close', items: [{ code: '2222', name: 'B', tier: 2, price: 50 }] }, 'swingHold/latest': { dataDate: D, combo: { items: [] } } });
  let asked = 0;
  const lab = createAiSwingLab({ db, log: () => {}, dir: null, clock: () => Date.parse('2026-10-12T07:30:00+08:00'),
    askOllama: async () => { asked++; return '{"sells":[],"picks":[{"code":"2222","confidence":60,"horizon":"20","reason":"r","risk":"k"}],"note":"n"}'; },
    getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}), loadDays: async () => days.slice(0, 11),
    account: { colPath: 'aiSwingMembers/u3/days', snapPath: 'aiSwingMembers/u3/state/account', files: false, research: false,
      getSettings: async () => ({ initial: 0, flows: [{ date: '2026-10-12', amount: 200000, at: Date.parse('2026-10-12T07:20:00+08:00') }], goal: null }) } });
  assert.equal(await lab.pick(), true);
  assert.equal(asked, 1, '有呼叫 AI 決策');
  const doc = db.store[`aiSwingMembers/u3/days/${D}`];
  assert.ok(doc?.picks?.[0]?.position?.shares > 0, '以 07:20 入金的 20 萬定股數');
});

test('同一帳戶的快照寫入依序進行（三個排程並行呼叫也不重疊；審查 LOW）', async () => {
  const days = mkDays(); let running = 0, maxRunning = 0;
  const lab = createAiSwingLab({ db: fakeDb({}), log: () => {}, dir: null, askOllama: async () => '{}', getModelInfo: async () => ({ name: 'm' }), getRisk: async () => ({ disp: new Set(), attention: new Set() }), getIndustry: async () => ({}),
    loadDays: async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise(r => setTimeout(r, 15)); running--; return days.slice(0, 11); },
    account: { colPath: 'aiSwingMembers/u4/days', snapPath: 'aiSwingMembers/u4/state/account', files: false, research: false, getSettings: async () => ({ initial: 0, flows: [{ date: days[0].date, amount: 200000 }], goal: null }) } });
  await Promise.all([lab.writeAccount(), lab.writeAccount(), lab.writeAccount()]);
  assert.equal(maxRunning, 1);
});
