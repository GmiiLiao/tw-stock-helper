import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { resolveSession, evaluateRunGates, runOnce, pollLoop, pastDeadline, readTradingDays, readHolidays, expectedPrevTradingDay, isTerminal, WINDOWS } from './run-flow.mjs';
import { writeIssue, archiveDir, isFinal } from './archive.mjs';
import { makeIssue, makePack, makeTemplateShell, DAY, TRADING_DAYS } from './w5-fixtures.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'analyst-run-'));
const tw = s => Date.parse(`${s}+08:00`);
const HOLIDAYS = new Set(['2026-10-08']);                    // 虛構的表訂休市（週四）：fixtures 的交易日清單已排除
const EVE = tw('2026-10-02T23:25:00');                       // 週五晚上（資料日 10/02）
const MOR = tw('2026-10-05T06:15:00');                       // 週一早上（morning 的資料日＝10/02）

/** 在 root 放一份熱力定版（latest.json＋manifest＋檔案）。 */
function putHeatmap(root, day, { prev = null } = {}) {
  const dir = join(root, 'daily-heatmap'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.json.gz`), gzipSync('{}'));
  if (prev) writeFileSync(join(dir, `${prev}.json.gz`), gzipSync('{}'));
  writeFileSync(join(dir, '_manifest.json'), JSON.stringify({ rows: { [day]: { status: 'final', file: `${day}.json.gz` } } }));
  writeFileSync(join(dir, 'latest.json'), JSON.stringify({ dataDate: day, canonicalAt: 'x' }));
}
function mkDeps(over = {}) {
  const calls = { loadPack: 0, produce: 0, publish: 0 };
  const deps = {
    loadPack: async ({ date, edition }) => { calls.loadPack++; return makePack(date, edition); },
    produce: async ({ pack }) => { calls.produce++; return { issue: makeIssue(pack.dataDate, pack.edition), transcript: [{ label: 'r1' }], engineUsed: 'claude-cli', errors: [] }; },
    publish: async () => { calls.publish++; return true; },
    ...over,
  };
  return { deps, calls };
}
const base = root => ({ root, tradingDays: TRADING_DAYS, holidays: HOLIDAYS });

test('resolveSession：evening 取場次日；週末／休市日＝非交易日；鏡像沒有的平日＝等鏡像', () => {
  const ev = n => resolveSession({ edition: 'evening', nowMs: n, tradingDays: TRADING_DAYS, holidays: HOLIDAYS });
  assert.deepEqual([ev(EVE).state, ev(EVE).day], ['ok', DAY]);
  assert.equal(ev(tw('2026-10-03T00:10:00')).day, DAY);                       // 跨午夜仍是 10/02 場次
  assert.equal(ev(tw('2026-10-03T23:25:00')).state, 'non-trading');           // 週六
  assert.equal(ev(tw('2026-10-08T23:25:00')).state, 'non-trading');           // 表訂休市
  assert.equal(ev(tw('2026-10-13T23:25:00')).state, 'waiting-mirror');        // 平日、鏡像尚無
});

test('resolveSession：morning 取今天之前最後一個交易日；鏡像落後＝等鏡像', () => {
  const mo = n => resolveSession({ edition: 'morning', nowMs: n, tradingDays: TRADING_DAYS, holidays: HOLIDAYS });
  assert.deepEqual([mo(MOR).state, mo(MOR).day], ['ok', DAY]);
  assert.equal(mo(tw('2026-10-06T06:15:00')).day, '2026-10-05');
  assert.equal(mo(tw('2026-10-13T06:15:00')).day, '2026-10-12');
  assert.equal(mo(tw('2026-10-14T06:15:00')).state, 'waiting-mirror');       // 預期最後交易日 10/13，鏡像只到 10/12
});

test('expectedPrevTradingDay：跳過週末與表訂休市', () => {
  assert.equal(expectedPrevTradingDay('2026-10-09', HOLIDAYS), '2026-10-07');
  assert.equal(expectedPrevTradingDay('2026-10-05', HOLIDAYS), '2026-10-02');
});

test('pastDeadline／WINDOWS', () => {
  assert.equal(pastDeadline('evening', tw('2026-10-03T00:29:00')), false);
  assert.equal(pastDeadline('evening', tw('2026-10-03T00:31:00')), true);
  assert.equal(pastDeadline('evening', tw('2026-10-02T23:30:00')), false);
  assert.equal(pastDeadline('morning', tw('2026-10-05T07:29:00')), false);
  assert.equal(pastDeadline('morning', tw('2026-10-05T07:30:00')), true);
  assert.equal(WINDOWS.evening.startMin, 23 * 60 + 20); assert.equal(WINDOWS.morning.startMin, 6 * 60 + 10);
});

test('evaluateRunGates：P1 熱力未定版＝硬失敗；已定版通過；P2 缺前日熱力＝軟警告', () => {
  const root = tmp();
  const g0 = evaluateRunGates({ root, day: DAY, tradingDays: TRADING_DAYS, holidays: HOLIDAYS });
  assert.equal(g0.pass, false); assert.match(g0.hard[0], /^P1/);
  putHeatmap(root, '2026-10-01');                                              // 只有前一日：latest.dataDate ≠ DAY
  assert.equal(evaluateRunGates({ root, day: DAY, tradingDays: TRADING_DAYS, holidays: HOLIDAYS }).pass, false);
  putHeatmap(root, DAY);                                                       // 10/01 的熱力檔先前已放過 ⇒ P2 也過
  const g1 = evaluateRunGates({ root, day: DAY, tradingDays: TRADING_DAYS, holidays: HOLIDAYS });
  assert.equal(g1.pass, true);
  assert.ok(!g1.soft.some(s => /^P2/.test(s)));
  const root2 = tmp(); putHeatmap(root2, DAY);                                 // 沒有前一交易日熱力檔
  const g2 = evaluateRunGates({ root: root2, day: DAY, tradingDays: TRADING_DAYS, holidays: HOLIDAYS });
  assert.equal(g2.pass, true);
  assert.ok(g2.soft.some(s => /^P2/.test(s)));
});

test('evaluateRunGates pinned（指定日期補跑舊日）：latest 指向更新的日子也照過，只看 manifest rows[day].status＝final（2026-10-09）', () => {
  const root = tmp();
  const dir = join(root, 'daily-heatmap'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${DAY}.json.gz`), gzipSync('{}'));
  writeFileSync(join(dir, '_manifest.json'), JSON.stringify({ rows: { [DAY]: { status: 'final', file: `${DAY}.json.gz` }, '2026-10-05': { status: 'final', file: '2026-10-05.json.gz' } } }));
  writeFileSync(join(dir, 'latest.json'), JSON.stringify({ dataDate: '2026-10-05' }));
  // 不指定日期：舊行為（latest ≠ DAY ⇒ P1 硬失敗）
  const g0 = evaluateRunGates({ root, day: DAY, tradingDays: TRADING_DAYS, holidays: HOLIDAYS });
  assert.equal(g0.pass, false); assert.match(g0.hard[0], /^P1 熱力尚未定版/);
  // 指定日期：manifest 該日 final＋檔在 ⇒ 過
  assert.equal(evaluateRunGates({ root, day: DAY, tradingDays: TRADING_DAYS, holidays: HOLIDAYS, pinned: true }).pass, true);
  // 指定日期但 manifest 非 final ⇒ 硬失敗
  writeFileSync(join(dir, '_manifest.json'), JSON.stringify({ rows: { [DAY]: { status: 'draft', file: `${DAY}.json.gz` } } }));
  const g2 = evaluateRunGates({ root, day: DAY, tradingDays: TRADING_DAYS, holidays: HOLIDAYS, pinned: true });
  assert.equal(g2.pass, false); assert.match(g2.hard[0], /非 final/);
  // 指定日期、manifest 沒有該日 ⇒ 硬失敗
  writeFileSync(join(dir, '_manifest.json'), JSON.stringify({ rows: {} }));
  assert.equal(evaluateRunGates({ root, day: DAY, tradingDays: TRADING_DAYS, holidays: HOLIDAYS, pinned: true }).pass, false);
  // 指定日期、final 但檔案不見 ⇒ 硬失敗
  writeFileSync(join(dir, '_manifest.json'), JSON.stringify({ rows: { [DAY]: { status: 'final', file: 'gone.json.gz' } } }));
  assert.match(evaluateRunGates({ root, day: DAY, tradingDays: TRADING_DAYS, holidays: HOLIDAYS, pinned: true }).hard[0], /定版檔不存在/);
});

