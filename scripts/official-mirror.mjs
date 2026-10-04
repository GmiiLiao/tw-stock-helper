#!/usr/bin/env node
// ── 第二大腦·官方資料鏡像 CLI（2026-10-04 使用者：官網能下載的都下載補入第二大腦，交易日盤後自動更新）─────────
// 存放 second-brain/official/{host}/{dataset}/…；核心規則見 scripts/lib/official-mirror.mjs，盤點見 docs/OFFICIAL-DATA-INVENTORY-2026-10-04.md。
//   daily   [--date D] [--slot main|snap|all]  盤後：上市 MI_INDEX 回聲確認 D 是交易日 → 帶日期資料（main）＋快照（snap）＋近 5 個交易日補漏
//   retry   [--days 5]                        補抓近 N 個交易日未到／失敗的鍵；P1 必有表仍缺、或交易日未確認 ⇒ 寫 _alerts
//   backfill [--max 2500] [--only a,b]        先轉存研究快取（0 請求），再回補帶日期資料的歷史（P1→P3）；每個台北日上限 --max 個請求
//   verify  [--only a,b] [--snapshots]        未驗證端點各打 1 次，通過才排進 daily／backfill
//   migrate                                   研究快取（.surge-cache/official、MOPS t163sb04）轉存進來，0 請求
//   status                                    印出各資料集進度、寫 manifest.json（含最新警示）
// 開跑前檢查（會發請求的指令）：單一程序鎖（原子建立）、研究回補程序仍在跑就不開、daemon 日誌近 30 分鐘有上游故障字樣就不開。
// 節奏：證交所系／櫃買系／期交所各一條佇列、逐請求 ≥3 秒、平日 07:30～15:30 不跑、封鎖訊號立即停；MIS 一律不打（額度歸 daemon）。
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, readSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import * as C from './lib/official-mirror.mjs';
import { recentOutageLines } from './lib/outage-scan.mjs';
import { DATED, resolveFrom } from './official-mirror/adapters-dated.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const ROOT = process.env.OFFICIAL_ROOT || join(REPO, 'second-brain', 'official');
const SURGE = process.env.SURGE_CACHE || join(REPO, 'scripts', 'surge-lab', '.surge-cache');
const DAEMON_LOG = process.env.DAEMON_LOG || join(homedir(), 'Library', 'Logs', 'twstock-ai-daemon', 'ai-daemon.out.log');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const MI = DATED.find(x => x.id === 'twse_mi_index');

function args(argv) {
  const a = { cmd: argv[0], date: null, slot: 'all', max: 2500, only: null, days: 5, snapshots: false, forceHours: false, allowConcurrent: false, ackOutage: false };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--date') a.date = argv[++i]; else if (k === '--slot') a.slot = argv[++i]; else if (k === '--max') a.max = Number(argv[++i]);
    else if (k === '--only') a.only = argv[++i].split(','); else if (k === '--days') a.days = Number(argv[++i]);
    else if (k === '--snapshots') a.snapshots = true; else if (k === '--force-hours') a.forceHours = true;
    else if (k === '--allow-concurrent') a.allowConcurrent = true; else if (k === '--ack-outage') a.ackOutage = true;
    else throw new Error(`未知參數：${k}`);
  }
  return a;
}

// ── 註冊表 ───────────────────────────────────────────────
const verifyFile = () => join(ROOT, '_verify.json');
const readVerify = () => { try { return JSON.parse(readFileSync(verifyFile(), 'utf8')); } catch { return {}; } };
function snapshotAdapters() {
  const reg = JSON.parse(readFileSync(join(HERE, 'official-mirror', 'snapshot-registry.json'), 'utf8')).entries;
  return reg.map(e => ({ ...e, request: ctx => ({ url: e.url, method: e.method || 'GET', body: e.body ? C.render(e.body, ctx) : undefined }),
    spec: { mustContain: e.mustContain || [], mustMatch: e.mustMatch || [], emptyRe: e.emptyRe, minLen: 200 } }));
}
function activeDated(only) { const ver = readVerify(); return DATED.filter(ad => !ad.disabled && (!only || only.includes(ad.id)) && (ad.verified || ver[ad.id]?.ok)); }

