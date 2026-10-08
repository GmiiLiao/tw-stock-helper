// node --test scripts/lib/tpex-close-finmind.test.mjs
// 上櫃收盤第三方後備（FinMind）：token 讀取順序與不外洩、請求（標頭／逾時／402·401·403·429／空資料＝notYet）、
// 上櫃篩選（前一份官方集合 ∪ 權證碼型 ∪ Info 最新列＝tpex；排除上市、興櫃、已轉上市、指數列）、列格式轉換（0→'---'、量不換算）、
// 完整性驗證、排程（21:50／23:30、每日最多 2 次請求、當日停用、重啟不重打）、存 3P 不進官方鏈、官方到了記 supersededBy。
// 全部注入 fetch／requester，不打網路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tokenFromEnvText, readFinmindToken, redactToken, createFinmindRequester, selectOtcRows, toOpenapiRows, buildThirdPartyClose,
  createTpexThirdParty, modeOf, resolveMode, finmindScopesOf, startTpexThirdPartyTimer, REGISTRY_SCOPES,
  FINMIND_DATA_URL, THIRD_PARTY, MISSING_FIELDS, FALLBACK_POLICY,
} from './tpex-close-finmind.mjs';
import { createTpexClose } from './tpex-close-quotes.mjs';
import { synthOpenapi } from './tpex-close.fixture.mjs';

const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.FAKE-TEST-TOKEN.abcdefgh12345678';
const tmp = () => mkdtempSync(join(tmpdir(), 'tpex-3p-'));
const tw = (iso, hm) => Date.parse(`${iso}T${hm}:00+08:00`);
const SMALL = { minRows: 5, minStocks4: 3, minEtf00: 1 };
const D = '2026-10-08';
const PREV = '2026-10-07';
const N4 = 40;   // 4 碼股檔數：排除 1 檔已轉上市＝1/41＜3%（與前一份相比的缺漏門檻），排除 3 檔＞3%
const STOCKS = Array.from({ length: N4 }, (_, i) => String(1100 + i));

// ── 合成資料 ──
const fm = (iso, id, close = 10, extra = {}) => ({
  date: iso, stock_id: id, Trading_Volume: 1000, Trading_money: Math.round(1000 * close), open: close ? +(close - 0.1).toFixed(2) : 0,
  max: close ? +(close + 0.5).toFixed(2) : 0, min: close ? +(close - 0.2).toFixed(2) : 0, close, spread: close ? 0.1 : 0, Trading_turnover: 5, ...extra,
});
/** 官方上櫃檔（openapi 形狀）：1100–1139、006201、00679B、權證 700000–700002，另加 3092（10-08 起轉上市） */
function officialRows(roc) {
  const rows = synthOpenapi({ roc, n4: N4 });
  rows.push({ Date: roc, SecuritiesCompanyCode: '3092', CompanyName: '鴻碩', Close: '24.55', Change: '0.00', Open: '24.5', High: '24.6', Low: '24.4', TradingShares: '1000', TransactionAmount: '24550', TransactionNumber: '2', Capitals: '1000000' });
  return rows;
}
/** 前一份官方（10-07） */
const prevOfficialRows = () => officialRows('1151007');
/** FinMind 當日全市場（含上市、興櫃、已轉上市、指數列、上市權證、新上櫃股／ETF／權證） */
function priceRows(iso = D) {
  return [
    ...STOCKS.map((c, i) => fm(iso, c, 10 + i)),
    fm(iso, '006201', 20), fm(iso, '00679B', 30),
    fm(iso, '700000', 0, { Trading_Volume: 0, Trading_money: 0, Trading_turnover: 0 }), fm(iso, '700001', 0.3), fm(iso, '700002', 0, { Trading_Volume: 291 }),
    fm(iso, '3092', 24.15), fm(iso, '2330', 2550), fm(iso, '6999', 33), fm(iso, 'TPEx', 426.71), fm(iso, 'TAIEX', 23000),
    fm(iso, '4527', 55), fm(iso, '00992B', 15), fm(iso, '700099', 0.5), fm(iso, '030001', 1.2),
  ];
}
function infoRows() {
  const r = (id, type, date = D, name = `名${id}`) => ({ stock_id: id, stock_name: name, type, date, industry_category: 'x' });
  return [
    ...[...STOCKS, '006201', '00679B'].map(c => r(c, 'tpex')),
    r('2330', 'twse'), r('3092', 'tpex', '2021-05-15'), r('3092', 'twse'), r('3092', 'twse'), r('6999', 'emerging'),
    r('TPEx', 'tpex'), r('4527', 'tpex', D, '新上櫃'), r('00992B', 'tpex', D, '新債ETF'),
  ];
}
const codes = rows => rows.map(r => String(r.SecuritiesCompanyCode ?? r.stock_id)).sort();

// ── token ──
test('token：取第一個非空的 FINMIND_TOKEN 行（容許 export、引號、註解、空值行）', () => {
  assert.equal(tokenFromEnvText('A=1\nFINMIND_TOKEN=\n# FINMIND_TOKEN=nope\nexport FINMIND_TOKEN="abc123"\nFINMIND_TOKEN=second'), 'abc123');
  assert.equal(tokenFromEnvText("FINMIND_TOKEN='q1' \r\n"), 'q1');
  assert.equal(tokenFromEnvText('OTHER=1'), null);
  assert.equal(tokenFromEnvText(''), null);
});