test('runOnce 帶 day（--date 補跑）：latest 已是更新的日子仍能組包定版', async () => {
  const root = tmp(); putHeatmap(root, '2026-10-01'); putHeatmap(root, DAY);
  // 補跑 10/01：manifest 補上 10/01 final，latest 指向 DAY
  const dir = join(root, 'daily-heatmap');
  writeFileSync(join(dir, '_manifest.json'), JSON.stringify({ rows: { '2026-10-01': { status: 'final', file: '2026-10-01.json.gz' }, [DAY]: { status: 'final', file: `${DAY}.json.gz` } } }));
  const { deps, calls } = mkDeps();
  const r = await runOnce({ ...base(root), edition: 'evening', nowMs: EVE, day: '2026-10-01', deps });
  assert.notEqual(r.status, 'pending', JSON.stringify(r.reasons));
  assert.equal(r.day, '2026-10-01');
  assert.equal(calls.loadPack, 1);
});

test('runOnce：已定版直接結束（不組包、不呼叫模型），只補確認發佈', async () => {
  const root = tmp(); putHeatmap(root, DAY);
  writeIssue({ root, issue: makeIssue(DAY, 'evening'), pack: makePack(), transcript: [], edition: 'evening', dataDate: DAY, now: EVE });
  const { deps, calls } = mkDeps();
  const r = await runOnce({ ...base(root), edition: 'evening', nowMs: EVE, deps });
  assert.equal(r.status, 'already-final');
  assert.deepEqual(calls, { loadPack: 0, produce: 0, publish: 1 });
  const r2 = await runOnce({ ...base(root), edition: 'evening', nowMs: EVE, deps: mkDeps({ publish: async () => false }).deps });
  assert.equal(r2.status, 'final-unpublished');                               // 發佈失敗：下輪重試，不是終端
  assert.equal(isTerminal(r2.status), false);
});

