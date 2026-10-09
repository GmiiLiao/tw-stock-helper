#!/usr/bin/env node
// ── 第二大腦·官方資料鏡像 CLI（2026-10-04 使用者：官網能下載的都下載補入第二大腦，交易日盤後自動更新）─────────
// 存放 second-brain/official/{host}/{dataset}/…；核心規則見 scripts/lib/official-mirror.mjs，盤點見 docs/OFFICIAL-DATA-INVENTORY-2026-10-04.md。
//   daily   [--date D] [--slot main|snap|all]  盤後：上市 MI_INDEX 回聲確認 D 是交易日 → 帶日期資料（main）＋快照（snap）＋近 5 個交易日補漏
//   retry   [--days 5]                        補抓近 N 個交易日未到／失敗的鍵＋最後交易日缺的興櫃每日快照；P1 必有表仍缺、交易日未確認、
//                                             或興櫃兩個快照來源都缺 ⇒ 寫 _alerts
//   backfill [--max 2500] [--only a,b]        先轉存研究快取（0 請求），再回補帶日期資料的歷史（P1→P3）；每個台北日上限 --max 個請求
//   verify  [--only a,b] [--snapshots]        未驗證端點各打 1 次，通過才排進 daily／backfill
//   migrate                                   研究快取（.surge-cache/official、MOPS t163sb04）與期交所 30 日逐筆一次性回補轉存進來，0 請求
//   ticks   [--max-files 5] [--refetch D,…]   期交所 30 日逐筆 zip 每日歸檔（平日 17:10）：交易日表到最後收盤日都已歸檔 ⇒ 0 請求；
//                                             否則清單 1＋待抓日檔（平常 1）。清單上更晚的日檔只有夜盤、略過。見 official-mirror/taifex-ticks.mjs
//   status                                    印出各資料集進度、寫 manifest.json（含最新警示）
// 開跑前檢查（會發請求的指令）：單一程序鎖（原子建立）、研究回補程序仍在跑就不開、daemon 日誌近 30 分鐘有封鎖／限流訊號的機構家族本次不跑
//       （2026-10-08·WP7：舊版任何故障字樣就三個機構全停——上櫃 openapi 大檔傳輸被切斷是常態、不是封鎖，鏡像因此停擺三天；
//        其餘故障字樣只記為「降級」照跑，交給佇列的封鎖／連續失敗保護）。daily／retry 被擋 ⇒ 照樣寫 _alerts（停擺不可無聲），
//       並自動重試（daily 每 30 分鐘×5、retry 每 15 分鐘×3，遇禁跑窗停）；daily／retry 拿不到鏡像鎖也寫 _alerts、每 5 分鐘等鎖（2026-10-09）。
// 節奏：證交所系／櫃買系／期交所各一條佇列、逐請求 ≥3 秒、平日 07:30～15:30 不跑、封鎖訊號立即停；MIS 一律不打（額度歸 daemon）。
//       每日 16:25–16:55、21:40–22:35 也不跑（daemon 重任務窗，lib DAEMON_BUSY_WINDOWS；排程改 22:40，2026-10-04·WM-SCAN G4-32）。
// 定版（2026-10-04·G2-37）：非 must 帶日期表的空表要隔 ≥6 小時再看一次仍空才定版（MI_INDEX 未確認的空＝不當休市）；
//       每日快照以官方回聲日為鍵（keyByEcho）；_alerts 經 audit-data-sources 的 officialMirror(本機) 列進 dataHealth。
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, readSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import * as C from './lib/official-mirror.mjs';
import { mirrorOutageGate } from './lib/outage-scan.mjs';
import { DATED, resolveFrom } from './official-mirror/adapters-dated.mjs';
import { TICKS, runTicks, verifyTicks, migrateTicks, ticksGapAlerts, ticksClosedFrom } from './official-mirror/taifex-ticks.mjs';
import { createTpexClose } from './lib/tpex-close-quotes.mjs';
import { downloadStream, reasonText } from './lib/tpex-close-download.mjs';
import { GATE_RETRY, LOCK_WAIT, LOCK_YIELD_CMDS, retryWhileBlocked, lockWaitRounds } from './lib/official-mirror-retry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const ROOT = process.env.OFFICIAL_ROOT || join(REPO, 'second-brain', 'official');
const SURGE = process.env.SURGE_CACHE || join(REPO, 'scripts', 'surge-lab', '.surge-cache');
const TICKS_SRC = process.env.TICKS_SRC || join(REPO, 'second-brain', 'sara-lab', 'taifex', 'ticks-30d');   // 2026-10-09 一次性回補（migrate 轉存）
const DAEMON_LOG = process.env.DAEMON_LOG || join(homedir(), 'Library', 'Logs', 'twstock-ai-daemon', 'ai-daemon.out.log');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const MI = DATED.find(x => x.id === 'twse_mi_index');