test('token：repo 外設定檔存在就優先 → 環境變數 → .env.local；回傳只說來源類別、不帶路徑內容', () => {
  const dir = tmp();
  const cfg = join(dir, 'finmind.env'); const envLocal = join(dir, '.env.local');
  writeFileSync(envLocal, 'X=1\nFINMIND_TOKEN=from-env-local\n');
  assert.deepEqual(readFinmindToken({ env: {}, configPath: cfg, envLocalPath: envLocal }), { token: 'from-env-local', from: 'env-local' });
  assert.deepEqual(readFinmindToken({ env: { FINMIND_TOKEN: 'from-env' }, configPath: cfg, envLocalPath: envLocal }), { token: 'from-env', from: 'env' });
  writeFileSync(cfg, 'FINMIND_TOKEN=from-config\n');
  assert.deepEqual(readFinmindToken({ env: { FINMIND_TOKEN: 'from-env' }, configPath: cfg, envLocalPath: envLocal }), { token: 'from-config', from: 'config' });
  writeFileSync(cfg, '# 空\n');
  assert.equal(readFinmindToken({ env: {}, configPath: cfg, envLocalPath: envLocal }).from, 'env-local', '設定檔存在但沒有 token ⇒ 往下找');
  assert.deepEqual(readFinmindToken({ env: {}, configPath: join(dir, 'none'), envLocalPath: join(dir, 'none2') }), { token: null, from: null });
});

test('redactToken：全文、末 8 碼、token_tail 欄都抹掉', () => {
  const s = redactToken(`bad ${TOKEN} tail ${TOKEN.slice(-8)} {"token_tail":"${TOKEN.slice(-8)}"}`, TOKEN);
  assert.equal(s.includes(TOKEN), false); assert.equal(s.includes(TOKEN.slice(-8)), false);
  assert.match(s, /\[token\]/); assert.match(s, /token_tail/);
});

// ── 請求 ──
function fakeFetch(plan) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers || {}) }, signal: init.signal });
    const p = typeof plan === 'function' ? plan(String(url), calls.length - 1) : plan;
    if (p.throw) throw p.throw;
    return new Response(typeof p.body === 'string' ? p.body : JSON.stringify(p.body), { status: p.status || 200 });
  };
  f.calls = calls;
  return f;
}
const reqWith = (fetchImpl, over = {}) => {
  const dir = tmp(); const logPath = join(dir, 'requests.log');
  const rq = createFinmindRequester({ tokenReader: () => ({ token: TOKEN, from: 'env' }), fetchImpl, logPath, ...over });
  return { rq, logPath, dir };
};

test('請求：token 只在 Authorization: Bearer 標頭；URL 不帶 token、不帶 data_id；帶逾時；逐筆記錄（不含 token）', async () => {
  const f = fakeFetch({ body: { msg: 'success', status: 200, data: priceRows() } });
  const { rq, logPath } = reqWith(f);
  const r = await rq.request('TaiwanStockPrice', { start_date: D, end_date: D });
  assert.equal(r.status, 'ok'); assert.equal(r.rows.length, priceRows().length);
  const c = f.calls[0];
  assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
  const u = new URL(c.url);
  assert.equal(`${u.origin}${u.pathname}`, FINMIND_DATA_URL);
  assert.equal(u.searchParams.get('dataset'), 'TaiwanStockPrice'); assert.equal(u.searchParams.get('start_date'), D); assert.equal(u.searchParams.get('end_date'), D);
  assert.equal(u.searchParams.has('data_id'), false); assert.equal(c.url.includes(TOKEN), false);
  assert.ok(c.signal instanceof AbortSignal, '要帶逾時');
  const log = readFileSync(logPath, 'utf8');
  assert.equal(log.includes(TOKEN), false); assert.equal(log.includes(TOKEN.slice(-8)), false);
  assert.match(log, /TaiwanStockPrice/); assert.match(log, /"http":200/);
});

test('請求：token 不可放進參數；沒有 token ⇒ noToken、不發請求', async () => {
  const f = fakeFetch({ body: { msg: 'success', data: [] } });
  const { rq } = reqWith(f);
  await assert.rejects(() => rq.request('TaiwanStockPrice', { token: 'x' }), /token/);
  const { rq: rq2 } = reqWith(f, { tokenReader: () => ({ token: null, from: null }) });
  assert.equal((await rq2.request('TaiwanStockPrice', { start_date: D, end_date: D })).status, 'noToken');
  assert.equal(f.calls.length, 0);
});

test('請求：空 data＝notYet；402＝quota、401／403／TokenIllegal＝auth、429＝rate、5xx＝failed、逾時＝failed；錯誤訊息抹 token', async () => {
  const cases = [
    [{ body: { msg: 'success', status: 200, data: [] } }, 'notYet'],
    [{ status: 402, body: { msg: 'Requests reach the upper limit', status: 402 } }, 'quota'],
    [{ status: 401, body: { msg: 'unauthorized' } }, 'auth'],
    [{ status: 403, body: { msg: 'forbidden' } }, 'auth'],
    [{ status: 200, body: { msg: `TokenIllegal ${TOKEN}`, status: 400, token_tail: TOKEN.slice(-8) } }, 'auth'],
    [{ status: 429, body: 'Too Many Requests' }, 'rate'],
    [{ status: 503, body: 'x' }, 'failed'],
    [{ throw: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }, 'failed'],
    [{ status: 400, body: { msg: `bad ${TOKEN}`, status: 400, token_tail: TOKEN.slice(-8) } }, 'failed'],
  ];
  for (const [plan, want] of cases) {
    const { rq, logPath } = reqWith(fakeFetch(plan));
    const r = await rq.request('TaiwanStockPrice', { start_date: D, end_date: D });
    assert.equal(r.status, want, JSON.stringify(plan).slice(0, 80));
    assert.equal(String(r.reason).includes(TOKEN.slice(-8)), false, 'reason 不含 token 末 8 碼');
    assert.equal(readFileSync(logPath, 'utf8').includes(TOKEN.slice(-8)), false, '記錄不含 token 末 8 碼');
  }
});

