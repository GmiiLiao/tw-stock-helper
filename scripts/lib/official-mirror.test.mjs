// 第二大腦官方鏡像核心測試：node --test scripts/lib/official-mirror.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as C from './official-mirror.mjs';

const jsonRes = (obj, status = 200) => async () => ({ status, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(JSON.stringify(obj)) });
const textRes = (txt, status = 200) => async () => ({ status, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from(txt) });
const tmp = () => mkdtempSync(join(tmpdir(), 'om-'));

test('樣板變數：日期、民國、月初、季、市場；缺變數丟錯', () => {
  const c = C.ctxOf({ day: '2026-10-02', market: 'otc' });
  assert.equal(C.render('{date8}|{dateSlash}|{rocDate}|{rocYear}|{month}|{month2}|{ym01}|{market}', c), '20261002|2026/10/02|115/10/02|115|10|10|20261001|otc');
  assert.equal(C.render('{rocYear}_{month}', C.ctxOf({ year: 2022, month: 7 })), '111_7');
  assert.equal(C.render('{season2}', C.ctxOf({ year: 2026, season: 2 })), '02');
  assert.throws(() => C.render('{nope}', c), /nope/);
});

test('日期正規化：西元、民國（斜線／緊湊／中文）', () => {
  assert.equal(C.normDate('20261002'), '2026-10-02');
  assert.equal(C.normDate('115/10/02'), '2026-10-02');
  assert.equal(C.normDate('1151002'), '2026-10-02');
  assert.equal(C.normDate('115年10月02日 股價升降幅度'), '2026-10-02');
  assert.equal(C.normDate('2026/1/5'), '2026-01-05');
  assert.equal(C.normDate('abc'), null);
});

test('禁跑窗：平日 07:30～15:30（台北）', () => {
  assert.equal(C.inQuietWindow(new Date('2026-10-05T00:00:00Z')), true);    // 週一 08:00
  assert.equal(C.inQuietWindow(new Date('2026-10-05T07:29:00Z')), true);    // 週一 15:29 仍在窗內
});

test('禁跑窗邊界與週末', () => {
  assert.equal(C.inQuietWindow(new Date('2026-10-05T07:30:00Z')), false);   // 週一 15:30 起可跑
  assert.equal(C.inQuietWindow(new Date('2026-10-04T02:00:00Z')), false);   // 週日 10:00
  assert.equal(C.inQuietWindow(new Date('2026-10-05T14:00:00Z')), false);   // 週一 22:00
});

test('證交所 rwd 驗證：回聲相符 ok、不符 mismatch、查無 empty', () => {
  const ctx = C.ctxOf({ day: '2026-10-02' });
  assert.equal(C.VALIDATORS.twseDate({ stat: 'OK', date: '20261002', tables: [{ data: [[1]] }] }, ctx).status, 'ok');
  assert.equal(C.VALIDATORS.twseDate({ stat: 'OK', date: '20261001', tables: [{ data: [[1]] }] }, ctx).status, 'mismatch');
  assert.equal(C.VALIDATORS.twseDate({ stat: '很抱歉，沒有符合條件的資料!' }, ctx).status, 'empty');
  assert.equal(C.VALIDATORS.twseDate({ stat: 'OK', date: '20261002', fields: ['a'], data: [] }, ctx).status, 'empty');
});

test('區間端點：title 帶別天日期＝mismatch；0 筆合法', () => {
  const ctx = C.ctxOf({ day: '2026-10-02' });
  assert.equal(C.VALIDATORS.twseRange({ stat: 'OK', title: '115/10/01 ~ 115/10/01', data: [[1]], fields: ['x'] }, ctx).status, 'mismatch');
  assert.equal(C.VALIDATORS.twseRange({ stat: 'OK', title: '115/10/02 ~ 115/10/02', data: [], fields: ['x'] }, ctx).status, 'empty');
});

