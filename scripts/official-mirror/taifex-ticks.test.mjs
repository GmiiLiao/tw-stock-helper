// 期交所 30 日逐筆 zip 歸檔測試：node --test scripts/official-mirror/taifex-ticks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import * as C from '../lib/official-mirror.mjs';
import { TICKS, ticksFileUrl, parseTicksList, readSingleZip, scanTicksCsv, validateTicksZip, storeTicksDay, planTicks, ticksPending, ticksGapAlerts, ticksClosedFrom, runTicks, verifyTicks, migrateTicks } from './taifex-ticks.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ticks-'));
// cp950 表頭（官方檔實際位元組）：成交日期,商品代號,到期月份(週別),成交時間,成交價格,成交數量(B+S),近月價格,遠月價格,開盤集合競價
const HEADER = Buffer.from('a6a8a5e6a4e9b4c12cb0d3ab7ea54eb8b92ca8ecb4c1a4eba5f728b667a74f292ca6a8a5e6aec9b6a12ca6a8a5e6bbf9aee62ca6a8a5e6bcc6b67128422b53292caaf1a4ebbbf9aee62cbbb7a4ebbbf9aee62cb67dbd4cb6b0a658c476bbf9', 'hex');
/** 逐筆 CSV：rows＝[[YYYYMMDD, HHMMSS], …]，extra 個 TX 筆數拉大檔案（模擬新版變大）。 */
function csv(rows, extra = 0) {
  const lines = rows.map(([d, t]) => `${d},TX     ,202610     ,${t},23000,2,-,-, `);
  for (let i = 0; i < extra; i++) lines.push(`${rows.at(-1)[0]},MTX    ,202610     ,${rows.at(-1)[1]},23001,2,-,-, `);
  return Buffer.concat([HEADER, Buffer.from(` \r\n${lines.join('\r\n')}\r\n`, 'latin1')]);
}
/** 多檔 zip：entries＝[[name, data]]；method 0＝stored、8＝deflate。 */
function zipMulti(entries, { method = 8 } = {}) {
  const locals = []; const cds = []; let off = 0;
  for (const [name, data] of entries) {
    const comp = method === 8 ? deflateRawSync(data) : data; const crc = crc32(data) >>> 0; const nm = Buffer.from(name, 'latin1');
    const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(method, 8); loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nm.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(off, 42);
    locals.push(loc, nm, comp); cds.push(cd, nm); off += 30 + nm.length + comp.length;
  }
  const cdBuf = Buffer.concat(cds); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}