function args(argv) {
  const a = { cmd: argv[0], date: null, slot: 'all', max: 2500, only: null, days: 5, snapshots: false, forceHours: false, allowConcurrent: false, ackOutage: false,
    maxFiles: TICKS.maxFilesPerRun, refetch: [], forceList: false };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--date') a.date = argv[++i]; else if (k === '--slot') a.slot = argv[++i]; else if (k === '--max') a.max = Number(argv[++i]);
    else if (k === '--only') a.only = argv[++i].split(','); else if (k === '--days') a.days = Number(argv[++i]);
    else if (k === '--snapshots') a.snapshots = true; else if (k === '--force-hours') a.forceHours = true;
    else if (k === '--allow-concurrent') a.allowConcurrent = true; else if (k === '--ack-outage') a.ackOutage = true;
    else if (k === '--max-files') a.maxFiles = Number(argv[++i]); else if (k === '--refetch') a.refetch = argv[++i].split(',');
    else if (k === '--force-list') a.forceList = true;
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
  // 空表只有「已確認」（final 不是 false：隔 ≥6h 再看仍空，或舊版已定版的列）才算休市；未確認的空留在候選日，補漏會再抓（G2-37）
  for (const [k, r] of Object.entries(C.loadManifest(ROOT, MI.host, MI.id).rows || {})) { if (r.status === 'ok') confirmed.add(k); else if (r.status === 'empty' && r.final !== false) closed.add(k); }
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
 *  月營收 t21sc03／t21sc03_ky 不用這條：它們帶 ad.stable，改由資料定版（出表日期相隔 ≥3 日內容相同＋名冊較上月完整），
 *  2026-09 之前的舊定版頁維持定版（legacyTrustBefore），見 lib isFinalFor／stableDecision。 */
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
const FAMILY_HOST = { twse: 'www.twse.com.tw', tpex: 'www.tpex.org.tw', taifex: 'www.taifex.com.tw' };
/** 回傳 { ok, reason }；ok 時 a.gate＝{ blocked: [家族], degraded: [家族] }，被擋的家族佇列已先停（本次該家族全部 skipped）。 */
function preflight(a) {
  a.gate = { blocked: [], degraded: [] };
  if (!a.allowConcurrent) {
    let running = '';
    try { running = execFileSync('pgrep', ['-fl', 'surge-lab/official_backfill.mjs|surge-lab/mops_fin_backfill.mjs'], { encoding: 'utf8' }).trim(); } catch { running = ''; }
    if (running) { const reason = `研究回補程序仍在跑（${running.split('\n')[0].slice(0, 120)}）——同一出口 IP，不疊加`; log(`${reason}；本次不執行`); return { ok: false, reason }; }
  }
  if (!a.ackOutage && existsSync(DAEMON_LOG)) {
    const g = mirrorOutageGate(tailText(DAEMON_LOG, 2 << 20), Date.now(), 30 * 60000);
    for (const [f, ls] of Object.entries(g.degraded)) {
      a.gate.degraded.push(f);
      log(`daemon 日誌近 30 分鐘 ${f} 有故障字樣（${ls.length} 行，例：${ls.at(-1).slice(25, 100)}）——不是封鎖／限流訊號，照跑（佇列遇封鎖立即停、連續 3 次失敗停）`);
    }
    const fams = Object.keys(g.blocked);
    if (fams.includes('*')) {
      const ex = g.blocked['*'].at(-1).slice(25, 100);
      const reason = `daemon 日誌近 30 分鐘有封鎖／限流訊號且認不出機構（例：${ex}）——全部機構本次不跑（--ack-outage 才放行）`;
      log(reason); return { ok: false, reason };
    }
    for (const f of fams) {
      a.gate.blocked.push(f);
      C.queueFor(FAMILY_HOST[f] || f, queueOpts(a)).stop(`daemon 日誌近 30 分鐘有 ${f} 封鎖／限流訊號（例：${g.blocked[f].at(-1).slice(25, 100)}）——此機構本次不跑（--ack-outage 才放行）`);
    }
  }
  return { ok: true };
}

/** 回傳 { ok, reason }：ok＝已持有鏡像鎖（程序結束自動釋放）；拿不到時 reason 說明誰在跑（呼叫端決定讓路或等鎖）。 */
function acquireLock(cmd) {
  const p = join(ROOT, '_lock.json');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(p, 'wx'); writeFileSync(fd, JSON.stringify({ pid: process.pid, cmd, at: new Date().toISOString() })); closeSync(fd);
      process.on('exit', () => { try { if (JSON.parse(readFileSync(p, 'utf8')).pid === process.pid) unlinkSync(p); } catch { /* 忽略 */ } });
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let cur = {}; try { cur = JSON.parse(readFileSync(p, 'utf8')); } catch { cur = {}; }
      let alive = false; try { if (cur.pid) { process.kill(cur.pid, 0); alive = true; } } catch { alive = false; }
      if (alive) return { ok: false, reason: `另一個 ${cur.cmd}（pid ${cur.pid}，${cur.at} 開始）還在跑` };
      try { unlinkSync(p); } catch { /* 被別人清掉了 */ }
    }
  }
  return { ok: false, reason: '鎖檔競爭（連續兩次建立都失敗）' };
}
/** 拿鏡像鎖（2026-10-09 全站掃描第 1(b) 項）：backfill／ticks／verify／migrate 拿不到就讓路（只記 log）；
 *  daily／retry 拿不到 ⇒ 寫 _alerts（停擺不可無聲），每 5 分鐘再試，最多到 LOCK_WAIT 的上限或進入禁跑窗；
 *  等待期間不持有鎖、也不發任何請求，拿到鎖才往下走（不疊加併發）。 */
