// node --test scripts/lib/tpex-close-quotes.test.mjs
// 共用取得層：收件匣合法／不合法檔、快取命中 0 請求、帶日期優先＋回聲 notYet、停滯後 16:00 才退 openapi、Range 續傳、304、
// 封鎖當日停用、退避、請求間隔 ≥3 秒（含多個日期同時要）、19:00 告警、鏡像唯讀、官方重產記版本、無主鎖清除／空鎖檔不搶、
// 14:45 前今日檔 0 請求與出檔窗 2 分鐘再試、收件匣略過下載中的檔、手動腳本拒收由 daemon 補發告警。全部注入 fetch，不打網路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTpexClose, MIRROR_IDS } from './tpex-close-quotes.mjs';
import { synthOpenapi, datedPayload, mockFetch, realFullFixture, truncatedFixture } from './tpex-close.fixture.mjs';
import { OPENAPI_URL, parseTpexClose } from './tpex-close-parse.mjs';

const REAL = realFullFixture();
const TRUNC = truncatedFixture(REAL?.buf);

const SMALL = { minRows: 5, minStocks4: 3, minEtf00: 1 };
const tw = (iso, hm) => Date.parse(`${iso}T${hm}:00+08:00`);
const tmp = () => mkdtempSync(join(tmpdir(), 'tpex-close-'));
const FAST_DL = { ttfbMs: 300, stallMs: 80, capMs: 3000, tickMs: 10 };
const backdate = (p, sec = 120) => { const d = new Date(Date.now() - sec * 1000); utimesSync(p, d, d); };

function make(over = {}) {
  let t = over.at ?? tw('2026-10-08', '20:00');
  const alerts = []; const waits = [];
  const svc = createTpexClose({ root: over.root || tmp(), mirrorRoot: over.mirrorRoot ?? null, now: () => t, network: over.network || 'never', limits: SMALL,
    policy: { inboxSettleMs: 0, ...(over.policy || {}) },
    fetchImpl: over.fetchImpl, onAlert: over.noAlert ? undefined : (x, k) => alerts.push([x, k]), sleep: async ms => { waits.push(ms); t += ms; }, download: FAST_DL, log: () => {} });
  return { svc, alerts, waits, set: v => { t = v; }, get t() { return t; } };
}

test('收件匣：合法檔（使用者下載的任意檔名）→ 驗證採用、移到 _done、快取有該資料日', async () => {
  const { svc } = make();
  mkdirSync(join(svc.root, '_inbox'), { recursive: true });
  writeFileSync(join(svc.root, '_inbox', 'tpex_mainboard_daily_close_quotes (1).json'), JSON.stringify(synthOpenapi()));
  const r = await svc.ingestInbox();
  assert.equal(r.accepted.length, 1); assert.equal(r.rejected.length, 0); assert.equal(r.accepted[0].dataDate, '2026-10-08');
  assert.deepEqual(readdirSync(join(svc.root, '_inbox')).filter(n => n !== '_done'), []);
  assert.equal(readdirSync(join(svc.root, '_inbox', '_done')).length, 1);
  const g = await svc.getTpexClose('20261008');
  assert.equal(g.status, 'ok'); assert.equal(g.source, 'inbox'); assert.equal(g.rows.length, synthOpenapi().length);
});

