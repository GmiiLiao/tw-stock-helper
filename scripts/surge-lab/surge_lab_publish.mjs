#!/usr/bin/env node
// 起漲研究後台發佈：官方化重訓驗證（CV）／逐列命中漏網／鏡像健康／影子管線狀態 → Firestore surgeShadow/lab-*（2026-10-04 使用者「我需要在後台看到資料」）。
// 只寫 surgeShadow 這個集合的 lab-* 文件（客戶端規則預設拒絕，僅 /api/admin/surge-shadow 以超級管理員讀）；不碰站上任何資料。
//
// 讀（全是本機檔，零網路）：
//   <dir>/out/pre_fix_20261004/official_cv_*        修正前快照（含 official_cv_robust.json 與分析文件）
//   <dir>/out/official_cv_*                         目前輸出（重訓後覆蓋；與快照逐位相同時視為「尚未產出修正後」）
//   <repo>/second-brain/official/{manifest.json,_verify.json,_alerts/LATEST.json,_lock.json,_budget/,_runs/}
//   <dir>/out/a35_shadow_daily_status.json          每日影子協調器的狀態（沒有就發佈 null＋說明）
//   <SURGE_CACHE 或 dir/.surge-cache>/panel_dates.json＋鏡像 MI_INDEX manifest ⇒ 最後交易日（dataDate；不用日曆日）
// 寫：surgeShadow/lab-cvrows-*（gzip Bytes 的 {cols,rows}）→ lab-cv（摘要＋逐列清單與 sha256，最後寫）→ lab-mirror → lab-pipeline；
//     同時發佈 cv 與 cvrows 時，清掉清單外的舊 lab-cvrows-*。任何一份 ≥ 900,000 位元組 ⇒ 整批不寫。
//
// 用法：node scripts/surge-lab/surge_lab_publish.mjs [--only cv,cvrows,mirror,pipeline] [--dry-run] [--dir <surge-lab 目錄>] [--mirror <鏡像目錄>]
// 憑證：GOOGLE_APPLICATION_CREDENTIALS；沒有就從 daemon 的 launchd plist 讀路徑（不印出內容）。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import {
  CV_TASKS, CV_VERSIONS, CV_MODELS, CVROWS_SCHEMA, LAB_DOC_IDS, MAX_DOC_BYTES,
  lastTradingDay, planCvTask, buildCvDoc, buildMirrorDoc, buildPipelineDoc, assertDocSizes,
} from '../lib/surge-lab-report.mjs';

const COLLECTION = 'surgeShadow';
const PARTS = ['cv', 'cvrows', 'mirror', 'pipeline'];
const BATCH_BYTES = 4_000_000;   // 一個 batch 的估計總位元組（Firestore 單次請求 10 MiB，留餘裕）
const PLIST = join(homedir(), 'Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist');
const RUNS_MAX = 10;

function parseArgs(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const a = { dir: here, mirror: null, dryRun: false, only: new Set(PARTS) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--dir') a.dir = argv[++i];
    else if (argv[i] === '--mirror') a.mirror = argv[++i];
    else if (argv[i] === '--only') {
      const want = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
      const bad = want.filter(w => !PARTS.includes(w));
      if (!want.length || bad.length) throw new Error(`--only 只接受 ${PARTS.join(',')}（收到：${bad.join(',') || '空'}）`);
      a.only = new Set(want);
    } else throw new Error(`未知參數：${argv[i]}`);
  }
  if (!a.dir || !existsSync(join(a.dir, 'out'))) throw new Error(`找不到研究輸出目錄：${a.dir}/out`);
  a.dir = resolve(a.dir);
  a.mirror = resolve(a.mirror || join(a.dir, '..', '..', 'second-brain', 'official'));
  a.cache = resolve(process.env.SURGE_CACHE || join(a.dir, '.surge-cache'));
  return a;
}

const readText = p => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const readJson = p => { const t = readText(p); return t === null ? null : JSON.parse(t); };
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const mtimeIso = p => (existsSync(p) ? statSync(p).mtime.toISOString() : null);

/** 最後交易日：研究面板日期＋鏡像 MI_INDEX 已確認日（兩者都沒有 ⇒ 中止，不拿日曆日充數）。 */
function resolveDataDate(a) {
  const panelDates = readJson(join(a.cache, 'panel_dates.json')) || [];
  const mi = readJson(join(a.mirror, 'www.twse.com.tw', 'twse_mi_index', '_manifest.json'));
  const r = lastTradingDay({ panelDates, miIndexRows: mi?.rows || {} });
  if (!r.date) throw new Error(`無法由資料判定最後交易日（${a.cache}/panel_dates.json 與鏡像 MI_INDEX 都沒有可用日期）`);
  return r;
}