async function acquireLockOrWait(a) {
  let last = acquireLock(a.cmd);
  if (last.ok) return true;
  const wait = LOCK_WAIT[a.cmd];
  if (!wait || LOCK_YIELD_CMDS.includes(a.cmd)) { log(`${last.reason}——本次 ${a.cmd} 讓路、不執行`); return false; }
  const rounds = lockWaitRounds(wait); const gapMin = wait.gapMs / 60000;
  log(`${last.reason}——本次 ${a.cmd} 每 ${gapMin} 分鐘再試拿鎖（最多 ${rounds} 輪）`);
  // 等鎖中只記 lockwait-（2026-10-09 審查 M1）：每日熱力把 blocked-daily-<日>-* 當成「鏡像 daily 已跑完」，等鎖時寫 blocked- 會讓熱力提早開跑；
  //   _alerts 留給放棄時寫（等鎖中另一個程序正持鎖執行，不搶寫共用檔）
  writeRunLog(`lockwait-${a.cmd}-${C.taipeiDate()}-${Date.now()}`, { cmd: a.cmd, reason: `拿不到鏡像鎖：${last.reason}（每 ${gapMin} 分鐘再試、最多 ${rounds} 輪）` });
  const r = await retryWhileBlocked({
    attempt: round => round > 0 && (last = acquireLock(a.cmd)).ok,
    gapMs: wait.gapMs, maxRounds: rounds, stopReason: () => (a.forceHours ? null : C.blockedReason()),
  });
  if (r.done) { log(`拿到鏡像鎖（等了 ${r.attempts - 1} 輪）`); return true; }
  const why = r.stopped === 'max' ? `已等滿 ${rounds} 輪` : `進入禁跑窗（${r.stopped}）`;
  log(`${a.cmd} 放棄等鎖：${why}`);
  recordBlocked(a, `拿不到鏡像鎖、已放棄：${last.reason}（${why}）`, { status: false });
  return false;
}

// ── 工作執行：每個機構一條共用佇列 ─────────────────────────────
const queueOpts = a => ({ quiet: a.forceHours ? () => false : C.blockedReason, log });   // --force-hours 連 daemon 重任務窗也放行（手動除錯用）
// 額度記在「這輪開跑的台北日」（2026-10-08·WP7）：舊版收尾時才取日期，23:20 開跑、跨午夜結束的那輪會把 2,500 記到隔天，
//   隔天晚上的回補一開始就「已達上限」——回補實際上隔一晚才跑一次（_budget/2026-10-08.json＝10-07 那輪的 2,501）。
const budgetFile = (day = C.taipeiDate()) => join(ROOT, '_budget', `${day}.json`);
function readBudget(day) { try { return JSON.parse(readFileSync(budgetFile(day), 'utf8')).requests || 0; } catch { return 0; } }
function addBudget(n, day) { mkdirSync(join(ROOT, '_budget'), { recursive: true }); writeFileSync(budgetFile(day), JSON.stringify({ requests: readBudget(day) + n })); }

// ── 上櫃 openapi 收盤大檔（4.7MB 未壓縮）：先從共用快取收養（2026-10-08）────────────────────────
//   daemon／收件匣已把同一支端點的原始回應存進 second-brain/tpex-close/（scripts/lib/tpex-close-quotes.mjs，已驗證、sha256 算在原始位元組上）。
//   這輪要的那個月已有 openapi 格式的檔、且資料日不晚於這輪的資料日 ⇒ 用它的原始位元組走同一套驗證／存檔（0 請求，清單列標 adopted）。
//   沒有才打網路，而且改用串流下載器（停滯 30 秒才中止、總上限 6 分鐘、Accept-Encoding: identity）——舊 httpFetch 的 45 秒總逾時在 15KB/s 時必敗。
const TPEX_CLOSE_ADOPT = new Set(['tpex_oa_tpex_mainboard_daily_close_quotes']);
let _tpexClose = null;
async function adoptFromTpexClose(j, man) {
  try {
    _tpexClose ||= createTpexClose({ network: 'never', mirrorRoot: ROOT });
    const src = _tpexClose.openapiRawFor(j.ctx.dateDash.slice(0, 7));
    if (!src || src.dataDate > j.ctx.dateDash) return null;   // 比這輪資料日還新的不收（PIT）
    const out = await C.fetchAndStore(j.ad, { root: ROOT, key: j.key, ctx: j.ctx, man, snapshot: true, final: j.final ?? true, keyByEcho: !!j.keyByEcho,
      fetchImpl: async () => new Response(src.raw, { status: 200, headers: { 'content-type': 'application/json' } }) });
    const k = out?.key || j.key; const row = man.rows[k];
    if (!/^(ok|unchanged)$/.test(row?.status || '') || row.lastTry) return null;
    man.rows[k] = { ...row, adopted: { from: 'second-brain/tpex-close', dataDate: src.dataDate, source: src.source, fetchedAt: src.fetchedAt, sha256: src.sha256 } };
    return { key: k, status: row.status, src };
  } catch (e) { log(`  ${j.ad.id}：共用快取收養失敗（${e.message.slice(0, 60)}），改走網路`); return null; }
}
/** fetchAndStore 用的 fetch：串流下載（停滯偵測）；HTTP 錯誤照原狀態碼回給 fetchAndStore 判封鎖／5xx，傳輸失敗丟錯（佇列照舊退避重試一次） */
async function streamFetch(url, init = {}) {
  const r = await downloadStream(url, { headers: { ...(init.headers || {}), 'Accept-Encoding': 'identity' } });
  if (!r.ok && r.reason === 'http') return new Response(null, { status: r.http });
  if (!r.ok) throw new Error(`串流下載${reasonText(r)}`);
  return new Response(r.buf, { status: 200, headers: { 'content-type': 'application/json' } });
}