// ── 交易日：確認＝研究面板日 ∪ MI_INDEX ok；候選＝之後的平日扣官方休市日（開始／最後交易日是交易日）且未被確認休市 ──────
function officialHolidays() {
  const id = 'twse_oa_holidaySchedule_holidaySchedule'; const man = C.loadManifest(ROOT, 'openapi.twse.com.tw', id); const out = new Set();
  for (const r of Object.values(man.rows || {})) {
    if (!r.file || r.status !== 'ok') continue;
    try { for (const h of C.readEntry(ROOT, 'openapi.twse.com.tw', id, r.file).payload || []) if (!/開始交易|最後交易/.test(h.Name || '')) { const d = C.normDate(h.Date); if (d) out.add(d); } } catch { /* 壞檔略過 */ }
  }
  return out;
}
function dayInfo(until) {
  const confirmed = new Set(); const closed = new Set();
  try { for (const d of JSON.parse(readFileSync(join(SURGE, 'panel_dates.json'), 'utf8'))) confirmed.add(d); } catch { /* 沒有研究快取就只靠鏡像 */ }
  for (const [k, r] of Object.entries(C.loadManifest(ROOT, MI.host, MI.id).rows || {})) { if (r.status === 'ok') confirmed.add(k); else if (r.status === 'empty') closed.add(k); }
  const hol = officialHolidays(); const last = [...confirmed].sort().at(-1) || '2026-10-02';
  const candidates = new Set(confirmed);
  for (let t = Date.parse(`${last}T12:00:00Z`) + 864e5; t <= Date.parse(`${until}T12:00:00Z`); t += 864e5) {
    const d = new Date(t).toISOString().slice(0, 10); const dow = new Date(t).getUTCDay();
    if (dow >= 1 && dow <= 5 && !hol.has(d) && !closed.has(d)) candidates.add(d);
  }
  return { confirmed, candidates: [...candidates].sort(), closed };
}
const months = (from, to) => { const out = []; let [y, m] = from.split('-').map(Number); const [ty, tm] = to.split('-').map(Number); while (y < ty || (y === ty && m <= tm)) { out.push([y, m]); if (++m > 12) { m = 1; y++; } } return out; };
const ymKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
/** 月表何時定版（時鐘規則）：月底過後（次月 finalAfterDay 日的隔天起，預設 2 日）。
 *  月營收 t21sc03／t21sc03_ky 不用這條：它們帶 ad.stable，改由內容穩定（兩次觀測相隔 ≥3 日內容相同）定版，見 lib fetchAndStore。 */
function monthFinal(ad, y, m, today) { const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1]; return today >= `${ny}-${String(nm).padStart(2, '0')}-${String((ad.finalAfterDay ?? 1) + 1).padStart(2, '0')}`; }
/** 季財報何時定版：各業最晚法定期限翌日。 */
function quarterFinal(y, q, today) { return today >= (q === 4 ? `${y + 1}-04-01` : `${y}-${['06-01', '09-01', '12-01'][q - 1]}`); }

/** 一個資料集在某天／某月／某季要抓的鍵（含 sii／otc 變體）。 */
function jobsFor(ad, { day = null, y = null, m = null, q = null }, extra = {}) {
  return (ad.variants || [null]).map(v => {
    const ctx = ad.unit === 'month' ? C.ctxOf({ year: y, month: m, market: v }) : ad.unit === 'quarter' ? C.ctxOf({ year: y, season: q, market: v }) : C.ctxOf({ day, market: v });
    const base = ad.unit === 'month' ? ymKey(y, m) : ad.unit === 'quarter' ? `${y}Q${q}` : day;
    return { ad, key: v ? `${base}.${v}` : base, ctx, ...extra };
  });
}

// ── 開跑前檢查與鎖 ────────────────────────────────────────
function tailText(path, bytes) {
  const st = statSync(path); const len = Math.min(st.size, bytes); const buf = Buffer.alloc(len); const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
  return buf.toString('utf8');
}
function preflight(a) {
  if (!a.allowConcurrent) {
    let running = '';
    try { running = execFileSync('pgrep', ['-fl', 'surge-lab/official_backfill.mjs|surge-lab/mops_fin_backfill.mjs'], { encoding: 'utf8' }).trim(); } catch { running = ''; }
    if (running) { log(`研究回補程序仍在跑（${running.split('\n')[0].slice(0, 120)}）——同一出口 IP，不疊加；本次不執行`); return false; }
  }
  if (!a.ackOutage && existsSync(DAEMON_LOG)) {
    const lines = recentOutageLines(tailText(DAEMON_LOG, 2 << 20), Date.now(), 30 * 60000);
    if (lines.length) { log(`daemon 日誌近 30 分鐘有上游故障字樣（${lines.length} 行，例：${lines.at(-1).slice(25, 100)}）——上游可能正在擋，本次不執行（--ack-outage 才放行）`); return false; }
  }
  return true;
}