function versionInput(dir, def, task) {
  const vd = join(dir, def.dir);
  const cvPath = join(vd, `official_cv_${task}.json`);
  const cvText = readText(cvPath);
  const md = existsSync(vd) ? readdirSync(vd).filter(f => /^official_cv_hitmiss_analysis_.*\.md$/.test(f)).sort().at(-1) : undefined;
  const mdText = md ? readText(join(vd, md)) : null;
  const csv = Object.fromEntries(CV_MODELS.map(m => [m, Object.fromEntries(['hits', 'misses', 'outside'].map(k => [k, readText(join(vd, `official_cv_${task}_${m}_${k}.csv`))]))]));
  return {
    def, cvText, sha: cvText ? sha256(cvText) : null, mtime: mtimeIso(cvPath),
    robustText: readText(join(vd, 'official_cv_robust.json')),
    analysis: md ? { file: `${def.dir}/${md}`, text: mdText, sha: sha256(mdText) } : null,
    csv,
  };
}

/** CV 摘要＋逐列文件（逐列以 gzip(JSON) 存 Bytes；sha256 寫進摘要，API 讀時核對）。 */
function collectCv(a, dataDate, generatedAt) {
  const entries = []; const rowWrites = []; const warnings = [];
  for (const t of CV_TASKS) {
    const { entry, payloads } = planCvTask(t.id, CV_VERSIONS.map(def => versionInput(a.dir, def, t.id)));
    entries.push(entry);
    for (const v of entry.versions) for (const w of v.warnings || []) warnings.push(`${t.id}/${v.id}：${w}`);
    for (const v of entry.versions) if (v.robustNote) warnings.push(`${t.id}/${v.id}：${v.robustNote}`);
    for (const p of payloads) {
      const gz = gzipSync(Buffer.from(JSON.stringify({ cols: p.cols, rows: p.rows }), 'utf8'), { level: 9 });
      rowWrites.push({
        id: p.id, gz, sha: sha256(gz),
        meta: { id: p.id, task: p.task, version: p.version, model: p.model, kind: p.kind, totalRows: p.totalRows, keptRows: p.keptRows, filterNote: p.filterNote, gzBytes: gz.length, sha256: sha256(gz) },
      });
    }
  }
  const doc = buildCvDoc({ dataDate, generatedAt, tasks: entries, rowsDocs: rowWrites.map(w => w.meta) });
  return { doc, rowWrites, warnings };
}