async function runJobs(jobs, a, { budget = Infinity } = {}) {
  const byFam = new Map(); const mans = new Map(); const stats = {}; let requests = 0;
  for (const j of jobs) { if (j.ad.host === 'mis.twse.com.tw') continue; const f = C.familyOf(j.ad.host); if (!byFam.has(f)) byFam.set(f, []); byFam.get(f).push(j); }
  const bump = k => { stats[k] = (stats[k] || 0) + 1; };
  await Promise.all([...byFam.values()].map(async list => {
    for (const j of list) {
      if (requests >= budget) { bump('overBudget'); continue; }
      const mk = `${j.ad.host}/${j.ad.id}`; if (!mans.has(mk)) mans.set(mk, C.loadManifest(ROOT, j.ad.host, j.ad.id));
      const man = mans.get(mk);
      if (j.snapshot && TPEX_CLOSE_ADOPT.has(j.ad.id)) {   // 0 請求：從共用快取收養（見上）
        const ad = await adoptFromTpexClose(j, man);
        if (ad) { bump(`${ad.status}(收養)`); C.saveManifest(ROOT, man); log(`  ${j.ad.id} ${ad.key}：${ad.status}（收養共用快取 ${ad.src.dataDate}·${ad.src.source}，0 請求）`); continue; }
      }
      const q = C.queueFor(j.ad.host, queueOpts(a)); if (q.stopped) { bump('skipped'); continue; }
      const prevAttempts = man.rows?.[j.key]?.attempts || 0; const before = q.count;
      const fetchImpl = TPEX_CLOSE_ADOPT.has(j.ad.id) ? streamFetch : undefined;
      const out = await q.run(() => C.fetchAndStore(j.ad, { root: ROOT, key: j.key, ctx: j.ctx, man, snapshot: !!j.snapshot, final: j.final ?? true, mustHaveRows: !!j.must, keyByEcho: !!j.keyByEcho, fetchImpl }));
      requests += q.count - before;
      if (out?.skipped) { bump('skipped'); continue; }
      const k = out?.key || j.key;   // keyByEcho 時實際寫入的是官方回聲日的鍵
      const row = man.rows[k];
      if (row && !C.isFinalFor(j.ad, man, k)) man.rows[k] = { ...row, attempts: (k === j.key ? prevAttempts : (row.attempts || 0)) + 1 };
      const st = row?.lastTry ? `${row.status}(保留·本次${row.lastTry.status})` : (row?.status === 'empty' && row.final === false ? 'empty(待確認)' : (row?.status || 'fail'));
      bump(st); C.saveManifest(ROOT, man);
      if (!/^(ok|unchanged|empty)$/.test(st)) log(`  ${j.ad.id} ${k}${k !== j.key ? `（執行鍵 ${j.key}）` : ''}：${st}${row?.note ? `（${row.note}）` : ''}`);
    }
  }));
  return { requests, stats };
}
const mergeStats = (...ss) => ss.reduce((acc, s) => { for (const [k, v] of Object.entries(s || {})) acc[k] = (acc[k] || 0) + v; return acc; }, {});

/** 近 n 個候選交易日（今天要到 22:00 後才算進來：官方當日表多半要到晚上才齊）。 */
function recentDays(info, n, today) {
  const lateEnough = C.taipeiNow().getUTCHours() >= 22;
  return info.candidates.filter(d => d < today || (d === today && lateEnough)).slice(-n);
}
/** 近 N 個交易日的補漏：MI_INDEX 對候選日、其他帶日期表對已確認日；未定版且嘗試未滿 6 次。skip＝本輪已抓過的「id|key」（同一輪重抓不算空表確認，白費請求）。 */
function catchUpJobs(n, only, today, skip = new Set()) {
  const info = dayInfo(today);
  const recent = recentDays(info, n, today); const jobs = [];
  for (const ad of activeDated(only)) {
    if (ad.unit !== 'day') continue;
    const man = C.loadManifest(ROOT, ad.host, ad.id);
    for (const d of recent) {
      if (ad.id !== MI.id && !info.confirmed.has(d)) continue;
      for (const j of jobsFor(ad, { day: d }, { must: !!ad.must && ad.id !== MI.id })) if (!skip.has(`${ad.id}|${j.key}`) && !C.isFinal(man, j.key) && (man.rows?.[j.key]?.attempts || 0) < 6) jobs.push(j);
    }
  }
  return { jobs, recent };
}