function acquireLock(cmd) {
  const p = join(ROOT, '_lock.json');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(p, 'wx'); writeFileSync(fd, JSON.stringify({ pid: process.pid, cmd, at: new Date().toISOString() })); closeSync(fd);
      process.on('exit', () => { try { if (JSON.parse(readFileSync(p, 'utf8')).pid === process.pid) unlinkSync(p); } catch { /* 忽略 */ } });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let cur = {}; try { cur = JSON.parse(readFileSync(p, 'utf8')); } catch { cur = {}; }
      let alive = false; try { if (cur.pid) { process.kill(cur.pid, 0); alive = true; } } catch { alive = false; }
      if (alive) { log(`另一個 ${cur.cmd}（pid ${cur.pid}，${cur.at} 開始）還在跑——本次 ${cmd} 不執行`); return false; }
      try { unlinkSync(p); } catch { /* 被別人清掉了 */ }
    }
  }
  return false;
}

// ── 工作執行：每個機構一條共用佇列 ─────────────────────────────
const queueOpts = a => ({ quiet: a.forceHours ? () => false : C.inQuietWindow, log });
const budgetFile = () => join(ROOT, '_budget', `${C.taipeiDate()}.json`);
function readBudget() { try { return JSON.parse(readFileSync(budgetFile(), 'utf8')).requests || 0; } catch { return 0; } }
function addBudget(n) { mkdirSync(join(ROOT, '_budget'), { recursive: true }); writeFileSync(budgetFile(), JSON.stringify({ requests: readBudget() + n })); }

async function runJobs(jobs, a, { budget = Infinity } = {}) {
  const byFam = new Map(); const mans = new Map(); const stats = {}; let requests = 0;
  for (const j of jobs) { if (j.ad.host === 'mis.twse.com.tw') continue; const f = C.familyOf(j.ad.host); if (!byFam.has(f)) byFam.set(f, []); byFam.get(f).push(j); }
  const bump = k => { stats[k] = (stats[k] || 0) + 1; };
  await Promise.all([...byFam.values()].map(async list => {
    for (const j of list) {
      if (requests >= budget) { bump('overBudget'); continue; }
      const q = C.queueFor(j.ad.host, queueOpts(a)); if (q.stopped) { bump('skipped'); continue; }
      const mk = `${j.ad.host}/${j.ad.id}`; if (!mans.has(mk)) mans.set(mk, C.loadManifest(ROOT, j.ad.host, j.ad.id));
      const man = mans.get(mk); const prevAttempts = man.rows?.[j.key]?.attempts || 0; const before = q.count;
      const out = await q.run(() => C.fetchAndStore(j.ad, { root: ROOT, key: j.key, ctx: j.ctx, man, snapshot: !!j.snapshot, final: j.final ?? true, mustHaveRows: !!j.must }));
      requests += q.count - before;
      if (out?.skipped) { bump('skipped'); continue; }
      const row = man.rows[j.key];
      if (row && !C.isFinalFor(j.ad, man, j.key)) man.rows[j.key] = { ...row, attempts: prevAttempts + 1 };
      const st = row?.lastTry ? `${row.status}(保留·本次${row.lastTry.status})` : (row?.status || 'fail');
      bump(st); C.saveManifest(ROOT, man);
      if (!/^(ok|unchanged|empty)$/.test(st)) log(`  ${j.ad.id} ${j.key}：${st}${row?.note ? `（${row.note}）` : ''}`);
    }
  }));
  return { requests, stats };
}
const mergeStats = (...ss) => ss.reduce((acc, s) => { for (const [k, v] of Object.entries(s || {})) acc[k] = (acc[k] || 0) + v; return acc; }, {});

