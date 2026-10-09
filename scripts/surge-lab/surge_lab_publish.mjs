#!/usr/bin/env node
// 起漲研究後台發佈：官方化重訓驗證（CV）／逐列命中漏網／鏡像健康／影子管線狀態 → Firestore surgeShadow/lab-*（2026-10-04 使用者「我需要在後台看到資料」）。
// 只寫 surgeShadow 這個集合的 lab-* 文件（客戶端規則預設拒絕，僅 /api/admin/surge-shadow 以超級管理員讀）；不碰站上任何資料。
//
// 讀（全是本機檔，零網路）：
//   <dir>/out/pre_fix_20261004/official_cv_*        修正前快照（含 official_cv_robust.json 與分析文件）
//   <dir>/out/official_cv_*                         目前輸出（重訓後覆蓋；與快照逐位相同時視為「尚未產出修正後」）
//   <repo>/second-brain/official/{manifest.json,_verify.json,_alerts/LATEST.json,_lock.json,_budget/,_runs/,<host>/<id>/_manifest.json}
//   <dir>/out/a35_shadow_daily_status.json          每日影子協調器的狀態
//   <SURGE_CACHE 或 dir/.surge-cache>/panel_dates.json＋鏡像 MI_INDEX manifest ⇒ 最後交易日（dataDate；不用日曆日）
// 寫：surgeShadow/lab-cvrows-*（gzip Bytes 的 {cols,rows}）→ lab-cv（摘要＋逐列清單與 sha256，最後寫）→ lab-mirror → lab-pipeline；
//     同時發佈 cv 與 cvrows 時，清掉清單外的舊 lab-cvrows-*。任何一份 ≥ 900,000 位元組 ⇒ 整批不寫。
// 殘缺輸入不覆蓋好資料（2026-10-04 審查；CLAUDE.md「殘缺資料不可覆蓋好的快取」）——各部分獨立判斷，壞的那部分不寫、其餘照常、結束碼 1：
//   cv／cvrows：任一任務缺修正前快照 ⇒ 不寫；這次沒有逐列或有任務一份逐列都沒有 ⇒ 不刪舊逐列。
//   mirror：鏡像目錄或 manifest.json 不存在／讀不了 ⇒ 不寫（不以 present:false 蓋掉舊文件）；其他鏡像檔半寫 ⇒ 重讀一次，仍壞就 null＋readErrors。
//   pipeline：狀態檔不存在 ⇒ 只在 Firestore 還沒有 lab-pipeline 時才寫 null＋說明；讀不了（半寫）⇒ 不寫。
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
  lastTradingDay, planCvTask, buildCvDoc, buildMirrorDoc, buildPipelineDoc, assertDocSizes, cvGateProblems, staleRowsToDelete, datasetUnit,
} from '../lib/surge-lab-report.mjs';
import { DATED } from '../official-mirror/adapters-dated.mjs';
import { stampAfterPublish } from '../lib/writer-version.mjs';

const COLLECTION = 'surgeShadow';
const PARTS = ['cv', 'cvrows', 'mirror', 'pipeline'];
const BATCH_BYTES = 4_000_000;   // 一個 batch 的估計總位元組（Firestore 單次請求 10 MiB，留餘裕）
const PLIST = join(homedir(), 'Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist');
const RUNS_MAX = 10;
const REREAD_MS = 500;           // 鏡像檔不是原子寫入（official-mirror writeFileSync），讀到半寫就隔一下重讀一次

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
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const mtimeIso = p => (existsSync(p) ? statSync(p).mtime.toISOString() : null);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** JSON 檔：不存在 ⇒ { absent }；解析失敗 ⇒ 隔 REREAD_MS 重讀一次，仍失敗 ⇒ { error }（不丟錯，由呼叫端決定）。 */
async function readJsonSafe(p) {
  if (!existsSync(p)) return { value: null, absent: true, error: null };
  for (let k = 0; ; k++) {
    try { return { value: JSON.parse(readFileSync(p, 'utf8')), absent: false, error: null }; } catch (e) {
      if (k >= 1) return { value: null, absent: false, error: `讀取失敗：${String(e?.message || e).slice(0, 160)}` };
      await sleep(REREAD_MS);
    }
  }
}