test('收件匣：截斷／非櫃買檔／週末資料日 → 改名 .rejected＋說明檔、告警；不進快取', async () => {
  const { svc, alerts } = make();
  const inbox = join(svc.root, '_inbox'); mkdirSync(inbox, { recursive: true });
  const full = JSON.stringify(synthOpenapi());
  writeFileSync(join(inbox, 'cut.json'), full.slice(0, 300));
  writeFileSync(join(inbox, 'other.json'), JSON.stringify({ hello: 1 }));
  writeFileSync(join(inbox, 'weekend.json.gz'), gzipSync(JSON.stringify(synthOpenapi({ roc: '1151010' }))));
  const r = await svc.ingestInbox();
  assert.equal(r.accepted.length, 0); assert.equal(r.rejected.length, 3);
  for (const n of ['cut.json', 'other.json', 'weekend.json.gz']) {
    assert.ok(existsSync(join(inbox, `${n}.rejected`)), n);
    assert.match(readFileSync(join(inbox, `${n}.rejected.txt`), 'utf8'), /拒收：.+\n[\s\S]*tpex-close-import/);
  }
  assert.equal(alerts.length, 3);
  assert.equal((await svc.getTpexClose('2026-10-08')).status, 'missing');
  assert.equal((await svc.ingestInbox()).rejected.length, 0, '拒收檔不重複處理');
});

test('收件匣：真實完整檔被採用（預設門檻；快取存原始位元組、sha256 與原檔相同）；截斷檔拒收', { skip: REAL ? false : '本機沒有任何真實完整檔——略過' }, async () => {
  const root = tmp();
  const echo = parseTpexClose(REAL.buf).echo;
  const svc = createTpexClose({ root, mirrorRoot: null, now: () => tw(echo, '20:00'), log: () => {} });
  mkdirSync(join(root, '_inbox'), { recursive: true });
  writeFileSync(join(root, '_inbox', 'tpex_mainboard_daily_close_quotes.json'), REAL.buf);
  backdate(join(root, '_inbox', 'tpex_mainboard_daily_close_quotes.json'));
  const r = await svc.ingestInbox();
  assert.equal(r.accepted[0]?.dataDate, echo, JSON.stringify(r.rejected));
  if (REAL.known1008) { assert.equal(r.accepted[0].rows, 12221); assert.equal(r.accepted[0].stocks4, 886); }
  const man = JSON.parse(readFileSync(join(root, '_manifest.json'), 'utf8'));
  assert.equal(man.days[echo].sha256, createHash('sha256').update(REAL.buf).digest('hex'));
  assert.equal(gunzipSync(readFileSync(join(root, man.days[echo].file))).equals(REAL.buf), true, '快取存的是原始位元組');
  writeFileSync(join(root, '_inbox', 'partial.json'), TRUNC);
  backdate(join(root, '_inbox', 'partial.json'));
  assert.match((await svc.ingestInbox()).rejected[0].reason, /非完整 JSON/);
});

test('收件匣：下載中的檔（.crdownload／.part／0 位元組／1 分鐘內剛寫入）不碰——不改名、不告警；下載完成且穩定後才採用', async () => {
  const h = make({ policy: { inboxSettleMs: 60_000 } });
  const inbox = join(h.svc.root, '_inbox'); mkdirSync(inbox, { recursive: true });
  const full = JSON.stringify(synthOpenapi());
  writeFileSync(join(inbox, 'tpex_mainboard_daily_close_quotes.json.crdownload'), full.slice(0, 200));
  writeFileSync(join(inbox, 'tpex_mainboard_daily_close_quotes (1).json.part'), full.slice(0, 200));
  writeFileSync(join(inbox, 'tpex_mainboard_daily_close_quotes (1).json'), '');   // Firefox 佔位檔
  writeFileSync(join(inbox, 'fresh.json'), full);                                   // 剛寫入（cp 中／剛下載完）
  for (const n of ['tpex_mainboard_daily_close_quotes.json.crdownload', 'tpex_mainboard_daily_close_quotes (1).json.part', 'tpex_mainboard_daily_close_quotes (1).json']) backdate(join(inbox, n));
  const r1 = await h.svc.ingestInbox();
  assert.equal(r1.accepted.length, 0); assert.equal(r1.rejected.length, 0); assert.equal(r1.waiting.length, 4);
  assert.equal(h.alerts.length, 0);
  assert.equal(readdirSync(inbox).filter(n => /rejected|processing/.test(n)).length, 0, '沒有任何檔被改名');
  assert.equal((await h.svc.getTpexClose('2026-10-08')).status, 'missing', '讀者路徑也不碰下載中的檔');
  backdate(join(inbox, 'fresh.json'));
  const r2 = await h.svc.ingestInbox();
  assert.deepEqual(r2.accepted.map(x => x.name), ['fresh.json']); assert.equal(r2.waiting.length, 3);
  assert.deepEqual(h.svc.status().inboxWaiting.sort(), ['tpex_mainboard_daily_close_quotes (1).json', 'tpex_mainboard_daily_close_quotes (1).json.part', 'tpex_mainboard_daily_close_quotes.json.crdownload']);
  assert.equal((await h.svc.ingestInbox({ settleMs: 0 })).waiting.length, 3, '手動 --inbox（settleMs 0）仍略過暫存副檔名與 0 位元組檔');
});

