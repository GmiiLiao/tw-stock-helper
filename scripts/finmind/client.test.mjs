// FinMind 用戶端（假 fetch，不打網路）單元測試：node --test scripts/finmind/client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFinMindClient, buildUrl, classifyHttp, FinMindError, API_BASE } from './client.mjs';

const TOKEN = 'eyFAKEtokenvaluexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxTAIL1234';
const enc = new TextEncoder();

function resp(status, text, { chunk = 0 } = {}) {
  const bytes = enc.encode(text);
  const body = chunk ? (async function* () { for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk); })() : null;
  return { status, ok: status >= 200 && status < 300, body, text: async () => text };
}

function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(url, init) : step;
  };
  fn.calls = calls;
  return fn;
}

function collectSink() {
  const got = [];
  const make = () => {
    const mine = [];
    return { async write(rows) { mine.push(...rows); }, async end() { got.push(mine); return mine.length; }, abort() { mine.length = 0; } };
  };
  return { make, got };
}

const OK = JSON.stringify({ msg: 'success', status: 200, data: [{ date: '2026-10-07', stock_id: '2330', close: 2585 }, { date: '2026-10-07', stock_id: '2330', close: 2590 }] });
const base = (o = {}) => ({ token: TOKEN, sleep: async () => {}, now: () => 0, ...o });
const job = { endpoint: 'data', params: { dataset: 'TaiwanStockKBar', data_id: '2330', start_date: '2026-10-07' }, label: 'k' };

test('buildUrl：參數進 query、token 不准進 URL；classifyHttp 分類', () => {
  assert.equal(buildUrl('data', { dataset: 'X', start_date: '2026-10-07', end_date: null }), `${API_BASE}/data?dataset=X&start_date=2026-10-07`);
  assert.throws(() => buildUrl('data', { token: 'x' }), /token/);
  assert.throws(() => buildUrl('../x', {}), /endpoint/);
  assert.deepEqual([400, 401, 402, 403, 429, 500, 503].map(classifyHttp), ['param', 'auth', 'quota', 'auth', 'rate', 'server', 'server']);
});

test('成功：token 只在 Authorization: Bearer 標頭、串流切列交給 sink、記錄不含 token', async () => {
  const f = fakeFetch([resp(200, OK, { chunk: 7 })]);
  const logs = [];
  const c = createFinMindClient(base({ fetchImpl: f, log: r => logs.push(r) }));
  const s = collectSink();
  const r = await c.fetchRows(job, s.make);
  assert.equal(r.rows, 2); assert.equal(r.result, 2);
  assert.deepEqual(s.got[0].map(x => JSON.parse(x).close), [2585, 2590]);
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!f.calls[0].url.includes(TOKEN));
  assert.match(f.calls[0].headers['User-Agent'], /TW-Stock-App/);
  assert.equal(logs.length, 1); assert.equal(logs[0].http, 200); assert.equal(logs[0].rows, 2);
  assert.ok(!JSON.stringify(logs).includes(TOKEN) && !JSON.stringify(logs).includes(TOKEN.slice(-8)));
});

test('HTTP 400：不重試、錯誤與記錄都抹掉 token_tail', async () => {
  const f = fakeFetch([resp(400, JSON.stringify({ msg: 'date parameter is missing.', status: 400, token_tail: TOKEN.slice(-8) }))]);
  const logs = [];
  const c = createFinMindClient(base({ fetchImpl: f, log: r => logs.push(r) }));
  await assert.rejects(c.fetchRows(job, collectSink().make), e => e instanceof FinMindError && e.kind === 'param' && /date parameter/.test(e.message) && !e.message.includes(TOKEN.slice(-8)));
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(logs).includes(TOKEN.slice(-8)));
});

test('HTTP 402／403：不重試，分別回報 quota／auth；HTTP 200 但內文 status=402 也算 quota', async () => {
  for (const [st, kind] of [[402, 'quota'], [403, 'auth']]) {
    const f = fakeFetch([resp(st, JSON.stringify({ msg: 'x', status: st }))]);
    await assert.rejects(createFinMindClient(base({ fetchImpl: f })).fetchRows(job, collectSink().make), e => e.kind === kind);
    assert.equal(f.calls.length, 1);
  }
  const f = fakeFetch([resp(200, JSON.stringify({ msg: 'Requests reach the upper limit.', status: 402 }))]);
  await assert.rejects(createFinMindClient(base({ fetchImpl: f })).fetchRows(job, collectSink().make), e => e.kind === 'quota');
});