test('請求：回聲——任何一列 date≠要的那天 ⇒ invalid（不收部分）', async () => {
  const rows = priceRows(); rows[3] = { ...rows[3], date: PREV };
  const { rq } = reqWith(fakeFetch({ body: { msg: 'success', data: rows } }));
  const r = await rq.request('TaiwanStockPrice', { start_date: D, end_date: D });
  assert.equal(r.status, 'ok', '請求層不判讀內容');
  const b = buildThirdPartyClose({ iso: D, priceRows: rows, infoRows: infoRows(), prevOfficial: { dataDate: PREV, rows: prevOfficialRows() }, limits: SMALL });
  assert.equal(b.status, 'invalid'); assert.match(b.reason, /date/);
});

// ── 篩選與轉換 ──
test('篩選（當天，有 Info）：前一份官方 ∪ 權證碼型 ∪ Info 最新列＝tpex；排除上市、興櫃、已轉上市、指數列、上市權證', () => {
  const s = selectOtcRows({ iso: D, priceRows: priceRows(), prevOfficialRows: prevOfficialRows(), infoRows: infoRows() });
  assert.deepEqual(codes(s.rows), [...STOCKS, '00679B', '006201', '00992B', '4527', '700000', '700001', '700002', '700099'].sort());
  assert.equal(s.method, 'prev+warrant+info');
  for (const c of ['2330', '3092', '6999', 'TPEx', 'TAIEX', '030001']) assert.ok(s.excluded.includes(c), c);
});

test('篩選（沒有 Info，例：補歷史日或 Info 額度用完）：只用前一份官方 ∪ 權證碼型；新上櫃股可能漏、要說出來', () => {
  const s = selectOtcRows({ iso: D, priceRows: priceRows(), prevOfficialRows: prevOfficialRows(), infoRows: null });
  assert.deepEqual(codes(s.rows), [...STOCKS, '00679B', '006201', '3092', '700000', '700001', '700002', '700099'].sort());
  assert.equal(s.method, 'prev+warrant');
  assert.match(s.note, /新上櫃/);
});

test('轉換：openapi 形狀；收盤 0 ⇒ 開高低收與漲跌都是 ---（有量無價列的量照留）；量為股、不換算；FinMind 沒有的欄不捏造', () => {
  const rows = toOpenapiRows([fm(D, '1100', 10.5, { spread: -0.25, Trading_turnover: 12.0000001 }), fm(D, '700002', 0, { Trading_Volume: 291 }), fm(D, '1101', 12, { spread: 0 })], { iso: D, nameOf: c => (c === '1100' ? '股0' : '') });
  const [a, b, c] = rows;
  assert.deepEqual(a, { Date: '1151008', SecuritiesCompanyCode: '1100', CompanyName: '股0', Close: '10.50', Change: '-0.25', Open: '10.40', High: '11.00', Low: '10.30', TradingShares: '1000', TransactionAmount: '10500', TransactionNumber: '12' });
  assert.equal(b.Close, '---'); assert.equal(b.Open, '---'); assert.equal(b.High, '---'); assert.equal(b.Low, '---'); assert.equal(b.Change, '---');
  assert.equal(b.TradingShares, '291'); assert.equal(b.CompanyName, '', '新權證沒有名稱就留空，不捏造');
  assert.equal(c.Change, '0.00');
  for (const f of MISSING_FIELDS) assert.equal(f in a, false, f);
  assert.ok(MISSING_FIELDS.includes('Capitals'));
});

test('組裝：驗證 ok（同一套門檻）＋文件標記 source=finmind、grade=3P、volumeBasis、missingFields；名稱先用前一份官方、再用 Info', () => {
  const b = buildThirdPartyClose({ iso: D, priceRows: priceRows(), infoRows: infoRows(), prevOfficial: { dataDate: PREV, rows: prevOfficialRows() }, limits: SMALL });
  assert.equal(b.status, 'ok', b.reason);
  assert.equal(b.meta.source, 'finmind'); assert.equal(b.meta.grade, '3P'); assert.equal(b.meta.volumeBasis, THIRD_PARTY.volumeBasis);
  assert.deepEqual(b.meta.missingFields, MISSING_FIELDS);
  assert.equal(b.meta.prevOfficial, PREV); assert.equal(b.meta.otcFilter, 'prev+warrant+info');
  const byCode = new Map(b.rows.map(r => [r.SecuritiesCompanyCode, r]));
  assert.equal(byCode.get('1100').CompanyName, '股0', '前一份官方名稱');
  assert.equal(byCode.get('4527').CompanyName, '新上櫃', 'Info 名稱');
  assert.equal(b.stats.dup, 0);
});

test('組裝：與前一份官方相比缺太多 4 碼股 ⇒ invalid；空資料 ⇒ notYet', () => {
  const few = priceRows().filter(r => !['1100', '1101', '1102'].includes(r.stock_id));
  const b = buildThirdPartyClose({ iso: D, priceRows: few, infoRows: infoRows(), prevOfficial: { dataDate: PREV, rows: prevOfficialRows() }, limits: { ...SMALL, minStocks4: 1 } });
  assert.equal(b.status, 'invalid'); assert.match(b.reason, /缺/);
  assert.equal(buildThirdPartyClose({ iso: D, priceRows: [], infoRows: null, prevOfficial: null, limits: SMALL }).status, 'notYet');
});