/** 近 N 個交易日的補漏：MI_INDEX 對候選日、其他帶日期表對已確認日；未定版且嘗試未滿 6 次。 */
function catchUpJobs(n, only, today) {
  const info = dayInfo(today); const lateEnough = C.taipeiNow().getUTCHours() >= 22;
  const recent = info.candidates.filter(d => d < today || (d === today && lateEnough)).slice(-n); const jobs = [];
  for (const ad of activeDated(only)) {
    if (ad.unit !== 'day') continue;
    const man = C.loadManifest(ROOT, ad.host, ad.id);
    for (const d of recent) {
      if (ad.id !== MI.id && !info.confirmed.has(d)) continue;
      for (const j of jobsFor(ad, { day: d }, { must: !!ad.must && ad.id !== MI.id })) if (!C.isFinal(man, j.key) && (man.rows?.[j.key]?.attempts || 0) < 6) jobs.push(j);
    }
  }
  return { jobs, recent };
}

// ── daily ───────────────────────────────────────────────
async function cmdDaily(a) {
  const D = a.date || C.taipeiDate(); const today = C.taipeiDate();
  log(`daily ${D}（slot ${a.slot}）→ ${ROOT}`);
  const r0 = await runJobs(jobsFor(MI, { day: D }), a);
  const miRow = C.loadManifest(ROOT, MI.host, MI.id).rows?.[D];
  const state = miRow?.status === 'ok' ? 'trading' : miRow?.status === 'empty' ? 'closed' : 'unknown';
  log({ trading: `${D} 是交易日（MI_INDEX 回聲＝${D}）`, closed: `${D} 休市（官方查無當日行情）`, unknown: `${D} 未確認（MI_INDEX ${miRow?.status || '未抓'}）——帶日期資料交給補漏／retry` }[state]);
  const jobs = []; const [y, mo, dd] = D.split('-').map(Number);
  if (state === 'trading' && a.slot !== 'snap') {
    for (const ad of activeDated(a.only)) {
      if (ad.id === MI.id) continue;
      if (ad.unit !== 'month') { jobs.push(...jobsFor(ad, { day: D }, { must: !!ad.must })); continue; }
      jobs.push(...jobsFor(ad, { y, m: mo }, { final: false, force: true }));                                   // 當月表逐日長大：每晚覆蓋、不定版
      const [py, pm] = mo === 1 ? [y - 1, 12] : [y, mo - 1]; const man = C.loadManifest(ROOT, ad.host, ad.id);
      // 上月表：未定版就抓。月營收 t21sc03 兩表（ad.stable）由內容穩定定版（fetchAndStore 不採用這裡的 final），申報期後仍每晚抓到兩次觀測一致為止
      for (const j of jobsFor(ad, { y: py, m: pm }, { final: monthFinal(ad, py, pm, today), force: true })) if (!C.isFinalFor(ad, man, j.key)) jobs.push(j);
    }
  }
  if (a.slot !== 'main') jobs.push(...snapshotJobs(D, state, a, today));
  const todo = jobs.filter(j => j.force || j.snapshot || !C.isFinalFor(j.ad, C.loadManifest(ROOT, j.ad.host, j.ad.id), j.key));
  const r1 = await runJobs(todo, a);
  const cu = catchUpJobs(5, a.only, today); const r2 = cu.jobs.length ? await runJobs(cu.jobs, a) : { requests: 0, stats: {} };
  const requests = r0.requests + r1.requests + r2.requests; const stats = mergeStats(r0.stats, r1.stats, r2.stats);
  writeRunLog(`daily-${D}-${a.slot}`, { date: D, state, requests, catchUpKeys: cu.jobs.length, stats });
  cmdStatus({ quiet: true });
  log(`daily 完成：${requests} 個請求`, JSON.stringify(stats));
}

