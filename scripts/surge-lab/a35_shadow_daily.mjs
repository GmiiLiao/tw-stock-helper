#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 起漲影子（a35 shadow）每日流程協調器（2026-10-04）：每個交易日在定版資料到齊後產生名單、下一交易日 09:00 前凍結、
// 到期對答案、發佈到超級管理員後台——全自動。可重入、冪等：同一個時段重跑只會補做還沒做的步驟。
//
//   ① 鎖（mkdir，固定在本檔旁 .a35_shadow_daily.lock——與快取無關，排程與手動演練互斥；崩潰後由下一輪依 pid 回收）
//      ＋前置檢查（研究用環境變數、研究程序正在改寫共用快取就不跑——被擋的時刻記入狀態檔，缺口原因會註明）
//   ② 唯讀 Firestore：休市日曆、最近幾份 chipArchive 的到齊狀態（canonical-gate.archiveDayStatus）＋模型輸入（資券／借券兩市、上市當沖；
//      surge-shadow-daily.modelInputsStatus）、站上 pred 是否定版（canonicalAt）
//      D＝收盤＋法人到齊、pred 已定版、模型輸入到齊、還沒有名單的打分日；現在 ≥ 下一交易日 08:45 ⇒ 記為缺口（missed），不產生
//      （資券／借券／當沖 19:45～21:49 才進歸檔 ⇒ 正常交易日最早 22:40 那一輪產生；2026-10-04 審查）
//      整天沒有歸檔、之後的交易日已有歸檔 ⇒ 疑似臨時休市（suspectedClosures，與缺口分開；休市日曆補上後自動剔除）
//   ③ fetch_cache（明確指定 SURGE_CACHE）→ panel.py → 除權息補抓（a35_shadow_fetch.mjs d --no-close）
//   ④ 對答案：每份事前凍結名單，有效目標日（以現在的休市日曆重算；臨時休市事後才進日曆）收盤到齊且還沒對過 ⇒ a35_shadow_score.py（失敗不中止）
//   ⑤ 訓練矩陣需要時重建（a35_shadow_matrix.py 判斷 → SURGE_SHADOW_EXTRA_EXRIGHT=1 build_lu1.py → a32_walkforward_prep.py）
//   ⑥ a35_shadow_list.py --day D --target-day 下一交易日（永不 --force）
//   ⑦ a35_shadow_publish.mjs（永不 --allow-replace；out/ 沒變就不重寫）
//   ⑦b T1 分軌前向影子（登錄 T1-TRACKS-FWD-2026-10-05；總開關 tracks/forward_config.json，預設停用）：
//      a37_tracks_fwd.py daily（前向專用快取 .surge-cache-F、輸出 out/tracks_fwd/；凍結 core／缺口／到期評分／parity／摘要）
//      → a37_tracks_publish.mjs（surgeShadow/tracks-*；out/tracks_fwd 沒變就不重寫）。失敗只記為步驟失敗，絕不擋 a35。
//   ⑧ 若有 surge_lab_publish.mjs 則 --only mirror,pipeline；狀態檔 out/a35_shadow_daily_status.json（含 tracks）
//
// 用法：node scripts/surge-lab/a35_shadow_daily.mjs [--dry-run] [--now YYYY-MM-DDTHH:MM] [--out <out 目錄>] [--cache <快取目錄>] [--no-publish]
//   --dry-run：只讀 Firestore 與本機檔，印出這一輪會做什麼；不取鎖、不跑任何子程序、不寫任何檔。--now 只限 dry-run。
//   --no-publish：照常執行但不跑 publish／surge_lab_publish。
//   --cache：正式執行時只能搭配 --no-publish（演練）；演練的輸出一律寫到 --out 或「<快取>-out-rehearsal」，絕不寫正式 out/
//            （否則演練產生的事前凍結名單會被下一輪排程當成正式紀錄發佈；2026-10-04 審查）。子程序以 SURGE_SHADOW_OUT 接收輸出目錄。
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
import { archiveCloseReady } from '../lib/canonical-gate.mjs';
import {
  envLeak, makeCalendar, isTradingDay, nextTradingDay, tradingDaysBetween, taipeiNow, deadlineOf, planDays, scorePlan,
  exrightPlan, parsePs, foreignResearchProcs, researchWaitUntil, RESEARCH_WAIT, lockVerdict, mergeMissed, addDaysIso, pruneNonTrading, effectiveTarget, PIPELINE_START, LOOKBACK_DOCS,
} from '../lib/surge-shadow-daily.mjs';
import { basisOf } from './a35_shadow_meta.mjs';
import {
  parseForwardConfig, tracksPlan, mirrorLimitStatus, prevTradingDay, pendingScores, tracksNeedData, tracksUptoDays, tracksAlerts, TRACKS_CORE_RE, TRACKS_GAP_RE, TRACKS_OUT_DIR,
} from '../lib/surge-tracks-daily.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const PROD_OUT = join(HERE, 'out');
let OUT = PROD_OUT;                                   // 正式＝本檔旁 out/；dry-run 可 --out；演練（--cache＋--no-publish）強制改到別處
let STATUS_PATH = join(OUT, 'a35_shadow_daily_status.json');
const LOCK_DIR = join(HERE, '.a35_shadow_daily.lock'); // 固定位置（與 --cache 無關）：排程與手動演練互斥（gitignore）
const MAX_BLOCKS = 50;
const PY = '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3';   // 有 numpy／pandas；/usr/local/bin/python3（3.13）沒有
const NODE = '/opt/homebrew/bin/node';
const PLIST = join(homedir(), 'Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist');
const MIRROR_HOLIDAY_DIR = join(REPO, 'second-brain/official/openapi.twse.com.tw/twse_oa_holidaySchedule_holidaySchedule');
const FROZEN_RE = /^shadow_(\d{4}-\d{2}-\d{2})\.json$/;
const TRACKS_CONFIG = join(HERE, 'tracks', 'forward_config.json');
const MIRROR_ROOT = process.env.OFFICIAL_ROOT ? resolve(process.env.OFFICIAL_ROOT) : join(REPO, 'second-brain/official');   // worktree 演練可指到主 checkout 的鏡像（唯讀）
const TRACKS_PROD_CACHE = join(HERE, '.surge-cache-F');        // 分軌前向專用快取（只增不改；共用／釘住快取不寫）
const TRACKS_FINGERPRINT_SKIP = /^(tracks_fwd_status\.json|tracks_fwd_dispatt_overlap\.json|plan\.json|\.published(_raw_verify)?\.json)$/;
const MIN = 60_000;
const TIMEOUT = { fetchCache: 20 * MIN, panel: 15 * MIN, exright: 2 * MIN, score: 15 * MIN, matrix: 5 * MIN, buildLu1: 60 * MIN, prep: 30 * MIN, list: 40 * MIN, publish: 10 * MIN, labPublish: 10 * MIN,
  tracks: 10 * MIN, tracksPublish: 5 * MIN };
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
  const a = { dryRun: false, now: null, cache: null, out: null, noPublish: false, rehearsal: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--now') a.now = argv[++i];
    else if (argv[i] === '--cache') a.cache = resolve(argv[++i]);
    else if (argv[i] === '--out') a.out = resolve(argv[++i]);
    else if (argv[i] === '--no-publish') a.noPublish = true;
    else throw new Error(`未知參數：${argv[i]}`);
  }
  if (a.now && !a.dryRun) throw new Error('--now 只能搭配 --dry-run（正式執行一律用現在時刻）');
  if (!a.dryRun && a.cache) {
    if (!a.noPublish) throw new Error('--cache 正式執行只能搭配 --no-publish（演練）：別的快取產生的名單不可進正式 out/、更不可發佈');
    a.rehearsal = true;
    a.out = a.out || `${a.cache.replace(/\/+$/, '')}-out-rehearsal`;
  }
  if (!a.dryRun && a.out && !a.rehearsal) throw new Error('--out 只能搭配 --dry-run 或演練（--cache＋--no-publish）');
  if (a.rehearsal && resolve(a.out) === PROD_OUT) throw new Error(`演練輸出不可指到正式 out/（${PROD_OUT}）`);
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
// 收盤＋法人（定版閘門）＋模型輸入（資券／借券／當沖）——與 a35_shadow_meta.basisOf（名單產生端讀本機快取）同一支判斷
const STATUS_FIELDS = ['date', 'closeJson', 'instJson', 'otcPending', 'gapFixSource', 'complete', 'marginJson', 'lendingJson', 'dayTradeJson'];
const basisSummary = (date, doc) => basisOf(date, doc);
function mirrorHolidayRows() {
  try {
    const mf = readJson(join(MIRROR_HOLIDAY_DIR, '_manifest.json'));
    return JSON.parse(gunzipSync(readFileSync(join(MIRROR_HOLIDAY_DIR, mf.lastFile))).toString('utf8')).payload || null;
  } catch { return null; }
}

