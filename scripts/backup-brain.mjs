#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 第二大腦備份：Firestore → second-brain/backup/（本地災難備援）
//
// 動機（實案 2026-07-17）：TPEx 歷史 API 靜默污染事件——若當時有本地備份，
// 不需重抓 70 分鐘、也不怕來源改版斷檔。雲端資料的最後一道保險。
//
// ⚠ 涵蓋範圍表（DATED／CONTENT_DIFF／SKIP）在 scripts/lib/backup-brain-plan.mjs——
//   **沒列進去的集合只會進 singletons.json（每集合最多 200 份）**。新增逐日集合時去那裡登記。
//
// 策略（可重跑、冪等；2026-10-08 WP0 改為增量）：
//   users：每次全量深度匯出（含子集合）——帳號/持倉不可再生，最高優先。
//   DATED（逐日集合）：每份文件一個檔。平日只讀「id ≥ 截止日（預設近 7 天）」與非日期 id（latest、summary…）；
//     每個集合每 7 天全量比對一次（槽位分散在一週 7 天）。沒有狀態記錄、本機份數少於雲端、--full 時全量。
//     狀態記在 backup/_backup-state.json（每集合最近一次全量比對的台北日）。
//   singletons：其餘集合整包寫入 singletons.json（覆蓋）。先 count()，200 份內全抓，超過取 id 最大的 200 份並告警。
//     mopsNews 另外由本機 DATED 檔整包放進來（wiki 讀 S.mopsNews）。
//   CONTENT_DIFF（finReports/stockHistory…，以個股宇宙為上限）：每輪全讀，內容變更才寫。
//   manifest.json：每集合的模式、理由、雲端／本機份數、讀取份數、耗時；整輪用時接近 10 分鐘逾時就告警。
//
// 用法：node scripts/backup-brain.mjs [--full] [--dry-run [--list-ids]] [--only a,b,singletons,users] [--report 檔案]
//   --full       所有 DATED 集合全量比對
//   --dry-run    唯讀試跑：不寫任何檔、不讀文件內容，只用 count() 估算這一輪與平日／全量日的讀取量
//   --list-ids   搭配 --dry-run：列出增量區間會讀到的文件 id（只取 id，讀取量＝增量份數）
//   --only       只跑列出的集合（singletons、users 是兩個階段名）；manifest 會記 only
//   --report     另存一份 manifest（試跑時寫到別處用）
//   環境變數 BACKUP_BRAIN_ROOT：改寫到別的目錄（驗證寫入路徑用；daemon 不設）
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATED, CONTENT_DIFF, SKIP_COLLECTIONS, SINGLETON_FROM_LOCAL, SINGLETON_MAX_DOCS, RUN_BUDGET_MS, PLAN_VERSION, FULL_SWEEP_DAYS,
  taipeiDay, cutFor, incrementalRanges, idInRanges, decideMode, singletonWarnings, budgetLevel, safeFileName, validateTables,
} from './lib/backup-brain-plan.mjs';

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
const FULL = argv.includes('--full');
const DRY = argv.includes('--dry-run');
const LIST_IDS = DRY && argv.includes('--list-ids');
const ONLY = argVal('--only') ? new Set(argVal('--only').split(',').map(s => s.trim()).filter(Boolean)) : null;
const REPORT = argVal('--report');
const wants = (id) => !ONLY || ONLY.has(id);

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();
const DOC_ID = admin.firestore.FieldPath.documentId();

const ROOT = process.env.BACKUP_BRAIN_ROOT
  ? path.resolve(process.env.BACKUP_BRAIN_ROOT)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'second-brain', 'backup');
const STATE_FILE = path.join(ROOT, '_backup-state.json');
const T0 = Date.now();
const TODAY = taipeiDay(T0);

const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });
const stat = { written: 0, skipped: 0, unchanged: 0 };
const reads = { docs: 0, countQueries: 0 };   // countQueries：count() 聚合查詢，每 1,000 筆索引計 1 次讀取
const report = {};                             // 每集合一列
const warnings = [], errors = [];
let budgetWarned = false;