function readLock(mirror) {
  const lock = readJson(join(mirror, '_lock.json'));
  if (!lock) return null;
  let alive = null;
  if (Number.isInteger(lock.pid)) { try { process.kill(lock.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
  return { ...lock, alive };
}

function collectMirror(a, dataDate, generatedAt) {
  const m = a.mirror;
  const budgetDir = join(m, '_budget');
  const budgetFile = existsSync(budgetDir) ? readdirSync(budgetDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1) : undefined;
  const runsDir = join(m, '_runs');
  const runs = existsSync(runsDir)
    ? readdirSync(runsDir).filter(f => f.endsWith('.json')).map(f => ({ name: f.replace(/\.json$/, ''), ...readJson(join(runsDir, f)) }))
      .sort((x, y) => String(y.at || '').localeCompare(String(x.at || ''))).slice(0, RUNS_MAX)
    : [];
  return buildMirrorDoc({
    manifest: readJson(join(m, 'manifest.json')), verify: readJson(join(m, '_verify.json')), alerts: readJson(join(m, '_alerts', 'LATEST.json')),
    lock: readLock(m), budget: budgetFile ? { day: budgetFile.slice(0, 10), ...readJson(join(budgetDir, budgetFile)) } : null, runs,
    lastTradingDay: dataDate, dataDate, generatedAt,
  });
}

function collectPipeline(a, dataDate, generatedAt) {
  const p = join(a.dir, 'out', 'a35_shadow_daily_status.json');
  return buildPipelineDoc({ status: readJson(p), mtime: mtimeIso(p), dataDate, generatedAt });
}

async function initDb() {
  let cred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!cred && existsSync(PLIST)) cred = execFileSync('plutil', ['-extract', 'EnvironmentVariables.GOOGLE_APPLICATION_CREDENTIALS', 'raw', PLIST], { encoding: 'utf8' }).trim();
  if (!cred || !existsSync(cred)) throw new Error('缺 Firestore 憑證（GOOGLE_APPLICATION_CREDENTIALS 或 daemon plist）');
  const { initializeApp, cert } = await import('firebase-admin/app');
  initializeApp({ credential: cert(JSON.parse(readFileSync(cred, 'utf8'))) });
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  return { db: getFirestore(), FieldValue };
}

/** 依估計位元組分批寫（逐列文件單份可達 ~350KB）。 */
async function commitAll(db, FieldValue, writes) {
  let batch = db.batch(); let bytes = 0; let n = 0;
  for (const w of writes) {
    if (n && bytes + w.bytes > BATCH_BYTES) { await batch.commit(); batch = db.batch(); bytes = 0; n = 0; }
    batch.set(db.collection(COLLECTION).doc(w.id), { ...w.data, updatedAt: FieldValue.serverTimestamp() });
    bytes += w.bytes; n++;
  }
  if (n) await batch.commit();
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const ltd = resolveDataDate(a);
  const dataDate = ltd.date;
  console.log(`資料日（最後交易日）${dataDate}｜面板 ${ltd.panelLast ?? '—'}｜鏡像 MI_INDEX ${ltd.mirrorLast ?? '—'}`);
  const writes = [];   // { id, bytes, data }
  let cvRowIds = null;
  if (a.only.has('cv') || a.only.has('cvrows')) {
    const cv = collectCv(a, dataDate, generatedAt);
    for (const w of cv.warnings) console.log(`  ⚠ ${w}`);
    for (const t of cv.doc.tasks) console.log(`  ${t.id}：${t.versions.map(v => `${v.id}${v.sameAs ? `＝${v.sameAs}` : ''}`).join('、') || t.note}`);
    if (a.only.has('cvrows')) {
      for (const w of cv.rowWrites) {
        const data = { schema: CVROWS_SCHEMA, ...w.meta, dataDate, gz: w.gz };
        writes.push({ id: w.id, bytes: w.gz.length + Buffer.byteLength(JSON.stringify({ ...w.meta, dataDate }), 'utf8') + 64, data });
      }
      cvRowIds = new Set(cv.rowWrites.map(w => w.id));
    }
    if (a.only.has('cv')) {
      const reportJson = JSON.stringify(cv.doc);
      writes.push({ id: LAB_DOC_IDS.cv, bytes: Buffer.byteLength(reportJson, 'utf8'), data: { schema: cv.doc.schema, dataDate, reportJson } });   // 逐列之後才寫摘要
    }
  }
  for (const [part, build] of [['mirror', () => collectMirror(a, dataDate, generatedAt)], ['pipeline', () => collectPipeline(a, dataDate, generatedAt)]]) {
    if (!a.only.has(part)) continue;
    const doc = build();
    const reportJson = JSON.stringify(doc);
    writes.push({ id: LAB_DOC_IDS[part], bytes: Buffer.byteLength(reportJson, 'utf8'), data: { schema: doc.schema, dataDate, reportJson } });
    if (part === 'mirror') console.log(`  鏡像：${doc.summary.datasets} 資料集（日資料落後 ${doc.summary.stale}、有失敗或只有空表 ${doc.summary.withBad}）｜驗證 ${doc.summary.verifyOk}/${doc.summary.verifyTotal}｜警示 ${doc.alerts ? `缺 ${doc.alerts.missingTotal}` : '無檔'}｜鎖 ${doc.lock ? `${doc.lock.cmd} pid ${doc.lock.pid}${doc.lock.alive ? '（執行中）' : '（已結束）'}` : '無'}`);
    if (part === 'pipeline') console.log(`  管線狀態：${doc.present ? '有' : '無（null＋說明）'}`);
  }
  const biggest = assertDocSizes(writes.map(w => [w.id, w.bytes]), MAX_DOC_BYTES);
  for (const w of writes) console.log(`    ${w.id.padEnd(44)} ${String(w.bytes).padStart(8)} B`);
  console.log(`共 ${writes.length} 份文件、合計 ${writes.reduce((s, w) => s + w.bytes, 0)} 位元組、最大 ${biggest ? `${biggest[0]} ${biggest[1]}` : '—'} 位元組（上限 ${MAX_DOC_BYTES}）`);
  if (a.dryRun) { console.log('--dry-run：不寫 Firestore'); return; }
  const { db, FieldValue } = await initDb();
  await commitAll(db, FieldValue, writes);
  console.log(`✓ 已寫入 ${COLLECTION}/（${writes.length} 份）`);
  if (cvRowIds && a.only.has('cv')) {
    const stale = (await db.collection(COLLECTION).listDocuments()).filter(r => r.id.startsWith('lab-cvrows-') && !cvRowIds.has(r.id));
    if (stale.length) {
      const batch = db.batch(); for (const r of stale) batch.delete(r); await batch.commit();
      console.log(`✓ 清掉清單外的舊逐列文件 ${stale.length} 份：${stale.map(r => r.id).join(', ')}`);
    }
  }
}

main().then(() => process.exit(0), e => { console.error('✖', e.message); process.exit(1); });