// ── daily ───────────────────────────────────────────────
async function cmdDaily(a) {
  // a.runDate：排程那輪開跑時的台北日（main 釘住）——當晚重試／等鎖跨午夜後仍抓同一天，不會改抓尚未開盤的隔日（2026-10-09）
  const D = a.date || a.runDate || C.taipeiDate(); const today = C.taipeiDate(); const runStart = new Date().toISOString();
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
  const done = new Set([`${MI.id}|${D}`, ...todo.map(j => `${j.ad.id}|${j.key}`)]);
  const cu = catchUpJobs(5, a.only, today, done); const r2 = cu.jobs.length ? await runJobs(cu.jobs, a) : { requests: 0, stats: {} };
  const requests = r0.requests + r1.requests + r2.requests; const stats = mergeStats(r0.stats, r1.stats, r2.stats);
  // 每日快照（只能每日累積）本輪抓到幾個：retry 依此判定停擺日寫 _alerts（WP7）
  const dailySnapJobs = todo.filter(j => j.snapshot && j.ad.freq === 'daily');
  const dailySnap = { planned: dailySnapJobs.length, ok: dailySnapJobs.filter(j => C.fetchedOkSince(C.loadManifest(ROOT, j.ad.host, j.ad.id), runStart)).length };
  // 帶 --only 的手動 daily 另存帶時間戳的檔名，不可覆蓋同日排程那輪的完整紀錄（dailySnapshotGaps 會略過 only 輪次）
  writeRunLog(a.only?.length ? `daily-${D}-${a.slot}-only-${Date.now()}` : `daily-${D}-${a.slot}`, { date: D, state, requests, catchUpKeys: cu.jobs.length, stats, dailySnap, gate: a.gate, only: a.only });
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
    // 每日快照以官方回聲日為鍵（G2-37）：週／月／季的「本期抓過了沒」靠執行鍵判斷，維持舊鍵避免回聲日落在上期而天天重抓
    out.push({ ad, key, ctx: C.ctxOf({ day: asOf }), snapshot: true, keyByEcho: ad.freq === 'daily' });
  }
  return out;
}