test('HTTP 429：照退避表等待後重試，成功就回傳；sink 每次重來（不殘留上一次的半份）', async () => {
  const waits = [];
  const f = fakeFetch([resp(429, '{"msg":"slow","status":429}'), resp(200, OK)]);
  const s = collectSink();
  const c = createFinMindClient(base({ fetchImpl: f, sleep: async ms => { waits.push(ms); }, retry: { rate: [111, 222], server: [5] } }));
  const r = await c.fetchRows(job, s.make);
  assert.equal(r.rows, 2); assert.equal(r.attempt, 2); assert.deepEqual(waits, [111]);
});

test('5xx／網路錯誤／截斷的回應：重試到用完退避表後丟出', async () => {
  const waits = [];
  const f = fakeFetch([resp(503, 'busy'), new TypeError('fetch failed'), resp(200, OK.slice(0, 40), { chunk: 5 })]);
  const c = createFinMindClient(base({ fetchImpl: f, sleep: async ms => { waits.push(ms); }, retry: { server: [1, 2], rate: [] } }));
  await assert.rejects(c.fetchRows(job, collectSink().make), e => e.kind === 'truncated' && e.attempts === 3);
  assert.deepEqual(waits, [1, 2]);
  assert.equal(f.calls.length, 3);
});

test('逾時：回報 timeout（可重試類）', async () => {
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
  const f = fakeFetch([hang]);
  const c = createFinMindClient(base({ fetchImpl: f, timeoutMs: 20, retry: { server: [], rate: [] } }));
  await assert.rejects(c.fetchRows(job, collectSink().make), e => e.kind === 'timeout');
});

test('停止訊號：等待中收到 abort 立刻丟 aborted、不再發請求', async () => {
  const ac = new AbortController();
  const f = fakeFetch([resp(503, 'x')]);
  const c = createFinMindClient({ token: TOKEN, fetchImpl: f, now: () => 0, signal: ac.signal, retry: { server: [60e3], rate: [] } });
  const p = c.fetchRows(job, collectSink().make);
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, e => e.kind === 'aborted');
  assert.equal(f.calls.length, 1);
});

test('限速：送出前先等 limiter.waitMs()，每次嘗試都登記', async () => {
  const waits = []; let recorded = 0; const queue = [300, 0];
  const limiter = { waitMs: () => queue.shift() ?? 0, record: () => { recorded++; } };
  const c = createFinMindClient(base({ fetchImpl: fakeFetch([resp(200, OK)]), limiter, sleep: async ms => { waits.push(ms); } }));
  await c.fetchRows(job, collectSink().make);
  assert.deepEqual(waits, [300]); assert.equal(recorded, 1);
});

test('userInfo：回 level、user_count、每小時上限；內容抹除 token 欄位；網路錯誤回 ok=false 不丟出', async () => {
  const body = { level: 3, level_title: 'Sponsor', user_count: 54, api_request_limit_hour: 6000, api_request_limit_day: '-', token: TOKEN, token_tail: TOKEN.slice(-8) };
  const logs = [];
  const c = createFinMindClient(base({ fetchImpl: fakeFetch([resp(200, JSON.stringify(body))]), log: r => logs.push(r) }));
  const u = await c.userInfo();
  assert.equal(u.ok, true); assert.equal(u.level, 3); assert.equal(u.info.user_count, 54); assert.equal(u.info.api_request_limit_hour, 6000);
  assert.ok(!JSON.stringify(u).includes(TOKEN.slice(-8)));
  assert.ok(!JSON.stringify(logs).includes(TOKEN.slice(-8)));
  const bad = await createFinMindClient(base({ fetchImpl: fakeFetch([new TypeError(`boom ${TOKEN}`)]) })).userInfo();
  assert.equal(bad.ok, false); assert.ok(!JSON.stringify(bad).includes(TOKEN));
});

test('沒有 token 不建立用戶端', () => {
  assert.throws(() => createFinMindClient({ token: '' }), /token/);
});

test('本機寫入失敗（例如磁碟滿）：標成 local、不重試', async () => {
  const f = fakeFetch([resp(200, OK)]);
  const c = createFinMindClient(base({ fetchImpl: f, retry: { server: [1, 1], rate: [] } }));
  const make = () => ({ async write() { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; }, async end() {}, abort() {} });
  await assert.rejects(c.fetchRows(job, make), e => e.kind === 'local' && /ENOSPC/.test(e.message));
  assert.equal(f.calls.length, 1);
});
