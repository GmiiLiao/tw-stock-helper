// 閒置券商稽核（--skip-idle-brokers 啟用前的檢驗）單元測試：node --test scripts/finmind/idle-audit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { appendMember, closeGroup, finalizeGroup, groupPaths, openGroup } from './store.mjs';
import { buildContext } from './backfill.mjs';
import { AUDIT_FILE, EXIT, auditIdle, main, parseArgs, probeStatus } from './idle-audit.mjs';

const DS = 'TaiwanStockTradingDailyReport';
const BROKERS = ['1001', '1020', '5555', '7777', '9A00'];
const DAYS = ['2022-12-30', '2023-01-03', '2023-03-15', '2023-07-03', '2024-01-02', '2024-04-11', '2024-07-01', '2024-10-08', '2024-10-09', '2025-01-02', '2025-03-03'];
const TODAY = '2025-03-04';   // 今天以前最後交易日 2025-03-03 ⇒ 探針 2023-01-03、2023-07-03、2024-01-02、2024-07-01、2025-01-02、2025-03-03
const PROBES = ['2023-01-03', '2023-07-03', '2024-01-02', '2024-07-01', '2025-01-02', '2025-03-03'];
const PROBE_ROWS = Object.freeze({ 1001: 0, 1020: 5, 5555: 0, 7777: 0, '9A00': 3 });   // 1001、5555、7777 探針全 0
const AUDIT = '2024-10-08';
const tmp = () => mkdtempSync(join(tmpdir(), 'fm-idle-'));

/** 寫一天的分點群組：rowsBy＝索引登錄的列數；dataRowsBy＝實際寫進 gz 的列數（預設相同，用來做索引與資料不符）。 */
function writeDay(root, date, rowsBy, { finalize = true, dataRowsBy = rowsBy } = {}) {
  const g = openGroup(groupPaths(root, DS, date));
  for (const [id, n] of Object.entries(rowsBy)) {
    const k = dataRowsBy[id] ?? n;
    const lines = Array.from({ length: k }, (_, i) => JSON.stringify({ securities_trader_id: id, stock_id: '2330', price: 100 + i, buy: 1000, sell: 0, date }));
    appendMember(g, id, k ? gzipSync(`${lines.join('\n')}\n`) : null, n);
  }
  if (finalize) finalizeGroup(g); else closeGroup(g);
}

/** 探針 6 天全收尾；2024-04-11 是已抓完整的非探針日，5555 當天有成交（佐證：不算閒置）。 */
function fixture({ probes = PROBES } = {}) {
  const root = tmp();
  for (const d of probes) writeDay(root, d, PROBE_ROWS);
  writeDay(root, '2024-04-11', { ...PROBE_ROWS, 5555: 2 });
  return root;
}
const audit = (root, extra = {}) => auditIdle({ root, days: DAYS, todayIso: TODAY, auditDate: AUDIT, brokers: BROKERS, ...extra });
const fakeLd = { tradingDays: () => DAYS, brokersFor: () => BROKERS, stocksFor: () => [], etfsFor: () => [] };
const run = async (argv, root) => { const out = []; const code = await main(argv, { root, ld: fakeLd, todayIso: TODAY, print: s => out.push(String(s)) }); return { code, out: out.join('\n') }; };

test('auditIdle：閒置券商在稽核日全部 0 列 ⇒ 通過；紀錄含稽核日、閒置券商數、結果、被佐證排除的券商', async () => {
  const root = fixture();
  writeDay(root, AUDIT, PROBE_ROWS);
  const r = await audit(root);
  assert.equal(r.code, EXIT.ok, r.reasons.join('；'));
  assert.equal(r.record.result, 'pass');
  assert.equal(r.record.auditDate, AUDIT);
  assert.equal(r.record.idleCount, 2);
  assert.deepEqual(r.record.idleIds, ['1001', '7777']);
  assert.deepEqual(r.record.excluded, [{ id: '5555', dates: ['2024-04-11'] }]);
  assert.deepEqual(r.record.probes, PROBES);
  assert.equal(r.record.auditDay.brokers, 5);
  assert.equal(r.record.auditDay.rows, 8);
  assert.equal(r.record.auditDay.dataRows, 8);
});

test('auditIdle：任一閒置券商在稽核日有成交 ⇒ 結束碼 1，原因列出券商與列數', async () => {
  const root = fixture();
  writeDay(root, AUDIT, { ...PROBE_ROWS, 7777: 4 });
  const r = await audit(root);
  assert.equal(r.code, EXIT.violation);
  assert.match(r.reasons.join('\n'), /7777.*4 列/);
  assert.equal(r.record.result, 'fail');
  assert.deepEqual(r.record.violations, [{ id: '7777', rows: 4 }]);
});

test('auditIdle：稽核日本身不當佐證——只在稽核日有成交的券商仍在閒置候選內，會被抓到（不會自己證明自己）', async () => {
  const root = tmp();
  for (const d of PROBES) writeDay(root, d, PROBE_ROWS);
  writeDay(root, AUDIT, { ...PROBE_ROWS, 5555: 1 });
  const r = await audit(root);
  assert.equal(r.code, EXIT.violation);
  assert.deepEqual(r.record.violations, [{ id: '5555', rows: 1 }]);
});