test('櫃買與 openapi 驗證', () => {
  const ctx = C.ctxOf({ day: '2026-10-02' });
  assert.equal(C.VALIDATORS.tpexDate({ stat: 'ok', date: '20261002', tables: [{ data: [[1]] }] }, ctx).status, 'ok');
  assert.equal(C.VALIDATORS.tpexDate({ stat: 'ok', date: '20261001', tables: [{ data: [[1]] }] }, ctx).status, 'mismatch');
  const o = C.VALIDATORS.openapi([{ 出表日期: '1151002', x: 1 }, { 出表日期: '1151001' }]);
  assert.equal(o.status, 'ok'); assert.equal(o.echo, '2026-10-02'); assert.equal(o.rows, 2);
  assert.equal(C.VALIDATORS.openapi([]).status, 'empty');
  assert.equal(C.VALIDATORS.openapi({ a: 1 }).status, 'bad');
});

test('文字頁驗證：必須含民國年月；查無＝empty；過短＝bad', () => {
  const ctx = C.ctxOf({ year: 2022, month: 7 });
  const page = '上市公司111年7月份營業收入統計表' + 'x'.repeat(300);
  assert.equal(C.VALIDATORS.contains(page, ctx, { mustContain: ['{rocYear}年{month}月'] }).status, 'ok');
  assert.equal(C.VALIDATORS.contains(page.replace('111年7月', '111年8月'), ctx, { mustContain: ['{rocYear}年{month}月'] }).status, 'mismatch');
  assert.equal(C.VALIDATORS.contains('查無資料' + 'x'.repeat(300), ctx, { emptyRe: '查無' }).status, 'empty');
  assert.equal(C.VALIDATORS.contains('短', ctx, {}).status, 'bad');
});