// ── 排程與存放 ──
function harness({ mode = 'publish', at = tw(D, '21:50'), plan, root = tmp(), seedPrev = true, tradingDay = () => true } = {}) {
  let t = at;
  const alerts = []; const published = []; const calls = [];
  const tpex = createTpexClose({ root, mirrorRoot: null, now: () => t, network: 'never', limits: SMALL, policy: { inboxSettleMs: 0 }, log: () => {} });
  const requester = { async request(dataset, params) { calls.push({ dataset, params, at: t }); return plan(dataset, calls.length - 1, params); } };
  const ctl = createTpexThirdParty({ tpex, mode, requester, now: () => t, isTradingDay: tradingDay, onAlert: (x, k) => alerts.push([x, k]), onPublish: r => { published.push(r); }, limits: SMALL, log: () => {} });
  const seed = async () => { if (seedPrev) await tpex.importBuffer(Buffer.from(JSON.stringify(prevOfficialRows())), { source: 'inbox', expect: PREV }); };
  return { tpex, ctl, alerts, published, calls, root, seed, set: v => { t = v; } };
}
const okPrice = () => ({ status: 'ok', http: 200, rows: priceRows() });
const okInfo = () => ({ status: 'ok', http: 200, rows: infoRows() });

test('模式：預設 off（不打任何請求）；env TPEX_CLOSE_3P＝local／publish 才開', async () => {
  assert.equal(modeOf({}), 'off'); assert.equal(modeOf({ TPEX_CLOSE_3P: 'publish' }), 'publish'); assert.equal(modeOf({ TPEX_CLOSE_3P: 'LOCAL' }), 'local'); assert.equal(modeOf({ TPEX_CLOSE_3P: 'yes' }), 'off');
  const h = harness({ mode: 'off', plan: () => okPrice() }); await h.seed();
  assert.equal((await h.ctl.tick(D)).status, 'off'); assert.equal(h.calls.length, 0);
});

test('21:50 前、非交易日、官方已到 ⇒ 0 請求', async () => {
  const h = harness({ at: tw(D, '21:49'), plan: () => okPrice() }); await h.seed();
  assert.equal((await h.ctl.tick(D)).status, 'wait');
  const nt = harness({ plan: () => okPrice(), tradingDay: () => false }); await nt.seed();
  assert.equal((await nt.ctl.tick(D)).status, 'skip');
  const off = harness({ plan: () => okPrice() }); await off.seed();
  await off.tpex.importBuffer(Buffer.from(JSON.stringify(officialRows('1151008'))), { source: 'dated', expect: D });
  assert.equal((await off.ctl.tick(D)).status, 'official');
  assert.equal(h.calls.length + nt.calls.length + off.calls.length, 0);
  assert.equal(FALLBACK_POLICY.firstMin, 21 * 60 + 50); assert.equal(FALLBACK_POLICY.retryMin, 23 * 60 + 30); assert.equal(FALLBACK_POLICY.maxRequests, 2);
});

test('21:50 官方仍缺：價格＋Info 共 2 次請求 → 存 3P（不進官方鏈）→ publish 模式發佈一次、告警一次；之後 0 請求', async () => {
  const h = harness({ plan: d => (d === 'TaiwanStockPrice' ? okPrice() : okInfo()) }); await h.seed();
  const r = await h.ctl.tick(D);
  assert.equal(r.status, '3P', r.reason);
  assert.deepEqual(h.calls.map(c => c.dataset), ['TaiwanStockPrice', 'TaiwanStockInfo']);
  assert.equal(h.published.length, 1);
  const p = h.published[0];
  assert.equal(p.grade, '3P'); assert.equal(p.source, 'finmind'); assert.equal(p.dataDate, D); assert.equal(p.volumeBasis, THIRD_PARTY.volumeBasis); assert.ok(p.sha256);
  assert.equal(h.alerts.length, 1); assert.doesNotMatch(h.alerts[0][0], /token/i);
  // 官方鏈看不到 3P：getTpexClose／getLatestTpexClose 照舊只回官方；發行股數不會被 3P（沒有 Capitals）蓋掉
  assert.notEqual((await h.tpex.getTpexClose(D)).status, 'ok');
  assert.equal((await h.tpex.getLatestTpexClose({ maxAgeDays: 30 })).dataDate, PREV);
  assert.equal(h.tpex.openapiRawFor('2026-10')?.dataDate, PREV, '官方鏡像收養只會拿到官方檔，不會拿到 3P');
  // 之後的 tick：0 請求、不重發佈
  h.set(tw(D, '22:30')); assert.equal((await h.ctl.tick(D)).status, '3P-cached');
  h.set(tw(D, '23:40')); await h.ctl.tick(D);
  assert.equal(h.calls.length, 2); assert.equal(h.published.length, 1); assert.equal(h.alerts.length, 1);
});

test('local 模式：存 3P 但不發佈（網站照舊）', async () => {
  const h = harness({ mode: 'local', plan: d => (d === 'TaiwanStockPrice' ? okPrice() : okInfo()) }); await h.seed();
  assert.equal((await h.ctl.tick(D)).status, '3P');
  assert.equal(h.published.length, 0); assert.equal(h.tpex.getThirdParty(D).grade, '3P');
});