// ── T1 分軌前向影子：規劃（唯讀；任何錯誤只記在 tracks.error，不影響 a35）──
const tracksPaths = rehearsal => ({ out: join(OUT, TRACKS_OUT_DIR), cache: rehearsal ? join(OUT, '.tracks-cache') : TRACKS_PROD_CACHE });
const mirrorManifestRows = rel => readJson(join(MIRROR_ROOT, rel, '_manifest.json'))?.rows || {};
const listByRe = (dir, re) => (existsSync(dir) ? readdirSync(dir).map(f => f.match(re)?.[1]).filter(Boolean).sort() : []);

async function tracksSurvey(db, { nowTw, cal, docs, blocks, rehearsal }) {
  const today = nowTw.slice(0, 10);
  const cfg = parseForwardConfig(readJson(TRACKS_CONFIG));
  const { out, cache } = tracksPaths(rehearsal);
  const enabled = cfg.enabled || rehearsal;
  const base = { cfg, enabled, out, cache, start: null, plan: { produce: [], missed: [], waiting: [], done: [], suspected: [], errors: [] }, pending: [], panelLast: null, needData: false };
  if (!enabled) return base;
  const latestReady = [...docs.keys()].sort().filter(d => basisOf(d, docs.get(d)).ready).at(-1) ?? null;
  const start = cfg.enabled ? cfg.startDay : latestReady;            // 演練（--cache＋--no-publish）：只試最近一個收盤到齊的交易日
  if (!start) return base;
  const core = new Set(listByRe(out, TRACKS_CORE_RE)); const gap = new Set(listByRe(out, TRACKS_GAP_RE));
  const window = start <= today ? tradingDaysBetween(addDaysIso(start, -1), today, cal) : [];
  const oldest = [...docs.keys()].sort()[0] ?? today;
  const unknown = window.filter(d => !docs.has(d) && d < oldest && !core.has(d) && !gap.has(d));
  const extra = new Map();
  if (unknown.length) {                                                 // 唯讀：超出 a35 回看範圍、尚未凍結也未記缺口的日子（協調器停過幾天才會發生）
    const snaps = await db.getAll(...unknown.map(d => db.collection('chipArchive').doc(d)), { fieldMask: STATUS_FIELDS });
    snaps.forEach((sn, i) => extra.set(unknown[i], sn.exists ? sn.data() : null));
  }
  const days = window.map(d => (docs.has(d) ? basisOf(d, docs.get(d)) : extra.has(d) ? basisOf(d, extra.get(d)) : { ...basisOf(d, null), found: d >= oldest ? false : null }));
  const readyDays = new Set([...docs.keys()].filter(d => basisOf(d, docs.get(d)).ready));   // 到期評分只在當天資料到齊後才算「可處理」（07:05 不為今天抓除權息）
  const rows = { twse: mirrorManifestRows('www.twse.com.tw/twse_twt84u'), tpex: mirrorManifestRows('www.tpex.org.tw/tpex_dailyquotes') };
  const mirrorOf = d => { try { return mirrorLimitStatus(rows, d, prevTradingDay(d, cal)); } catch (e) { return { ok: false, missing: [String(e?.message || e)] }; } };
  const plan = tracksPlan({ days, cal, nowTw, start, hasCore: d => core.has(d), hasGap: d => gap.has(d), mirrorOf, blocks });
  const yStatus = d => readJson(join(out, `tracks_fwd_score_${d}_y.json`))?.status ?? null;
  const hasScore = (d, stage) => existsSync(join(out, `tracks_fwd_score_${d}_${stage}.json`)) || (stage !== 'y' && yStatus(d) !== null && yStatus(d) !== 'ok');
  const pending = pendingScores({ frozenDays: [...core], hasScore, cal, today, isReady: d => readyDays.has(d) });
  const panelLast = readJson(join(out, 'tracks_fwd_status.json'))?.panel_last ?? null;
  return { ...base, start, plan, pending, panelLast, needData: tracksNeedData({ produce: plan.produce, pending, panelLast }) };
}