test('抓取＋存檔：ok 寫檔與清單；回聲不符不寫檔、不算主機故障', async () => {
  const root = tmp();
  try {
    const ad = { id: 'x', host: 'h', kind: 'json', validator: 'twseDate', request: ctx => ({ url: `https://h/x?d=${ctx.date8}` }) };
    const man = { id: 'x', host: 'h', rows: {} };
    const r1 = await C.fetchAndStore(ad, { root, key: '2026-10-02', ctx: C.ctxOf({ day: '2026-10-02' }), man, fetchImpl: jsonRes({ stat: 'OK', date: '20261002', tables: [{ data: [[1], [2]] }] }) });
    assert.equal(r1.row.status, 'ok'); assert.equal(r1.row.rows, 2); assert.ok(existsSync(join(root, 'h', 'x', '2026-10-02.json.gz')));
    const back = C.readEntry(root, 'h', 'x', '2026-10-02.json.gz'); assert.equal(back.payload.date, '20261002'); assert.equal(back.meta.source, 'official');
    const r2 = await C.fetchAndStore(ad, { root, key: '2026-10-05', ctx: C.ctxOf({ day: '2026-10-05' }), man, fetchImpl: jsonRes({ stat: 'OK', date: '20261002', tables: [{ data: [[1]] }] }) });
    assert.equal(r2.row.status, 'mismatch'); assert.equal(r2.neutral, true); assert.ok(!r2.failed); assert.ok(!existsSync(join(root, 'h', 'x', '2026-10-05.json.gz')));
    assert.equal(C.isFinal(man, '2026-10-02'), true); assert.equal(C.isFinal(man, '2026-10-05'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('快照：內容沒變記 unchanged、不另存；5xx 可重試', async () => {
  const root = tmp();
  try {
    const ad = { id: 's', host: 'h', kind: 'json', validator: 'openapi', request: () => ({ url: 'https://h/s' }) };
    const man = { id: 's', host: 'h', rows: {} }; const body = [{ Date: '1151002', v: 1 }];
    await C.fetchAndStore(ad, { root, key: '2026-10-02', ctx: {}, man, snapshot: true, fetchImpl: jsonRes(body) });
    const r = await C.fetchAndStore(ad, { root, key: '2026-10-05', ctx: {}, man, snapshot: true, fetchImpl: jsonRes(body) });
    assert.equal(r.row.status, 'unchanged'); assert.ok(!existsSync(join(root, 'h', 's', '2026-10-05.json.gz')));
    const e = await C.fetchAndStore(ad, { root, key: '2026-10-06', ctx: {}, man, snapshot: true, fetchImpl: jsonRes({}, 503) });
    assert.equal(e.retryable, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('家族佇列：禁跑窗不送出；封鎖訊號立即停；暫時錯誤只重試一次；中性結果不清零失敗計數', async () => {
  const noSleep = async () => {};
  const quietQ = new C.FamilyQueue('twse', { quiet: () => true, log: () => {}, sleepFn: noSleep });
  assert.equal((await quietQ.run(async () => ({}))).skipped !== undefined, true);
  const q1 = new C.FamilyQueue('twse', { quiet: () => false, log: () => {}, sleepFn: noSleep });
  await q1.run(async () => ({ fatal: true, failed: true, note: 'HTTP 403' }));
  assert.equal(q1.stopped, true); assert.equal(q1.count, 1);
  const q2 = new C.FamilyQueue('tpex', { quiet: () => false, log: () => {}, sleepFn: noSleep });
  let n = 0; await q2.run(async () => { n++; return { retryable: true, failed: true }; });
  assert.equal(n, 2, '5xx 只重試一次'); assert.equal(q2.consecFail, 1);
  await q2.run(async () => ({ neutral: true })); assert.equal(q2.consecFail, 1, '中性結果不清零');
  await q2.run(async () => ({ failed: true })); await q2.run(async () => ({ failed: true }));
  assert.equal(q2.stopped, true);
  assert.ok(q2.gapMs >= C.MIN_GAP_MS);
  assert.equal(C.familyOf('mopsov.twse.com.tw'), 'twse'); assert.equal(C.familyOf('openapi.twse.com.tw'), 'twse'); assert.equal(C.familyOf('www.tpex.org.tw'), 'tpex');
});

test('fetchAndStore：403／307／封鎖頁＝fatal；已有好資料不被失敗或空表覆蓋；必有表的空表不定版', async () => {
  const root = tmp();
  try {
    const ad = { id: 'x', host: 'www.twse.com.tw', kind: 'json', validator: 'twseDate', request: () => ({ url: 'https://h/x' }) };
    const ctx = C.ctxOf({ day: '2026-10-02' }); const man = { id: 'x', host: 'www.twse.com.tw', rows: {} };
    assert.equal((await C.fetchAndStore(ad, { root, key: 'k1', ctx, man, fetchImpl: jsonRes({}, 403) })).fatal, true);
    assert.equal((await C.fetchAndStore(ad, { root, key: 'k1', ctx, man, fetchImpl: jsonRes({}, 307) })).fatal, true);
    assert.equal((await C.fetchAndStore(ad, { root, key: 'k1', ctx, man, fetchImpl: textRes('<html>FOR SECURITY REASONS, this page can not be accessed</html>') })).fatal, true);
    await C.fetchAndStore(ad, { root, key: '2026-10-02', ctx, man, fetchImpl: jsonRes({ stat: 'OK', date: '20261002', tables: [{ data: [[1]] }] }) });
    const bad = await C.fetchAndStore(ad, { root, key: '2026-10-02', ctx, man, fetchImpl: jsonRes({}, 500) });
    assert.equal(man.rows['2026-10-02'].status, 'ok', '5xx 不覆蓋已有的好資料'); assert.equal(man.rows['2026-10-02'].lastTry.status, 'fail'); assert.equal(bad.retryable, true);
    await C.fetchAndStore(ad, { root, key: '2026-10-02', ctx, man, fetchImpl: jsonRes({ stat: 'OK', date: '20261002', fields: ['a'], data: [] }) });
    assert.equal(man.rows['2026-10-02'].status, 'ok', '空表不覆蓋已有內容');
    const p = await C.fetchAndStore(ad, { root, key: '2026-10-05', ctx: C.ctxOf({ day: '2026-10-05' }), man, mustHaveRows: true, fetchImpl: jsonRes({ stat: 'OK', date: '20261005', fields: ['a'], data: [] }) });
    assert.equal(p.row.status, 'pending'); assert.equal(C.isFinal(man, '2026-10-05'), false); assert.equal(p.neutral, true);
    await C.fetchAndStore(ad, { root, key: '2026-11', ctx, man, final: false, fetchImpl: jsonRes({ stat: 'OK', date: '20261002', tables: [{ data: [[1]] }] }) });
    assert.equal(C.isFinal(man, '2026-11'), false, '月表當月不定版'); assert.equal(C.hasGood(man, '2026-11'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('櫃買區間公告與月表的回聲；文字頁 mustMatch', () => {
  const ctx = C.ctxOf({ day: '2026-10-02' });
  assert.equal(C.VALIDATORS.tpexRange({ stat: 'ok', tables: [{ title2: '公布注意期間為 115/10/01 至 115/10/01', data: [[1]] }] }, ctx).status, 'mismatch');
  assert.equal(C.VALIDATORS.tpexRange({ stat: 'ok', tables: [{ title2: '公布注意期間為 115/10/02 至 115/10/02', data: [] }] }, ctx).status, 'empty');
  assert.equal(C.VALIDATORS.tpexMonth({ stat: 'ok', tables: [{ date: '202609', data: [[1]] }] }, C.ctxOf({ year: 2026, month: 10 })).status, 'mismatch');
  assert.equal(C.VALIDATORS.tpexMonth({ stat: 'ok', tables: [{ date: '202610', data: [[1]] }] }, C.ctxOf({ year: 2026, month: 10 })).status, 'ok');
  const page = '<input value="2026/10/02">' + 'x'.repeat(1200);
  assert.equal(C.VALIDATORS.contains(page, ctx, { mustMatch: ['<td[^>]*>\\s*{dateSlashNoPad}\\s*</td>'], minLen: 1000 }).status, 'mismatch', '表單回填的日期不算資料');
  assert.equal(C.VALIDATORS.contains(page + '<td>2026/10/2</td>', ctx, { mustMatch: ['<td[^>]*>\\s*{dateSlashNoPad}\\s*</td>'], minLen: 1000 }).status, 'ok');
  const q = C.ctxOf({ year: 2026, season: 2, market: 'sii' });
  assert.equal(C.VALIDATORS.contains('上市公司 第二季 <th>公司<br>代號</th><td> 2330 </td>' + 'x'.repeat(300), q, { mustContain: ['{marketName}', '{seasonZh}'], mustMatch: ['<td[^>]*>\\s*\\d{4}\\s*</td>'] }).status, 'ok');
});

// ── 月營收 t21sc03：內容穩定定版（取代「次月 11 日的隔天」時鐘規則·2026-10-04）──
const T21_STABLE = { afterDay: 11, minGapDays: 3, strip: '出表日期[：:][^<]*(?:<!--[^>]*-->)?' };
const t21Ad = { id: 't21', host: 'm', kind: 'text', ext: 'html', encoding: 'utf-8', request: ctx => ({ url: `https://m/t21sc03_${ctx.rocYear}_${ctx.month}_0.html` }), spec: { mustContain: ['{rocYear}年{month}月'] }, stable: T21_STABLE };
const t21Page = (stamp, body = '1101 台泥 13,515,534') => `上市公司115年8月份營業收入統計表<div class=tt>出表日期：${stamp}</div><table>${body}</table>` + 'x'.repeat(400);
const aug = C.ctxOf({ year: 2026, month: 8, market: 'sii' });

test('內容穩定定版：去掉出表日期後比雜湊；次月 11 日起相隔 ≥3 日兩次相同才定版；申報期內不定版', async () => {
  const root = tmp();
  try {
    const man = { id: 't21', host: 'm', rows: {} }; const k = '2026-08.sii';
    const go = (iso, page) => C.fetchAndStore(t21Ad, { root, key: k, ctx: aug, man, now: new Date(iso), final: true, fetchImpl: textRes(page) });
    assert.equal(C.stableShaOf(t21Page('115/09/12<!--20:00:18-->'), T21_STABLE), C.stableShaOf(t21Page('115/09/15<!--09:01:02-->'), T21_STABLE), '產生時戳不影響內容雜湊');
    assert.notEqual(C.stableShaOf(t21Page('115/09/12'), T21_STABLE), C.stableShaOf(t21Page('115/09/12', '1101 台泥 13,515,535'), T21_STABLE));
    let r = await go('2026-09-10T12:00:00Z', t21Page('115/09/10<!--20:00:00-->'));            // 台北 09-10：申報期內
    assert.equal(r.row.final, false, '呼叫端傳 final:true 也不採用'); assert.equal(r.row.stableFrom, null);
    r = await go('2026-09-11T12:00:00Z', t21Page('115/09/11<!--20:00:00-->'));
    assert.equal(r.row.final, false); assert.equal(r.row.stableFrom, '2026-09-11T12:00:00.000Z');
    r = await go('2026-09-13T12:00:00Z', t21Page('115/09/13<!--20:00:00-->'));
    assert.equal(r.row.final, false, '只差 2 日'); assert.equal(C.isFinalFor(t21Ad, man, k), false);
    r = await go('2026-09-14T12:00:00Z', t21Page('115/09/14<!--20:00:00-->'));
    assert.equal(r.row.final, true); assert.equal(r.row.finalBy, 'stable'); assert.equal(C.isFinalFor(t21Ad, man, k), true);
    assert.notEqual(r.row.sha256, r.row.stableSha, '原始位元組雜湊含時戳，另存內容雜湊');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('內容穩定定版：晚申報者上表（內容變了）⇒ 起點重算；舊時鐘規則的 final 不算數、以舊檔當第一次觀測', async () => {
  const root = tmp();
  try {
    const man = { id: 't21', host: 'm', rows: {} }; const k = '2026-08.sii';
    const go = (iso, page) => C.fetchAndStore(t21Ad, { root, key: k, ctx: aug, man, now: new Date(iso), fetchImpl: textRes(page) });
    await go('2026-09-11T02:00:00Z', t21Page('115/09/11'));
    let r = await go('2026-09-14T02:00:00Z', t21Page('115/09/14', '1101 台泥 13,515,534 2880 華南金 1,234'));
    assert.equal(r.row.final, false, '內容變了'); assert.equal(r.row.stableFrom, '2026-09-14T02:00:00.000Z');
    r = await go('2026-09-17T02:00:00Z', t21Page('115/09/17', '1101 台泥 13,515,534 2880 華南金 1,234'));
    assert.equal(r.row.final, true);
    // 舊列：時鐘規則標 final:true、沒有 stableSha／stableFrom／finalBy（2026-10-04 鏡像回補留下的）
    const legacy = { id: 't21', host: 'm', rows: {} }; const lk = '2026-07.sii';
    const file = C.writeEntry(root, 'm', 't21', lk, { kind: 'text', ext: 'html', buffer: Buffer.from(t21Page('115/10/04<!--18:00:04-->').replace('8月', '7月')) });
    legacy.rows[lk] = { status: 'ok', file, echo: '2026-07', rows: null, sha256: 'old', at: '2026-10-04T10:00:04.000Z', final: true };
    const jul = C.ctxOf({ year: 2026, month: 7, market: 'sii' });
    assert.equal(C.isFinal(legacy, lk), true); assert.equal(C.isFinalFor(t21Ad, legacy, lk), false, '舊時鐘定版不算數 ⇒ 會被重抓');
    assert.equal(C.isFinalFor({ id: 'other' }, legacy, lk), true, '其他資料集（沒有 stable）仍照 isFinal');
    const again = await C.fetchAndStore(t21Ad, { root, key: lk, ctx: jul, man: legacy, now: new Date('2026-10-07T10:00:00Z'), fetchImpl: textRes(t21Page('115/10/07<!--09:00:00-->').replace('8月', '7月')) });
    assert.equal(again.row.final, true, '舊檔內容（去時戳）相同且相隔 3 日'); assert.equal(again.row.stableFrom, '2026-10-04T10:00:04.000Z');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('文字頁（MOPS／期交所）：原始位元組存 .html.gz、清單有 sha256；年月不符不存', async () => {
  const root = tmp();
  try {
    const ad = { id: 't', host: 'm', kind: 'text', ext: 'html', encoding: 'utf-8', request: ctx => ({ url: `https://m/t_${ctx.rocYear}_${ctx.month}.html` }), spec: { mustContain: ['{rocYear}年{month}月'] } };
    const man = { id: 't', host: 'm', rows: {} }; const page = '上市公司111年7月份營業收入' + 'x'.repeat(400);
    const r = await C.fetchAndStore(ad, { root, key: '2022-07.sii', ctx: C.ctxOf({ year: 2022, month: 7, market: 'sii' }), man, fetchImpl: textRes(page) });
    assert.equal(r.row.status, 'ok'); assert.match(r.row.sha256, /^[0-9a-f]{64}$/);
    assert.equal(C.readEntry(root, 'm', 't', r.row.file).toString('utf8'), page);
    const bad = await C.fetchAndStore(ad, { root, key: '2022-08.sii', ctx: C.ctxOf({ year: 2022, month: 8, market: 'sii' }), man, fetchImpl: textRes(page) });
    assert.equal(bad.row.status, 'mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