test('auditIdle：稽核日覆蓋未完成 ⇒ 結束碼 3（沒收尾；收尾了但缺券商＝帶了 --skip-idle-brokers 抓的；整天 0 列＝FinMind 缺日）', async () => {
  const part = fixture(); writeDay(part, AUDIT, PROBE_ROWS, { finalize: false });
  const a = await audit(part);
  assert.equal(a.code, EXIT.notReady); assert.match(a.reasons[0], /尚未收尾/);
  const none = await audit(fixture());
  assert.equal(none.code, EXIT.notReady); assert.match(none.reasons[0], /尚未收尾/);
  const skipped = fixture(); writeDay(skipped, AUDIT, { 1020: 5, 5555: 0, '9A00': 3 });
  const b = await audit(skipped);
  assert.equal(b.code, EXIT.notReady); assert.match(b.reasons[0], /缺 2 家券商.*1001、7777/);
  const empty = fixture(); writeDay(empty, AUDIT, Object.fromEntries(BROKERS.map(id => [id, 0])));
  const c = await audit(empty);
  assert.equal(c.code, EXIT.notReady); assert.match(c.reasons[0], /0 列/);
});

test('auditIdle：資料檔與索引不符（索引 0 列、資料卻有該券商的列）⇒ 結束碼 1', async () => {
  const root = fixture();
  writeDay(root, AUDIT, PROBE_ROWS, { dataRowsBy: { ...PROBE_ROWS, 1001: 1 } });
  const r = await audit(root);
  assert.equal(r.code, EXIT.violation);
  assert.match(r.reasons.join('\n'), /資料檔 9 列≠索引 8 列/);
  assert.match(r.reasons.join('\n'), /1001.*資料檔有 1 列/);
});

test('auditIdle：稽核日不合法 ⇒ 結束碼 2（非交易日、探針日、不在略過區間）；探針不足 4 個 ⇒ 結束碼 3', async () => {
  const root = fixture();
  assert.equal((await audit(root, { auditDate: '2024-10-10' })).code, EXIT.usage);
  const probe = await audit(root, { auditDate: '2024-07-01' });
  assert.equal(probe.code, EXIT.usage); assert.match(probe.reasons[0], /探針日/);
  const out = await audit(root, { auditDate: '2022-12-30' });
  assert.equal(out.code, EXIT.usage); assert.match(out.reasons[0], /略過區間/);
  const few = fixture({ probes: PROBES.slice(0, 3) });
  writeDay(few, AUDIT, PROBE_ROWS);
  const f = await audit(few);
  assert.equal(f.code, EXIT.notReady); assert.match(f.reasons[0], /探針.*3 個/);
});

test('auditIdle：沒有券商清單（TaiwanSecuritiesTraderInfo 未下載）⇒ 結束碼 3，不猜', async () => {
  const root = fixture(); writeDay(root, AUDIT, PROBE_ROWS);
  const r = await audit(root, { brokers: null });
  assert.equal(r.code, EXIT.notReady); assert.match(r.reasons[0], /券商清單/);
});

test('與 --skip-idle-brokers 同口徑：稽核通過後，backfill 的閒置集合＝稽核的閒置集合', async () => {
  const root = fixture(); writeDay(root, AUDIT, PROBE_ROWS);
  const r = await audit(root);
  const ctx = buildContext({ dataset: 'x', root, skipIdleBrokers: true }, fakeLd, root, TODAY);
  assert.deepEqual(ctx.idleBrokers.ids, r.record.idleIds);
});

test('main --date：通過寫 _idle-audit.json、結束碼 0；--no-write 不寫；不通過不寫、結束碼 1', async () => {
  const root = fixture(); writeDay(root, AUDIT, PROBE_ROWS);
  const file = join(root, DS, AUDIT_FILE);
  const dry = await run(['--date', AUDIT, '--no-write', '--root', root], root);
  assert.equal(dry.code, 0); assert.equal(existsSync(file), false); assert.match(dry.out, /通過/);
  const ok = await run(['--date', AUDIT, '--root', root], root);
  assert.equal(ok.code, 0);
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(rec.auditDate, AUDIT); assert.equal(rec.idleCount, 2); assert.equal(rec.result, 'pass');
  const bad = fixture(); writeDay(bad, AUDIT, { ...PROBE_ROWS, 1001: 2 });
  const no = await run(['--date', AUDIT, '--root', bad], bad);
  assert.equal(no.code, 1); assert.equal(existsSync(join(bad, DS, AUDIT_FILE)), false); assert.match(no.out, /1001/);
});

test('probeStatus／main --probe-status：探針日全部收尾且涵蓋全部券商 ⇒ 0；有缺 ⇒ 3（判斷第一步 --probe-brokers 是否完成）', async () => {
  const root = fixture();
  const s = probeStatus({ root, days: DAYS, todayIso: TODAY, brokers: BROKERS });
  assert.equal(s.complete, true); assert.equal(s.idleCount, 2); assert.equal(s.probes.length, 6);
  assert.equal((await run(['--probe-status', '--root', root], root)).code, 0);
  const few = fixture({ probes: PROBES.slice(0, 5) });
  const t = probeStatus({ root: few, days: DAYS, todayIso: TODAY, brokers: BROKERS });
  assert.equal(t.complete, false); assert.deepEqual(t.probes.filter(p => !p.final).map(p => p.date), ['2025-03-03']);
  const r = await run(['--probe-status', '--root', few], few);
  assert.equal(r.code, 3); assert.match(r.out, /2025-03-03/);
});

test('parseArgs：--date 要 YYYY-MM-DD；--date 與 --probe-status 擇一；看不懂的參數報錯', () => {
  assert.deepEqual(parseArgs(['--date', AUDIT, '--no-write']), { date: AUDIT, noWrite: true });
  assert.deepEqual(parseArgs(['--probe-status']), { probeStatus: true });
  assert.throws(() => parseArgs(['--date', '2024/10/08']), /YYYY-MM-DD/);
  assert.throws(() => parseArgs([]), /--date 或 --probe-status/);
  assert.throws(() => parseArgs(['--date', AUDIT, '--probe-status']), /擇一/);
  assert.throws(() => parseArgs(['--bogus']), /看不懂/);
  assert.throws(() => parseArgs(['--date']), /缺值/);
});