/** 快照：每日／每週六／每月（本月尚無成功的）／季（申報窗內每晚，其餘月一次）；鍵＝資料所屬交易日（非交易日記為最後交易日）。 */
function snapshotJobs(D, state, a, today) {
  const info = dayInfo(D);
  const lastConfirmed = [...info.confirmed].filter(d => d <= D).sort().at(-1) || D;
  const asOf = state === 'trading' || (state === 'unknown' && info.candidates.includes(D)) ? D : lastConfirmed;
  const tw = new Date(`${D}T12:00:00+08:00`); const dow = tw.getUTCDay(); const ym = D.slice(0, 7);
  const [y, mo] = D.split('-').map(Number);
  const qWindow = mo === 5 || mo === 8 || mo === 11 || mo === 3 || (mo === 4 && +D.slice(8) <= 10);
  const curQ = mo <= 2 ? [y - 1, 3] : mo <= 4 ? [y - 1, 4] : mo <= 7 ? [y, 1] : mo <= 10 ? [y, 2] : [y, 3];   // 最近一個申報窗已開始的季
  const out = [];
  for (const ad of snapshotAdapters()) {
    if (a.only && !a.only.includes(ad.id)) continue;
    const man = C.loadManifest(ROOT, ad.host, ad.id);
    const good = Object.entries(man.rows || {}).filter(([, r]) => /^(ok|unchanged|empty)$/.test(r.status)).map(([k]) => k);
    if (ad.unit === 'quarter') {                                                                                // MOPS 季財報（sii／otc）：申報窗內每晚刷新，期限翌日定版
      for (const j of jobsFor(ad, { y: curQ[0], q: curQ[1] }, { final: quarterFinal(curQ[0], curQ[1], today), force: true })) if (!C.isFinal(man, j.key) && (qWindow || !C.hasGood(man, j.key))) out.push(j);
      continue;
    }
    const due = ad.freq === 'daily' ? true
      : ad.freq === 'weekly' ? (dow === 6 || !good.some(k => k >= new Date(tw - 7 * 864e5).toISOString().slice(0, 10)))
        : ad.freq === 'quarterly' ? (qWindow || !good.some(k => k.startsWith(ym)))                              // openapi 財報表：申報窗內每天、其餘每月一次
          : !good.some(k => k.startsWith(ym));
    if (!due) continue;
    let key = asOf; let n = 2; while (C.isFinal(man, key) && man.rows[key].status !== 'unchanged') key = `${asOf}.r${n++}`;
    out.push({ ad, key, ctx: C.ctxOf({ day: asOf }), snapshot: true });
  }
  return out;
}

// ── retry ───────────────────────────────────────────────
async function cmdRetry(a) {
  const today = C.taipeiDate(); const { jobs, recent } = catchUpJobs(a.days, a.only, today);
  const r = await runJobs(jobs, a);
  const info = dayInfo(today); const alerts = [];
  for (const d of recent) if (!info.confirmed.has(d) && !info.closed.has(d)) alerts.push({ id: MI.id, key: d, status: '交易日未確認（MI_INDEX 未取得）' });
  for (const ad of activeDated(a.only).filter(x => x.priority === 1 && x.unit === 'day' && x.must)) {
    const man = C.loadManifest(ROOT, ad.host, ad.id);
    for (const d of recent) if (info.confirmed.has(d)) for (const j of jobsFor(ad, { day: d })) if (!C.isFinal(man, j.key)) alerts.push({ id: ad.id, key: j.key, status: man.rows?.[j.key]?.status || '未抓' });
  }
  writeAlerts(alerts);
  writeRunLog(`retry-${today}`, { requests: r.requests, stats: r.stats, alerts: alerts.length });
  cmdStatus({ quiet: true });
}
function writeAlerts(alerts) {
  mkdirSync(join(ROOT, '_alerts'), { recursive: true });
  const body = JSON.stringify({ rule: '交易日不得有資料缺漏（補不到要出警示）', at: new Date().toISOString(), missing: alerts }, null, 1);
  writeFileSync(join(ROOT, '_alerts', 'LATEST.json'), body);
  if (alerts.length) { writeFileSync(join(ROOT, '_alerts', `${C.taipeiDate()}.json`), body); log(`⚠ 仍缺 ${alerts.length} 筆 → _alerts/`); }
}