test('收件匣：沒有告警通道的程序（手動腳本）拒收 ⇒ 記在清單；daemon 的 checkMissing 補發一次', async () => {
  const root = tmp();
  const script = createTpexClose({ root, mirrorRoot: null, now: () => tw('2026-10-08', '20:00'), limits: SMALL, policy: { inboxSettleMs: 0 }, log: () => {} });
  mkdirSync(join(root, '_inbox'), { recursive: true });
  writeFileSync(join(root, '_inbox', 'bad.json'), '{"hello":1}');
  assert.equal(await script.getLatestTpexClose(), null);
  assert.equal(script.status().inboxRejected[0].alerted, false);
  const d = make({ root });
  d.svc.checkMissing('2026-10-08');
  for (let i = 0; i < 50 && !d.alerts.length; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(d.alerts.length, 1); assert.match(d.alerts[0][0], /拒收 bad\.json/);
  assert.equal(await d.svc.flushInboxAlerts(), 0, '每筆只補發一次');
  writeFileSync(join(root, '_inbox', 'bad2.json'), '{"hello":2}');
  await d.svc.ingestInbox();
  assert.equal(d.alerts.length, 2, '有告警通道的程序當場發');
  assert.equal(await d.svc.flushInboxAlerts(), 0);
});

test('不開網路的程序：快取命中 0 請求；沒有就 missing（不捏造）', async () => {
  let calls = 0; const f = async () => { calls++; throw new Error('不該打網路'); };
  const { svc } = make({ fetchImpl: f });
  await svc.importBuffer(Buffer.from(JSON.stringify(synthOpenapi())), { source: 'import' });
  assert.equal((await svc.getTpexClose('2026-10-08')).status, 'ok');
  assert.equal((await svc.getTpexClose('2026-10-07')).status, 'missing');
  assert.equal(calls, 0);
});

test('網路：帶日期端點優先、回聲相符 ⇒ ok 並寫快取；再要同一天＝0 請求', async () => {
  const f = mockFetch(() => ({ status: 200, headers: { 'content-encoding': 'gzip' }, chunks: [{ data: JSON.stringify(datedPayload('2026-10-08')) }] }));
  const { svc } = make({ fetchImpl: f, network: 'auto' });
  const r = await svc.getTpexClose('20261008');
  assert.equal(r.status, 'ok', r.reason); assert.equal(r.source, 'dated'); assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /afterTrading\/dailyQuotes\?date=2026%2F10%2F08/);
  assert.equal((await svc.getTpexClose('2026-10-08')).status, 'ok'); assert.equal(f.calls.length, 1);
  const svc2 = createTpexClose({ root: svc.root, mirrorRoot: null, now: () => tw('2026-10-08', '21:00'), network: 'auto', fetchImpl: f, limits: SMALL });
  assert.equal((await svc2.getTpexClose('2026-10-08')).source, 'dated', '重啟後讀本機快取'); assert.equal(f.calls.length, 1);
});