/** 讀 Firestore 與本機 out/，算出這一輪的計畫（純讀取） */
async function survey(db, nowTw, prevMissed, blocks, opts = {}) {
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
  const plan = planDays({ days, cal, nowTw, hasList, missedBefore, blocks });
  // 事前凍結名單與對答案：有效目標日＝以現在的休市日曆重算（颱風假等臨時休市封印時不在日曆；只看封印的 targetDay 會永遠等不到歸檔）
  const forward = readdirSync(OUT).filter(f => FROZEN_RE.test(f)).map(f => readJson(join(OUT, f))).filter(f => f?.kind === 'frozen-forward' && f.sha256);
  const scoreSha = new Map(forward.map(f => [f.scoringDay, readJson(join(OUT, `shadow_score_${f.scoringDay}.json`))?.frozenSha256 ?? null]));
  const target = new Map(forward.map(f => [f.scoringDay, effectiveTarget(f, cal)]));
  const targetOf = f => target.get(f.scoringDay);
  const closeReady = new Set();
  for (const f of forward) {
    const t = targetOf(f);
    if (scoreSha.get(f.scoringDay) === f.sha256 || t > today) continue;
    const doc = docs.has(t) ? docs.get(t) : (await db.collection('chipArchive').doc(t).get()).data();   // 唯讀
    if (doc && archiveCloseReady(doc)) closeReady.add(t);
  }
  const scores = scorePlan({ forward, scoreSha, closeReady, targetOf });
  const targetShifts = forward.filter(f => targetOf(f) !== f.targetDay).map(f => ({ scoringDay: f.scoringDay, sealedTargetDay: f.targetDay, effectiveTargetDay: targetOf(f) }));
  const latest = days.at(-1) || null;
  let latestNext = null;
  try { latestNext = latest ? nextTradingDay(latest.date, cal) : null; } catch (e) { plan.errors.push({ date: latest?.date, error: e.message }); }
  let tracks;
  try { tracks = await tracksSurvey(db, { nowTw, cal, docs, blocks, rehearsal: !!opts.rehearsal }); } catch (e) {
    tracks = { error: String(e?.message || e).slice(0, 400), enabled: false, needData: false, plan: null, pending: [] };
  }
  return { cal, plan, scores, days, latest, latestNext, targetShifts, tracks };
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

/** out/tracks_fwd 的指紋（狀態檔、計畫檔、發佈紀錄與子目錄不算）；沒有任何紀錄＝null */
function tracksFingerprint(dir) {
  if (!existsSync(dir)) return null;
  const ent = readdirSync(dir).filter(f => f.endsWith('.json') && !TRACKS_FINGERPRINT_SKIP.test(f)).map(f => { const s = statSync(join(dir, f)); return [f, s.size, s.mtimeMs]; });
  if (!ent.some(([f]) => TRACKS_CORE_RE.test(f) || TRACKS_GAP_RE.test(f))) return null;
  return createHash('sha256').update(JSON.stringify(ent.sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
}

/** ⑦b 分軌前向：凍結／缺口／評分（python）→ 發佈（node）。任何失敗只記成步驟失敗，不影響已完成的 a35。 */
async function tracksStep(st, ctx, step) {
  const t = ctx.survey.tracks;
  const prevPub = st.tracks?.lastPublish ?? null;
  st.tracks = { enabled: !!t?.enabled, startDay: t?.start ?? null, error: t?.error ?? null, lastPublish: prevPub, pending: (t?.pending || []).length,
    plan: t?.plan ? { produce: t.plan.produce, missed: t.plan.missed, waiting: t.plan.waiting, suspected: t.plan.suspected, errors: t.plan.errors } : null };
  if (!t || t.error) { st.steps.push({ name: 'tracks', ok: false, ms: 0, err: `分軌前向規劃失敗：${t?.error ?? '沒有規劃'}` }); return; }
  if (!t.enabled) { st.steps.push({ name: 'tracks', ok: true, ms: 0, skipped: `分軌前向未啟用（${t.cfg?.error || 'tracks/forward_config.json 的 enabled＝false'}）` }); return; }
  if (t.plan.produce.length + t.plan.missed.length + t.pending.length > 0) {
    mkdirSync(t.out, { recursive: true });
    const prodPrewire = join(PROD_OUT, TRACKS_OUT_DIR, 'tracks_fwd_prewire.json');
    if (ctx.rehearsal && existsSync(prodPrewire) && !existsSync(join(t.out, 'tracks_fwd_prewire.json'))) writeFileSync(join(t.out, 'tracks_fwd_prewire.json'), readFileSync(prodPrewire));
    const planPath = join(t.out, 'plan.json');
    const cal = ctx.survey.cal;
    writeJsonAtomic(planPath, { schema: 't1-tracks-plan/v1', nowTw: ctx.nowTw, startDay: t.start, enabled: t.enabled, rehearsal: !!ctx.rehearsal,
      calendar: { holidays: [...cal.holidays].sort(), covered: [...cal.covered].sort(), sources: cal.sources },
      produce: t.plan.produce, missed: t.plan.missed, waiting: t.plan.waiting, preflightBlocks: st.preflightBlocks || [] });
    const env = { ...ctx.env, SURGE_CACHE: t.cache, SURGE_TRACKS_SHARED: ctx.cache, OFFICIAL_ROOT: MIRROR_ROOT, SURGE_TRACKS_OUT: t.out };
    const r = await step('tracks', PY, ['a37_tracks_fwd.py', 'daily', '--plan', planPath, ...(ctx.rehearsal ? ['--rehearsal'] : [])], { timeoutMs: TIMEOUT.tracks, env });
    st.tracks.exit = r.code;
    // 凍結停擺（釘選檔被改、接線前證明不成立）、新缺口、C6、鏡像落後：期限前每一輪都告警（寫 _alerts＋error 級記成步驟失敗）
    const alerts = tracksAlerts(readJson(join(t.out, 'tracks_fwd_status.json')), r.code);
    writeJsonAtomic(join(t.out, '_alerts', 'LATEST.json'), { schema: 't1-tracks-alerts/v1', time: new Date().toISOString(), nowTw: ctx.nowTw, alerts });
    st.tracks.alerts = alerts;
    const errs = alerts.filter(x => x.level === 'error');
    st.steps.push({ name: 'tracks-health', ok: errs.length === 0, ms: 0, err: errs.length ? errs.map(x => `[${x.code}] ${x.msg}`).join('｜').slice(0, 900) : null,
      warn: alerts.filter(x => x.level === 'warn').map(x => x.msg).join('｜') || null });
  } else st.steps.push({ name: 'tracks', ok: true, ms: 0, skipped: '分軌前向：沒有要凍結、記缺口或到期評分的日子' });
  if (ctx.noPublish) { st.steps.push({ name: 'tracks-publish', ok: true, ms: 0, skipped: '--no-publish（本機演練，不寫 Firestore）' }); return; }
  const fp = tracksFingerprint(t.out);
  if (!fp) { st.steps.push({ name: 'tracks-publish', ok: true, ms: 0, skipped: '還沒有任何分軌前向紀錄' }); return; }
  if (prevPub?.ok && prevPub.fingerprint === fp) { st.steps.push({ name: 'tracks-publish', ok: true, ms: 0, skipped: 'out/tracks_fwd 自上次發佈後沒有變動' }); return; }
  const r = await step('tracks-publish', NODE, ['a37_tracks_publish.mjs', '--dir', t.out], { timeoutMs: TIMEOUT.tracksPublish });
  st.tracks.lastPublish = { fingerprint: fp, ok: r.code === 0, finishedAt: new Date().toISOString() };
}

// ── 主流程 ──
async function execute(st, ctx) {
  const { env, cache, survey: sv } = ctx;
  const step = async (name, cmd, args, opts) => {
    log(`▶ ${name}：${[cmd.split('/').pop(), ...args].join(' ')}`);
    const r = await run(cmd, args, opts.env || env, opts);
    const ok = r.code === 0;
    st.steps.push({ name, ok, ms: r.ms, code: r.code, err: ok ? null : (r.spawnError || (r.timedOut ? `逾時 ${opts.timeoutMs / MIN} 分` : '') + ' ' + r.tail.slice(-600)).trim() });
    log(`${ok ? '✓' : '✖'} ${name}（${(r.ms / 1000).toFixed(0)}s，exit ${r.code}）`);
    return r;
  };
  const { plan, scores, cal } = sv;
  const tr = sv.tracks;
  const needData = plan.produce.length > 0 || scores.length > 0 || !!tr?.needData;   // 分軌要凍結或有到期評分而面板還沒那天 ⇒ 也刷新面板
  if (needData) {
    if ((await step('fetch_cache', NODE, ['fetch_cache.mjs', cache], { timeoutMs: TIMEOUT.fetchCache })).code !== 0) return;
    if ((await step('panel', PY, ['panel.py'], { timeoutMs: TIMEOUT.panel })).code !== 0) return;
    const upto = [...plan.produce.map(p => p.date), ...scores.map(s => s.targetDay), ...(tr?.enabled ? tracksUptoDays({ produce: tr.plan.produce, pending: tr.pending }) : [])].sort().at(-1);
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
  await tracksStep(st, ctx, step);                    // ⑦b 分軌前向（a35 名單＋發佈之後；失敗不回頭影響 a35）
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
  if (a.rehearsal) { mkdirSync(OUT, { recursive: true }); log(`演練模式：快取 ${a.cache}、輸出 ${OUT}（不發佈；正式 out/ 不動）`); }
  const cache = a.cache || join(HERE, '.surge-cache');
  let nowTw = a.now || taipeiNow();
  const prev = readJson(STATUS_PATH) || {};
  const st = { schema: 'a35.shadowDaily.v1', lastRunAt: new Date().toISOString(), nowTw, dryRun: a.dryRun, rehearsal: a.rehearsal, cache, out: OUT, D: null, nextTD: null, deadline: null,
    plan: null, steps: [], produced: [], scored: [], missed: prev.missed || [], suspectedClosures: prev.suspectedClosures || [], targetShifts: [],
    preflightBlocks: prev.preflightBlocks || [], revenueSha256: null, dataBasis: null, lastPublish: prev.lastPublish || null,
    tracks: prev.tracks ? { lastPublish: prev.tracks.lastPublish ?? null } : null };
  // ① 前置：研究用環境變數、SURGE_CACHE 指到別處、執行檔不在
  const leak = envLeak(process.env);
  if (process.env.SURGE_CACHE && resolve(process.env.SURGE_CACHE) !== cache) leak.push(`SURGE_CACHE=${process.env.SURGE_CACHE}`);
  const missingBin = [PY, NODE].filter(p => !existsSync(p));
  if (leak.length || missingBin.length || !existsSync(cache) || !existsSync(OUT)) {
    console.error(`✖ 前置檢查失敗：${[leak.length && `研究用環境變數 ${leak.join(', ')}`, missingBin.length && `找不到 ${missingBin.join(', ')}`, !existsSync(cache) && `沒有快取目錄 ${cache}`, !existsSync(OUT) && `沒有 ${OUT}`].filter(Boolean).join('；')}`);
    return 2;
  }
  const lockDir = LOCK_DIR;
  if (!a.dryRun && !acquireLock(lockDir)) return 0;
  const onSignal = sig => { if (current) killGroup(current, 'SIGTERM'); if (!a.dryRun) releaseLock(lockDir); console.error(`收到 ${sig}，中止`); process.exit(143); };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    const scanForeign = () => foreignResearchProcs(parsePs(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })), process.pid);
    let foreign = scanForeign();
    // 期限前最後一輪（07:05）遇研究程序在跑：等它結束（每 2 分鐘檢查、最多到 08:45）再照常凍結；其他時段維持略過（2026-10-09）
    const waitUntil = foreign.length ? researchWaitUntil(nowTw) : null;
    // --now 演練（指定時刻）不真的等：迴圈比的是真實時鐘，未來的 --now 會一直睡並持鎖（審查 M4）
    if (waitUntil && (a.dryRun || a.now)) log(`（dry-run）期限前最後一輪：研究程序在跑，正式執行會每 ${RESEARCH_WAIT.pollMs / 60000} 分鐘檢查、最多等到 ${waitUntil}（台北）`);
    else if (waitUntil) {
      const t0 = Date.now();
      log(`期限前最後一輪：研究程序在跑，每 ${RESEARCH_WAIT.pollMs / 60000} 分鐘檢查、最多等到 ${waitUntil}（台北）：${foreign.map(f => f.pid).join(', ')}`);
      while (foreign.length && taipeiNow() < waitUntil) { await sleep(RESEARCH_WAIT.pollMs); foreign = scanForeign(); }
      st.steps.push({ name: 'preflight-wait', ok: !foreign.length, ms: Date.now() - t0, ...(foreign.length ? { err: `等到 ${waitUntil} 研究程序仍在跑` } : {}) });
      if (!foreign.length) { nowTw = taipeiNow(); st.nowTw = nowTw; log(`研究程序已結束（等了 ${Math.round((Date.now() - t0) / 60000)} 分鐘），照常凍結；現在 ${nowTw}`); }
    }
    if (foreign.length) {
      const msg = `研究程序正在使用共用快取，本輪不做：${foreign.map(f => `${f.pid} ${f.command.slice(0, 120)}`).join(' | ')}`;
      log(msg); st.steps.push({ name: 'preflight', ok: false, ms: 0, err: msg });
      st.preflightBlocks = [...st.preflightBlocks, nowTw].slice(-MAX_BLOCKS);   // 之後若因此錯過期限，缺口原因會註明（planDays blocks）
      if (!a.dryRun) writeJsonAtomic(STATUS_PATH, st);
      return 0;
    }
    let cred, sv;
    try { cred = credPath(); sv = await survey(await initDb(cred), nowTw, st.missed, st.preflightBlocks, { rehearsal: a.rehearsal }); } catch (e) {
      const msg = `讀取 Firestore／日曆失敗：${String(e?.message || e).slice(0, 400)}`;
      console.error(`✖ ${msg}`); st.steps.push({ name: 'survey', ok: false, ms: 0, err: msg });
      if (!a.dryRun) writeJsonAtomic(STATUS_PATH, st);
      return 1;
    }
    const { plan, scores, latest, latestNext, cal } = sv;
    const at = new Date().toISOString();
    st.missed = pruneNonTrading(mergeMissed(st.missed, plan.missed.map(m => ({ ...m, recordedAt: at }))), cal);   // 日曆補上的臨時休市不算缺口
    st.suspectedClosures = pruneNonTrading(mergeMissed(st.suspectedClosures, plan.suspected.map(m => ({ ...m, recordedAt: at }))), cal);
    st.targetShifts = sv.targetShifts;
    st.plan = { produce: plan.produce, waiting: plan.waiting, done: plan.done, errors: plan.errors, newlyMissed: plan.missed, suspected: plan.suspected, score: scores };
    if (latest) { st.D = latest.date; st.nextTD = latestNext; st.deadline = latestNext ? deadlineOf(latestNext) : null; st.dataBasis = latest; }
    log(`現在 ${nowTw}（台北）；最近交易日 ${st.D ?? '—'}（到齊 ${latest?.ready ?? '—'}、${latest?.basis ?? ''}）→ 下一交易日 ${st.nextTD ?? '—'}，期限 ${st.deadline ?? '—'}`);
    const tp = sv.tracks;
    log(`分軌前向：${tp?.error ? `規劃失敗 ${tp.error}` : !tp?.enabled ? '未啟用（forward_config.enabled＝false）' : `起算 ${tp.start ?? '—'}｜凍結 ${tp.plan.produce.map(p => `${p.date}→${p.nextTD}`).join(', ') || '無'}｜缺口 ${tp.plan.missed.map(m => `${m.date}（${m.reason}）`).join(', ') || '無'}｜等待 ${tp.plan.waiting.map(w => `${w.date}（${w.why}）`).join(', ') || '無'}｜到期評分 ${tp.pending.map(p => `${p.day}:${p.stage}${p.actionable === false ? '（到期日資料未到齊，不刷新）' : ''}`).join(', ') || '無'}${tp.plan.suspected.length ? `｜疑似臨時休市 ${tp.plan.suspected.map(x => x.date).join(', ')}` : ''}${tp.plan.errors.length ? `｜錯誤 ${JSON.stringify(tp.plan.errors)}` : ''}`}`);
    log(`計畫：產生 ${plan.produce.map(p => `${p.date}→${p.nextTD}`).join(', ') || '無'}｜等待 ${plan.waiting.map(w => `${w.date}（${w.why}）`).join(', ') || '無'}｜新缺口 ${plan.missed.map(m => `${m.scoringDay}（${m.reason}）`).join(', ') || '無'}｜對答案 ${scores.map(s => `${s.scoringDay}→${s.targetDay}${s.targetDay !== s.sealedTargetDay ? `（封印 ${s.sealedTargetDay}）` : ''}`).join(', ') || '無'}｜已完成 ${plan.done.join(', ') || '無'}${plan.suspected.length ? `｜疑似臨時休市 ${plan.suspected.map(x => x.scoringDay).join(', ')}` : ''}${plan.errors.length ? `｜錯誤 ${JSON.stringify(plan.errors)}` : ''}`);
    if (a.dryRun) {
      const needData = plan.produce.length > 0 || scores.length > 0 || !!tp?.needData;
      const upto = [...plan.produce.map(p => p.date), ...scores.map(s => s.targetDay), ...(tp?.enabled && tp.plan ? tracksUptoDays({ produce: tp.plan.produce, pending: tp.pending }) : [])].sort().at(-1);
      const steps = [];
      if (needData) {
        steps.push(`node fetch_cache.mjs ${cache}`, 'python3 panel.py');
        for (const d of exrightTodo(sv.cal, upto, cache)) steps.push(`node a35_shadow_fetch.mjs ${d} --no-close`);
        for (const s of scores) steps.push(`python3 a35_shadow_score.py out/shadow_${s.scoringDay}.json`);
        for (const p of plan.produce) steps.push(`python3 a35_shadow_matrix.py --day ${p.date}（需要時 SURGE_SHADOW_EXTRA_EXRIGHT=1 build_lu1.py → a32_walkforward_prep.py）`, `python3 a35_shadow_list.py --day ${p.date} --target-day ${p.nextTD} --workers 3 --require-matrix-sidecar`);
      }
      const fp = outFingerprint();
      steps.push(st.lastPublish?.ok && st.lastPublish.fingerprint === fp && !needData ? '（publish 略過：out/ 自上次發佈後沒有變動）' : 'node a35_shadow_publish.mjs');
      if (tp?.error) steps.push(`（分軌前向規劃失敗：${tp.error}——記為步驟失敗，不影響 a35）`);
      else if (!tp?.enabled) steps.push('（分軌前向：tracks/forward_config.json 的 enabled＝false，不執行）');
      else {
        if (tp.plan.produce.length + tp.plan.missed.length + tp.pending.length) {
          steps.push(`SURGE_CACHE=${tp.cache} SURGE_TRACKS_OUT=${tp.out} python3 a37_tracks_fwd.py daily --plan ${join(tp.out, 'plan.json')}（凍結 ${tp.plan.produce.map(p => p.date).join(',') || '無'}｜缺口 ${tp.plan.missed.map(m => m.date).join(',') || '無'}｜到期評分 ${tp.pending.length}）`);
        } else steps.push('（分軌前向：沒有要凍結、記缺口或到期評分的日子）');
        steps.push(`node a37_tracks_publish.mjs --dir ${tp.out}（out/tracks_fwd 沒變就略過）`);
      }
      if (existsSync(join(HERE, 'surge_lab_publish.mjs'))) steps.push('node surge_lab_publish.mjs --only mirror,pipeline');
      console.log(`--dry-run：這一輪會依序執行（不取鎖、不寫檔、不跑子程序）：\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
      return 0;
    }
    // SURGE_SHADOW_OUT：python 端（list／score／missed 檔）的輸出目錄＝本輪 OUT（演練不寫正式 out/）；
    // SURGE_SHADOW_EXTRA_EXRIGHT=1：build_lu1 併入逐日補抓除權息（與上線特徵一致；研究 build 預設不開）
    const env = { ...process.env, SURGE_CACHE: cache, SURGE_SHADOW_OUT: OUT, SURGE_SHADOW_EXTRA_EXRIGHT: '1', GOOGLE_APPLICATION_CREDENTIALS: cred,
      PATH: `${dirname(PY)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` };
    try { await execute(st, { env, cache, survey: sv, noPublish: a.noPublish, rehearsal: a.rehearsal, nowTw }); } catch (e) {
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