/** 單檔 zip（deflate）；opts.badCrc 竄改 CRC。 */
function zip(name, data, { badCrc = false } = {}) {
  const comp = deflateRawSync(data); const crc = (crc32(data) ^ (badCrc ? 1 : 0)) >>> 0; const nm = Buffer.from(name, 'latin1');
  const time = (16 << 11) | (38 << 5) | 26; const date = ((2026 - 1980) << 9) | (10 << 5) | 8;
  const loc = Buffer.alloc(30);
  loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(8, 8); loc.writeUInt16LE(time, 10); loc.writeUInt16LE(date, 12);
  loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14);
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + nm.length + comp.length; const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + nm.length, 12); eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([loc, nm, comp, cd, nm, eocd]);
}
const fname = d => `Daily_${d.replaceAll('-', '_')}.csv`;
/** 完整日檔：前一晚夜盤（prevDay 15:00–23:59＋跨午夜）＋檔名日日盤 08:45–13:45。 */
const fullDay = (day, prevDay, extra = 0) => zip(fname(day), csv([[prevDay.replaceAll('-', ''), '150000'], [prevDay.replaceAll('-', ''), '235959'], [day.replaceAll('-', ''), '000001'], [day.replaceAll('-', ''), '084500'], [day.replaceAll('-', ''), '134500']], extra));
/** 清單頁（照 2026-10-09 實際頁面的列結構：時間｜日期｜rpt｜csv）；times[d] 給「YYYY/MM/DD PM hh:mm:ss」，預設檔名日 PM 04:38:00。 */
const listHtml = (days, times = {}) => `<table><thead><tr><th>時間</th><th>日期</th><th>下載(*.rpt)</th><th>下載(*.csv)</th></tr></thead><tbody>${days.slice().reverse().map(d => {
  const u = d.replaceAll('-', '_');
  return `<tr ><td align="center">${times[d] || `${d.replaceAll('-', '/')} PM 04:38:00`}</td><td align="center">${d.replaceAll('-', '/')}</td>`
    + `<td align="center"><input onClick="javascript:window.open('https://www.taifex.com.tw/file/taifex/Dailydownload/Dailydownload/Daily_${u}.zip')" value="下載"></td>`
    + `<td align="center"><input onClick="javascript:window.open('https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_${u}.zip')" value="下載" title=""></td></tr>`;
}).join('')}</tbody></table>`;
const T1012 = { '2026-10-12': '2026/10/09 AM 05:11:42' };   // 10-09 補假清單上 10-12 檔的實際上架時間（只有夜盤）
const quietQueue = () => new C.FamilyQueue('taifex', { quiet: () => false, log: () => {}, sleepFn: async () => {} });
/** 假的 fetch：routes[url] ＝ Buffer｜{status}｜函式；記下每次請求的 URL。 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async url => {
    calls.push(url); let r = routes[url]; if (typeof r === 'function') r = r();
    if (!r) return { status: 404, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('not found') };
    if (!Buffer.isBuffer(r)) return { status: r.status, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from(r.body || '') };
    return { status: 200, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => r };
  };
  return { impl, calls };
}
// 30 個交易日（2026-08-26～10-08，扣週末與 09-25、09-28 休市）
const TD = ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09',
  '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24',
  '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
const LIST_1009 = [...TD.slice(1), '2026-10-12'];   // 10-09 補假：清單已出現 10-12（只有夜盤），08-26 提前滾出

test('清單頁：只認 DailydownloadCSV 連結、去重升冪；時間欄 12 小時制轉 24 小時；太少＝bad', () => {
  const L = parseTicksList(listHtml(LIST_1009, T1012));
  assert.equal(L.status, 'ok'); assert.equal(L.days.length, 30); assert.equal(L.first, '2026-08-27'); assert.equal(L.last, '2026-10-12');
  assert.equal(L.times['2026-10-12'], '2026-10-09T05:11:42'); assert.equal(L.times['2026-10-08'], '2026-10-08T16:38:00');
  assert.equal(parseTicksList(listHtml(LIST_1009, { '2026-10-08': '2026/10/08 PM 12:05:00', '2026-10-07': '2026/10/07 AM 12:05:00' })).times['2026-10-08'], '2026-10-08T12:05:00');
  assert.equal(parseTicksList(listHtml(LIST_1009, { '2026-10-07': '2026/10/07 AM 12:05:00' })).times['2026-10-07'], '2026-10-07T00:05:00');
  // 沒有列結構（改版）：日子照認、只是沒有時間
  const flat = parseTicksList(LIST_1009.map(d => `<a href="DailydownloadCSV/Daily_${d.replaceAll('-', '_')}.zip">x</a>`).join(''));
  assert.equal(flat.days.length, 30);
  assert.equal(parseTicksList(listHtml(TD.slice(0, 5))).status, 'bad');
  assert.equal(parseTicksList('<html>維護中</html>').status, 'bad');
});

test('zip 完整性：正常檔 ok；截斷、CRC 不符、不是 zip ⇒ bad', () => {
  const z = fullDay('2026-10-08', '2026-10-07');
  const r = readSingleZip(z); assert.equal(r.ok, true); assert.equal(r.name, 'Daily_2026_10_08.csv'); assert.equal(r.zipTime, '2026-10-08T16:38:52');
  assert.equal(validateTicksZip(z.subarray(0, z.length - 30), '2026-10-08').status, 'bad');
  assert.equal(validateTicksZip(zip(fname('2026-10-08'), csv([['20261008', '134500']]), { badCrc: true }), '2026-10-08').status, 'bad');
  assert.equal(validateTicksZip(Buffer.from('<html>error</html>'), '2026-10-08').status, 'bad');
});

test('回聲：完整日檔 ok（含夜盤日曆日）；只有夜盤的未來檔 mismatch；最晚成交日相符但沒有日盤 partial', () => {
  const ok = validateTicksZip(fullDay('2026-10-08', '2026-10-07'), '2026-10-08');
  assert.equal(ok.status, 'ok'); assert.equal(ok.echo, '2026-10-08'); assert.equal(ok.rows, 5); assert.deepEqual(Object.keys(ok.dates).sort(), ['20261007', '20261008']);
  // 10-09 補假時的 Daily_2026_10_12.zip：只有 10-08 夜盤（日曆日 10-08、10-09）
  const night = zip(fname('2026-10-12'), csv([['20261008', '150000'], ['20261009', '045959']]));
  const m = validateTicksZip(night, '2026-10-12'); assert.equal(m.status, 'mismatch'); assert.equal(m.echo, '2026-10-09');
  // 週二檔若在日盤前上架：跨午夜夜盤的日曆日＝檔名日，但沒有 08:45 之後的成交
  const p = validateTicksZip(zip(fname('2026-10-13'), csv([['20261012', '150000'], ['20261013', '050000']])), '2026-10-13');
  assert.equal(p.status, 'partial');
  // zip 內檔名日與請求日不同
  assert.equal(validateTicksZip(fullDay('2026-10-07', '2026-10-06'), '2026-10-08').status, 'mismatch');
});

test('回聲不符拒收：不寫檔、清單記 mismatch；已有好資料時只記 lastTry', () => {
  const root = tmp();
  try {
    const man = { id: TICKS.id, host: TICKS.host, rows: {} };
    const night = zip(fname('2026-10-12'), csv([['20261008', '150000'], ['20261009', '045959']]));
    const r = storeTicksDay(root, man, '2026-10-12', night, validateTicksZip(night, '2026-10-12'), { at: '2026-10-09T10:00:00Z', url: ticksFileUrl('2026-10-12') });
    assert.equal(r.action, 'reject'); assert.equal(man.rows['2026-10-12'].status, 'mismatch');
    assert.ok(!existsSync(join(C.datasetDir(root, TICKS.host, TICKS.id), '2026-10-12.zip.gz')));
    const full = fullDay('2026-10-08', '2026-10-07');
    storeTicksDay(root, man, '2026-10-08', full, validateTicksZip(full, '2026-10-08'), { at: '2026-10-09T10:00:00Z', url: 'u' });
    const bad = full.subarray(0, 100);
    assert.equal(storeTicksDay(root, man, '2026-10-08', bad, validateTicksZip(bad, '2026-10-08'), { at: '2026-10-10T10:00:00Z', url: 'u' }).action, 'reject');
    assert.equal(man.rows['2026-10-08'].status, 'ok'); assert.equal(man.rows['2026-10-08'].lastTry.status, 'bad');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('同名更新：同 sha 只記再確認；不同且變大 ⇒ 覆蓋、舊版改名留存；不同但沒變大 ⇒ 保留舊版並列警示', () => {
  const root = tmp();
  try {
    const man = { id: TICKS.id, host: TICKS.host, rows: {} }; const day = '2026-10-08'; const dir = C.datasetDir(root, TICKS.host, TICKS.id);
    const v1 = fullDay(day, '2026-10-07'); const v2 = fullDay(day, '2026-10-07', 50); const v3 = fullDay(day, '2026-10-07', 10);
    const put = (buf, at) => storeTicksDay(root, man, day, buf, validateTicksZip(buf, day), { at, url: ticksFileUrl(day) });
    assert.equal(put(v1, '2026-10-08T10:00:00Z').action, 'new');
    assert.equal(C.readEntry(root, TICKS.host, TICKS.id, man.rows[day].file).equals(v1), true);
    assert.equal(put(v1, '2026-10-09T10:00:00Z').action, 'same'); assert.equal(man.rows[day].recheck, '2026-10-09T10:00:00Z');
    assert.ok(v2.length > v1.length);
    assert.equal(put(v2, '2026-10-10T10:00:00Z').action, 'replace');
    assert.equal(man.rows[day].sha256, C.sha256(v2)); assert.equal(man.rows[day].versions.length, 1);
    assert.equal(man.rows[day].versions[0].sha256, C.sha256(v1));
    assert.ok(existsSync(join(dir, man.rows[day].versions[0].file)));
    assert.equal(C.readEntry(root, TICKS.host, TICKS.id, man.rows[day].file).equals(v2), true);
    assert.ok(v3.length < v2.length);
    assert.equal(put(v3, '2026-10-11T10:00:00Z').action, 'keep');
    assert.equal(man.rows[day].sha256, C.sha256(v2)); assert.equal(man.rows[day].lastTry.status, 'differs');
    const alerts = ticksGapAlerts({ man, confirmed: new Set([day, '2026-10-12']), lastClosed: '2026-10-12', from: day });
    assert.ok(alerts.some(a => a.key === day && /不同版本/.test(a.status)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('計畫：清單上晚於最後收盤日的日檔（夜盤未來檔）略過；早於清單首檔的交易日記永久缺；已歸檔不重抓', () => {
  const man = { rows: Object.fromEntries(TD.slice(1, -1).map(d => [d, { status: 'ok', final: true }])) };
  const p = planTicks({ listDays: LIST_1009, man, confirmed: new Set(TD), lastClosed: '2026-10-08', from: '2026-08-26' });
  assert.deepEqual(p.fetch, ['2026-10-08']); assert.deepEqual(p.future, ['2026-10-12']); assert.deepEqual(p.lost, ['2026-08-26']); assert.deepEqual(p.unlisted, []);
  // 歸檔起點（TICKS.from＝08-27）之前的日子不算永久缺
  assert.equal(TICKS.from, '2026-08-27'); assert.deepEqual(planTicks({ listDays: LIST_1009, man, confirmed: new Set(TD), lastClosed: '2026-10-08' }).lost, []);
  // 10-12 收盤歸檔後（交易日表確認 10-12）才抓同名檔
  const p2 = planTicks({ listDays: LIST_1009, man, confirmed: new Set([...TD, '2026-10-12']), lastClosed: '2026-10-12' });
  assert.deepEqual(p2.fetch, ['2026-10-08', '2026-10-12']); assert.deepEqual(p2.future, []);
  // 待抓：最後收盤日之前都歸檔了 ⇒ 空（本輪不抓清單）；lost 不算待抓
  const man2 = { rows: { ...man.rows, '2026-10-08': { status: 'ok', final: true }, '2026-08-26': { status: 'lost' } } };
  assert.deepEqual(ticksPending({ man: man2, confirmed: new Set(TD), lastClosed: '2026-10-08' }), []);
});

test('runTicks：補假日清單含 10-12 夜盤檔 ⇒ 只抓已收盤的 10-08、10-12 一次都不請求；滾出清單的日子記 lost；全部歸檔後 0 請求', async () => {
  const root = tmp();
  try {
    // 08-27 沒歸檔、清單首檔已是 08-28 ⇒ 08-27 永久缺
    const man = { id: TICKS.id, host: TICKS.host, rows: Object.fromEntries(TD.slice(2, -1).map(d => [d, { status: 'ok', final: true }])) };
    C.saveManifest(root, man);
    const f = fakeFetch({ [TICKS.listUrl]: Buffer.from(listHtml([...TD.slice(2), '2026-10-12'], T1012)), [ticksFileUrl('2026-10-08')]: fullDay('2026-10-08', '2026-10-07'),
      [ticksFileUrl('2026-10-12')]: () => { throw new Error('不該請求未來交易日檔'); } });
    const q = quietQueue(); const now = () => new Date('2026-10-09T10:10:00Z');
    const r = await runTicks({ root, confirmed: new Set(TD), lastClosed: '2026-10-08', q, fetchImpl: f.impl, now });
    assert.equal(r.requests, 2); assert.deepEqual(f.calls, [TICKS.listUrl, ticksFileUrl('2026-10-08')]);
    assert.deepEqual(r.plan.future, ['2026-10-12']); assert.deepEqual(r.plan.lost, ['2026-08-27']);
    const m2 = C.loadManifest(root, TICKS.host, TICKS.id);
    assert.equal(m2.rows['2026-10-08'].status, 'ok'); assert.equal(m2.rows['2026-08-27'].status, 'lost'); assert.equal(m2.rows['2026-08-26'], undefined); assert.equal(m2.rows['2026-10-12'], undefined);
    assert.equal(m2.list.first, '2026-08-28'); assert.ok(existsSync(join(C.datasetDir(root, TICKS.host, TICKS.id), m2.list.file)));
    const r2 = await runTicks({ root, confirmed: new Set(TD), lastClosed: '2026-10-08', q, fetchImpl: f.impl, now });
    assert.equal(r2.requests, 0); assert.equal(f.calls.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runTicks：已收盤日拿到只有夜盤的版本 ⇒ 拒收；清單時間沒變不重抓；重新上架（時間變新）才抓到完整版；403 立即停機構', async () => {
  const root = tmp();
  try {
    const day = '2026-10-13'; const days = [...TD.slice(2), '2026-10-12', day];
    let served = zip(fname(day), csv([['20261012', '150000'], ['20261013', '050000']]));
    let t13 = '2026/10/13 PM 04:38:00';   // 清單時間看似完整、內容卻只有夜盤（回聲把關）
    const f = fakeFetch({ [TICKS.listUrl]: () => Buffer.from(listHtml(days, { [day]: t13 })), [ticksFileUrl(day)]: () => served });
    const conf = new Set(['2026-10-12', day]); const now = () => new Date('2026-10-14T10:10:00Z');
    const base = { root, confirmed: conf, lastClosed: day, fetchImpl: f.impl, now };
    C.saveManifest(root, { id: TICKS.id, host: TICKS.host, rows: Object.fromEntries([...TD.slice(2), '2026-10-12'].map(d => [d, { status: 'ok', final: true }])) });
    const r1 = await runTicks({ ...base, q: quietQueue() });
    assert.equal(r1.stats.partial, 1); assert.equal(C.loadManifest(root, TICKS.host, TICKS.id).rows[day].status, 'partial');
    assert.ok(!existsSync(join(C.datasetDir(root, TICKS.host, TICKS.id), `${day}.zip.gz`)));
    const r2 = await runTicks({ ...base, q: quietQueue() });                 // 同一上架版本：只花清單 1 個請求
    assert.equal(r2.requests, 1); assert.deepEqual(r2.plan.stale, [day]);
    served = fullDay(day, '2026-10-12'); t13 = '2026/10/13 PM 05:20:00';   // 官方重新上架
    const r3 = await runTicks({ ...base, q: quietQueue() });
    assert.equal(r3.requests, 2); assert.equal(r3.stats.new, 1);
    const row = C.loadManifest(root, TICKS.host, TICKS.id).rows[day];
    assert.equal(row.status, 'ok'); assert.equal(row.listTime, '2026-10-13T17:20:00');
    // 封鎖：清單頁 403 ⇒ 佇列停、不抓日檔
    const g = fakeFetch({ [TICKS.listUrl]: { status: 403 } }); const q = quietQueue();
    C.saveManifest(root, { id: TICKS.id, host: TICKS.host, rows: {} });
    const r4 = await runTicks({ ...base, fetchImpl: g.impl, q });
    assert.equal(q.stopped, true); assert.equal(g.calls.length, 1); assert.equal(r4.stats.listFail, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('同名更新偵測（0 個額外請求）：已歸檔日清單時間變新才重抓；轉存列 zip 時間與清單相符 ⇒ 直接記上；清單時間早於 13:45 ⇒ 不抓', () => {
  const ok = extra => ({ status: 'ok', final: true, ...extra });
  const man = { rows: {
    '2026-10-06': ok({ listTime: '2026-10-06T16:37:40' }),                   // 清單沒變
    '2026-10-07': ok({ listTime: '2026-10-07T16:38:55' }),                   // 重新上架
    '2026-10-08': ok({ zipTime: '2026-10-08T16:37:36', migrated: true }),    // 轉存：與清單差 4 秒
    '2026-10-05': ok({ zipTime: '2026-10-05T09:00:00', migrated: true }),    // 轉存的是較早版本
  } };
  const times = { '2026-10-05': '2026-10-05T16:39:08', '2026-10-06': '2026-10-06T16:37:40', '2026-10-07': '2026-10-07T18:02:11', '2026-10-08': '2026-10-08T16:37:40', '2026-10-12': '2026-10-12T05:11:42' };
  const p = planTicks({ listDays: Object.keys(times).sort(), times, man, confirmed: new Set(Object.keys(times)), lastClosed: '2026-10-12', from: '2026-10-05' });
  assert.deepEqual(p.fetch, ['2026-10-05', '2026-10-07']); assert.deepEqual(p.updated, ['2026-10-05', '2026-10-07']);
  assert.deepEqual(p.adopt, ['2026-10-08']); assert.deepEqual(p.notReady, ['2026-10-12']); assert.deepEqual(p.future, []);
});

test('verify：清單＋最新收盤日檔；本機已有 ⇒ 重下載比對 sha256', async () => {
  const root = tmp();
  try {
    const full = fullDay('2026-10-08', '2026-10-07'); const man = { id: TICKS.id, host: TICKS.host, rows: {} };
    storeTicksDay(root, man, '2026-10-08', full, validateTicksZip(full, '2026-10-08'), { at: '2026-10-09T07:00:00Z', url: 'u' }); C.saveManifest(root, man);
    const f = fakeFetch({ [TICKS.listUrl]: Buffer.from(listHtml(LIST_1009, T1012)), [ticksFileUrl('2026-10-08')]: full });
    const v = await verifyTicks({ root, lastClosed: '2026-10-08', q: quietQueue(), fetchImpl: f.impl, now: () => new Date('2026-10-09T09:00:00Z') });
    assert.equal(v.ok, true); assert.equal(v.key, '2026-10-08'); assert.equal(v.sameAsLocal, true); assert.equal(v.list.n, 30);
    assert.deepEqual(f.calls, [TICKS.listUrl, ticksFileUrl('2026-10-08')]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('轉存一次性回補：sha256 相符才收、missing 記永久缺、第二次 0 檔；缺口警示不含最後收盤日', () => {
  const root = tmp(); const src = tmp();
  try {
    const a = fullDay('2026-10-07', '2026-10-06'); const b = fullDay('2026-10-08', '2026-10-07');
    writeFileSync(join(src, 'Daily_2026_10_07.zip'), a); writeFileSync(join(src, 'Daily_2026_10_08.zip'), b);
    writeFileSync(join(src, '_manifest.json'), JSON.stringify({
      files: { 'Daily_2026_10_07.zip': { bytes: a.length, sha256: C.sha256(a) }, 'Daily_2026_10_08.zip': { bytes: b.length, sha256: 'f'.repeat(64) } },
      missing: { '2026-10-06': '已滾出 30 日窗' } }));
    assert.equal(migrateTicks({ root, src }), 1);
    const man = C.loadManifest(root, TICKS.host, TICKS.id);
    assert.equal(man.rows['2026-10-07'].status, 'ok'); assert.equal(man.rows['2026-10-07'].migrated, true); assert.equal(man.rows['2026-10-07'].sha256, C.sha256(a));
    assert.equal(man.rows['2026-10-08'], undefined); assert.equal(man.rows['2026-10-06'].status, 'lost');
    assert.equal(migrateTicks({ root, src }), 0);
    const conf = new Set(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-12']);
    const al = ticksGapAlerts({ man, confirmed: conf, lastClosed: '2026-10-12', from: '2026-10-05' });
    assert.deepEqual(al.map(x => x.key), ['2026-10-05', '2026-10-06', '2026-10-08']);
    assert.match(al.find(x => x.key === '2026-10-06').status, /永久缺/);
    assert.ok(!readdirSync(src).some(f => f.endsWith('.gz')));   // 來源目錄不動
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }); }
});

test('未設定目錄不存在時轉存回 0（不丟錯）', () => {
  const root = tmp();
  try { mkdirSync(join(root, 'x')); assert.equal(migrateTicks({ root, src: join(root, 'nope') }), 0); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('zip：stored（不壓縮）也認；多個 CSV ⇒ bad', () => {
  const data = csv([['20261007', '150000'], ['20261008', '134500']]);
  assert.equal(validateTicksZip(zipMulti([[fname('2026-10-08'), data]], { method: 0 }), '2026-10-08').status, 'ok');
  const two = validateTicksZip(zipMulti([[fname('2026-10-08'), data], ['other.csv', data]]), '2026-10-08');
  assert.equal(two.status, 'bad'); assert.match(two.note, /CSV 檔數 2/);
});

test('CSV 壞列：零星（檔尾 EOF、單行註記）容忍並記 badRows；超過門檻或表頭不對 ⇒ 拒收', () => {
  const good = csv([['20261007', '150000'], ['20261008', '084500'], ['20261008', '134500']]);
  const withJunk = Buffer.concat([good, Buffer.from('本資料僅供參考\r\n\x1a', 'latin1')]);
  const r = scanTicksCsv(withJunk); assert.equal(r.ok, true); assert.equal(r.badRows, 1); assert.equal(r.rows, 3);
  const v = validateTicksZip(zip(fname('2026-10-08'), withJunk), '2026-10-08'); assert.equal(v.status, 'ok'); assert.equal(v.badRows, 1); assert.match(v.note, /容忍 1 列/);
  const tooMany = Buffer.concat([good, Buffer.from('x\r\ny\r\nz\r\nw\r\n', 'latin1')]);
  assert.equal(scanTicksCsv(tooMany).ok, false);
  assert.equal(scanTicksCsv(Buffer.from('date,code,month,time\r\n20261008,TX,202610,134500\r\n', 'latin1')).ok, false);
});

test('最後收盤日：交易日表確認日；今天是候選交易日且過 16:50 也算；休市日不算', () => {
  const confirmed = new Set(['2026-10-07', '2026-10-08']);
  // 10-09 補假（不在候選）：17:10 仍是 10-08
  assert.equal(ticksClosedFrom({ confirmed, candidates: ['2026-10-07', '2026-10-08'], today: '2026-10-09', now: new Date('2026-10-09T09:10:00Z') }).lastClosed, '2026-10-08');
  // 10-12 平日：16:49 還不算、16:50 起算
  const cand = ['2026-10-07', '2026-10-08', '2026-10-12'];
  assert.equal(ticksClosedFrom({ confirmed, candidates: cand, today: '2026-10-12', now: new Date('2026-10-12T08:49:00Z') }).lastClosed, '2026-10-08');
  const c = ticksClosedFrom({ confirmed, candidates: cand, today: '2026-10-12', now: new Date('2026-10-12T08:50:00Z') });
  assert.equal(c.lastClosed, '2026-10-12'); assert.ok(c.closed.has('2026-10-12'));
  // 確認日不會超過今天
  assert.equal(ticksClosedFrom({ confirmed: new Set(['2026-10-13']), candidates: [], today: '2026-10-12', now: new Date('2026-10-12T09:00:00Z') }).lastClosed, null);
});

test('日檔請求：429 立即停機構；200 但不是 zip 算失敗、連 3 次停（不再當成功）', async () => {
  const root = tmp();
  try {
    const days = TD.slice(1); const pend = TD.slice(-5);
    C.saveManifest(root, { id: TICKS.id, host: TICKS.host, rows: Object.fromEntries(days.filter(d => !pend.includes(d)).map(d => [d, { status: 'ok', final: true }])) });
    const base = { root, confirmed: new Set(TD), lastClosed: '2026-10-08', now: () => new Date('2026-10-09T09:10:00Z') };
    const a = fakeFetch({ [TICKS.listUrl]: Buffer.from(listHtml(days)), ...Object.fromEntries(pend.map(d => [ticksFileUrl(d), { status: 429 }])) });
    const qa = quietQueue(); const ra = await runTicks({ ...base, q: qa, fetchImpl: a.impl });
    assert.equal(qa.stopped, true); assert.equal(a.calls.length, 2); assert.equal(ra.requests, 2);
    const b = fakeFetch({ [TICKS.listUrl]: Buffer.from(listHtml(days)), ...Object.fromEntries(pend.map(d => [ticksFileUrl(d), { status: 200, body: '<html>系統維護</html>' }])) });
    const qb = quietQueue(); await runTicks({ ...base, q: qb, fetchImpl: b.impl });
    assert.equal(qb.stopped, true); assert.match(qb.stopReason, /連續失敗 3 次/); assert.equal(b.calls.length, 4);
    assert.equal(C.loadManifest(root, TICKS.host, TICKS.id).rows[pend[0]].status, 'fail');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('拒收：zip 完整的原樣隔離到 _rejected/（同 sha 不重寫）；zip 壞同一上架版本重抓滿 3 次後等重新上架', () => {
  const root = tmp();
  try {
    const man = { id: TICKS.id, host: TICKS.host, rows: {} }; const day = '2026-10-13'; const lt = '2026-10-13T16:38:00';
    const night = zip(fname(day), csv([['20261012', '150000'], ['20261013', '050000']]));
    const put = (buf, at) => storeTicksDay(root, man, day, buf, validateTicksZip(buf, day), { at, url: 'u', listTime: lt });
    put(night, '2026-10-13T09:10:00Z'); put(night, '2026-10-14T09:10:00Z');
    const rej = readdirSync(join(C.datasetDir(root, TICKS.host, TICKS.id), '_rejected'));
    assert.equal(rej.length, 1); assert.equal(man.rows[day].rejectedFile, `_rejected/${rej[0]}`);
    assert.equal(C.readEntry(root, TICKS.host, TICKS.id, man.rows[day].rejectedFile).equals(night), true);
    const plan = () => planTicks({ listDays: [day], times: { [day]: lt }, man, confirmed: new Set([day]), lastClosed: day, from: day });
    assert.deepEqual(plan().stale, [day]);                     // 同一上架版本已判定只有夜盤
    const man2 = { id: TICKS.id, host: TICKS.host, rows: {} }; const trunc = fullDay(day, '2026-10-12').subarray(0, 200);
    for (let i = 1; i <= 3; i++) {
      assert.deepEqual(planTicks({ listDays: [day], times: { [day]: lt }, man: man2, confirmed: new Set([day]), lastClosed: day, from: day }).fetch, [day]);
      storeTicksDay(root, man2, day, trunc, validateTicksZip(trunc, day), { at: `2026-10-1${3 + i}T09:10:00Z`, url: 'u', listTime: lt });
      assert.equal(man2.rows[day].zipRetry.n, i); assert.equal(man2.rows[day].rejectedFile, undefined);
    }
    assert.deepEqual(planTicks({ listDays: [day], times: { [day]: lt }, man: man2, confirmed: new Set([day]), lastClosed: day, from: day }).stale, [day]);
    assert.deepEqual(planTicks({ listDays: [day], times: { [day]: '2026-10-16T16:40:00' }, man: man2, confirmed: new Set([day]), lastClosed: day, from: day }).fetch, [day]);   // 重新上架
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('單輪上限：待抓 5 檔、--max-files 2 ⇒ 只抓最舊 2 檔，其餘記 overCap；清單少於 20 檔 ⇒ 整輪不抓日檔', async () => {
  const root = tmp();
  try {
    const days = TD.slice(1); const pend = TD.slice(-5);
    C.saveManifest(root, { id: TICKS.id, host: TICKS.host, rows: Object.fromEntries(days.filter(d => !pend.includes(d)).map(d => [d, { status: 'ok', final: true }])) });
    const prevOf = d => TD[TD.indexOf(d) - 1];
    const f = fakeFetch({ [TICKS.listUrl]: Buffer.from(listHtml(days)), ...Object.fromEntries(pend.map(d => [ticksFileUrl(d), fullDay(d, prevOf(d))])) });
    const r = await runTicks({ root, confirmed: new Set(TD), lastClosed: '2026-10-08', q: quietQueue(), fetchImpl: f.impl, now: () => new Date('2026-10-09T09:10:00Z'), maxFiles: 2 });
    assert.equal(r.stats.new, 2); assert.equal(r.stats.overCap, 3); assert.deepEqual(f.calls.slice(1), pend.slice(0, 2).map(ticksFileUrl));
    const g = fakeFetch({ [TICKS.listUrl]: Buffer.from(listHtml(days.slice(0, 10))) });
    const r2 = await runTicks({ root, confirmed: new Set(TD), lastClosed: '2026-10-08', q: quietQueue(), fetchImpl: g.impl, now: () => new Date('2026-10-09T09:10:00Z') });
    assert.equal(r2.stats.listFail, 1); assert.equal(g.calls.length, 1);
    assert.ok(readdirSync(join(C.datasetDir(root, TICKS.host, TICKS.id), '_list')).some(n => /\.bad-\d{6}\.html\.gz$/.test(n)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verify：清單上最新的是只有夜盤的版本（時間早於 13:45）⇒ 改驗前一個完整檔', async () => {
  const root = tmp();
  try {
    const full = fullDay('2026-10-08', '2026-10-07');
    const f = fakeFetch({ [TICKS.listUrl]: Buffer.from(listHtml(LIST_1009, T1012)), [ticksFileUrl('2026-10-08')]: full });
    const v = await verifyTicks({ root, lastClosed: '2026-10-12', q: quietQueue(), fetchImpl: f.impl, now: () => new Date('2026-10-12T05:00:00Z') });
    assert.equal(v.ok, true); assert.equal(v.key, '2026-10-08'); assert.equal(v.sameAsLocal, null); assert.equal(v.action, 'new');
    assert.ok(!f.calls.includes(ticksFileUrl('2026-10-12')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