// ── retry ───────────────────────────────────────────────
async function cmdRetry(a) {
  const today = C.taipeiDate(); const { jobs, recent } = catchUpJobs(a.days, a.only, today);
  const r0 = await runJobs(jobs, a);
  // 興櫃每日快照只在 daily 跑：22:40 那輪失敗一次，當日興櫃行情就永久缺（只能每日累積、無法回補）⇒ retry 也補最後一個已確認交易日
  //   （06:45 開盤前兩個端點回的都是前一交易日，keyByEcho 以回聲日定鍵）。只在兩個來源都缺時才抓（≤2 個請求）。
  const emAds = snapshotAdapters().filter(ad => C.EMERGING_SNAPSHOT_IDS.includes(ad.id) && (!a.only || a.only.includes(ad.id)));
  const emMans = () => emAds.map(ad => C.loadManifest(ROOT, ad.host, ad.id));
  const lastTd = [...dayInfo(today).confirmed].filter(d => d < today).sort().at(-1);
  const rEm = lastTd && emAds.length && C.snapshotGapDays(emMans(), [lastTd]).length
    ? await runJobs(emAds.map(ad => ({ ad, key: lastTd, ctx: C.ctxOf({ day: lastTd }), snapshot: true, keyByEcho: true })), a)
    : { requests: 0, stats: {} };
  const r = { requests: r0.requests + rEm.requests, stats: mergeStats(r0.stats, rEm.stats) };
  const alerts = gapAlerts(recent, a.only, today);
  writeAlerts(alerts);
  // 帶時間戳：同日多輪（06:45 排程＋手動）各留一份請求帳
  writeRunLog(`retry-${today}-${Date.now()}`, { requests: r.requests, stats: r.stats, alerts: alerts.length, gate: a.gate });
  cmdStatus({ quiet: true });
}
/** 近期交易日的缺口（只讀本機清單與 run log，0 請求）：retry 跑完寫、daily／retry 被開跑閘門擋下時也寫（停擺不可無聲·WP7）。 */
function gapAlerts(recent, only, today) {
  const info = dayInfo(today); const alerts = [];
  for (const d of recent) if (!info.confirmed.has(d) && !info.closed.has(d)) alerts.push({ id: MI.id, key: d, status: '交易日未確認（MI_INDEX 未取得）' });
  for (const ad of activeDated(only).filter(x => x.priority === 1 && x.unit === 'day' && x.must)) {
    const man = C.loadManifest(ROOT, ad.host, ad.id);
    for (const d of recent) if (info.confirmed.has(d)) for (const j of jobsFor(ad, { day: d })) if (!C.isFinal(man, j.key)) alerts.push({ id: ad.id, key: j.key, status: man.rows?.[j.key]?.status || '未抓' });
  }
  // 交易日不得有資料缺漏：官方確認的交易日，興櫃兩個快照來源都沒有 ⇒ 警示（之前的日子已無法補抓，只能揭露）
  const emAds = snapshotAdapters().filter(ad => C.EMERGING_SNAPSHOT_IDS.includes(ad.id) && (!only || only.includes(ad.id)));
  if (emAds.length) for (const d of C.snapshotGapDays(emAds.map(ad => C.loadManifest(ROOT, ad.host, ad.id)), recent.filter(d => info.confirmed.has(d)))) {
    alerts.push({ id: C.EMERGING_SNAPSHOT_IDS[0], key: d, status: '興櫃每日快照缺（www 與 openapi 兩個來源都沒有；只能每日累積、無法回補）' });
  }
  // 期交所 30 日逐筆（2026-10-09）：滾動窗、只能每日歸檔——verify 通過後，最近 30 個確認交易日沒歸檔／已滾出清單（永久缺）／同名檔異版 ⇒ 警示；
  //   已在歸檔（清單有列）卻 verify 未通過 ⇒ ticks 每輪 0 請求空轉，也要警示（停擺不可無聲，審查 M1）
  if (!only || only.includes(TICKS.id)) {
    const tv = readVerify()[TICKS.id]; const tman = C.loadManifest(ROOT, TICKS.host, TICKS.id);
    if (tv?.ok) alerts.push(...ticksGapAlerts({ man: tman, confirmed: info.confirmed, lastClosed: lastClosedDay(info, today) }));
    else if (Object.keys(tman.rows || {}).length) alerts.push({ id: TICKS.id, key: today, status: `30 日逐筆歸檔停擺：verify 未通過（${tv?.status || '未驗證'}${tv?.note ? `·${tv.note}` : ''}）——ticks 每輪 0 請求，約 29 個交易日後永久缺；跑 verify --only ${TICKS.id}` });
  }
  // 停擺日：交易日收盤後到下一交易日開盤前沒有一輪 daily 把每日快照抓齊（WP7：10-05 排在禁跑窗、10-06／10-07 被開跑閘門擋，三天都沒有）
  if (!only) {
    const runs = readDailyRuns(); const since = runs.map(r => r.date).filter(Boolean).sort()[0] || null;
    const next = {}; info.candidates.forEach((d, i) => { if (info.candidates[i + 1]) next[d] = info.candidates[i + 1]; });
    const tw = C.taipeiNow(); const lateToday = tw.getUTCHours() * 60 + tw.getUTCMinutes() >= 23 * 60 + 30;   // 今天的 daily（22:40）跑完之後才檢查今天
    const nDaily = snapshotAdapters().filter(ad => ad.freq === 'daily').length;
    for (const g of C.dailySnapshotGaps(recent.filter(d => info.confirmed.has(d) && (d < today || lateToday)), runs, { next, since })) {
      alerts.push({ id: 'official-mirror.daily', key: g.key, status: g.ran
        ? `每日快照只取得 ${g.ok ?? '?'}/${g.planned ?? nDaily}（缺的只能每日累積、無法回補）`
        : `daily 未執行（停擺）：每日快照 0/${nDaily}（只能每日累積、無法回補；帶日期資料由 retry／backfill 補）` });
    }
  }
  return alerts;
}
function readDailyRuns() {
  const dir = join(ROOT, '_runs'); const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter(f => /^daily-\d{4}-\d{2}-\d{2}-/.test(f))) { try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { /* 壞檔略過 */ } }
  return out;
}
/** daily／retry 被開跑閘門擋下：記 _runs 並照樣寫 _alerts（含「本次未執行」一列），停擺日不再無聲。 */
/** status:false＝呼叫端沒持有鏡像鎖（等鎖中），不重寫 manifest.json（持鎖的程序會寫，避免兩個程序同時寫同一檔）。 */
function recordBlocked(a, reason, { status = true } = {}) {
  const today = C.taipeiDate();
  writeRunLog(`blocked-${a.cmd}-${today}-${Date.now()}`, { cmd: a.cmd, reason });
  const alerts = gapAlerts(recentDays(dayInfo(today), a.days || 5, today), a.only, today);
  writeAlerts([{ id: 'official-mirror', key: today, status: `${a.cmd} 未執行：${reason}` }, ...alerts]);
  if (status) cmdStatus({ quiet: true });
}
/** ticks 用：警示內容跟 LATEST.json 一樣就不重寫——LATEST 的 at 是稽核判斷 retry 排程有沒有在跑的心跳，不可被每日 ticks 蓋掉（審查 L2）。 */
function writeAlertsIfChanged(alerts) {
  let cur = null; try { cur = JSON.parse(readFileSync(join(ROOT, '_alerts', 'LATEST.json'), 'utf8')).missing; } catch { cur = null; }
  if (cur && JSON.stringify(cur) === JSON.stringify(alerts)) return false;
  writeAlerts(alerts); return true;
}
function writeAlerts(alerts) {
  mkdirSync(join(ROOT, '_alerts'), { recursive: true });
  const body = JSON.stringify({ rule: '交易日不得有資料缺漏（補不到要出警示）', at: new Date().toISOString(), missing: alerts }, null, 1);
  // 原子寫入（暫存檔＋rename；2026-10-09 審查 M2）：等鎖中的程序與持鎖程序可能同時寫，稽核不可讀到半截檔
  const atomic = (f, b) => { const tmp = `${f}.tmp${process.pid}`; writeFileSync(tmp, b); renameSync(tmp, f); };
  atomic(join(ROOT, '_alerts', 'LATEST.json'), body);
  if (alerts.length) { atomic(join(ROOT, '_alerts', `${C.taipeiDate()}.json`), body); log(`⚠ 仍缺 ${alerts.length} 筆 → _alerts/`); }
}

