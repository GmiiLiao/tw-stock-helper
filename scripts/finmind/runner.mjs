// ── 下載執行器：依計畫逐群組、逐成員抓取並落地 ───────────────────────────────────────
// 不變式：
//   ① 一個成員的資料只有在完整收到、回聲驗證（每列 date 等於請求日／落在請求區間）通過後才追加；半份資料不落地。
//   ② 群組內所有成員都成功才收尾（改名成正式檔）；中途停止留 .part 檔，下次續抓。
//   ③ 時段窗（main／idle）每個請求前檢查；額度（user_info）每 monitorEvery 個請求檢查；402 等額度、403／429 用完退避／本機寫入失敗／
//      連續 maxConsecutiveFailures 次失敗 ⇒ 停。
//   ④ 近 recentDays 天的群組第一個請求回 0 列 ⇒ 視為 FinMind 尚未更新，不落地、下次再抓（不把「還沒出」當成「沒有資料」）。
//   ⑤ 停止訊號（SIGTERM）：stopSignal 由 CLI 傳入；當前請求結束後收尾、刷碟、寫 _coverage。
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { appendMember, closeGroup, datasetDir, finalizeGroup, groupPaths, gzipLines, openGroup, readJson, supersedeGroup, syncGroup, writeJsonAtomic } from './store.mjs';
import { requestFor } from './jobs.mjs';
import { msUntilOpen } from './timewin.mjs';
import { defaultSleep, FinMindError } from './client.mjs';
import { SOURCE_LABEL } from './datasets.mjs';

const DATE_IN_ROW = /"date"\s*:\s*"(\d{4}-\d{2}-\d{2})/;
const RANGE_FILE = /^range_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:\.part)?\.jsonl\.gz$/;
const WINDOW_RECHECK_MS = 5 * 60e3;
const QUOTA_RESUME_RATIO = 0.9;
const QUOTA_HIGH_RATIO = 0.95;
const MIN_LEVEL = 3;
const PROGRESS_EVERY = 100;
const MAX_QUOTA_RETRIES = 3;

export const variantOf = g => (g.spec.mode === 'broker-day' && g.route === 'stock' ? 'by-stock' : null);
const iso = ms => new Date(ms).toISOString();
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400e3;

/** 回聲驗證的期望：日群組要同一天；區間群組要落在區間內；快照不檢查。 */
export function expectDate(g) {
  if (g.date) return d => d === g.date;
  if (g.range) return d => d >= g.range[0] && (!g.range[1] || d <= g.range[1]);
  return () => true;
}

/** 寫 gzip 的 sink：邊收邊檢查每列日期；有不符的列就丟 echo 錯誤（整個成員不落地）。 */
export function makeSink(g) {
  const ok = expectDate(g);
  const w = gzipLines();
  let bad = 0; let badSample = null; let first = null;
  return {
    async write(rows) {
      for (const r of rows) {
        const m = DATE_IN_ROW.exec(r);
        if (m && !ok(m[1])) { bad += 1; badSample ||= m[1]; }
      }
      if (first == null && rows.length) first = rows[0];
      await w.write(rows);
    },
    async end(info) {
      if (bad) { w.abort(); throw new FinMindError('echo', `回聲不符：${bad} 列的 date 不在請求範圍（例：${badSample}，請求 ${g.date || g.range?.join('～') || g.group}）`); }
      if (!info.rows) { w.abort(); return { gz: null, first: null }; }
      return { gz: await w.end(), first };
    },
    abort() { w.abort(); },
  };
}

