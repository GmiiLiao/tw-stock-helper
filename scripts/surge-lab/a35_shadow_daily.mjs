#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 起漲影子（a35 shadow）每日流程協調器（2026-10-04）：每個交易日在定版資料到齊後產生名單、下一交易日 09:00 前凍結、
// 到期對答案、發佈到超級管理員後台——全自動。可重入、冪等：同一個時段重跑只會補做還沒做的步驟。
//
//   ① 鎖（mkdir，崩潰後由下一輪依 pid 回收）＋前置檢查（研究用環境變數、研究程序正在改寫共用快取就不跑）
//   ② 唯讀 Firestore：休市日曆、最近幾份 chipArchive 的到齊狀態（canonical-gate.archiveDayStatus）、站上 pred 是否定版（canonicalAt）
//      D＝到齊且 pred 已定版、還沒有名單的打分日；現在 ≥ 下一交易日 08:45 ⇒ 記為缺口（missed），不產生
//   ③ fetch_cache（明確指定 SURGE_CACHE）→ panel.py → 除權息補抓（a35_shadow_fetch.mjs d --no-close）
//   ④ 對答案：每份事前凍結名單，目標日收盤到齊且還沒對過 ⇒ a35_shadow_score.py（失敗不中止）
//   ⑤ 訓練矩陣需要時重建（a35_shadow_matrix.py 判斷 → build_lu1.py → a32_walkforward_prep.py）
//   ⑥ a35_shadow_list.py --day D --target-day 下一交易日（永不 --force）
//   ⑦ a35_shadow_publish.mjs（永不 --allow-replace；out/ 沒變就不重寫）→ 若有 surge_lab_publish.mjs 則 --only mirror,pipeline
//   ⑧ 狀態檔 out/a35_shadow_daily_status.json
//
// 用法：node scripts/surge-lab/a35_shadow_daily.mjs [--dry-run] [--now YYYY-MM-DDTHH:MM] [--out <out 目錄>]（後兩者僅限 dry-run） [--cache <快取目錄>]
//   --dry-run：只讀 Firestore 與本機檔，印出這一輪會做什麼；不取鎖、不跑任何子程序、不寫任何檔。
//   --no-publish：照常執行但不跑 publish／surge_lab_publish（本機演練：除了 Firestore 唯讀，不碰外部寫入）。
// 憑證：GOOGLE_APPLICATION_CREDENTIALS；沒有就從 daemon 的 launchd plist 讀路徑（不印出內容）。
// 排程：scripts/surge-lab/launchd/com.gmii.twstock.surge-shadow.plist（安裝屬持久設定，需使用者核可）。
// 影子模式：不取代、不修改站上漲停預測；寫入只有 surgeShadow/*（經 publish）。非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { archiveDayStatus, archiveCloseReady } from '../lib/canonical-gate.mjs';
import {
  envLeak, makeCalendar, isTradingDay, nextTradingDay, tradingDaysBetween, taipeiNow, deadlineOf, planDays, scorePlan,
  exrightPlan, parsePs, foreignResearchProcs, lockVerdict, mergeMissed, addDaysIso, PIPELINE_START, LOOKBACK_DOCS,
} from '../lib/surge-shadow-daily.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
let OUT = join(HERE, 'out');                          // --out 只限 dry-run（正式執行時 python 端一律寫 HERE/out）
let STATUS_PATH = join(OUT, 'a35_shadow_daily_status.json');
const PY = '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3';   // 有 numpy／pandas；/usr/local/bin/python3（3.13）沒有
const NODE = '/opt/homebrew/bin/node';
const PLIST = join(homedir(), 'Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist');
const MIRROR_HOLIDAY_DIR = join(REPO, 'second-brain/official/openapi.twse.com.tw/twse_oa_holidaySchedule_holidaySchedule');
const FROZEN_RE = /^shadow_(\d{4}-\d{2}-\d{2})\.json$/;
const MIN = 60_000;
const TIMEOUT = { fetchCache: 20 * MIN, panel: 15 * MIN, exright: 2 * MIN, score: 15 * MIN, matrix: 5 * MIN, buildLu1: 60 * MIN, prep: 30 * MIN, list: 40 * MIN, publish: 10 * MIN, labPublish: 10 * MIN };
const EXIT = { MISSED: 4, NOT_READY: 5, INCONSISTENT: 6, CALENDAR: 7 };    // a35_shadow_list.py 的結束碼