// ── ticks（期交所 30 日逐筆 zip；平日 17:10，排程窗 17:00–21:30）────────────────────
// 「該日已收盤歸檔」＝交易日表的確認日（研究面板日 ∪ MI_INDEX 回聲 ok）；今天若是候選交易日（平日、不在官方休市表、未確認休市）
//   且已過 16:50（日檔 16:37–16:46 上架）也算——今天的 MI_INDEX 要到 22:40 daily 才確認。清單上更晚的日檔（休市日先上架的
//   下一交易日檔）只有夜盤、略過；檔案完不完整最後由回聲（最晚成交日＝檔名日、有日盤成交）把關。
const lastClosedDay = (info, today) => [...info.confirmed].filter(d => d <= today).sort().at(-1) || null;
const ticksClosed = today => { const info = dayInfo(today); return ticksClosedFrom({ confirmed: info.confirmed, candidates: info.candidates, today }); };
/** 一次性回補轉存（0 請求、冪等）：例外只記 log，不拖垮呼叫端（每晚 backfill 開頭也會跑，審查 L1）。 */
function migrateTicksSafe() {
  try { return migrateTicks({ root: ROOT, src: TICKS_SRC, log }); } catch (e) { log(`${TICKS.id} 轉存失敗（${String(e.message).slice(0, 80)}），略過`); return 0; }
}
async function cmdTicks(a) {
  const today = C.taipeiDate();
  if (!Number.isInteger(a.maxFiles) || a.maxFiles < 0) throw new Error(`--max-files 要是 ≥0 的整數：${a.maxFiles}`);
  for (const d of a.refetch) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`--refetch 日期要是 YYYY-MM-DD：${d}`);
  if (!readVerify()[TICKS.id]?.ok) {   // 新端點先 verify 通過才進每日（鏡像既有規則）；停擺照寫 _alerts（gapAlerts 會列）
    log(`${TICKS.id} 尚未 verify 通過（先跑 verify --only ${TICKS.id}）——本次 0 請求`);
    writeRunLog(`ticks-${today}-${Date.now()}`, { requests: 0, skipped: '未 verify' });
    writeAlertsIfChanged(gapAlerts(recentDays(dayInfo(today), a.days, today), null, today));
    return;
  }
  const migrated = migrateTicksSafe();   // 先把一次性回補轉進來，免得第一輪把本機已有的檔重抓一遍（審查 M4）
  if (migrated) log(`${TICKS.id}：轉存一次性回補 ${migrated} 檔（0 請求）`);
  const { closed, lastClosed } = ticksClosed(today);
  log(`ticks ${today}：交易日表最後收盤日 ${lastClosed} → ${ROOT}`);
  const r = await runTicks({ root: ROOT, confirmed: closed, lastClosed, q: C.queueFor(TICKS.host, queueOpts(a)), log,
    maxFiles: a.maxFiles, refetch: a.refetch, forceList: a.forceList });
  const alerts = gapAlerts(recentDays(dayInfo(today), a.days, today), null, today);
  const wrote = writeAlertsIfChanged(alerts);
  writeRunLog(`ticks-${today}-${Date.now()}`, { requests: r.requests, stats: r.stats, lastClosed, plan: r.plan || null, list: r.list || null, alerts: alerts.length, alertsWritten: wrote, gate: a.gate });
  cmdStatus({ quiet: true });
  log(`ticks 完成：${r.requests} 個請求`, JSON.stringify(r.stats));
}