test('21:50 FinMind 還沒有（空資料）→ 23:30 再試 1 次；第二次已用完額度 ⇒ 不打 Info、改用前一份官方＋權證碼型', async () => {
  let n = 0;
  const h = harness({ plan: d => { n++; return d === 'TaiwanStockPrice' ? (n === 1 ? { status: 'notYet', http: 200, rows: [] } : okPrice()) : okInfo(); } }); await h.seed();
  assert.equal((await h.ctl.tick(D)).status, 'tried');
  h.set(tw(D, '22:40')); await h.ctl.tick(D);
  assert.equal(h.calls.length, 1, '同一個時段不重打');
  h.set(tw(D, '23:30'));
  const r = await h.ctl.tick(D);
  assert.equal(r.status, '3P', r.reason);
  assert.deepEqual(h.calls.map(c => c.dataset), ['TaiwanStockPrice', 'TaiwanStockPrice']);
  assert.equal(h.tpex.getThirdParty(D).otcFilter, 'prev+warrant');
});

test('403／TokenIllegal ⇒ 當日停用＋告警一次（含交易日缺漏）；之後 0 請求', async () => {
  const h = harness({ plan: () => ({ status: 'auth', http: 403, rows: null, reason: 'HTTP 403' }) }); await h.seed();
  assert.equal((await h.ctl.tick(D)).status, 'disabled');
  h.set(tw(D, '23:30')); assert.equal((await h.ctl.tick(D)).status, 'disabled');
  assert.equal(h.calls.length, 1);
  assert.equal(h.alerts.length, 1); assert.match(h.alerts[0][0], /缺漏/);
});

test('429 → 23:30 再試仍 429 ⇒ 當日停用＋交易日缺漏告警（不捏造、不發佈）', async () => {
  const h = harness({ plan: () => ({ status: 'rate', http: 429, rows: null, reason: 'HTTP 429' }) }); await h.seed();
  assert.equal((await h.ctl.tick(D)).status, 'tried'); assert.equal(h.alerts.length, 0, '第一次失敗還有 23:30，不先告警');
  h.set(tw(D, '23:30')); assert.equal((await h.ctl.tick(D)).status, 'disabled');
  assert.equal(h.calls.length, 2); assert.equal(h.published.length, 0);
  assert.equal(h.alerts.length, 1); assert.match(h.alerts[0][0], /缺漏/);
  h.set(tw(D, '23:50')); await h.ctl.tick(D); assert.equal(h.calls.length, 2);
});

test('重啟不重打：狀態落地；新的控制器同一天 21:55 不再請求', async () => {
  const root = tmp();
  const h1 = harness({ root, plan: () => ({ status: 'notYet', http: 200, rows: [] }) }); await h1.seed();
  await h1.ctl.tick(D);
  const h2 = harness({ root, at: tw(D, '21:55'), plan: () => okPrice(), seedPrev: false });
  assert.equal((await h2.ctl.tick(D)).status, 'waiting');
  assert.equal(h2.calls.length, 0);
});

test('官方之後到了：官方存進快取時 3P 記 supersededBy；控制器回 official、不再發佈 3P', async () => {
  const h = harness({ plan: d => (d === 'TaiwanStockPrice' ? okPrice() : okInfo()) }); await h.seed();
  await h.ctl.tick(D);
  await h.tpex.importBuffer(Buffer.from(JSON.stringify(officialRows('1151008'))), { source: 'dated', expect: D });
  const tp = h.tpex.getThirdParty(D);
  assert.equal(tp.supersededBy.source, 'dated'); assert.ok(tp.supersededBy.sha256);
  h.set(tw(D, '22:10')); assert.equal((await h.ctl.tick(D)).status, 'official');
  assert.equal(h.published.length, 1);
  // 官方已在時 3P 不可再寫入
  const again = await h.tpex.storeThirdParty({ iso: D, rows: buildThirdPartyClose({ iso: D, priceRows: priceRows(), infoRows: infoRows(), prevOfficial: { dataDate: PREV, rows: prevOfficialRows() }, limits: SMALL }).rows, meta: {} });
  assert.equal(again.stored, false);
});

test('驗證不過 ⇒ 不存、不發佈；第二個時段也失敗 ⇒ 交易日缺漏告警', async () => {
  const bad = () => ({ status: 'ok', http: 200, rows: priceRows().filter(r => !['1100', '1101', '1102'].includes(r.stock_id)) });
  const h = harness({ plan: d => (d === 'TaiwanStockPrice' ? bad() : okInfo()) }); await h.seed();
  assert.equal((await h.ctl.tick(D)).status, 'tried');
  assert.equal(h.tpex.getThirdParty(D), null); assert.equal(h.published.length, 0);
  h.set(tw(D, '23:31')); await h.ctl.tick(D);
  assert.equal(h.alerts.filter(a => /缺漏/.test(a[0])).length, 1);
  assert.ok(existsSync(join(h.root, '_thirdparty', 'state.json')));
});