const log = (...a) => console.log(new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const sha256File = p => createHash('sha256').update(readFileSync(p)).digest('hex');
function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1));
  renameSync(tmp, path);
}

function parseArgs(argv) {
  const a = { dryRun: false, now: null, cache: null, out: null, noPublish: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--now') a.now = argv[++i];
    else if (argv[i] === '--cache') a.cache = resolve(argv[++i]);
    else if (argv[i] === '--out') a.out = resolve(argv[++i]);
    else if (argv[i] === '--no-publish') a.noPublish = true;
    else throw new Error(`未知參數：${argv[i]}`);
  }
  if ((a.now || a.out) && !a.dryRun) throw new Error('--now／--out 只能搭配 --dry-run（正式執行一律用現在時刻與本檔旁的 out/）');
  if (a.now && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(a.now)) throw new Error('--now 格式 YYYY-MM-DDTHH:MM（台北時間）');
  return a;
}

// ── 子程序：獨立行程群組＋逾時（先 SIGTERM，10 秒後 SIGKILL 整群，ProcessPool 的子行程一起收）──
let current = null;
const killGroup = (child, sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* 已結束 */ } } };
function run(cmd, args, env, { timeoutMs, capture = false } = {}) {
  return new Promise(res => {
    const t0 = Date.now(); let done = false, out = '', tail = '', timedOut = false;
    const finish = r => { if (done) return; done = true; current = null; res({ ms: Date.now() - t0, stdout: out, tail, timedOut, ...r }); };
    const child = spawn(cmd, args, { cwd: HERE, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    const keep = s => { tail = (tail + s).slice(-3000); };
    child.stdout.on('data', b => { const s = b.toString(); if (capture) out += s; else process.stdout.write(s); keep(s); });
    child.stderr.on('data', b => { const s = b.toString(); process.stderr.write(s); keep(s); });
    const timer = setTimeout(() => { timedOut = true; killGroup(child, 'SIGTERM'); setTimeout(() => killGroup(child, 'SIGKILL'), 10_000).unref(); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); finish({ code: -1, signal: null, spawnError: e.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); finish({ code, signal }); });
  });
}

// ── 鎖 ──
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function acquireLock(dir) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      writeJsonAtomic(join(dir, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString(), host: hostname(), argv: process.argv.slice(2) });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = readJson(join(dir, 'owner.json'));
      if (lockVerdict(owner, isAlive) === 'busy') { log(`另一輪正在執行（pid ${owner.pid}，${owner.startedAt}），本輪不做`); return false; }
      log(`回收殘留的鎖（持有者 ${owner?.pid ?? '不明'} 已不在）`);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return false;
}
function releaseLock(dir) {
  const owner = readJson(join(dir, 'owner.json'));
  if (owner?.pid === process.pid) rmSync(dir, { recursive: true, force: true });
}

// ── Firestore（唯讀）──
function credPath() {
  let cred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!cred && existsSync(PLIST)) cred = execFileSync('/usr/bin/plutil', ['-extract', 'EnvironmentVariables.GOOGLE_APPLICATION_CREDENTIALS', 'raw', PLIST], { encoding: 'utf8' }).trim();
  if (!cred || !existsSync(cred)) throw new Error('缺 Firestore 憑證（GOOGLE_APPLICATION_CREDENTIALS 或 daemon plist）');
  return cred;
}
async function initDb(cred) {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(readFileSync(cred, 'utf8'))) });
  return getFirestore();
}
const STATUS_FIELDS = ['date', 'closeJson', 'instJson', 'otcPending', 'gapFixSource', 'complete'];
const basisSummary = (date, doc) => {
  if (!doc) return { date, found: false, ready: false, missing: ['文件不存在'], basis: null };
  const st = archiveDayStatus(doc);
  return { date, found: true, ready: st.ready, missing: st.missing, basis: st.basis, nonOfficialOtcClose: /yahoo/i.test(String(doc.gapFixSource || '')), gapFixSource: doc.gapFixSource ?? null, otcPending: doc.otcPending ?? null };
};
function mirrorHolidayRows() {
  try {
    const mf = readJson(join(MIRROR_HOLIDAY_DIR, '_manifest.json'));
    return JSON.parse(gunzipSync(readFileSync(join(MIRROR_HOLIDAY_DIR, mf.lastFile))).toString('utf8')).payload || null;
  } catch { return null; }
}