test('網路：回聲不符＝notYet（中性）、那一份存在它自己的日子；14:45 前今日檔不試；出檔窗（～15:30）2 分鐘再試、之後 10 分鐘', async () => {
  const f = mockFetch(() => ({ status: 200, chunks: [{ data: JSON.stringify(datedPayload('2026-10-07')) }] }));
  const h = make({ fetchImpl: f, network: 'auto', at: tw('2026-10-08', '14:00') });
  assert.equal((await h.svc.getTpexClose('2026-10-08')).status, 'notYet'); assert.equal(f.calls.length, 0, '14:45 前 0 請求');
  h.set(tw('2026-10-08', '14:44'));
  assert.equal((await h.svc.getTpexClose('2026-10-08')).status, 'notYet'); assert.equal(f.calls.length, 0);
  h.set(tw('2026-10-08', '14:46'));
  const r = await h.svc.getTpexClose('2026-10-08');
  assert.equal(r.status, 'notYet'); assert.equal(f.calls.length, 1);
  assert.equal((await h.svc.getTpexClose('2026-10-07')).status, 'ok', '回來的前一日檔照樣可用');
  h.set(tw('2026-10-08', '14:47'));
  assert.equal((await h.svc.getTpexClose('2026-10-08')).backoff, true); assert.equal(f.calls.length, 1);
  h.set(tw('2026-10-08', '14:48') + 30_000);
  await h.svc.getTpexClose('2026-10-08'); assert.equal(f.calls.length, 2, '出檔窗內 2 分鐘再試');
  h.set(tw('2026-10-08', '15:40'));
  await h.svc.getTpexClose('2026-10-08'); assert.equal(f.calls.length, 3);
  h.set(tw('2026-10-08', '15:45'));
  assert.equal((await h.svc.getTpexClose('2026-10-08')).backoff, true, '15:30 後回到 10 分鐘');
  h.set(tw('2026-10-08', '15:51'));
  await h.svc.getTpexClose('2026-10-08'); assert.equal(f.calls.length, 4);
});

test('網路：14:51 出檔（帶日期端點回當日完整檔）⇒ 當日 ok，種子可換成當日檔', async () => {
  let published = false;
  const f = mockFetch(() => ({ status: 200, chunks: [{ data: JSON.stringify(published ? datedPayload('2026-10-08') : { stat: 'ok', date: '20261008', tables: [{ title: '上櫃股票行情', date: '115/10/08', fields: ['代號', '名稱', '收盤', '漲跌', '開盤', '最高', '最低', '均價', '成交股數'], data: [] }] }) }] }));
  const h = make({ fetchImpl: f, network: 'auto', at: tw('2026-10-08', '14:47') });
  assert.equal((await h.svc.getTpexClose('2026-10-08')).status, 'notYet', '空表＝還沒出');
  published = true;
  h.set(tw('2026-10-08', '14:51'));
  const r = await h.svc.getTpexClose('2026-10-08');
  assert.equal(r.status, 'ok', r.reason); assert.equal(r.source, 'dated'); assert.equal(f.calls.length, 2);
});

test('網路：帶日期端點停滯 ⇒ 16:00 前不打 openapi；16:00 後 openapi 用 identity＋串流，收完驗證採用', async () => {
  const openapiBody = JSON.stringify(synthOpenapi());
  const f = mockFetch(url => (url === OPENAPI_URL
    ? { status: 200, headers: { 'content-length': String(Buffer.byteLength(openapiBody)), etag: '"e1"', 'accept-ranges': 'bytes', 'last-modified': 'Thu, 08 Oct 2026 10:00:06 GMT' }, chunks: [{ delay: 5, data: openapiBody.slice(0, 200) }, { delay: 30, data: openapiBody.slice(200) }] }
    : { status: 200, chunks: [{ data: '{"stat":"ok","date":"2026' }], hangAfter: true }));
  const h = make({ fetchImpl: f, network: 'auto', at: tw('2026-10-07', '15:55') });
  const early = await h.svc.getTpexClose('2026-10-07');
  assert.equal(early.status, 'failed'); assert.match(early.reason, /停滯/); assert.equal(f.calls.length, 1, '15:55＜16:00：不打 openapi');
  h.set(tw('2026-10-07', '16:30'));
  const r = await h.svc.getTpexClose('2026-10-07');
  assert.equal(r.status, 'notYet', '10-08 的 openapi 檔對 10-07 是 notYet');
  assert.equal(f.calls.at(-1).url, OPENAPI_URL); assert.equal(f.calls.at(-1).headers['Accept-Encoding'], 'identity');
  assert.equal((await h.svc.getTpexClose('2026-10-08')).source, 'openapi', '下載到的 10-08 檔存在它自己的資料日');
  assert.ok(h.waits.some(w => w >= 2900), '對櫃買的請求彼此間隔 ≥3 秒');
});

