import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { writeIssue, writePending, writeAlert, readManifest, readLatest, readIssue, archiveDir, deadlineMs, isFinal, renderIssueMarkdown, shouldUpdateLatest } from './archive.mjs';
import { makeIssue, makePack, makeTemplateShell, DAY } from './w5-fixtures.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'analyst-archive-'));
const T0 = Date.parse('2026-10-02T23:40:00+08:00');   // 資料日晚上
const gunzipJson = f => JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));
const write = (root, over = {}, o = {}) => writeIssue({ root, issue: makeIssue(DAY, 'evening'), pack: makePack(DAY, 'evening'), transcript: [{ label: 'r1', n: 1 }], edition: 'evening', dataDate: DAY, now: T0, ...o, ...over });

test('writeIssue：寫齊 issue／pack／transcript／md、manifest 列與 latest.json', () => {
  const root = tmp();
  const r = write(root);
  assert.equal(r.status, 'written');
  const dir = archiveDir(root);
  for (const f of [`${DAY}.evening.json.gz`, `${DAY}.evening.pack.json.gz`, `${DAY}.evening.transcript.jsonl.gz`, `reports/${DAY}.evening.md`, '_manifest.json', 'latest.json']) assert.ok(existsSync(join(dir, f)), f);
  const row = readManifest(root).rows[`${DAY}.evening`];
  assert.equal(row.status, 'final');
  assert.equal(row.engineTier, 'claude');
  assert.equal(row.packSha256, 'packsha');
  assert.deepEqual(row.check, { pass: true, blockers: 0, cut: 1, warnings: 0, repairRounds: 1 });
  assert.deepEqual(row.degraded, []);
  assert.equal(row.canonicalAt, new Date(T0).toISOString());
  assert.deepEqual(readLatest(root), { dataDate: DAY, edition: 'evening', canonicalAt: row.canonicalAt });
  assert.equal(isFinal(root, DAY, 'evening'), true);
  assert.equal(readIssue(root, `${DAY}.evening`).dataDate, DAY);
});

test('檔本體不含時間戳、不同 now／不同目錄寫出的 gz 位元組完全相同（可重現）', () => {
  const issue = makeIssue(DAY, 'evening');
  issue.meta.generatedAt = '2026-10-02T15:00:00.000Z'; issue.meta.canonicalAt = 'x';
  const a = tmp(), b = tmp();
  write(a, { issue }, { now: T0 }); write(b, { issue }, { now: T0 + 86400e3 });
  const fa = readFileSync(join(archiveDir(a), `${DAY}.evening.json.gz`)), fb = readFileSync(join(archiveDir(b), `${DAY}.evening.json.gz`));
  assert.ok(fa.equals(fb));
  const body = gunzipJson(join(archiveDir(a), `${DAY}.evening.json.gz`));
  assert.equal(body.meta.generatedAt, undefined); assert.equal(body.meta.canonicalAt, undefined);
  assert.ok(readFileSync(join(archiveDir(a), `${DAY}.evening.pack.json.gz`)).equals(readFileSync(join(archiveDir(b), `${DAY}.evening.pack.json.gz`))));
  assert.equal(readManifest(a).rows[`${DAY}.evening`].sha256, readManifest(b).rows[`${DAY}.evening`].sha256);   // 時間戳只在 manifest
});

test('寫一次：已存在不覆寫（skip-exists）', () => {
  const root = tmp();
  write(root);
  const f = join(archiveDir(root), `${DAY}.evening.json.gz`);
  const before = readFileSync(f);
  const issue2 = makeIssue(DAY, 'evening'); issue2.summary.headline = '另一版';
  const r = write(root, { issue: issue2 });
  assert.equal(r.status, 'skip-exists');
  assert.ok(readFileSync(f).equals(before));
});

test('--force 開盤前：舊檔改名 .r1；開盤後：只寫 .amend-1、不動原檔與 latest', () => {
  const root = tmp();
  write(root);
  const dir = archiveDir(root);
  const issue2 = makeIssue(DAY, 'evening'); issue2.summary.headline = '修補版';
  const r = write(root, { issue: issue2, force: true }, { now: T0 + 3600e3 });
  assert.equal(r.status, 'written-forced');
  assert.ok(existsSync(join(dir, `${DAY}.evening.r1.json.gz`)));
  assert.equal(gunzipJson(join(dir, `${DAY}.evening.json.gz`)).summary.headline, '修補版');
  assert.equal(readManifest(root).rows[`${DAY}.evening`].revisions.length, 1);
  // 開盤後（下一交易日 10/05 08:30 之後）
  const late = Date.parse('2026-10-05T09:30:00+08:00');
  const issue3 = makeIssue(DAY, 'evening'); issue3.summary.headline = '開盤後修補';
  const before = readFileSync(join(dir, `${DAY}.evening.json.gz`));
  const r3 = write(root, { issue: issue3, force: true }, { now: late });
  assert.equal(r3.status, 'written-amend');
  assert.ok(existsSync(join(dir, `${DAY}.evening.amend-1.json.gz`)));
  assert.ok(readFileSync(join(dir, `${DAY}.evening.json.gz`)).equals(before));
  assert.equal(readManifest(root).rows[`${DAY}.evening`].amends.length, 1);
});