test('沒有 token ⇒ 當日停用、告警（不印 token 來源檔內容）、0 請求', async () => {
  const root = tmp(); mkdirSync(root, { recursive: true });
  const tpex = createTpexClose({ root, mirrorRoot: null, now: () => tw(D, '21:50'), network: 'never', limits: SMALL, log: () => {} });
  await tpex.importBuffer(Buffer.from(JSON.stringify(prevOfficialRows())), { source: 'inbox', expect: PREV });
  const f = fakeFetch({ body: { msg: 'success', data: priceRows() } });
  const alerts = [];
  const ctl = createTpexThirdParty({ tpex, mode: 'publish', requester: createFinmindRequester({ tokenReader: () => ({ token: null, from: null }), fetchImpl: f, logPath: join(root, 'r.log') }), now: () => tw(D, '21:50'), onAlert: x => alerts.push(x), limits: SMALL, log: () => {} });
  assert.equal((await ctl.tick(D)).status, 'disabled');
  assert.equal(f.calls.length, 0); assert.equal(alerts.length, 1); assert.match(alerts[0], /token/i);
});

test('發佈沒成功（onPublish 回 false：另一個寫入進行中／Firestore 失敗）⇒ 下一輪再發佈，不會因記憶體標記而永遠跳過', async () => {
  const root = tmp(); let t = tw(D, '21:50');
  const tpex = createTpexClose({ root, mirrorRoot: null, now: () => t, network: 'never', limits: SMALL, log: () => {} });
  await tpex.importBuffer(Buffer.from(JSON.stringify(prevOfficialRows())), { source: 'inbox', expect: PREV });
  const tries = [];
  const requester = { async request(d) { return d === 'TaiwanStockPrice' ? okPrice() : okInfo(); } };
  const ctl = createTpexThirdParty({ tpex, mode: 'publish', requester, now: () => t, onPublish: r => { tries.push(r.sha256); return tries.length > 1; }, limits: SMALL, log: () => {} });
  assert.equal((await ctl.tick(D)).status, '3P');
  t = tw(D, '21:53'); await ctl.tick(D);
  assert.equal(tries.length, 2, '第一次回 false ⇒ 下一輪（節流後）再發佈');
  t = tw(D, '21:56'); await ctl.tick(D);
  assert.equal(tries.length, 2, '成功後不再重發');
});