test('網路：openapi 中途停住 ⇒ 存部分檔；下一次帶 Range＋If-Range 續傳接成完整檔', async () => {
  const body = Buffer.from(JSON.stringify(synthOpenapi()));
  const half = Math.floor(body.length / 2);
  let openapiTry = 0;
  const f = mockFetch(url => {
    if (url !== OPENAPI_URL) return { status: 200, chunks: [{ data: '{' }], reset: true };
    openapiTry++;
    if (openapiTry === 1) return { status: 200, headers: { 'content-length': String(body.length), etag: '"e9"', 'accept-ranges': 'bytes' }, chunks: [{ data: body.subarray(0, half) }], hangAfter: true };
    return { status: 206, headers: { 'content-range': `bytes ${half}-${body.length - 1}/${body.length}`, etag: '"e9"' }, chunks: [{ data: body.subarray(half) }] };
  });
  const h = make({ fetchImpl: f, network: 'auto', at: tw('2026-10-08', '18:00') });
  const r1 = await h.svc.getTpexClose('2026-10-08');
  assert.equal(r1.status, 'failed'); assert.match(r1.reason, /openapi 下載停滯/);
  assert.ok(existsSync(join(h.svc.root, '_partial', 'openapi.part')));
  h.set(h.t + 60 * 60_000);
  const r2 = await h.svc.getTpexClose('2026-10-08');
  assert.equal(r2.status, 'ok', r2.reason); assert.equal(r2.source, 'openapi');
  const last = f.calls.at(-1);
  assert.equal(last.headers.Range, `bytes=${half}-`); assert.equal(last.headers['If-Range'], '"e9"');
  assert.equal(existsSync(join(h.svc.root, '_partial', 'openapi.part')), false, '完成後清掉部分檔');
});

test('網路：openapi 條件請求 304 或 Last-Modified 早於期望日 ⇒ 仍是舊檔、不下載本體', async () => {
  const body = Buffer.from(JSON.stringify(synthOpenapi({ roc: '1151007' })));
  let n = 0;
  const f = mockFetch(url => {
    if (url !== OPENAPI_URL) return { status: 200, chunks: [{ data: '{' }], reset: true };
    n++;
    if (n === 1) return { status: 200, headers: { 'content-length': String(body.length), etag: '"old"', 'last-modified': 'Wed, 07 Oct 2026 10:00:00 GMT' }, chunks: [{ data: body }] };
    return { status: 304, headers: { etag: '"old"' } };
  });
  const h = make({ fetchImpl: f, network: 'auto', at: tw('2026-10-07', '20:00') });
  assert.equal((await h.svc.getTpexClose('2026-10-07')).status, 'ok');
  h.set(tw('2026-10-08', '17:00'));
  const r = await h.svc.getTpexClose('2026-10-08');
  assert.equal(r.status, 'failed'); assert.match(r.reason, /openapi 仍是舊檔/);
  assert.equal(f.calls.at(-1).headers['If-None-Match'], '"old"');
});