/** 先寫暫存檔再改名：中途被砍（逾時 SIGTERM）也不會留下半個 singletons.json（daemon 上櫃後備與 wiki 都讀它） */
function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeIfChanged(file, obj, rec) {
  const next = JSON.stringify(obj);
  rec.bytes = (rec.bytes || 0) + next.length;
  try { if (fs.readFileSync(file, 'utf8') === next) { stat.unchanged++; rec.unchanged = (rec.unchanged || 0) + 1; return; } } catch { /* 不存在 */ }
  fs.writeFileSync(file, next);
  stat.written++; rec.written = (rec.written || 0) + 1;
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && typeof s.collections === 'object' && s.collections) return s;
  } catch { /* 沒有狀態＝第一次，各集合全量 */ }
  return { planVersion: PLAN_VERSION, collections: {} };
}
const state = loadState();
function saveState() {
  if (DRY) return;
  state.planVersion = PLAN_VERSION;
  state.updatedAt = Date.now();
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 1));
}

const listLocalIds = (dir) => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); } catch { return []; } };
const countLocal = (dir) => listLocalIds(dir).length;

async function countOf(q, label) {
  reads.countQueries++;
  try { return (await q.count().get()).data().count; }
  catch (e) { warnings.push(`${label}：count() 失敗（${String(e.message || e).slice(0, 60)}）——本輪不做份數比對`); return null; }
}

function rangeQuery(col, { start, end }) {
  let q = col;
  if (start != null) q = q.where(DOC_ID, '>=', start);
  if (end != null) q = q.where(DOC_ID, '<', end);
  return q;
}

function checkBudget() {
  const ms = Date.now() - T0;
  if (!budgetWarned && budgetLevel(ms) !== 'ok') {
    budgetWarned = true;
    warnings.push(`接近逾時：已用 ${(ms / 1000).toFixed(0)}s／${RUN_BUDGET_MS / 1000}s（${Math.round(ms / RUN_BUDGET_MS * 100)}%）——之後到期的全量比對延到下一輪`);
  }
}

// ── users：深度匯出（含子集合，一層）─────────────────────────────────────
async function backupUsers() {
  const rec = report.users = { kind: 'users', mode: 'full' };
  rec.cloud = await countOf(db.collection('users'), 'users');
  if (DRY) { rec.wouldRead = rec.cloud; rec.note = '子集合份數未估'; return; }
  const dir = path.join(ROOT, 'users'); ensure(dir);
  const snap = await db.collection('users').get();
  let n = snap.size;
  for (const d of snap.docs) {
    const out = { _doc: d.data(), _sub: {} };
    for (const sub of await d.ref.listCollections()) {
      const ss = await sub.get();
      n += ss.size;
      out._sub[sub.id] = Object.fromEntries(ss.docs.map((x) => [x.id, x.data()]));
    }
    writeIfChanged(path.join(dir, `${d.id}.json`), out, rec);
  }
  rec.read = n; reads.docs += n;
  console.log(`[backup] users: ${snap.size} 帳號（含子集合，共讀 ${n} 份）`);
}