test('latest.json：morning 優先於 evening；舊資料日不蓋新的', () => {
  const root = tmp();
  write(root);
  write(root, { issue: makeIssue(DAY, 'morning'), pack: makePack(DAY, 'morning'), edition: 'morning' }, { now: T0 + 6 * 3600e3 });
  assert.equal(readLatest(root).edition, 'morning');
  // 之後才補寫同日 evening（例如 --force 重跑）不得把 latest 拉回 evening
  const root2 = tmp();
  write(root2, { issue: makeIssue(DAY, 'morning'), pack: makePack(DAY, 'morning'), edition: 'morning' });
  write(root2, {}, { now: T0 + 1000 });
  assert.equal(readLatest(root2).edition, 'morning');
  assert.ok(isFinal(root2, DAY, 'evening'));                       // evening 版仍保留
  // 舊資料日不蓋新的
  const root3 = tmp();
  write(root3, { issue: makeIssue('2026-10-05', 'evening'), pack: makePack('2026-10-05', 'evening'), dataDate: '2026-10-05' });
  write(root3, {});
  assert.equal(readLatest(root3).dataDate, '2026-10-05');
  assert.equal(shouldUpdateLatest({ dataDate: DAY, edition: 'morning' }, DAY, 'morning'), true);
  assert.equal(shouldUpdateLatest({ dataDate: DAY, edition: 'evening' }, DAY, 'evening'), true);
});

test('非交易日不產檔', () => {
  const root = tmp();
  const r = write(root, { issue: makeIssue('2026-10-03', 'evening'), pack: makePack('2026-10-03', 'evening'), dataDate: '2026-10-03' });   // 週六，不在 calendar.tradingDays
  assert.equal(r.status, 'skip-non-trading');
  assert.equal(existsSync(archiveDir(root)) ? readdirSync(archiveDir(root)).filter(f => f.endsWith('.gz')).length : 0, 0);
  // 沒有交易日清單時只擋週末
  const r2 = write(root, { issue: makeIssue('2026-10-03', 'evening'), pack: { ...makePack('2026-10-03', 'evening'), calendar: null }, dataDate: '2026-10-03' });
  assert.equal(r2.status, 'skip-non-trading');
});

test('拒絕：模板殼、查核未過、資料日／版次不符', () => {
  const root = tmp();
  assert.equal(write(root, { issue: makeTemplateShell() }).status, 'refused');
  const bad = makeIssue(); bad.meta.check.pass = false;
  assert.equal(write(root, { issue: bad }).status, 'refused');
  assert.equal(write(root, { issue: makeIssue('2026-10-01', 'evening') }).status, 'refused');
  assert.equal(write(root, { issue: makeIssue(DAY, 'morning') }).status, 'refused');
  assert.equal(isFinal(root, DAY, 'evening'), false);
  assert.throws(() => write(root, { edition: 'noon' }), /版次/);
});

test('.lock：被占用回 locked；超過 30 分鐘的遺留鎖視為過期', () => {
  const root = tmp();
  write(root, {}, { now: T0 });                       // 建好目錄
  const lock = join(archiveDir(root), '.lock');
  writeFileSync(lock, '');
  const issue2 = makeIssue('2026-10-05', 'evening');
  const args = { issue: issue2, pack: makePack('2026-10-05', 'evening'), dataDate: '2026-10-05' };
  assert.equal(write(root, args, { now: Date.now() }).status, 'locked');
  const old = new Date(Date.now() - 3600e3);
  utimesSync(lock, old, old);
  assert.equal(write(root, args, { now: Date.now() }).status, 'written');
  assert.equal(existsSync(lock), false);
});

test('writePending／writeAlert：alert 過下一交易日 08:30 才寫；定版後清掉 pending 與 alert', () => {
  const root = tmp();
  const f = writePending(root, DAY, 'evening', ['P1 熱力尚未定版'], T0);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).reasons, ['P1 熱力尚未定版']);
  assert.equal(deadlineMs(DAY, '2026-10-05'), Date.parse('2026-10-05T08:30:00+08:00'));
  assert.equal(deadlineMs('2026-10-02', null), Date.parse('2026-10-05T08:30:00+08:00'));   // 無日曆：下一個平日
  const alertF = join(archiveDir(root), '_alerts', 'LATEST.json');
  assert.equal(writeAlert(root, { day: DAY, edition: 'morning', reasons: ['x'], now: Date.parse('2026-10-05T07:30:00+08:00'), nextTradingDay: '2026-10-05' }), false);
  assert.equal(existsSync(alertF), false);
  assert.equal(writeAlert(root, { day: DAY, edition: 'morning', reasons: ['x'], now: Date.parse('2026-10-05T08:31:00+08:00'), nextTradingDay: '2026-10-05' }), true);
  assert.equal(JSON.parse(readFileSync(alertF, 'utf8')).dataDate, DAY);
  assert.equal(writeAlert(root, { day: DAY, edition: 'evening', reasons: ['y'], now: T0, immediate: true }), true);
  write(root, {}, { now: T0 });
  assert.equal(existsSync(join(archiveDir(root), '_pending', `${DAY}.evening.json`)), false);
  assert.equal(existsSync(alertF), false);
});

test('renderIssueMarkdown：含卡片標題、claim 文字、名單與免責', () => {
  const md = renderIssueMarkdown(makeIssue());
  assert.match(md, /資料日 2026-10-02/);
  assert.match(md, /上市等權平均 \+0\.57%/);
  assert.match(md, /台積電/);
  assert.match(md, /不是投資建議/);
  assert.match(md, /AI 整理，非投資建議/);
});