test('網路：HTTP 403 ⇒ 當日停用櫃買網路＋告警；之後 0 請求', async () => {
  const f = mockFetch(() => ({ status: 403, chunks: [{ data: 'forbidden' }] }));
  const h = make({ fetchImpl: f, network: 'auto', at: tw('2026-10-08', '17:00') });
  assert.equal((await h.svc.getTpexClose('2026-10-08')).status, 'blocked');
  assert.equal(h.alerts.length, 1); assert.match(h.alerts[0][0], /HTTP 403/);
  h.set(tw('2026-10-08', '23:00'));
  assert.equal((await h.svc.getTpexClose('2026-10-08')).status, 'blocked'); assert.equal(f.calls.length, 1);
});

test('網路：傳輸失敗退避第一階 2 分（±20%）；同程序同時要同一天只打一輪', async () => {
  const f = mockFetch(() => ({ status: 200, chunks: [{ data: '{' }], reset: true }));
  const h = make({ fetchImpl: f, network: 'auto', at: tw('2026-10-07', '15:00') });
  const [a, b] = await Promise.all([h.svc.getTpexClose('2026-10-06'), h.svc.getTpexClose('2026-10-06')]);
  assert.equal(a.status, 'failed'); assert.equal(b.status, 'failed');
  assert.equal(f.calls.length, 2, '合流：帶日期＋openapi 各一次（前一日的檔不受 16:00 限制）');
  const want = h.svc.status().net.want['2026-10-06'];
  const gapMin = (want.nextTry - h.t) / 60_000;
  assert.ok(gapMin >= 1.5 && gapMin <= 2.5, `第一次退避 ${gapMin} 分`);
  assert.equal(want.fails, 1);
});

test('19:00 告警：交易日仍沒有已驗證檔 ⇒ 寫 _alerts、附手動下載說明；每日一次', async () => {
  const h = make({ at: tw('2026-10-08', '18:59') });
  assert.equal(h.svc.checkMissing('2026-10-08').alert, false);
  h.set(tw('2026-10-08', '19:01'));
  const a = h.svc.checkMissing('20261008');
  assert.equal(a.alert, true); assert.match(a.text, /_inbox[\s\S]*tpex-close-import/);
  assert.ok(existsSync(join(h.svc.root, '_alerts', '2026-10-08.json')));
  assert.equal(h.svc.checkMissing('2026-10-08').alert, false);
  assert.equal(h.svc.checkMissing('2026-10-10').alert, false, '週末不告警');
});

test('官方鏡像本機檔：唯讀讀取（不寫進鏡像）；getLatestTpexClose 取最新、太舊回 null', async () => {
  const mirrorRoot = tmp();
  const dir = join(mirrorRoot, 'www.tpex.org.tw', MIRROR_IDS.dated); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-10-06.json.gz'), gzipSync(JSON.stringify({ meta: { sha256: 'abc', fetchedAt: 'x' }, payload: datedPayload('2026-10-06') })));
  writeFileSync(join(dir, '_manifest.json'), JSON.stringify({ rows: { '2026-10-06': { status: 'ok', file: '2026-10-06.json.gz', echo: '2026-10-06' } } }));
  const before = readdirSync(dir).sort();
  const h = make({ mirrorRoot });
  const r = await h.svc.getTpexClose('2026-10-06');
  assert.equal(r.status, 'ok'); assert.equal(r.source, 'mirror');
  assert.deepEqual(readdirSync(dir).sort(), before, '鏡像目錄沒有被寫');
  await h.svc.importBuffer(Buffer.from(JSON.stringify(synthOpenapi({ roc: '1151005' }))));
  assert.equal((await h.svc.getLatestTpexClose()).dataDate, '2026-10-06');
  assert.equal((await h.svc.getLatestTpexClose({ before: '2026-10-05' })).dataDate, '2026-10-05');
  h.set(tw('2026-11-30', '12:00'));
  assert.equal(await h.svc.getLatestTpexClose({ maxAgeDays: 14 }), null);
});