// ── 2026-10-08 審查修正 ──
/** 181 字元的假 token（長度同正式 token；內容與正式 token 無關） */
const LONG_TOKEN = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${'Q'.repeat(20)}${'abcdefghij'.repeat(10)}.${'Z9y8X7w6V5'.repeat(2)}${'k'.repeat(3)}`;
const fragments16 = t => Array.from({ length: t.length - 15 }, (_, i) => t.slice(i, i + 16));
const leaks = (s, t) => fragments16(t).some(f => String(s).includes(f));

test('redactToken：先抹再截——長前綴＋完整 token、只回聲前段（被截斷）、JWT 型字串，都不留任何 ≥16 字的 token 片段', () => {
  assert.equal(LONG_TOKEN.length, 181);
  const long = `Your token is illegal, please check: ${'x'.repeat(120)} ${LONG_TOKEN} end`;
  const s1 = redactToken(long, LONG_TOKEN);
  assert.equal(leaks(s1, LONG_TOKEN), false); assert.match(s1, /\[token\]/);
  const s2 = redactToken(`cut: ${LONG_TOKEN.slice(0, 60)}`, LONG_TOKEN);
  assert.equal(leaks(s2, LONG_TOKEN), false, 'token 前 60 字（上游截斷）也要抹');
  const s3 = redactToken(`other jwt eyJabc123def456ghi.eyJpayload-part_x.sig-part_y and ok`, LONG_TOKEN);
  assert.doesNotMatch(s3, /eyJabc123def456ghi/); assert.match(s3, /and ok/);
  assert.equal(redactToken('no token here', LONG_TOKEN), 'no token here');
});

test('請求：上游回聲「長前綴＋完整 token」⇒ reason 與記錄都不含 token 任何 ≥16 字片段（先抹再截）', async () => {
  const msg = `Your token is illegal, please check: ${LONG_TOKEN}`;
  for (const plan of [{ status: 402, body: { msg } }, { status: 403, body: { msg } }, { status: 200, body: { msg: `TokenIllegal ${'y'.repeat(150)} ${LONG_TOKEN}` } }, { status: 500, body: `<html>${'p'.repeat(300)}${LONG_TOKEN}</html>` }]) {
    const dir = tmp(); const logPath = join(dir, 'requests.log');
    const rq = createFinmindRequester({ tokenReader: () => ({ token: LONG_TOKEN, from: 'env' }), fetchImpl: fakeFetch(plan), logPath });
    const r = await rq.request('TaiwanStockPrice', { start_date: D, end_date: D });
    assert.equal(leaks(r.reason, LONG_TOKEN), false, `reason：${JSON.stringify(plan).slice(0, 40)}`);
    assert.equal(leaks(readFileSync(logPath, 'utf8'), LONG_TOKEN), false, '記錄');
  }
});

test('告警文字不出現 FinMind 字樣與 HTTP 細節（只寫「第三方後備」）；細節只留日誌', async () => {
  const scenarios = [
    () => ({ status: 'auth', http: 403, rows: null, reason: 'HTTP 403 FinMind says no' }),
    () => ({ status: 'quota', http: 402, rows: null, reason: 'HTTP 402 FinMind upper limit' }),
    () => ({ status: 'rate', http: 429, rows: null, reason: 'HTTP 429' }),
    () => ({ status: 'failed', http: 503, rows: null, reason: 'HTTP 503 finmind down' }),
    () => ({ status: 'ok', http: 200, rows: priceRows().filter(r => !['1100', '1101', '1102'].includes(r.stock_id)) }),
  ];
  for (const sc of scenarios) {
    const h = harness({ plan: d => (d === 'TaiwanStockPrice' ? sc() : okInfo()) }); await h.seed();
    await h.ctl.tick(D); h.set(tw(D, '23:30')); await h.ctl.tick(D);
    assert.ok(h.alerts.length >= 1, '要告警');
    for (const [text] of h.alerts) { assert.doesNotMatch(text, /finmind/i, text); assert.doesNotMatch(text, /HTTP \d{3}/, text); assert.match(text, /第三方後備/); }
  }
  // 沒有 token
  const root = tmp();
  const tpex = createTpexClose({ root, mirrorRoot: null, now: () => tw(D, '21:50'), network: 'never', limits: SMALL, log: () => {} });
  await tpex.importBuffer(Buffer.from(JSON.stringify(prevOfficialRows())), { source: 'inbox', expect: PREV });
  const alerts = [];
  const ctl = createTpexThirdParty({ tpex, mode: 'local', requester: { request: async () => ({ status: 'noToken', http: null, rows: null, reason: 'FinMind token 未設定' }) }, now: () => tw(D, '21:50'), onAlert: x => alerts.push(x), limits: SMALL, log: () => {} });
  await ctl.tick(D);
  assert.equal(alerts.length, 1); assert.doesNotMatch(alerts[0], /finmind/i); assert.match(alerts[0], /token|憑證/i);
  // 成功告警
  const ok = harness({ plan: d => (d === 'TaiwanStockPrice' ? okPrice() : okInfo()) }); await ok.seed();
  await ok.ctl.tick(D);
  assert.doesNotMatch(ok.alerts[0][0], /finmind/i);
});

test('每日上限不只靠狀態檔：狀態檔寫不進去 ⇒ fail-closed（0 請求、當日停用、告警一次）；21:50→23:55 每 5 分鐘 tick 也不再打', async () => {
  const root = tmp(); const blocker = join(root, 'not-a-dir');
  writeFileSync(blocker, 'x');   // statePath 的父層是檔案 ⇒ mkdir／寫入一定失敗
  let t = tw(D, '21:50');
  const tpex = createTpexClose({ root, mirrorRoot: null, now: () => t, network: 'never', limits: SMALL, log: () => {} });
  await tpex.importBuffer(Buffer.from(JSON.stringify(prevOfficialRows())), { source: 'inbox', expect: PREV });
  const calls = []; const alerts = [];
  const requester = { async request(d) { calls.push(d); return { status: 'notYet', http: 200, rows: [] }; } };
  const ctl = createTpexThirdParty({ tpex, mode: 'local', requester, now: () => t, statePath: join(blocker, 'state.json'), onAlert: x => alerts.push(x), limits: SMALL, log: () => {} });
  for (let m = 21 * 60 + 50; m <= 23 * 60 + 55; m += 5) { t = tw(D, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); await ctl.tick(D); }
  assert.equal(calls.length, 0, '無法記錄請求次數 ⇒ 不請求');
  assert.equal(alerts.length, 1); assert.match(alerts[0], /缺漏/);
});

test('每日上限不只靠狀態檔：狀態檔每輪被刪（讀回失敗）⇒ 記憶體計數仍守住 2 次', async () => {
  const root = tmp(); const sp = join(root, '_thirdparty', 'state.json');
  let t = tw(D, '21:50');
  const tpex = createTpexClose({ root, mirrorRoot: null, now: () => t, network: 'never', limits: SMALL, log: () => {} });
  await tpex.importBuffer(Buffer.from(JSON.stringify(prevOfficialRows())), { source: 'inbox', expect: PREV });
  const calls = [];
  const requester = { async request(d) { calls.push(d); return { status: 'notYet', http: 200, rows: [] }; } };
  const ctl = createTpexThirdParty({ tpex, mode: 'local', requester, now: () => t, statePath: sp, onAlert: () => {}, limits: SMALL, log: () => {} });
  const { rmSync } = await import('node:fs');
  for (let m = 21 * 60 + 50; m <= 23 * 60 + 55; m += 5) {
    t = tw(D, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    await ctl.tick(D);
    rmSync(sp, { force: true });
  }
  assert.ok(calls.length <= FALLBACK_POLICY.maxRequests, `請求 ${calls.length} 次`);
  assert.equal(calls.length, 2, '21:50 與 23:30 各一次');
});

test('官方網路下載仍在進行（tpex.isFetching）⇒ busy：不打第三方、不發佈已存的 3P', async () => {
  const h = harness({ plan: d => (d === 'TaiwanStockPrice' ? okPrice() : okInfo()) }); await h.seed();
  let fetching = true;
  h.tpex.isFetching = iso => fetching && iso === D;
  assert.equal((await h.ctl.tick(D)).status, 'busy');
  assert.equal(h.calls.length, 0);
  fetching = false;
  assert.equal((await h.ctl.tick(D)).status, '3P');
  assert.equal(typeof createTpexClose({ root: tmp(), mirrorRoot: null, network: 'never', log: () => {} }).isFetching, 'function', '取得層要提供 isFetching');
});

test('跨日收尾：D 第一時段沒拿到、23:30 前 daemon 沒再跑 ⇒ D+1 第一次 tick 補發一次「交易日缺漏」告警；D 已有 3P 或官方則不發', async () => {
  const root = tmp();
  const h = harness({ root, plan: () => ({ status: 'notYet', http: 200, rows: [] }) }); await h.seed();
  await h.ctl.tick(D);
  assert.equal(h.alerts.length, 0);
  // 隔天（週五→週六也一樣要收尾）：新程序（重啟）
  const h2 = harness({ root, at: tw('2026-10-09', '00:05'), plan: () => okPrice(), seedPrev: false });
  await h2.ctl.tick('2026-10-09');
  assert.equal(h2.alerts.length, 1); assert.match(h2.alerts[0][0], /2026-10-08/); assert.match(h2.alerts[0][0], /缺漏/);
  await h2.ctl.tick('2026-10-09'); h2.set(tw('2026-10-09', '00:20')); await h2.ctl.tick('2026-10-09');
  assert.equal(h2.alerts.length, 1, '只發一次'); assert.equal(h2.calls.length, 0, '收尾不打請求');
  // 同一個程序跨日（記憶體狀態）
  const h3 = harness({ plan: () => ({ status: 'notYet', http: 200, rows: [] }) }); await h3.seed();
  await h3.ctl.tick(D); h3.set(tw('2026-10-09', '00:02')); await h3.ctl.tick('2026-10-09');
  assert.equal(h3.alerts.length, 1);
  // D 已存 3P ⇒ 不發
  const h4 = harness({ plan: d => (d === 'TaiwanStockPrice' ? okPrice() : okInfo()) }); await h4.seed();
  await h4.ctl.tick(D); const n4 = h4.alerts.length; h4.set(tw('2026-10-09', '00:02')); await h4.ctl.tick('2026-10-09');
  assert.equal(h4.alerts.length, n4);
  // D 官方晚到 ⇒ 不發
  const h5 = harness({ plan: () => ({ status: 'notYet', http: 200, rows: [] }) }); await h5.seed();
  await h5.ctl.tick(D);
  await h5.tpex.importBuffer(Buffer.from(JSON.stringify(officialRows('1151008'))), { source: 'dated', expect: D });
  h5.set(tw('2026-10-09', '00:02')); await h5.ctl.tick('2026-10-09');
  assert.equal(h5.alerts.length, 0);
});

test('模式要對應 source-registry 核准範圍：沒有 legitimacy.scopes 就強制 off（含 local）；publish 範圍涵蓋 local', () => {
  const reg = scopes => ({ sources: [{ host: 'api.finmindtrade.com', legitimacy: { status: 'approved', ...(scopes ? { scopes } : {}) } }] });
  assert.deepEqual(finmindScopesOf(reg(null)), []);
  assert.deepEqual(finmindScopesOf({ sources: [{ host: 'api.finmindtrade.com', legitimacy: { status: 'pending', scopes: [REGISTRY_SCOPES.publish] } }] }), [], '未核准不算');
  const m = (env, r) => resolveMode({ env: { TPEX_CLOSE_3P: env }, registry: r });
  assert.equal(m('publish', reg(null)).mode, 'off'); assert.match(m('publish', reg(null)).reason, /source-registry/);
  assert.equal(m('local', reg(null)).mode, 'off', 'local 也要核准（Sponsor 非商業授權；營運用途待裁定）');
  assert.equal(m('local', null).mode, 'off', '登錄檔讀不到 ⇒ off');
  assert.equal(m('local', reg([REGISTRY_SCOPES.local])).mode, 'local');
  assert.equal(m('publish', reg([REGISTRY_SCOPES.local])).mode, 'off', '只核准 local 不可 publish');
  assert.equal(m('publish', reg([REGISTRY_SCOPES.publish])).mode, 'publish');
  assert.equal(m('local', reg([REGISTRY_SCOPES.publish])).mode, 'local');
  assert.equal(m('', reg([REGISTRY_SCOPES.publish])).mode, 'off', 'env 沒開就是 off');
  assert.equal(resolveMode({ env: {}, registry: reg([REGISTRY_SCOPES.publish]) }).requested, 'off');
});

test('獨立計時器：不受 daemon 循序迴圈阻塞；每拍以「現在」的台北日期呼叫 tick；模式 off 不啟動；前一拍未完不重入', async () => {
  let fn = null; let ms = null; let unref = false;
  const fakeSetInterval = (f, m) => { fn = f; ms = m; return { unref: () => { unref = true; } }; };
  const ticks = []; let release;
  const ctl = { mode: 'local', tick: iso => { ticks.push(iso); return new Promise(r => { release = r; }); } };
  let t = tw(D, '23:30');
  const h = startTpexThirdPartyTimer({ ctl, now: () => t, setIntervalImpl: fakeSetInterval, log: () => {} });
  assert.ok(h); assert.ok(ms > 0 && ms <= 5 * 60_000); assert.equal(unref, true);
  fn(); fn();
  assert.deepEqual(ticks, [D], '前一拍未完不重入');
  release({ status: 'tried' }); await new Promise(r => setImmediate(r));
  t = tw('2026-10-09', '00:01'); fn();
  assert.deepEqual(ticks, [D, '2026-10-09']);
  assert.equal(startTpexThirdPartyTimer({ ctl: { mode: 'off', tick: () => {} }, setIntervalImpl: fakeSetInterval }), null);
});

test('daemon 接線：tick 只由獨立計時器呼叫（dailyJobsLoop 內不呼叫，避免被 23:00 盤後新聞趟等長任務卡到午夜後）；模式經 source-registry 閘門', () => {
  const src = readFileSync(new URL('../ai-daemon.mjs', import.meta.url), 'utf8');
  assert.equal(/_tpex3P\.tick\(/.test(src), false, 'daemon 不可直接呼叫 _tpex3P.tick');
  assert.match(src, /startTpexThirdPartyTimer\(/);
  assert.match(src, /resolveMode|resolveTpex3PMode/);
});