/** _coverage.json：每資料集（變體）一份，批次寫入。 */
export function createCoverage(root, now = Date.now) {
  const cache = new Map(); const dirty = new Set();
  const get = g => {
    const dir = datasetDir(root, g.dataset, variantOf(g));
    if (!cache.has(dir)) cache.set(dir, readJson(join(dir, '_coverage.json'), null) || { dataset: g.dataset, variant: variantOf(g), source: SOURCE_LABEL, groups: {}, failures: {} });
    dirty.add(dir);
    return cache.get(dir);
  };
  return {
    setGroup(g, og, status) {
      const c = get(g);
      // zeroMembers：回 0 列的成員數（分 K／逐筆的成員是當日有量的股票 ⇒ 0 列就是缺口，要看得見；分點券商路線的停業券商則屬正常）
      const zeroMembers = [...og.done.values()].filter(n => !n).length;
      c.groups[g.group] = { status, members: og.done.size, zeroMembers, planned: g.planned, rows: og.rows, bytes: og.bytes, updatedAt: iso(now()) };
    },
    cols(g, firstRow) {
      const c = get(g);
      if (c.cols || !firstRow) return;
      try { c.cols = Object.keys(JSON.parse(firstRow)); } catch { /* 非物件列 */ }
    },
    fail(g, member, e) {
      const c = get(g); const k = `${g.group}|${member}`;
      c.failures[k] = { kind: e.kind || 'unknown', msg: String(e.message || '').slice(0, 300), count: (c.failures[k]?.count || 0) + 1, errorAt: iso(now()) };
    },
    clearFail(g, member) { const c = get(g); delete c.failures[`${g.group}|${member}`]; },
    /** 群組被取代（搬到 _superseded/）：從 coverage 移除，免得 summary 把舊區間與新區間的列數重複累加。 */
    drop(g, group) {
      const c = get(g); delete c.groups[group];
      for (const k of Object.keys(c.failures)) if (k.startsWith(`${group}|`)) delete c.failures[k];
    },
    flush() {
      for (const dir of dirty) {
        const c = cache.get(dir);
        const gs = Object.entries(c.groups);
        const dates = gs.map(([k]) => k).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
        c.summary = { groups: gs.length, complete: gs.filter(([, v]) => v.status === 'complete').length, empty: gs.filter(([, v]) => v.status === 'empty').length,
          partial: gs.filter(([, v]) => v.status === 'partial').length, rows: gs.reduce((n, [, v]) => n + (v.rows || 0), 0), bytes: gs.reduce((n, [, v]) => n + (v.bytes || 0), 0),
          zeroMembers: gs.reduce((n, [, v]) => n + (v.zeroMembers || 0), 0),
          firstDate: dates[0] || null, lastDate: dates[dates.length - 1] || null, failures: Object.keys(c.failures).length };
        c.updatedAt = iso(now());
        writeJsonAtomic(join(dir, '_coverage.json'), c);
      }
      dirty.clear();
    },
  };
}