// ── DATED：增量（近 N 天＋非日期 id）＋每週全量比對 ─────────────────────────
// ⚠ 全量模式下**不要**加回「本機檔已存在就跳過」（2026-08-10 實案：雲端 chipArchive/2026-03-02 已回補成
//   close 1,944／lending 1,841，本機卻停在 close 1,079／lending 0，差了五個月的修復；份數一致所以份數比對永遠綠燈）。
//   增量模式省的是「讀取」（只讀近 N 天），雲端事後回補更舊的日子由每週全量比對接住——這是刻意的取捨，
//   全量那天 writeIfChanged 內容相同就不寫。
async function backupDated(spec) {
  const colId = spec.id;
  const col = db.collection(colId);
  const dir = path.join(ROOT, colId);
  const rec = report[colId] = { kind: 'dated' };
  const cut = cutFor(spec, TODAY);
  const incr = incrementalRanges(spec.families, cut);
  // 份數比對只看「增量區間以外的舊文件」：當天新長出的那份不算缺（見 decideMode 註解）
  const cloud = await countOf(col, colId);
  let recent = 0;
  for (const r of incr) { const n = await countOf(rangeQuery(col, r), colId); recent = n == null || recent == null ? null : recent + n; }
  const localIds = listLocalIds(dir);
  const localOld = localIds.filter(id => !idInRanges(incr, id)).length;
  const cloudOld = cloud == null || recent == null ? null : cloud - recent;
  const last = state.collections[colId] || null;
  const d = decideMode({ spec, today: TODAY, last, forceFull: FULL, localOld, cloudOld, elapsedMs: Date.now() - T0 });
  Object.assign(rec, { mode: d.mode, reason: d.reason, cloud, local: localIds.length, recent, cloudOld, localOld,
    cut: d.mode === 'incremental' ? cut : null, lastSweep: last?.sweepDay || null });
  if (d.reason === 'deferred-budget') warnings.push(`${colId}：全量比對到期但時間預算不足，延到下一輪`);

  if (DRY) {
    rec.incrementalWouldRead = recent;
    rec.wouldRead = d.mode === 'full' ? cloud : recent;
    if (LIST_IDS) {
      const ids = [];
      for (const r of incr) { const s = await rangeQuery(col, r).select().get(); reads.docs += s.size; ids.push(...s.docs.map(x => x.id)); }
      rec.incrementalIds = ids;
    }
    return;
  }

  ensure(dir);
  const ranges = d.mode === 'full' ? [{ start: null, end: null }] : incr;
  let n = 0;
  for (const r of ranges) {
    const snap = await rangeQuery(col, r).get();
    n += snap.size;
    for (const doc of snap.docs) writeIfChanged(path.join(dir, `${safeFileName(doc.id)}.json`), doc.data(), rec);
  }
  rec.read = n; reads.docs += n;
  if (d.mode === 'full') { state.collections[colId] = { sweepDay: TODAY, sweepAt: Date.now(), cloud }; saveState(); }
  console.log(`[backup] ${colId}: ${d.mode === 'full' ? `全量（${d.reason}）` : `增量 ≥${cut}`} 讀 ${n} 份（雲端 ${cloud ?? '?'}、本機 ${countLocal(dir)}）`);
}

// ── CONTENT_DIFF：每 doc 一檔，每輪全讀、變更才寫 ───────────────────────────
async function backupContentDiff(colId) {
  const col = db.collection(colId);
  const dir = path.join(ROOT, colId);
  const rec = report[colId] = { kind: 'contentDiff', mode: 'full' };
  rec.cloud = await countOf(col, colId);
  rec.local = countLocal(dir);
  if (DRY) { rec.wouldRead = rec.cloud; return; }
  ensure(dir);
  const snap = await col.get();
  for (const d of snap.docs) writeIfChanged(path.join(dir, `${safeFileName(d.id)}.json`), d.data(), rec);
  rec.read = snap.size; reads.docs += snap.size;
  console.log(`[backup] ${colId}: ${snap.size} docs`);
}

// ── singletons：其餘集合整包一檔 ─────────────────────────────────────────
function readLocalDated(colId) {
  const dir = path.join(ROOT, colId);
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return {}; }
  const out = {};
  for (const f of names) {
    try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { warnings.push(`${colId}/${f}：本機檔讀不回來（${String(e.message).slice(0, 40)}）`); }
  }
  return out;
}

let _prevSingletons;
function prevSingletons() {
  if (_prevSingletons === undefined) {
    try { _prevSingletons = JSON.parse(fs.readFileSync(path.join(ROOT, 'singletons.json'), 'utf8')); } catch { _prevSingletons = null; }
  }
  return _prevSingletons;
}