// ── backfill ────────────────────────────────────────────
async function cmdBackfill(a) {
  cmdMigrate();
  const today = C.taipeiDate(); const info = dayInfo(today); const left = Math.max(0, a.max - readBudget(today));
  if (!left) { log(`今日（台北 ${today}）回補已達上限 ${a.max} 個請求`); return; }
  const twh = C.taipeiNow().getUTCHours(); const mopsQuiet = twh === 23 || twh === 0;                         // 23:00～00:59 不碰 MOPS（daemon 重訊輪次、wiki 23:40）
  const jobs = [];
  for (const pr of [1, 2, 3]) for (const ad of activeDated(a.only).filter(x => x.priority === pr)) {
    if (mopsQuiet && ad.host === 'mopsov.twse.com.tw') continue;
    const from = resolveFrom(ad.from, today); const man = C.loadManifest(ROOT, ad.host, ad.id);
    const cand = ad.unit === 'month'
      ? months(from.slice(0, 7), today.slice(0, 7)).slice(0, -1).flatMap(([y, m]) => jobsFor(ad, { y, m }, { final: monthFinal(ad, y, m, today) }))
      : (ad.id === MI.id ? info.candidates : [...info.confirmed].sort()).filter(d => d >= from && d < today).flatMap(d => jobsFor(ad, { day: d }, { must: !!ad.must && ad.id !== MI.id }));
    // 3 次上限是給「抓不到」的鍵；內容穩定資料集「已有好資料、只是還在等穩定／名冊完整」的列不設上限（每輪回補 1 個請求），
    // 否則上月表在每日累積的嘗試次數會讓它跨月後永遠停在 final:false（2026-10-04 審查）
    for (const j of cand) if (!C.isFinalFor(ad, man, j.key) && ((man.rows?.[j.key]?.attempts || 0) < 3 || (ad.stable && C.hasGood(man, j.key)))) jobs.push(j);
  }
  log(`backfill：待抓 ${jobs.length} 個鍵；今日剩餘額度 ${left} 個請求`);
  const r = await runJobs(jobs, a, { budget: left });
  addBudget(r.requests, today);
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
  const doTicks = a.only ? a.only.includes(TICKS.id) : !ver[TICKS.id]?.ok;   // 期交所 30 日逐筆：清單＋最新收盤日檔（本機已有就重下載比對 sha256）
  log(`verify：${jobs.length} 個端點（各 1 次）${doTicks ? `＋${TICKS.id}（清單＋日檔 2 次）` : ''}`);
  await runJobs(jobs, a);
  for (const j of jobs) {
    const r = C.loadManifest(ROOT, j.ad.host, j.ad.id).rows?.[j.key];
    // 帶日期端點要抓到真資料（ok）才算驗證通過：空表無法證明參數正確（2026-10-04 taifex_large_trader「查無」頁被當成通過）；快照的空表合法
    const pass = j.snapshot ? /^(ok|empty|unchanged)$/.test(r?.status || '') : r?.status === 'ok';
    ver[j.ad.id] = { ok: pass, status: r?.status || '未抓', note: r?.note || null, rows: r?.rows ?? null, echo: r?.echo ?? null, at: new Date().toISOString() };
  }
  if (doTicks) ver[TICKS.id] = await verifyTicks({ root: ROOT, lastClosed: ticksClosed(today).lastClosed, q: C.queueFor(TICKS.host, queueOpts(a)) });
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
  n += migrateTicksSafe();   // 期交所 30 日逐筆一次性回補（sha256 對來源清單）
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

// daily／retry 被開跑閘門擋下（整批或某機構）、或跑到一半遇封鎖／限流訊號停掉時自動再試（2026-10-09 使用者追問：
//   10-06、10-07 daily 被擋後要等隔天 06:45 retry，而 retry 也被擋 ⇒ 兩天整晚沒抓；全站掃描第 1(a) 項：retry 被擋後當天不再試）。
//   daily：每 30 分鐘、最多 5 輪；retry：每 15 分鐘、最多 3 輪（lib/official-mirror-retry.mjs GATE_RETRY）。進入禁跑窗（平日 07:30–15:30、
//   daemon 重任務窗）就停。重試期間持有鏡像鎖（backfill 會讓路——當日資料優先於歷史回補）；每輪重新判斷閘門、重置家族佇列。
//   手動帶 --date 的 daily 不重試（維持舊行為）。
const FAMILY_HOSTS = ['www.twse.com.tw', 'www.tpex.org.tw', 'www.taifex.com.tw'];
const hitBlockSignal = a => FAMILY_HOSTS.some(h => { const q = C.queueFor(h, queueOpts(a)); return q.stopped && /封鎖|限流/.test(q.stopReason || ''); });
async function runWithGateRetry(a, run) {
  const { gapMs, maxRounds } = GATE_RETRY[a.cmd];
  const noRetry = a.cmd === 'daily' && !!a.date;
  let pf = { ok: true };
  const r = await retryWhileBlocked({
    gapMs, maxRounds: noRetry ? 0 : maxRounds,
    attempt: async () => {
      pf = preflight(a);
      if (!pf.ok) recordBlocked(a, pf.reason);
      else await run(a);
      return !(!pf.ok || a.gate.blocked.length > 0 || hitBlockSignal(a));
    },
    stopReason: () => C.blockedReason(),
    beforeRetry: round => { log(`${a.cmd} 第 ${round}/${maxRounds} 輪重試`); C.resetQueues(); },
    sleep: ms => { log(`${a.cmd} 有機構被擋（${pf.ok ? (a.gate.blocked.join('、') || '執行中遇封鎖／限流') : '整批'}）——${ms / 60000} 分鐘後重試`); return new Promise(res => setTimeout(res, ms)); },
  });
  if (r.done) return;
  if (r.stopped === 'max') log(`${a.cmd} 仍有機構被擋，已達重試上限（${r.attempts - 1} 輪）——交給下一個排程（retry／下次 daily 的 5 日補漏）`);
  else log(`${a.cmd} 重試停止：進入禁跑窗（${r.stopped}）`);
}

function writeRunLog(name, obj) { mkdirSync(join(ROOT, '_runs'), { recursive: true }); writeFileSync(join(ROOT, '_runs', `${name}.json`), JSON.stringify({ ...obj, at: new Date().toISOString() }, null, 1)); }

async function main() {
  const a = args(process.argv.slice(2)); mkdirSync(ROOT, { recursive: true });
  const net = ['daily', 'retry', 'backfill', 'verify', 'ticks'].includes(a.cmd);
  if (a.cmd === 'daily') a.runDate = C.taipeiDate();   // 釘住排程那輪的台北日（等鎖／當晚重試跨午夜仍抓同一天）
  if ((net || a.cmd === 'migrate') && !(await acquireLockOrWait(a))) return;
  if (a.cmd === 'daily') return runWithGateRetry(a, cmdDaily);
  if (a.cmd === 'retry') return runWithGateRetry(a, cmdRetry);
  if (net) {
    const pf = preflight(a);
    if (!pf.ok) { if (a.cmd === 'ticks') recordBlocked(a, pf.reason); return; }
  }
  if (a.cmd === 'backfill') return cmdBackfill(a);
  if (a.cmd === 'verify') return cmdVerify(a);
  if (a.cmd === 'migrate') return cmdMigrate();
  if (a.cmd === 'status') return cmdStatus();
  if (a.cmd === 'ticks') return cmdTicks(a);
  throw new Error('用法：official-mirror.mjs daily|retry|backfill|verify|migrate|ticks|status');
}

main().then(() => process.exit(0), e => { console.error('✖', e.stack || e.message); process.exit(1); });