export async function runPlan(opts) {
  const { groups, client, limiter = null, root, now = Date.now, sleep = defaultSleep, stopSignal = null, window = 'main', windowOpts = {},
    maxRequests = Infinity, log = () => {}, todayIso, flushEvery = 50, flushMs = 60e3, quotaWaitMs = 5 * 60e3, maxQuotaWaits = 14,
    maxConsecutiveFailures = 5, monitorEvery = 300, recentDays = 3 } = opts;
  const stats = { requests: 0, rows: 0, gzBytes: 0, members: 0, groupsFinalized: 0, groupsTouched: 0, failures: 0, notPublished: [], stopReason: null, startedAt: iso(now()) };
  const cov = createCoverage(root, now);
  const open = new Set();
  let consecutive = 0; let sinceFlush = 0; let lastFlush = now(); let nextMonitor = monitorEvery; let nextProgress = PROGRESS_EVERY;

  const flushAll = () => { for (const og of open) syncGroup(og); cov.flush(); lastFlush = now(); sinceFlush = 0; };
  const nap = async ms => { try { await sleep(ms, stopSignal); return true; } catch { return false; } };

  async function waitQuota(why) {
    for (let i = 0; i < maxQuotaWaits; i++) {
      flushAll();
      log({ type: 'pause', reason: `${why}：等 ${Math.round(quotaWaitMs / 60e3)} 分鐘再查額度（第 ${i + 1}/${maxQuotaWaits} 次）` });
      if (!(await nap(quotaWaitMs))) return 'signal';
      const u = await client.userInfo();
      const lim = Number(u.info?.api_request_limit_hour);
      if (u.ok && Number.isFinite(lim) && Number(u.info.user_count) < lim * QUOTA_RESUME_RATIO) return 'ok';
    }
    return 'timeout';
  }

  async function monitor() {
    const u = await client.userInfo();
    if (!u.ok) { log({ type: 'warn', msg: `user_info 查詢失敗（http=${u.http ?? '—'}），先繼續` }); return null; }
    if (u.level < MIN_LEVEL) return `level：方案等級 ${u.level} 低於 Sponsor（訂閱到期？）`;
    limiter?.setServerCap(u.info.api_request_limit_hour);
    const lim = Number(u.info.api_request_limit_hour);
    log({ type: 'quota', user_count: u.info.user_count, limit_hour: lim, local_last_hour: limiter?.inLastHour?.() ?? null });
    if (Number.isFinite(lim) && Number(u.info.user_count) >= lim * QUOTA_HIGH_RATIO) {
      const r = await waitQuota('伺服器用量接近每小時上限');
      if (r === 'signal') return 'signal';
      if (r === 'timeout') return 'quota：用量長時間未降';
    }
    return null;
  }

  async function beforeRequest(g) {
    if (stopSignal?.aborted) return 'signal';
    if (stats.requests >= maxRequests) return 'max-requests';
    let paused = false;
    // 重資料集（spec.heavy）在降速時段整段暫停（timewin.windowState 的 heavy 說明）
    const wo = g?.spec?.heavy ? { ...windowOpts, heavy: true } : windowOpts;
    for (let ms = msUntilOpen(now(), window, wo); ms > 0; ms = msUntilOpen(now(), window, wo)) {
      if (!paused) { flushAll(); log({ type: 'pause', reason: `時段窗（${window}${wo.heavy ? '・重資料集' : ''}）關閉，約 ${Math.round(ms / 60e3)} 分鐘後恢復` }); paused = true; }
      if (!(await nap(Math.min(ms, WINDOW_RECHECK_MS)))) return 'signal';
    }
    if (stats.requests >= nextMonitor) { nextMonitor = stats.requests + monitorEvery; return monitor(); }
    return null;
  }

  async function fetchMember(g, member, isProbe) {
    const job = { ...requestFor(g.spec, g, member, { route: g.route }), timeoutMs: g.spec.timeoutMs, label: `${g.dataset}/${g.group}/${member}` };
    for (let quotaRetries = 0; ; ) {
      try {
        const r = await client.fetchRows(job, () => makeSink(g));
        stats.requests += r.attempt; consecutive = 0; cov.clearFail(g, member);
        if (!r.rows && isProbe && g.date && daysBetween(g.date, todayIso) <= recentDays) return { notPublished: true };
        return { rows: r.rows, gz: r.result.gz, first: r.result.first };
      } catch (e) {
        stats.requests += e.attempts || 1;
        if (e.kind === 'aborted') return { stop: 'signal' };
        if (['auth', 'local', 'rate'].includes(e.kind)) return { stop: `${e.kind}：${e.message}` };
        if (e.kind === 'quota') {
          if (++quotaRetries > MAX_QUOTA_RETRIES) return { stop: `quota：同一請求連續 ${quotaRetries} 次 402` };
          const q = await waitQuota('HTTP 402 額度用完');
          if (q === 'ok') continue;
          return { stop: q === 'signal' ? 'signal' : 'quota：402 後等待逾時' };
        }
        stats.failures += 1; consecutive += 1; cov.fail(g, member, e);
        log({ type: 'fail', label: job.label, kind: e.kind, msg: e.message });
        if (consecutive >= maxConsecutiveFailures) return { stop: `consecutive-errors：連續 ${consecutive} 次失敗（最後 ${e.kind}：${e.message}）` };
        return { failed: true };
      }
    }
  }

  async function processGroup(g) {
    const paths = groupPaths(root, g.dataset, g.group, variantOf(g));
    if (g.replace) supersedeGroup(paths);   // 舊版搬到 _superseded/，不刪
    let og = null; let failed = 0;
    const openNow = () => { og = openGroup(paths); open.add(og); stats.groupsTouched += 1; };
    try {
      if (existsSync(paths.part)) openNow();   // 續抓：先驗證進行中的檔、略過已完成的成員
      let first = true;
      for (let i = 0; i < g.members.length; i++) {
        if (og?.done.has(g.members[i])) continue;
        const stop = await beforeRequest(g); if (stop) return stop;
        const r = await fetchMember(g, g.members[i], first && !(og?.rows > 0));   // 已有資料的群組不算「尚未更新」
        first = false;
        if (r.stop) return r.stop;
        if (r.notPublished) { stats.notPublished.push(`${g.dataset}/${g.group}`); log({ type: 'skip', reason: `${g.dataset} ${g.group} 第一個請求 0 列，視為尚未更新，下次再抓` }); return null; }
        if (r.failed) { failed += 1; continue; }
        if (!og) openNow();
        appendMember(og, g.members[i], r.gz, r.rows);
        cov.cols(g, r.first);
        stats.rows += r.rows; stats.gzBytes += r.gz?.length || 0; stats.members += 1;
        if (++sinceFlush >= flushEvery || now() - lastFlush >= flushMs) flushAll();
        if (stats.requests >= nextProgress) { nextProgress = stats.requests + PROGRESS_EVERY; log({ type: 'progress', ...progressOf() }); }
      }
      if (og && !failed) {
        finalizeGroup(og); open.delete(og);
        cov.setGroup(g, og, og.rows ? 'complete' : 'empty'); og = null;
        stats.groupsFinalized += 1;
        supersedeOlderRanges(g);
      }
      return null;
    } finally {
      if (og) { closeGroup(og); open.delete(og); cov.setGroup(g, og, 'partial'); }
    }
  }

  /**
   * 區間群組收尾後：同起點、終點不晚於本群組的舊區間檔（含沒收尾的 .part）搬到 _superseded/（不刪）。
   * 群組名帶終點（range_<起>_<迄>），--to 每往後一天就多一份涵蓋舊檔的新檔；不搬走的話，把目錄裡所有檔合併讀
   * 會重複計列（2026-10-09 審查：「續抓會不會重複」）。快照（snapshot_<日>）是刻意保留的版本歷史，不在此列。
   */
  function supersedeOlderRanges(g) {
    if (g.spec.mode !== 'range' || !g.range?.[1]) return;
    const variant = variantOf(g); const dir = datasetDir(root, g.dataset, variant);
    const [start, end] = g.range;
    const names = new Set();
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      const m = RANGE_FILE.exec(f);
      if (m && m[1] === start && m[2] !== end && m[2] <= end) names.add(`range_${m[1]}_${m[2]}`);
    }
    for (const name of names) {
      supersedeGroup(groupPaths(root, g.dataset, name, variant));
      cov.drop(g, name);
      log({ type: 'info', reason: `${g.dataset} ${name} 已被 ${g.group} 涵蓋：舊檔搬到 _superseded/（不刪）` });
    }
  }

  const progressOf = () => ({ requests: stats.requests, rows: stats.rows, gzBytes: stats.gzBytes, groupsFinalized: stats.groupsFinalized, failures: stats.failures });

  // afterMain（backfill 閘門標的 2023 以前群組）：同一資料集本次有 main 群組沒收尾（失敗、尚未更新）就不跑——空閒佇列只在主佇列完成後才開始
  const mainOpen = new Set(); const heldBack = new Map();
  try {
    for (const g of groups) {
      if (g.afterMain && mainOpen.has(g.dataset)) { heldBack.set(g.dataset, (heldBack.get(g.dataset) || 0) + 1); continue; }
      const before = stats.groupsFinalized;
      const stop = await processGroup(g);
      if (stop) { stats.stopReason = stop; break; }
      if (g.phase === 'main' && stats.groupsFinalized === before) mainOpen.add(g.dataset);
    }
    for (const [ds, n] of heldBack) log({ type: 'skip', reason: `${ds} 本次主佇列（2023 起）有群組沒收尾，2023 以前的 ${n} 個群組先不跑` });
    stats.heldBack = Object.fromEntries(heldBack);
  } finally {
    flushAll();
    stats.finishedAt = iso(now());
    stats.stopReason ||= 'done';
  }
  return stats;
}