test('runOnce：硬閘門不過 → 寫 _pending、不組包、不產檔', async () => {
  const root = tmp();                                                          // 沒有熱力
  const { deps, calls } = mkDeps();
  const r = await runOnce({ ...base(root), edition: 'evening', nowMs: EVE, deps });
  assert.equal(r.status, 'pending');
  assert.equal(calls.loadPack, 0); assert.equal(calls.produce, 0);
  const p = JSON.parse(readFileSync(join(archiveDir(root), '_pending', `${DAY}.evening.json`), 'utf8'));
  assert.match(p.reasons[0], /P1/);
  assert.equal(isFinal(root, DAY, 'evening'), false);
});

test('runOnce：pack 閘門回硬失敗／組包丟錯／資料日不符 → pending', async () => {
  const root = tmp(); putHeatmap(root, DAY, { prev: '2026-10-01' });
  let r = await runOnce({ ...base(root), edition: 'evening', nowMs: EVE, deps: mkDeps({ packGates: async () => ({ pass: false, hard: ['P8 風險旗標無法驗證'] }) }).deps });
  assert.deepEqual([r.status, r.reasons[0]], ['pending', 'P8 風險旗標無法驗證']);
  r = await runOnce({ ...base(root), edition: 'evening', nowMs: EVE, deps: mkDeps({ loadPack: async () => { throw new Error('P7 日曆缺'); } }).deps });
  assert.deepEqual([r.status, r.reasons[0]], ['pending', '組包失敗：P7 日曆缺']);
  r = await runOnce({ ...base(root), edition: 'evening', nowMs: EVE, deps: mkDeps({ loadPack: async () => makePack('2026-10-01') }).deps });
  assert.equal(r.status, 'pending');
  assert.equal(isFinal(root, DAY, 'evening'), false);
});