/** 讀 Firestore 與本機 out/，算出這一輪的計畫（純讀取） */
async function survey(db, nowTw, prevMissed) {
  const calDoc = (await db.collection('system').doc('tradingCalendar').get()).data() || null;   // 唯讀
  const cal = makeCalendar(calDoc, mirrorHolidayRows());
  if (!cal) throw new Error('休市日曆讀不到（Firestore system/tradingCalendar 與本機鏡像皆無）');
  const today = nowTw.slice(0, 10);
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(LOOKBACK_DOCS).select(...STATUS_FIELDS).get();   // 唯讀
  const docs = new Map(snap.docs.map(d => [d.get('date'), d.data()]).filter(([d]) => d && d <= today && isTradingDay(d, cal)));
  const dates = [...docs.keys()].sort();
  // 視窗＝最舊那份歸檔（不早於 PIPELINE_START）到今天的每個交易日：沒有歸檔文件的交易日也要看（整天沒歸檔、已過期限＝缺口）
  const window = dates.length ? tradingDaysBetween(addDaysIso(dates[0] < PIPELINE_START ? PIPELINE_START : dates[0], -1), today, cal) : [];
  const hasList = d => existsSync(join(OUT, `shadow_${d}.json`));
  const days = [];
  for (const d of window) {
    const b = basisSummary(d, docs.get(d));
    let canonical = false;
    if (b.ready && !hasList(d)) canonical = !!(await db.collection('limitUpForecast').doc(`pred-${d}`).get()).get('canonicalAt');   // 唯讀
    days.push({ ...b, canonical });
  }
  const missedBefore = new Set([...prevMissed.map(m => m.scoringDay), ...readdirSync(OUT).map(f => f.match(/^shadow_missed_(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean)]);
  const plan = planDays({ days, cal, nowTw, hasList, missedBefore });
  // 事前凍結名單與對答案
  const forward = readdirSync(OUT).filter(f => FROZEN_RE.test(f)).map(f => readJson(join(OUT, f))).filter(f => f?.kind === 'frozen-forward' && f.sha256);
  const scoreSha = new Map(forward.map(f => [f.scoringDay, readJson(join(OUT, `shadow_score_${f.scoringDay}.json`))?.frozenSha256 ?? null]));
  const closeReady = new Set();
  for (const f of forward) {
    if (scoreSha.get(f.scoringDay) === f.sha256 || f.targetDay > today) continue;
    const doc = docs.has(f.targetDay) ? docs.get(f.targetDay) : (await db.collection('chipArchive').doc(f.targetDay).get()).data();   // 唯讀
    if (doc && archiveCloseReady(doc)) closeReady.add(f.targetDay);
  }
  const scores = scorePlan({ forward, scoreSha, closeReady });
  const latest = days.at(-1) || null;
  let latestNext = null;
  try { latestNext = latest ? nextTradingDay(latest.date, cal) : null; } catch (e) { plan.errors.push({ date: latest?.date, error: e.message }); }
  return { cal, plan, scores, days, latest, latestNext };
}

function exrightTodo(cal, upto, cache) {
  const historyTo = readJson(join(REPO, 'scripts/data/exright-history.json'))?.to;
  if (!historyTo) throw new Error('讀不到 scripts/data/exright-history.json 的 to');
  const tradingDays = tradingDaysBetween(historyTo, upto, cal);
  const files = new Map();
  for (const d of tradingDays) { const p = join(cache, `a35_shadow_exright_${d}.json`); if (existsSync(p)) files.set(d, readJson(p)); }
  const retryFrom = tradingDays.length > 10 ? tradingDays.at(-10) : historyTo;
  return exrightPlan({ tradingDays, historyTo, files, upto, retryFrom, cap: 5 });
}

function outFingerprint() {
  const ent = [];
  for (const f of readdirSync(OUT)) if (/^shadow_.*\.json$/.test(f)) { const s = statSync(join(OUT, f)); ent.push([f, s.size, s.mtimeMs]); }
  const hist = join(OUT, 'shadow_hist');
  if (existsSync(hist)) for (const f of readdirSync(hist)) if (f.endsWith('.json')) { const s = statSync(join(hist, f)); ent.push([`shadow_hist/${f}`, s.size, s.mtimeMs]); }
  return createHash('sha256').update(JSON.stringify(ent.sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
}

// ── 主流程 ──
async function execute(st, ctx) {
  const { env, cache, survey: sv } = ctx;
  const step = async (name, cmd, args, opts) => {
    log(`▶ ${name}：${[cmd.split('/').pop(), ...args].join(' ')}`);
    const r = await run(cmd, args, env, opts);
    const ok = r.code === 0;
    st.steps.push({ name, ok, ms: r.ms, code: r.code, err: ok ? null : (r.spawnError || (r.timedOut ? `逾時 ${opts.timeoutMs / MIN} 分` : '') + ' ' + r.tail.slice(-600)).trim() });
    log(`${ok ? '✓' : '✖'} ${name}（${(r.ms / 1000).toFixed(0)}s，exit ${r.code}）`);
    return r;
  };
  const { plan, scores, cal } = sv;
  const needData = plan.produce.length > 0 || scores.length > 0;
  if (needData) {
    if ((await step('fetch_cache', NODE, ['fetch_cache.mjs', cache], { timeoutMs: TIMEOUT.fetchCache })).code !== 0) return;
    if ((await step('panel', PY, ['panel.py'], { timeoutMs: TIMEOUT.panel })).code !== 0) return;
    const upto = [...plan.produce.map(p => p.date), ...scores.map(s => s.targetDay)].sort().at(-1);
    const todo = exrightTodo(cal, upto, cache);
    for (const [i, d] of todo.entries()) {
      if (i) await sleep(3500);
      await step(`exright ${d}`, NODE, ['a35_shadow_fetch.mjs', d, '--no-close'], { timeoutMs: TIMEOUT.exright });
    }
    for (const s of scores) {
      const r = await step(`score ${s.scoringDay}`, PY, ['a35_shadow_score.py', join(OUT, `shadow_${s.scoringDay}.json`)], { timeoutMs: TIMEOUT.score });
      if (r.code === 0) st.scored.push(s.scoringDay);
    }
  } else st.steps.push({ name: 'fetch_cache+panel', ok: true, ms: 0, skipped: '沒有要產生或對答案的名單' });
  for (const p of plan.produce) await produce(st, p, step);
  const fp = outFingerprint();
  if (ctx.noPublish) st.steps.push({ name: 'publish', ok: true, ms: 0, skipped: '--no-publish（本機演練，不寫 Firestore）' });
  else if (st.lastPublish?.ok && st.lastPublish.fingerprint === fp) st.steps.push({ name: 'publish', ok: true, ms: 0, skipped: 'out/ 自上次發佈後沒有變動' });
  else {
    const r = await step('publish', NODE, ['a35_shadow_publish.mjs'], { timeoutMs: TIMEOUT.publish });
    st.lastPublish = { fingerprint: fp, ok: r.code === 0, finishedAt: new Date().toISOString() };
  }
}

async function produce(st, p, step) {
  const missed = reason => { st.missed = mergeMissed(st.missed, [{ scoringDay: p.date, targetDay: p.nextTD, deadline: p.deadline, reason, recordedAt: new Date().toISOString() }]); };
  const m = await step(`matrix-status ${p.date}`, PY, ['a35_shadow_matrix.py', '--day', p.date], { timeoutMs: TIMEOUT.matrix, capture: true });
  const ms = (() => { try { return JSON.parse(m.stdout.trim().split('\n').at(-1)); } catch { return null; } })();
  st.matrix = ms;
  if (!ms || ms.error) { st.steps.at(-1).ok = false; st.steps.at(-1).err = ms?.error || '矩陣狀態讀不到'; return; }
  if (ms.rebuild) {
    log(`訓練矩陣重建：${ms.reasons.join('、')}`);
    if ((await step('build_lu1', PY, ['build_lu1.py'], { timeoutMs: TIMEOUT.buildLu1 })).code !== 0) return;
    if ((await step('a32_walkforward_prep', PY, ['a32_walkforward_prep.py'], { timeoutMs: TIMEOUT.prep })).code !== 0) return;
  }
  if (taipeiNow() >= p.deadline) { missed('流程耗時超過期限（下一交易日 08:45）'); return; }
  const r = await step(`list ${p.date}`, PY, ['a35_shadow_list.py', '--day', p.date, '--target-day', p.nextTD, '--workers', '3', '--require-matrix-sidecar'], { timeoutMs: TIMEOUT.list });
  if (r.code === 0) st.produced.push(p.date);
  else if (r.code === EXIT.MISSED) missed('名單產生端時鐘閘（已過目標日 09:00）');
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.out) { OUT = a.out; STATUS_PATH = join(OUT, 'a35_shadow_daily_status.json'); }
  const cache = a.cache || join(HERE, '.surge-cache');
  const nowTw = a.now || taipeiNow();
  const prev = readJson(STATUS_PATH) || {};
  const st = { schema: 'a35.shadowDaily.v1', lastRunAt: new Date().toISOString(), nowTw, dryRun: a.dryRun, cache, D: null, nextTD: null, deadline: null,
    plan: null, steps: [], produced: [], scored: [], missed: prev.missed || [], revenueSha256: null, dataBasis: null, lastPublish: prev.lastPublish || null };
  // ① 前置：研究用環境變數、SURGE_CACHE 指到別處、執行檔不在
  const leak = envLeak(process.env);
  if (process.env.SURGE_CACHE && resolve(process.env.SURGE_CACHE) !== cache) leak.push(`SURGE_CACHE=${process.env.SURGE_CACHE}`);
  const missingBin = [PY, NODE].filter(p => !existsSync(p));
  if (leak.length || missingBin.length || !existsSync(cache) || !existsSync(OUT)) {
    console.error(`✖ 前置檢查失敗：${[leak.length && `研究用環境變數 ${leak.join(', ')}`, missingBin.length && `找不到 ${missingBin.join(', ')}`, !existsSync(cache) && `沒有快取目錄 ${cache}`, !existsSync(OUT) && `沒有 ${OUT}`].filter(Boolean).join('；')}`);
    return 2;
  }
  const lockDir = join(cache, 'a35_shadow_daily.lock');
  if (!a.dryRun && !acquireLock(lockDir)) return 0;
  const onSignal = sig => { if (current) killGroup(current, 'SIGTERM'); if (!a.dryRun) releaseLock(lockDir); console.error(`收到 ${sig}，中止`); process.exit(143); };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    const foreign = foreignResearchProcs(parsePs(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })), process.pid);
    if (foreign.length) {
      const msg = `研究程序正在使用共用快取，本輪不做：${foreign.map(f => `${f.pid} ${f.command.slice(0, 120)}`).join(' | ')}`;
      log(msg); st.steps.push({ name: 'preflight', ok: false, ms: 0, err: msg });
      if (!a.dryRun) writeJsonAtomic(STATUS_PATH, st);
      return 0;
    }
    let cred, sv;
    try { cred = credPath(); sv = await survey(await initDb(cred), nowTw, st.missed); } catch (e) {
      const msg = `讀取 Firestore／日曆失敗：${String(e?.message || e).slice(0, 400)}`;
      console.error(`✖ ${msg}`); st.steps.push({ name: 'survey', ok: false, ms: 0, err: msg });
      if (!a.dryRun) writeJsonAtomic(STATUS_PATH, st);
      return 1;
    }
    const { plan, scores, latest, latestNext } = sv;
    st.missed = mergeMissed(st.missed, plan.missed.map(m => ({ ...m, recordedAt: new Date().toISOString() })));
    st.plan = { produce: plan.produce, waiting: plan.waiting, done: plan.done, errors: plan.errors, newlyMissed: plan.missed, score: scores };
    if (latest) { st.D = latest.date; st.nextTD = latestNext; st.deadline = latestNext ? deadlineOf(latestNext) : null; st.dataBasis = latest; }
    log(`現在 ${nowTw}（台北）；最近交易日 ${st.D ?? '—'}（到齊 ${latest?.ready ?? '—'}、${latest?.basis ?? ''}）→ 下一交易日 ${st.nextTD ?? '—'}，期限 ${st.deadline ?? '—'}`);
    log(`計畫：產生 ${plan.produce.map(p => `${p.date}→${p.nextTD}`).join(', ') || '無'}｜等待 ${plan.waiting.map(w => `${w.date}（${w.why}）`).join(', ') || '無'}｜新缺口 ${plan.missed.map(m => `${m.scoringDay}（${m.reason}）`).join(', ') || '無'}｜對答案 ${scores.map(s => `${s.scoringDay}→${s.targetDay}`).join(', ') || '無'}｜已完成 ${plan.done.join(', ') || '無'}${plan.errors.length ? `｜錯誤 ${JSON.stringify(plan.errors)}` : ''}`);
    if (a.dryRun) {
      const needData = plan.produce.length > 0 || scores.length > 0;
      const upto = [...plan.produce.map(p => p.date), ...scores.map(s => s.targetDay)].sort().at(-1);
      const steps = [];
      if (needData) {
        steps.push(`node fetch_cache.mjs ${cache}`, 'python3 panel.py');
        for (const d of exrightTodo(sv.cal, upto, cache)) steps.push(`node a35_shadow_fetch.mjs ${d} --no-close`);
        for (const s of scores) steps.push(`python3 a35_shadow_score.py out/shadow_${s.scoringDay}.json`);
        for (const p of plan.produce) steps.push(`python3 a35_shadow_matrix.py --day ${p.date}（需要時 build_lu1.py → a32_walkforward_prep.py）`, `python3 a35_shadow_list.py --day ${p.date} --target-day ${p.nextTD} --workers 3 --require-matrix-sidecar`);
      }
      const fp = outFingerprint();
      steps.push(st.lastPublish?.ok && st.lastPublish.fingerprint === fp && !needData ? '（publish 略過：out/ 自上次發佈後沒有變動）' : 'node a35_shadow_publish.mjs');
      if (existsSync(join(HERE, 'surge_lab_publish.mjs'))) steps.push('node surge_lab_publish.mjs --only mirror,pipeline');
      console.log(`--dry-run：這一輪會依序執行（不取鎖、不寫檔、不跑子程序）：\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
      return 0;
    }
    const env = { ...process.env, SURGE_CACHE: cache, GOOGLE_APPLICATION_CREDENTIALS: cred, PATH: `${dirname(PY)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` };
    try { await execute(st, { env, cache, survey: sv, noPublish: a.noPublish }); } catch (e) {
      console.error('✖ 執行中斷：', e?.stack || e);
      st.steps.push({ name: 'execute', ok: false, ms: 0, err: String(e?.message || e).slice(0, 600) });
    }
    if (existsSync(join(cache, 'revenue.json'))) st.revenueSha256 = sha256File(join(cache, 'revenue.json'));
    writeJsonAtomic(STATUS_PATH, st);                 // surge_lab_publish 讀這份狀態發佈 pipeline
    if (!a.noPublish && existsSync(join(HERE, 'surge_lab_publish.mjs'))) {
      log('▶ surge_lab_publish --only mirror,pipeline');
      const r = await run(NODE, ['surge_lab_publish.mjs', '--only', 'mirror,pipeline'], env, { timeoutMs: TIMEOUT.labPublish });
      st.steps.push({ name: 'surge_lab_publish', ok: r.code === 0, ms: r.ms, code: r.code, err: r.code === 0 ? null : r.tail.slice(-600) });
    }
    writeJsonAtomic(STATUS_PATH, st);
    const failed = st.steps.filter(s => !s.ok);
    log(`完成：產生 ${st.produced.join(', ') || '無'}｜對答案 ${st.scored.join(', ') || '無'}｜失敗步驟 ${failed.map(s => s.name).join(', ') || '無'}`);
    return failed.length ? 1 : 0;
  } finally {
    if (!a.dryRun) releaseLock(lockDir);
  }
}

main().then(code => process.exit(code), e => { console.error('✖', e?.stack || e); process.exit(1); });