test('官方重產：同日同格式不同內容 ⇒ 新版現用、舊版列進 revisions；同日另一格式記在 alt；openapiRawFor 給鏡像收養', async () => {
  const { svc } = make();
  const a = synthOpenapi(); const b = synthOpenapi(); b[0] = { ...b[0], Close: '10.05' };
  await svc.importBuffer(Buffer.from(JSON.stringify(a)));
  await svc.importBuffer(Buffer.from(JSON.stringify(b)));
  const man = JSON.parse(readFileSync(join(svc.root, '_manifest.json'), 'utf8')).days['2026-10-08'];
  assert.equal(man.revisions.length, 1); assert.match(man.file, /\.r2\.openapi\.json\.gz$/);
  assert.equal((await svc.getTpexClose('2026-10-08')).rows[0].Close, '10.05');
  await svc.importBuffer(Buffer.from(JSON.stringify(datedPayload('2026-10-08'))));
  assert.ok(JSON.parse(readFileSync(join(svc.root, '_manifest.json'), 'utf8')).days['2026-10-08'].alt.dated);
  const raw = svc.openapiRawFor('2026-10');
  assert.equal(raw.dataDate, '2026-10-08'); assert.equal(raw.raw.toString(), JSON.stringify(b));
  assert.equal(svc.openapiRawFor('2026-09'), null);
});

test('鎖：pid 已不存在的 _lock 會被清掉，不卡住寫入', async () => {
  const { svc } = make();
  mkdirSync(svc.root, { recursive: true });
  writeFileSync(join(svc.root, '_lock'), JSON.stringify({ pid: 999999, at: 0 }));
  const r = await svc.importBuffer(Buffer.from(JSON.stringify(synthOpenapi())));
  assert.equal(r.status, 'ok'); assert.equal(existsSync(join(svc.root, '_lock')), false);
});

test('鎖：讀不到內容的 _lock（空檔）在 mtime 未過期前視為持有中、不搶；過期才清', async () => {
  const { svc } = make();
  mkdirSync(svc.root, { recursive: true });
  const lock = join(svc.root, '_lock');
  writeFileSync(lock, '');
  await assert.rejects(svc.importBuffer(Buffer.from(JSON.stringify(synthOpenapi()))), /鎖取得逾時/);
  assert.equal(existsSync(lock), true, '空鎖檔沒有被當成無主刪掉');
  backdate(lock, 11 * 60);
  assert.equal((await svc.importBuffer(Buffer.from(JSON.stringify(synthOpenapi())))).status, 'ok');
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(svc.root).filter(n => n.startsWith('_lock')), [], '暫存鎖檔都有清掉');
});

test('網路：三個日期同時要（宇宙背景＋補洞）⇒ 同程序的櫃買請求依序、彼此間隔 ≥3 秒', async () => {
  const times = []; let h = null;
  const f = mockFetch(() => ({ status: 200, chunks: [{ data: '{' }], reset: true }));
  const g = async (u, i) => { times.push(h.t); return f(u, i); };
  h = make({ fetchImpl: g, network: 'auto', at: tw('2026-10-08', '20:00') });
  const rs = await Promise.all(['2026-09-21', '2026-09-22', '2026-09-23'].map(d => h.svc.getTpexClose(d)));
  assert.deepEqual(rs.map(r => r.status), ['failed', 'failed', 'failed']);
  assert.equal(f.calls.length, 3, '歷史日只打帶日期端點');
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= 3000, `第 ${i} 個間隔 ${sorted[i] - sorted[i - 1]}ms`);
});