test('runOnce：成功 → 寫定版檔並發佈（evening 卡片標籤以資料日為當日）', async () => {
  const root = tmp(); putHeatmap(root, DAY, { prev: '2026-10-01' });
  let seen;
  const { deps, calls } = mkDeps({ produce: async o => { seen = o; return { issue: makeIssue(DAY, 'evening'), transcript: [], engineUsed: 'claude-cli', errors: [] }; } });
  const r = await runOnce({ ...base(root), edition: 'evening', nowMs: tw('2026-10-03T00:10:00'), deps });
  assert.equal(r.status, 'final');
  assert.equal(calls.publish, 1);
  assert.equal(seen.todayISO, DAY);
  assert.deepEqual(seen.engines, ['claude-cli', 'ollama']);
  assert.ok(isFinal(root, DAY, 'evening'));
  assert.equal(existsSync(join(archiveDir(root), '_pending', `${DAY}.evening.json`)), false);
});

test('runOnce：最終引擎是模板 → 不寫定版檔、不發佈，改寫 _pending＋_alerts', async () => {
  const root = tmp(); putHeatmap(root, DAY, { prev: '2026-10-01' });
  const { deps, calls } = mkDeps({ produce: async ({ pack }) => ({ issue: makeTemplateShell(pack.dataDate, pack.edition), transcript: [], engineUsed: 'template', errors: [{ engine: 'claude-cli', error: '401 未登入', auth: true }, { engine: 'ollama', error: 'ollama 連線失敗' }] }) });
  const r = await runOnce({ ...base(root), edition: 'evening', nowMs: EVE, deps });
  assert.equal(r.status, 'template-fallback');
  assert.equal(calls.publish, 0);
  assert.equal(isFinal(root, DAY, 'evening'), false);
  assert.equal(existsSync(join(archiveDir(root), `${DAY}.evening.json.gz`)), false);
  assert.ok(existsSync(join(archiveDir(root), '_pending', `${DAY}.evening.json`)));
  const alert = JSON.parse(readFileSync(join(archiveDir(root), '_alerts', 'LATEST.json'), 'utf8'));
  assert.equal(alert.dataDate, DAY);
  assert.match(alert.reasons[0], /401/);
  assert.equal(isTerminal(r.status), true);
});

test('runOnce：Claude 未登入且 Ollama 只是忙碌讓路 → ollama-deferred（非終端、不寫 alert、不發佈），之後可補', async () => {
  const root = tmp(); putHeatmap(root, DAY, { prev: '2026-10-01' });
  const { deps, calls } = mkDeps({ produce: async ({ pack }) => ({ issue: makeTemplateShell(pack.dataDate, pack.edition), transcript: [], engineUsed: 'template', errors: [{ engine: 'claude-cli', error: '401 未登入', auth: true }, { engine: 'ollama', error: 'ollama 忙碌（daemon 佔用），讓路' }] }) });
  const r = await runOnce({ ...base(root), edition: 'evening', nowMs: EVE, deps });
  assert.equal(r.status, 'ollama-deferred');
  assert.equal(isTerminal(r.status), false);
  assert.equal(calls.publish, 0);
  assert.equal(existsSync(join(archiveDir(root), '_alerts', 'LATEST.json')), false);
  assert.ok(existsSync(join(archiveDir(root), '_pending', `${DAY}.evening.json`)));
});

test('runOnce：非交易日不跑（不組包、不寫任何檔）', async () => {
  const root = tmp();
  const { deps, calls } = mkDeps();
  const r = await runOnce({ ...base(root), edition: 'evening', nowMs: tw('2026-10-03T23:25:00'), deps });
  assert.equal(r.status, 'non-trading');
  assert.deepEqual(calls, { loadPack: 0, produce: 0, publish: 0 });
  assert.equal(existsSync(archiveDir(root)), false);
  const r2 = await runOnce({ ...base(root), edition: 'evening', nowMs: EVE, day: '2026-10-03', deps });   // --date 指到週六
  assert.equal(r2.status, 'non-trading');
});