/** 最後交易日：研究面板日期＋鏡像 MI_INDEX 已確認日（兩者都沒有 ⇒ 中止，不拿日曆日充數）。 */
async function resolveDataDate(a) {
  const panel = await readJsonSafe(join(a.cache, 'panel_dates.json'));
  const mi = await readJsonSafe(join(a.mirror, 'www.twse.com.tw', 'twse_mi_index', '_manifest.json'));
  for (const [name, r] of [['panel_dates.json', panel], ['鏡像 MI_INDEX _manifest.json', mi]]) if (r.error) console.error(`  ⚠ ${name} ${r.error}（不採用）`);
  const r = lastTradingDay({ panelDates: Array.isArray(panel.value) ? panel.value : [], miIndexRows: mi.value?.rows || {} });
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

/** CV 摘要＋逐列文件（逐列以 gzip(JSON) 存 Bytes；sha256 寫進摘要，API 讀時核對）。缺修正前快照 ⇒ 丟錯（cv／cvrows 不寫）。 */
function collectCv(a, dataDate, generatedAt) {
  const entries = []; const rowWrites = []; const warnings = [];
  for (const t of CV_TASKS) {
    const { entry, payloads } = planCvTask(t.id, CV_VERSIONS.map(def => versionInput(a.dir, def, t.id)));
    entries.push(entry);
    for (const v of entry.versions) for (const w of v.warnings || []) warnings.push(`${t.id}/${v.id}：${w}`);
    for (const v of entry.versions) if (v.robustNote) warnings.push(`${t.id}/${v.id}：${v.robustNote}`);
    for (const p of payloads) {
      const gz = gzipSync(Buffer.from(JSON.stringify({ cols: p.cols, rows: p.rows }), 'utf8'), { level: 9 });
      const sha = sha256(gz);
      rowWrites.push({
        id: p.id, gz, sha,
        meta: { id: p.id, task: p.task, version: p.version, model: p.model, kind: p.kind, totalRows: p.totalRows, keptRows: p.keptRows, filterNote: p.filterNote, verified: p.verified, verifyNote: p.verifyNote, gzBytes: gz.length, sha256: sha },
      });
    }
  }
  const gate = cvGateProblems(entries);
  if (gate.length) throw new Error(`輸入不完整，cv／cvrows 不寫（不以空結果覆蓋 Firestore 上的資料；--dir 是否指到主 checkout 的 scripts/surge-lab？）：${gate.join('；')}`);
  const doc = buildCvDoc({ dataDate, generatedAt, tasks: entries, rowsDocs: rowWrites.map(w => w.meta) });
  return { doc, rowWrites, warnings };
}

function lockAlive(lock) {
  if (!Number.isInteger(lock?.pid)) return null;
  try { process.kill(lock.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 最近 RUNS_MAX 個執行記錄（依檔案修改時間新→舊；壞檔記 error、不中止）。 */
async function readRuns(m, readErrors) {
  const dir = join(m, '_runs');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((x, y) => y.t - x.t).slice(0, RUNS_MAX);
  const out = [];
  for (const { f } of files) {
    const r = await readJsonSafe(join(dir, f)); const name = f.replace(/\.json$/, '');
    if (r.error) { readErrors.push({ file: `_runs/${f}`, error: r.error }); out.push({ name, error: '讀取失敗' }); } else out.push({ name, ...(r.value || {}) });
  }
  return out;
}

/** 各日資料集（含必有表）在最後交易日那一列的狀態：<mirror>/<host>/<id>/_manifest.json rows[ltd].status。 */
async function readLtdRows(m, keys, ltd) {
  const out = {};
  for (const key of keys) {
    const r = await readJsonSafe(join(m, key, '_manifest.json'));
    out[key] = r.error ? { status: null, error: r.error } : { status: r.value?.rows?.[ltd]?.status ?? null, error: null };
  }
  return out;
}

async function collectMirror(a, dataDate, generatedAt) {
  const m = a.mirror;
  if (!existsSync(m)) throw new Error(`找不到鏡像目錄 ${m}（--mirror；預設路徑只在主 checkout 成立）——不以空資料覆蓋 lab-mirror`);
  const man = await readJsonSafe(join(m, 'manifest.json'));
  if (man.absent || man.error || !man.value || typeof man.value !== 'object') throw new Error(`鏡像 manifest.json ${man.absent ? '不存在' : man.error || '不是物件'}——不以空資料覆蓋 lab-mirror`);
  const readErrors = [];
  const opt = async (rel) => {
    const r = await readJsonSafe(join(m, rel));
    if (r.error) readErrors.push({ file: rel, error: r.error });
    return r.value;
  };
  const verify = await opt('_verify.json');
  const alerts = await opt(join('_alerts', 'LATEST.json'));
  const lockRaw = await opt('_lock.json');
  const budgetDir = join(m, '_budget');
  const budgetFile = existsSync(budgetDir) ? readdirSync(budgetDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1) : undefined;
  const budgetRaw = budgetFile ? await opt(join('_budget', budgetFile)) : null;
  const runs = await readRuns(m, readErrors);
  const mustKeys = DATED.filter(d => d.must && !d.disabled).map(d => `${d.host}/${d.id}`);
  const dayKeys = Object.entries(man.value.datasets || {}).filter(([, v]) => datasetUnit(v?.last ?? v?.first ?? '') === 'day').map(([k]) => k);
  const ltdRows = await readLtdRows(m, [...new Set([...dayKeys, ...mustKeys])].filter(k => existsSync(join(m, k))), dataDate);
  for (const [k, r] of Object.entries(ltdRows)) if (r.error) readErrors.push({ file: `${k}/_manifest.json`, error: r.error });
  return buildMirrorDoc({
    manifest: man.value, verify, alerts, lock: lockRaw ? { ...lockRaw, alive: lockAlive(lockRaw) } : null,
    budget: budgetRaw ? { day: budgetFile.slice(0, 10), ...budgetRaw } : null, runs, ltdRows, mustKeys, readErrors,
    lastTradingDay: dataDate, dataDate, generatedAt,
  });
}

/** 狀態檔不存在 ⇒ 回 onlyIfAbsent（正式寫入時 Firestore 已有 lab-pipeline 就保留舊的）；讀不了 ⇒ 丟錯（不寫）。 */
async function collectPipeline(a, dataDate, generatedAt) {
  const p = join(a.dir, 'out', 'a35_shadow_daily_status.json');
  const r = await readJsonSafe(p);
  if (r.error) throw new Error(`管線狀態檔 ${r.error}——不寫，保留 Firestore 上的舊狀態`);
  return { doc: buildPipelineDoc({ status: r.value, mtime: mtimeIso(p), dataDate, generatedAt }), onlyIfAbsent: r.absent };
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
  if (writes.length) await stampAfterPublish(db, COLLECTION, 'surge_lab_publish', join(dirname(fileURLToPath(import.meta.url)), '..', '..'), ['scripts/surge-lab/surge_lab_publish.mjs', 'scripts/lib/surge-lab-report.mjs']);
}

const labWrite = (id, doc, extra = {}) => { const reportJson = JSON.stringify(doc); return { id, bytes: Buffer.byteLength(reportJson, 'utf8'), data: { schema: doc.schema, dataDate: doc.dataDate, reportJson }, ...extra }; };

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const ltd = await resolveDataDate(a);
  const dataDate = ltd.date;
  console.log(`資料日（最後交易日）${dataDate}｜面板 ${ltd.panelLast ?? '—'}｜鏡像 MI_INDEX ${ltd.mirrorLast ?? '—'}`);
  const writes = [];   // { id, bytes, data, onlyIfAbsent? }
  const failed = [];
  const part = async (name, fn) => { try { await fn(); } catch (e) { failed.push(name); console.error(`✖ ${name} 未發佈：${e.message}`); } };
  let cvRowIds = null;
  if (a.only.has('cv') || a.only.has('cvrows')) await part('cv／cvrows', async () => {
    const cv = collectCv(a, dataDate, generatedAt);
    for (const w of cv.warnings) console.log(`  ⚠ ${w}`);
    for (const t of cv.doc.tasks) console.log(`  ${t.id}：${t.versions.map(v => `${v.id}${v.sameAs ? `＝${v.sameAs}` : `（打分日 ${v.scoredFirst ?? '—'}～${v.scoredLast ?? '—'}）`}`).join('、') || t.note}`);
    if (a.only.has('cvrows')) {
      for (const w of cv.rowWrites) {
        const data = { schema: CVROWS_SCHEMA, ...w.meta, dataDate, gz: w.gz };
        writes.push({ id: w.id, bytes: w.gz.length + Buffer.byteLength(JSON.stringify({ ...w.meta, dataDate }), 'utf8') + 64, data });
      }
      cvRowIds = cv.rowWrites.map(w => w.id);
    }
    if (a.only.has('cv')) writes.push(labWrite(LAB_DOC_IDS.cv, cv.doc));   // 逐列之後才寫摘要
  });
  if (a.only.has('mirror')) await part('mirror', async () => {
    const doc = await collectMirror(a, dataDate, generatedAt);
    writes.push(labWrite(LAB_DOC_IDS.mirror, doc));
    const s = doc.summary;
    console.log(`  鏡像：${s.datasets} 資料集（日資料落後 ${s.stale}、有失敗或只有空表 ${s.withBad}、必有表最後交易日非 ok ${s.mustNotOk}/${s.mustTotal}（其中鏡像尚無 ${s.mustAbsent}））｜驗證 ${s.verifyOk}/${s.verifyTotal}｜警示 ${doc.alerts ? `缺 ${doc.alerts.missingTotal}` : '無檔'}｜鎖 ${doc.lock ? `${doc.lock.cmd} pid ${doc.lock.pid}${doc.lock.alive ? '（執行中）' : '（已結束）'}` : '無'}${doc.readErrors.length ? `｜讀檔失敗 ${doc.readErrors.length}` : ''}`);
    for (const e of doc.readErrors) console.log(`  ⚠ ${e.file} ${e.error}`);
  });
  if (a.only.has('pipeline')) await part('pipeline', async () => {
    const { doc, onlyIfAbsent } = await collectPipeline(a, dataDate, generatedAt);
    writes.push(labWrite(LAB_DOC_IDS.pipeline, doc, { onlyIfAbsent }));
    const s = doc.summary;
    console.log(`  管線狀態：${doc.present ? `有（${s?.schemaKnown ? '' : `格式不明 ${s?.schema ?? '—'}｜`}步驟 ${s?.stepsTotal ?? 0}、失敗 ${s?.stepsFailed ?? 0}）` : '無檔——Firestore 已有 lab-pipeline 就保留舊的，沒有才寫 null＋說明'}`);
  });
  const biggest = assertDocSizes(writes.map(w => [w.id, w.bytes]), MAX_DOC_BYTES);
  for (const w of writes) console.log(`    ${w.id.padEnd(44)} ${String(w.bytes).padStart(8)} B${w.onlyIfAbsent ? '（僅在尚無此文件時寫）' : ''}`);
  console.log(`共 ${writes.length} 份文件、合計 ${writes.reduce((s, w) => s + w.bytes, 0)} 位元組、最大 ${biggest ? `${biggest[0]} ${biggest[1]}` : '—'} 位元組（上限 ${MAX_DOC_BYTES}）`);
  const code = failed.length ? 1 : 0;
  if (a.dryRun) { console.log(`--dry-run：不寫 Firestore${failed.length ? `｜未通過：${failed.join('、')}` : ''}`); return code; }
  if (!writes.length) { console.log('沒有可寫的文件'); return code; }
  const { db, FieldValue } = await initDb();
  const todo = [];
  for (const w of writes) {
    if (w.onlyIfAbsent && (await db.collection(COLLECTION).doc(w.id).get()).exists) { console.log(`  略過 ${w.id}：狀態檔不存在，保留 Firestore 上的舊文件`); continue; }
    todo.push(w);
  }
  await commitAll(db, FieldValue, todo);
  console.log(`✓ 已寫入 ${COLLECTION}/（${todo.length} 份）`);
  if (cvRowIds && a.only.has('cv')) {
    const existing = (await db.collection(COLLECTION).listDocuments()).map(r => r.id);
    const del = staleRowsToDelete(existing, cvRowIds);
    if (del.skipped) console.log(`  ⚠ 不清舊逐列：${del.skipped}`);
    else if (del.ids.length) {
      const batch = db.batch(); for (const id of del.ids) batch.delete(db.collection(COLLECTION).doc(id)); await batch.commit();
      console.log(`✓ 清掉清單外的舊逐列文件 ${del.ids.length} 份：${del.ids.join(', ')}`);
    }
  }
  return code;
}

main().then(code => process.exit(code), e => { console.error('✖', e.message); process.exit(1); });