test('網路：歷史日（一週以前）帶日期端點失敗不退 openapi（openapi 只有最新一份）；回聲相符但完整性不過 ⇒ failed＋looseRows、不進快取', async () => {
  const f = mockFetch(() => ({ status: 200, chunks: [{ data: '{' }], reset: true }));
  const h = make({ fetchImpl: f, network: 'auto', at: tw('2026-10-08', '20:00') });
  assert.equal((await h.svc.getTpexClose('2026-09-21')).status, 'failed'); assert.equal(f.calls.length, 1, '只打帶日期端點');
  const thin = mockFetch(() => ({ status: 200, chunks: [{ data: JSON.stringify(datedPayload('2026-09-22', { n4: 2 })) }] }));
  const h2 = make({ fetchImpl: thin, network: 'auto', at: tw('2026-10-08', '20:00') });
  const r = await h2.svc.getTpexClose('2026-09-22');
  assert.equal(r.status, 'failed'); assert.match(r.reason, /驗證不過/); assert.equal(r.looseRows.length, 4);
  assert.equal(h2.svc.status().days['2026-09-22'], undefined, '不合格的不進快取');
});

test('網路：帶日期端點回當日空表（stat ok、日期相符、0 列）＝notYet，不進退避階梯；5xx 可退 openapi', async () => {
  const empty = { stat: 'ok', date: '20261008', tables: [{ title: '上櫃股票行情', date: '115/10/08', fields: ['代號', '名稱', '收盤', '漲跌', '開盤', '最高', '最低', '均價', '成交股數'], data: [] }] };
  const f = mockFetch(() => ({ status: 200, chunks: [{ data: JSON.stringify(empty) }] }));
  const h = make({ fetchImpl: f, network: 'auto', at: tw('2026-10-08', '16:30') });
  const r = await h.svc.getTpexClose('2026-10-08');
  assert.equal(r.status, 'notYet'); assert.equal(h.svc.status().net.want['2026-10-08'].fails, 0);
  const body = JSON.stringify(synthOpenapi());
  const g = mockFetch(url => (url === OPENAPI_URL ? { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) }, chunks: [{ data: body }] } : { status: 503, chunks: [{ data: 'busy' }] }));
  const h2 = make({ fetchImpl: g, network: 'auto', at: tw('2026-10-08', '17:00') });
  assert.equal((await h2.svc.getTpexClose('2026-10-08')).source, 'openapi');
});

test('第三方後備（3P）存放：與官方分開記（thirdParty）、官方已在就拒寫、官方到了記 supersededBy、與官方同樣保留 60 天', async () => {
  const h = make({ at: tw('2026-10-08', '21:50') });
  const rows = synthOpenapi({ roc: '1151008' });
  const st = await h.svc.storeThirdParty({ iso: '2026-10-08', rows, meta: { source: 'finmind', grade: '3P', volumeBasis: 'tpex-dailyQuotes', missingFields: ['Capitals'], otcFilter: 'prev+warrant+info' } });
  assert.equal(st.stored, true);
  const tp = h.svc.getThirdParty('2026-10-08');
  assert.equal(tp.status, 'ok'); assert.equal(tp.grade, '3P'); assert.equal(tp.source, 'finmind'); assert.equal(tp.rows.length, rows.length);
  assert.equal(tp.supersededBy, null);
  assert.equal((await h.svc.getTpexClose('2026-10-08')).status, 'missing', '官方鏈看不到 3P');
  assert.equal(h.svc.status().days['2026-10-08'], undefined); assert.equal(h.svc.status().thirdParty['2026-10-08'].grade, '3P');
  // 官方到了
  await h.svc.importBuffer(Buffer.from(JSON.stringify(rows)), { source: 'openapi', expect: '2026-10-08' });
  assert.equal(h.svc.getThirdParty('2026-10-08').supersededBy.source, 'openapi');
  assert.equal((await h.svc.storeThirdParty({ iso: '2026-10-08', rows, meta: {} })).stored, false, '官方已在就不寫 3P');
  // 61 天後清掉
  h.set(tw('2026-12-09', '12:00'));
  await h.svc.importBuffer(Buffer.from(JSON.stringify(synthOpenapi({ roc: '1151208' }))), { source: 'inbox', expect: '2026-12-08' });
  assert.equal(h.svc.getThirdParty('2026-10-08'), null);
  assert.equal(readdirSync(h.svc.root).some(n => n.startsWith('2026-10-08.')), false, '檔案一起清掉');
});