test('runOnce：morning 以台北今天為卡片標籤基準', async () => {
  const root = tmp(); putHeatmap(root, DAY, { prev: '2026-10-01' });
  let seen;
  const { deps } = mkDeps({ produce: async o => { seen = o; return { issue: makeIssue(DAY, 'morning'), transcript: [], engineUsed: 'claude-cli', errors: [] }; } });
  const r = await runOnce({ ...base(root), edition: 'morning', nowMs: MOR, deps });
  assert.equal(r.status, 'final');
  assert.equal(seen.todayISO, '2026-10-05');
});

test('pollLoop：先 pending、熱力到齊後定版；沿用同一個 now／sleep 注入', async () => {
  const root = tmp();
  let t = EVE; const slept = [];
  const { deps, calls } = mkDeps();
  const sleep = async ms => { slept.push(ms); t += ms; if (slept.length === 2) putHeatmap(root, DAY, { prev: '2026-10-01' }); };
  const r = await pollLoop({ edition: 'evening', root, deps, now: () => t, sleep, ...{ tradingDays: TRADING_DAYS, holidays: HOLIDAYS } });
  assert.equal(r.status, 'final');
  assert.equal(slept.length, 2);
  assert.equal(slept[0], 10 * 60e3);
  assert.equal(calls.produce, 1);
});

test('pollLoop：evening 到 00:30 死線仍未定版 → 只留 pending（晨間版接手）；morning 到 07:30 → 寫 alert', async () => {
  const rootE = tmp(); let t = tw('2026-10-03T00:10:00');
  const { deps } = mkDeps();
  const rE = await pollLoop({ edition: 'evening', root: rootE, deps, now: () => t, sleep: async ms => { t += ms; }, tradingDays: TRADING_DAYS, holidays: HOLIDAYS });
  assert.equal(rE.status, 'pending');
  assert.ok(existsSync(join(archiveDir(rootE), '_pending', `${DAY}.evening.json`)));
  assert.equal(existsSync(join(archiveDir(rootE), '_alerts', 'LATEST.json')), false);
  const rootM = tmp(); let t2 = tw('2026-10-05T07:15:00');
  const rM = await pollLoop({ edition: 'morning', root: rootM, deps, now: () => t2, sleep: async ms => { t2 += ms; }, tradingDays: TRADING_DAYS, holidays: HOLIDAYS });
  assert.equal(rM.status, 'pending');
  assert.equal(JSON.parse(readFileSync(join(archiveDir(rootM), '_alerts', 'LATEST.json'), 'utf8')).dataDate, DAY);
});

test('readTradingDays／readHolidays：讀本機鏡像（檔案不存在回空／null）', () => {
  const root = tmp();
  assert.deepEqual(readTradingDays(root), []); assert.equal(readHolidays(root), null);
  const d1 = join(root, 'official', 'www.twse.com.tw', 'twse_mi_index'); mkdirSync(d1, { recursive: true });
  writeFileSync(join(d1, '_manifest.json'), JSON.stringify({ rows: { '2026-10-02': { status: 'ok' }, '2026-10-01': { status: 'ok' }, '2026-10-03': { status: 'bad' } } }));
  assert.deepEqual(readTradingDays(root), ['2026-10-01', '2026-10-02']);
  const d2 = join(root, 'official', 'openapi.twse.com.tw', 'twse_oa_holidaySchedule_holidaySchedule'); mkdirSync(d2, { recursive: true });
  writeFileSync(join(d2, '_manifest.json'), JSON.stringify({ lastFile: 'h.json.gz' }));
  writeFileSync(join(d2, 'h.json.gz'), gzipSync(JSON.stringify({ payload: [{ Name: '國慶日', Date: '1151010' }, { Name: '國曆新年開始交易日', Date: '1150102' }] })));
  const h = readHolidays(root);
  assert.ok(h.has('2026-10-10')); assert.equal(h.has('2026-01-02'), false);
});