async function backupSingletons() {
  const rec = report.singletons = { kind: 'singletons', collections: 0, docs: 0, truncated: [], fromLocal: {} };
  const classified = new Set([...SKIP_COLLECTIONS, ...DATED.map(s => s.id), ...CONTENT_DIFF]);
  const out = {};
  for (const c of await db.listCollections()) {
    if (classified.has(c.id)) continue;
    const n = await countOf(c, c.id);
    const truncated = n != null && n > SINGLETON_MAX_DOCS;
    if (truncated) rec.truncated.push(c.id);
    rec.collections++;
    if (DRY) {
      rec.docs += Math.min(n ?? 0, SINGLETON_MAX_DOCS);
      let ids = [];
      if (LIST_IDS) { const s = await c.select().get(); reads.docs += s.size; ids = s.docs.map(x => x.id); }
      for (const w of singletonWarnings(c.id, { count: n ?? 0, ids })) warnings.push(w);
      if (truncated) rec.docs += n;   // 截斷路徑要先讀全部 id
      continue;
    }
    // 舊版 limit(25) 依 id 升冪＝只留最舊的，最新文件與 latest 反而沒備到。
    // 200 份內全抓；超過才截斷成 id 最大（最新）的 200 份並告警。
    // ⚠ 不能用 orderBy(documentId, 'desc')：Firestore 要另建索引（2026-10-08 實測 FAILED_PRECONDITION），
    //   所以截斷路徑先只取 id（select()，讀取照算、頻寬極小）再 getAll 最新的 200 份。
    let docs;
    if (!truncated) docs = (await c.get()).docs;
    else {
      const idSnap = await c.select().get();
      reads.docs += idSnap.size;
      const refs = idSnap.docs.map(d => d.ref).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(-SINGLETON_MAX_DOCS);
      docs = (await db.getAll(...refs)).filter(d => d.exists);
    }
    rec.docs += docs.length; reads.docs += docs.length;
    out[c.id] = Object.fromEntries(docs.map((d) => [d.id, d.data()]));
    for (const w of singletonWarnings(c.id, { count: n ?? docs.length, ids: docs.map(d => d.id) })) warnings.push(w);
  }
  // 雙寫：mopsNews 已逐份進 DATED，這裡照舊整包放一份（取本機檔，不多讀雲端）；本機讀不到就沿用上一份，不讓 wiki 的重大訊息變空
  for (const colId of SINGLETON_FROM_LOCAL) {
    const local = DRY ? {} : readLocalDated(colId);
    // 試跑不寫檔：本機還沒有這個資料夾時，以 DATED 階段「這一輪會全量讀回」的份數估計
    const n = DRY ? (countLocal(path.join(ROOT, colId)) || (report[colId]?.mode === 'full' ? report[colId].cloud ?? 0 : 0))
      : Object.keys(local).length;
    if (!DRY) out[colId] = n ? local : (prevSingletons()?.[colId] || {});
    rec.fromLocal[colId] = n;
    if (!n) warnings.push(`${colId}：本機 DATED 檔是空的，singletons.json ${DRY ? '將' : '已'}沿用上一份`);
  }
  if (DRY) { rec.wouldRead = rec.docs; return; }
  ensure(ROOT);
  atomicWrite(path.join(ROOT, 'singletons.json'), JSON.stringify(out));
  console.log(`[backup] singletons.json: ${Object.keys(out).length} 集合、${rec.docs} 份${rec.truncated.length ? `（截斷：${rec.truncated.join('、')}）` : ''}`);
}

// ── 主流程 ──────────────────────────────────────────────────────────────
async function phase(name, fn) {
  const t0 = Date.now();
  try { await fn(); }
  catch (e) {
    const msg = String(e?.message || e).slice(0, 160);
    errors.push(`${name}: ${msg}`);
    report[name] = { ...(report[name] || {}), error: msg };
    console.error(`[backup] ✖ ${name}:`, msg);
  }
  report[name] = { ...(report[name] || {}), ms: Date.now() - t0 };
  checkBudget();
}

function buildManifest(extra = {}) {
  const ms = Date.now() - T0;
  return {
    at: new Date().toISOString(), startedAt: T0, finishedAt: Date.now(), ms, today: TODAY, planVersion: PLAN_VERSION,
    full: FULL, dryRun: DRY, only: ONLY ? [...ONLY] : null, aborted: null,
    stat, reads, budget: { ms: RUN_BUDGET_MS, used: +(ms / RUN_BUDGET_MS).toFixed(3), level: budgetLevel(ms) },
    sweepDays: FULL_SWEEP_DAYS,
    collections: report, warnings, errors, ...extra,
  };
}