// ── backfill ────────────────────────────────────────────
async function cmdBackfill(a) {
  cmdMigrate();
  const today = C.taipeiDate(); const info = dayInfo(today); const left = Math.max(0, a.max - readBudget());
  if (!left) { log(`今日（台北 ${today}）回補已達上限 ${a.max} 個請求`); return; }
  const twh = C.taipeiNow().getUTCHours(); const mopsQuiet = twh === 23 || twh === 0;                         // 23:00～00:59 不碰 MOPS（daemon 重訊輪次、wiki 23:40）
  const jobs = [];
  for (const pr of [1, 2, 3]) for (const ad of activeDated(a.only).filter(x => x.priority === pr)) {
    if (mopsQuiet && ad.host === 'mopsov.twse.com.tw') continue;
    const from = resolveFrom(ad.from, today); const man = C.loadManifest(ROOT, ad.host, ad.id);
    const cand = ad.unit === 'month'
      ? months(from.slice(0, 7), today.slice(0, 7)).slice(0, -1).flatMap(([y, m]) => jobsFor(ad, { y, m }, { final: monthFinal(ad, y, m, today) }))
      : (ad.id === MI.id ? info.candidates : [...info.confirmed].sort()).filter(d => d >= from && d < today).flatMap(d => jobsFor(ad, { day: d }, { must: !!ad.must && ad.id !== MI.id }));
    for (const j of cand) if (!C.isFinalFor(ad, man, j.key) && (man.rows?.[j.key]?.attempts || 0) < 3) jobs.push(j);
  }
  log(`backfill：待抓 ${jobs.length} 個鍵；今日剩餘額度 ${left} 個請求`);
  const r = await runJobs(jobs, a, { budget: left });
  addBudget(r.requests);
  writeRunLog(`backfill-${today}-${Date.now()}`, { requests: r.requests, pending: jobs.length, stats: r.stats });
  cmdStatus({ quiet: true });
  log(`backfill 結束：${r.requests} 個請求`, JSON.stringify(r.stats));
}

// ── verify ──────────────────────────────────────────────
async function cmdVerify(a) {
  const ver = readVerify(); const today = C.taipeiDate(); const last = [...dayInfo(today).confirmed].sort().at(-1);
  const [y, mo] = today.split('-').map(Number); const [py, pm] = mo === 1 ? [y - 1, 12] : [y, mo - 1];
  const jobs = [];
  for (const ad of DATED) {
    if (ad.disabled || (a.only ? !a.only.includes(ad.id) : (ad.verified || ver[ad.id]?.ok))) continue;
    jobs.push(...jobsFor(ad, ad.unit === 'month' ? { y: py, m: pm } : { day: last }).slice(0, 1));
  }
  if (a.snapshots) for (const ad of snapshotAdapters()) {
    if (a.only && !a.only.includes(ad.id)) continue;
    if (Object.keys(C.loadManifest(ROOT, ad.host, ad.id).rows || {}).length) continue;
    jobs.push(...(ad.unit === 'quarter' ? jobsFor(ad, { y: 2026, q: 2 }, { final: quarterFinal(2026, 2, today) }).slice(0, 1) : [{ ad, key: last, ctx: C.ctxOf({ day: last }), snapshot: true }]));
  }
  log(`verify：${jobs.length} 個端點（各 1 次）`);
  await runJobs(jobs, a);
  for (const j of jobs) {
    const r = C.loadManifest(ROOT, j.ad.host, j.ad.id).rows?.[j.key];
    // 帶日期端點要抓到真資料（ok）才算驗證通過：空表無法證明參數正確（2026-10-04 taifex_large_trader「查無」頁被當成通過）；快照的空表合法
    const pass = j.snapshot ? /^(ok|empty|unchanged)$/.test(r?.status || '') : r?.status === 'ok';
    ver[j.ad.id] = { ok: pass, status: r?.status || '未抓', note: r?.note || null, rows: r?.rows ?? null, echo: r?.echo ?? null, at: new Date().toISOString() };
  }
  writeFileSync(verifyFile(), JSON.stringify(ver, null, 1));
  const bad = Object.entries(ver).filter(([, v]) => !v.ok);
  log(`verify 完成：通過 ${Object.values(ver).filter(v => v.ok).length}、未過 ${bad.length}`); for (const [k, v] of bad) log(`  ✖ ${k}：${v.status}${v.note ? `（${v.note}）` : ''}`);
  cmdStatus({ quiet: true });
}