function writeManifest(m) {
  if (REPORT) { try { atomicWrite(path.resolve(REPORT), JSON.stringify(m, null, 1)); } catch (e) { console.error('[backup] report 寫入失敗:', e.message); } }
  if (DRY || (ONLY && !process.env.BACKUP_BRAIN_ROOT)) return;   // 試跑、或在正式目錄只跑部分集合：不覆蓋正式 manifest
  try { ensure(ROOT); atomicWrite(path.join(ROOT, 'manifest.json'), JSON.stringify(m, null, 1)); } catch (e) { console.error('[backup] manifest 寫入失敗:', e.message); }
}

// daemon execFile 逾時會送 SIGTERM：留下「做到哪」的 manifest（狀態檔每個集合全量完就寫，不會白做）
process.on('SIGTERM', () => {
  writeManifest(buildManifest({ aborted: 'SIGTERM' }));
  console.error(`[backup] ✖ 被終止（SIGTERM，已用 ${((Date.now() - T0) / 1000).toFixed(0)}s）`);
  process.exit(143);
});

function summaryLine(m) {
  const modes = Object.values(report).filter(r => r.kind === 'dated');
  const fullN = modes.filter(r => r.mode === 'full').length;
  const pct = Math.round(m.budget.used * 100);
  if (DRY) {
    const sum = (k) => Object.values(report).reduce((a, r) => a + (r[k] || 0), 0);
    return `[backup] 試跑（未寫檔）：本輪預估讀 ${sum('wouldRead')} 份（DATED 全量 ${fullN}／增量 ${modes.length - fullN} 集合）、`
      + `平日增量約 ${sum('incrementalWouldRead') + Object.values(report).filter(r => r.kind !== 'dated').reduce((a, r) => a + (r.wouldRead || 0), 0)} 份、`
      + `計數查詢 ${reads.countQueries} 次、警告 ${warnings.length}（${(m.ms / 1000).toFixed(0)}s）`;
  }
  const warn = warnings.length ? `、⚠ 警告 ${warnings.length}：${warnings[0].slice(0, 80)}` : '';
  const err = errors.length ? `、✖ 錯誤 ${errors.length}：${errors[0].slice(0, 80)}` : '';
  return `[backup] ${errors.length ? '部分失敗' : '完成'}：寫入 ${stat.written}、未變 ${stat.unchanged}、讀 ${reads.docs} 份＋計數 ${reads.countQueries} 次`
    + `（DATED 全量 ${fullN}／增量 ${modes.length - fullN}）、用時 ${(m.ms / 1000).toFixed(0)}s＝預算 ${pct}%${warn}${err}`;
}

async function main() {
  const problems = validateTables();
  if (problems.length) throw new Error(`涵蓋表設定錯誤：${problems.join('；')}`);
  if (!DRY) ensure(ROOT);
  if (wants('users')) await phase('users', backupUsers);              // 最高優先：不可再生
  for (const spec of DATED) if (wants(spec.id)) await phase(spec.id, () => backupDated(spec));
  if (wants('singletons')) await phase('singletons', backupSingletons);   // 在大型 CONTENT_DIFF 之前：萬一逾時，最新的 latest 已落地
  for (const c of CONTENT_DIFF) if (wants(c)) await phase(c, () => backupContentDiff(c));
  const m = buildManifest();
  writeManifest(m);
  for (const w of warnings) console.warn(`[backup] ⚠ ${w}`);
  if (DRY && !REPORT) console.log(JSON.stringify(m.collections, null, 1));
  console.log(summaryLine(m));   // daemon 只記 stdout 最後一行：警告／錯誤摘要要放在這一行
  process.exit(errors.length ? 1 : 0);
}
main().catch((e) => { console.error('[backup] 失敗:', e); process.exit(1); });