// ── migrate（研究快取 → 鏡像，0 請求）────────────────────────────
function cmdMigrate() {
  let n = 0; const today = C.taipeiDate();
  for (const ad of DATED.filter(x => x.migrateFrom)) {
    const src = join(SURGE, 'official', ad.migrateFrom); if (!existsSync(src)) continue;
    const man = C.loadManifest(ROOT, ad.host, ad.id);
    for (const f of readdirSync(src).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f))) {
      const day = f.slice(0, 10); if (C.hasGood(man, day)) continue;
      const o = JSON.parse(gunzipSync(readFileSync(join(src, f))).toString('utf8'));
      const meta = { url: o.source, fetchedAt: statSync(join(src, f)).mtime.toISOString(), fetchedAtNote: '研究快取沒有抓取時間，取檔案 mtime', echo: day, migratedFrom: `.surge-cache/official/${ad.migrateFrom}`, source: 'official' };
      const file = C.writeEntry(ROOT, ad.host, ad.id, day, { kind: 'json', payload: o.raw, meta });
      man.rows[day] = { status: 'ok', file, echo: day, migrated: true, at: meta.fetchedAt, final: true }; n++;
    }
    C.saveManifest(ROOT, man);
  }
  const fin = join(SURGE, 'official', 'mops_t163sb04');
  if (existsSync(fin)) {
    const man = C.loadManifest(ROOT, 'mopsov.twse.com.tw', 'mops_t163sb04');
    for (const f of readdirSync(fin).filter(f => /^(sii|otc)_\d+_\d\.html\.gz$/.test(f))) {
      const [mk, roc, s] = f.replace('.html.gz', '').split('_'); const key = `${+roc + 1911}Q${s}.${mk}`; if (C.hasGood(man, key)) continue;
      const file = C.writeEntry(ROOT, 'mopsov.twse.com.tw', 'mops_t163sb04', key, { kind: 'text', ext: 'html', buffer: gunzipSync(readFileSync(join(fin, f))) });
      man.rows[key] = { status: 'ok', file, migrated: true, at: statSync(join(fin, f)).mtime.toISOString(), final: quarterFinal(+roc + 1911, +s, today) }; n++;
    }
    C.saveManifest(ROOT, man);
  }
  log(`migrate：轉存 ${n} 檔（0 網路請求）`);
}

// ── status ─────────────────────────────────────────────
function cmdStatus({ quiet = false } = {}) {
  const out = {};
  if (existsSync(ROOT)) for (const host of readdirSync(ROOT).filter(h => !h.startsWith('_') && statSync(join(ROOT, h)).isDirectory())) {
    for (const id of readdirSync(join(ROOT, host)).filter(x => statSync(join(ROOT, host, x)).isDirectory())) {
      const rows = Object.entries(C.loadManifest(ROOT, host, id).rows || {});
      const cnt = {}; for (const [, r] of rows) cnt[r.status] = (cnt[r.status] || 0) + 1;
      const okKeys = rows.filter(([, r]) => /^(ok|empty|unchanged)$/.test(r.status)).map(([k]) => k).sort();
      out[`${host}/${id}`] = { first: okKeys[0] || null, last: okKeys.at(-1) || null, counts: cnt };
    }
  }
  let alerts = null; try { alerts = JSON.parse(readFileSync(join(ROOT, '_alerts', 'LATEST.json'), 'utf8')); } catch { alerts = null; }
  writeFileSync(join(ROOT, 'manifest.json'), JSON.stringify({ updated: new Date().toISOString(), alerts: alerts ? { at: alerts.at, missing: alerts.missing.length } : null, datasets: out }, null, 1));
  if (!quiet) {
    for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(64)} ${String(v.first).padEnd(12)} → ${String(v.last).padEnd(12)} ${JSON.stringify(v.counts)}`);
    if (alerts?.missing?.length) console.log(`⚠ 最新警示（${alerts.at}）：缺 ${alerts.missing.length} 筆，見 _alerts/LATEST.json`);
  }
}

function writeRunLog(name, obj) { mkdirSync(join(ROOT, '_runs'), { recursive: true }); writeFileSync(join(ROOT, '_runs', `${name}.json`), JSON.stringify({ ...obj, at: new Date().toISOString() }, null, 1)); }

async function main() {
  const a = args(process.argv.slice(2)); mkdirSync(ROOT, { recursive: true });
  const net = ['daily', 'retry', 'backfill', 'verify'].includes(a.cmd);
  if ((net || a.cmd === 'migrate') && !acquireLock(a.cmd)) return;
  if (net && !preflight(a)) return;
  if (a.cmd === 'daily') return cmdDaily(a);
  if (a.cmd === 'retry') return cmdRetry(a);
  if (a.cmd === 'backfill') return cmdBackfill(a);
  if (a.cmd === 'verify') return cmdVerify(a);
  if (a.cmd === 'migrate') return cmdMigrate();
  if (a.cmd === 'status') return cmdStatus();
  throw new Error('用法：official-mirror.mjs daily|retry|backfill|verify|migrate|status');
}

main().then(() => process.exit(0), e => { console.error('✖', e.stack || e.message); process.exit(1); });
