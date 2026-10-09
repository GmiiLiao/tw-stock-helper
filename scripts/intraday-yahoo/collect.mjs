#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Yahoo 個股 1／5／60 分K 原始資料收集（研究用·非官方）——2026-10-08 使用者核可
//
// 為什麼要每天抓：Yahoo 只保留 1 分K 近 30 日、5 分K 近 60 個交易日、60 分K 近 730 個交易日（2026-10-08 實測），
//   過期就永久消失；要有歷史只能從現在起每天累積。既有 scripts/archive-intraday.mjs（Firestore intradayArchive）
//   只存 5 分K 的 15 分鐘取樣點、量≥300 張；本程式存三種週期的完整原始 K 棒、全部有成交的上市櫃股票，存本機第二大腦。
//
// ⚠ 資料品質（實測）：價格路徑可用；成交量少計且逐日逐檔亂跳（5 分K 加總÷官方日量 0.66~1.21）；
//   沒有 13:30 收盤集合競價那根（60 分K 末根收盤 vs 官方收盤差>0.3% 約半數日）；偶有整日缺。
//   ⇒ 量與收盤一律用官方日資料；tw-official-data-sources 規定非官方來源不得進正式訓練，本資料只供實驗。
//
// 存放：second-brain/intraday-yahoo/{1m,5m,60m}/{YYYY-MM}/{YYYY-MM-DD}.json.gz（每日一檔、全部股票、gzip）
//   每檔 codes[code] = { t:[台北分鐘數], o,h,l,c:[價], v:[量(股)] }；只補不蓋——已有且較完整的不覆寫。
//   _coverage.json 各週期逐日覆蓋率（分母＝官方當日有成交者）；_alerts.json 即將過期仍有缺口、或被限流中止。
//
// 用法：node scripts/intraday-yahoo/collect.mjs [--backfill] [--only 1m,5m,60m] [--codes 2330,2059] [--force]
//   每日：1m 抓近 8 日、5m/60m 抓近 10 日（重疊即補洞）；某週期還沒有任何資料時自動改回補模式。
//   --backfill：1m 30 日（分 4 段）、5m 60 日、60m 730 日。
//   平日 07:30–14:00 拒跑（盤中不搶出口頻寬、當日 K 未收齊），--force 可略過。
// 節流：2 條工作線、每條每請求間隔 250ms；429 退避 30/60/120 秒，連續 3 次即中止並寫 _alerts。
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = process.env.INTRADAY_OUT || join(REPO, 'second-brain', 'intraday-yahoo');   // 測試時可改寫到暫存目錄
const PY = existsSync('/Library/Frameworks/Python.framework/Versions/3.14/bin/python3') ? '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3' : 'python3';
const Y = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Referer: 'https://finance.yahoo.com/' };
const WORKERS = 2, PACE_MS = 250, TIMEOUT_MS = 20000;
const BACKOFF_MS = [30000, 60000, 120000];
const DAY = 86400;
const REPAIR_CAP = 300;            // 每次補洞請求上限
const ALERT_RATIO = 0.97, ALERT_LEFT = 5;
const NODATA_DAYS = 7;
const CLOSE_MIN = 13 * 60 + 30;

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const FORCE = flag('--force');
const ONLY = (opt('--only') || '1m,5m,60m').split(',');
const CODES = opt('--codes')?.split(',') || null;

// 每種週期：保留期限（retention）、完整判定（末根分鐘數）、每日／回補抓取窗
const IV = {
  '1m': { keepCal: 30, lastMin: 13 * 60 + 20,
    daily: () => [{ p1: now() - 7.9 * DAY, p2: now() }],
    backfill: () => [[29.8, 22], [22, 14.1], [14.1, 6.2], [6.2, 0]].map(([a, b]) => ({ p1: now() - a * DAY, p2: now() - b * DAY })) },
  '5m': { keepTrading: 60, lastMin: 13 * 60 + 20, daily: () => [{ range: '10d' }], backfill: () => [{ range: '60d' }] },
  '60m': { keepTrading: 730, lastMin: 13 * 60, daily: () => [{ range: '10d' }], backfill: () => [{ range: '730d' }] },
};

const now = () => Math.floor(Date.now() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const twDate = ts => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const twMin = ts => { const [h, m] = new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }).split(':'); return +h * 60 + +m; };
const r2 = x => Math.round(x * 100) / 100;
const log = (...a) => console.log(new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei' }), ...a);

function writeAtomic(path, buf) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.tmp${process.pid}`; writeFileSync(tmp, buf); renameSync(tmp, path); }
const writeJson = (path, obj) => writeAtomic(path, JSON.stringify(obj, null, 1));
const readJson = (path, dflt) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return dflt; } };
const dayPath = (iv, d) => join(OUT, iv, d.slice(0, 7), `${d}.json.gz`);
const readDay = (iv, d) => { const p = dayPath(iv, d); return existsSync(p) ? JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')) : null; };
const listDays = iv => { const base = join(OUT, iv); if (!existsSync(base)) return []; return readdirSync(base).filter(m => /^\d{4}-\d{2}$/.test(m)).flatMap(m => readdirSync(join(base, m)).filter(f => f.endsWith('.json.gz')).map(f => f.slice(0, 10))).sort(); };

// ── 抓取（熔斷：連續 3 次 429 退避後仍 429 → 中止）──
let consec429 = 0, aborted = null, nReq = 0, nErr = 0;
async function fetchChart(sym, interval, w) {
  const q = w.range ? `range=${w.range}` : `period1=${Math.floor(w.p1)}&period2=${Math.floor(w.p2)}`;
  const url = `${Y}${encodeURIComponent(sym)}?interval=${interval}&${q}&includePrePost=false`;
  for (let a = 0; a < 3; a++) {
    if (aborted) return { err: 'aborted' };
    nReq++;
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.status === 429) {
        consec429++;
        if (consec429 > BACKOFF_MS.length) { aborted = `Yahoo 限流（連續 ${consec429} 次 429）`; return { err: aborted }; }
        log(`  429 退避 ${BACKOFF_MS[consec429 - 1] / 1000}s（${sym} ${interval}）`); await sleep(BACKOFF_MS[consec429 - 1]); continue;
      }
      consec429 = 0;
      if (r.status === 404) return { notFound: true };
      const j = await r.json().catch(() => null);
      const res = j?.chart?.result?.[0];
      if (r.ok && res) return { res };
      if (r.ok || r.status === 422) return { empty: true, why: j?.chart?.error?.description || `HTTP ${r.status}` };
      if (r.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      return { err: `HTTP ${r.status}` };
    } catch (e) { await sleep(1500 * (a + 1)); if (a === 2) { nErr++; return { err: e.message }; } }
  }
  nErr++; return { err: 'retries exhausted' };
}

/** chart 結果 → { 日期: {t,o,h,l,c,v} }；只收「已收盤」的日子（今日需 14:00 後） */
function digest(res) {
  const ts = res.timestamp || [], q = res.indicators?.quote?.[0] || {};
  const today = twDate(now()), afterClose = twMin(now()) >= 14 * 60;
  const by = {};
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (!(c > 0)) continue;
    const d = twDate(ts[i]), mi = twMin(ts[i]);
    if (d > today || (d === today && !afterClose)) continue;
    if (mi >= CLOSE_MIN) continue;      // 當日收集才有的 13:30 現價點（O=H=L=C、量 0），隔日再抓就沒有 → 不收，維持各日根數口徑一致
    const b = (by[d] ||= { t: [], o: [], h: [], l: [], c: [], v: [] });
    b.t.push(mi); b.o.push(r2(q.open?.[i] ?? c)); b.h.push(r2(q.high?.[i] ?? c)); b.l.push(r2(q.low?.[i] ?? c)); b.c.push(r2(c)); b.v.push(q.volume?.[i] ?? 0);
  }
  return by;
}

// ── 合併寫檔：只補不蓋（新的根數較多或末根較晚才取代）──
// 2026-10-08 修正：舊規則「末根較晚也取代」+ 回補分段在盤中切開 → 10-02 有 1,306 檔被 13:22 後的兩分鐘碎片蓋掉整天
const better = (nw, old) => !old || nw.t.length > old.t.length;
/** 同一次執行內、跨抓取窗的同日 K 棒以分鐘聯集合併（後到的同分鐘值覆寫） */
function unionBars(a, b) {
  const m = new Map();
  for (const x of [a, b]) x.t.forEach((t, i) => m.set(t, [x.o[i], x.h[i], x.l[i], x.c[i], x.v[i]]));
  const ts = [...m.keys()].sort((p, q) => p - q), out = { t: ts, o: [], h: [], l: [], c: [], v: [] };
  for (const t of ts) { const [o, h, l, c, v] = m.get(t); out.o.push(o); out.h.push(h); out.l.push(l); out.c.push(c); out.v.push(v); }
  return out;
}
function flush(iv, pending) {
  let wrote = 0, added = 0;
  for (const [d, m] of Object.entries(pending)) {
    const cur = readDay(iv, d) || { schema: 'intraday-yahoo/1', date: d, interval: iv, tz: 'Asia/Taipei', official: false,
      source: 'Yahoo Finance chart v8（非官方·研究用）', note: '價格路徑可用；成交量少計且逐日逐檔不一、無 13:30 收盤集合競價根——量與收盤請用官方日資料', codes: {} };
    let ch = 0;
    for (const [code, bars] of Object.entries(m)) if (better(bars, cur.codes[code])) { cur.codes[code] = bars; ch++; }
    if (!ch) continue;
    cur.updated = new Date().toISOString(); cur.n = Object.keys(cur.codes).length;
    writeAtomic(dayPath(iv, d), gzipSync(JSON.stringify(cur))); wrote++; added += ch;
  }
  return { wrote, added };
}

async function runPool(items, fn) {
  let k = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (k < items.length && !aborted) { const it = items[k++]; await fn(it); await sleep(PACE_MS); }
  }));
}

/** 抓一批（代號×抓取窗），每 300 檔落盤一次控制記憶體 */
async function collect(iv, codes, windows, suffix, stat) {
  let pending = {}, since = 0, done = 0;
  const t0 = Date.now();
  await runPool(codes, async code => {
    for (const w of windows) {
      // 已知市場：只在 404（代號不存在，可能轉市場）時換後綴；未知市場：.TW 沒資料就試 .TWO
      let sfx = suffix[code] || '.TW', r = await fetchChart(code + sfx, iv, w);
      if (r.notFound || (r.empty && !suffix[code])) { await sleep(PACE_MS); sfx = sfx === '.TW' ? '.TWO' : '.TW'; r = await fetchChart(code + sfx, iv, w); }
      if (r.res) { suffix[code] = sfx; for (const [d, b] of Object.entries(digest(r.res))) { const P = (pending[d] ||= {}); P[code] = P[code] ? unionBars(P[code], b) : b; } stat.ok++; }
      else if (r.notFound || r.empty) stat.empty.add(code); else stat.err.add(code);
    }
    done++; since++;
    if (since >= (iv === '1m' ? 150 : 300)) { const f = flush(iv, pending); stat.files += f.wrote; pending = {}; since = 0; }
    if (done % 500 === 0) log(`  ${iv} ${done}/${codes.length}｜${Math.round((Date.now() - t0) / 1000)}s`);
  });
  const f = flush(iv, pending); stat.files += f.wrote;
}

// ── 覆蓋率（分母＝官方當日有成交者）──
function coverage(iv, expected, tradingDays) {
  const rows = [];
  const today = twDate(now());
  for (const d of Object.keys(expected).sort()) {
    const exp = expected[d], f = readDay(iv, d);
    if (IV[iv].keepCal && (Date.parse(today) - Date.parse(d)) / 864e5 >= IV[iv].keepCal) continue;   // 已過 Yahoo 保留期：補不回來，不列不警示
    const idx = tradingDays.indexOf(d);
    if (IV[iv].keepTrading && idx >= 0 && tradingDays.length - idx >= IV[iv].keepTrading) continue;
    const have = f ? exp.filter(c => f.codes[c]) : [];
    const missing = exp.filter(c => !f?.codes[c]);
    // 剩幾天會從 Yahoo 消失
    const left = IV[iv].keepCal ? IV[iv].keepCal - Math.round((Date.parse(today) - Date.parse(d)) / 864e5) : IV[iv].keepTrading - (tradingDays.length - idx);
    rows.push({ day: d, expected: exp.length, have: have.length, ratio: exp.length ? +(have.length / exp.length).toFixed(4) : null, left, missingCount: missing.length, missing: missing.slice(0, 40) });
  }
  return rows;
}

async function main() {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const mins = tw.getHours() * 60 + tw.getMinutes(), wd = tw.getDay();
  if (!FORCE && wd >= 1 && wd <= 5 && mins >= 7 * 60 + 30 && mins < 14 * 60) { console.log('平日 07:30–14:00 不跑（盤中保留出口頻寬、當日 K 未收齊）；要強制請加 --force'); process.exit(0); }
  mkdirSync(OUT, { recursive: true });
  const LOCK = join(OUT, '.lock');
  if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > 4 * 3600e3) rmdirSync(LOCK);
  try { mkdirSync(LOCK); } catch { console.log('已有執行中（.lock）'); process.exit(0); }
  const release = () => { try { rmdirSync(LOCK); } catch { /* 已釋放 */ } };
  process.on('exit', release);

  const u = spawnSync(PY, [join(HERE, 'universe.py')], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (u.status !== 0) { console.error('universe.py 失敗：', u.stderr); process.exit(1); }
  const U = JSON.parse(u.stdout);
  const suffixPath = join(OUT, '_suffix.json');
  const suffix = readJson(suffixPath, {});
  const noDataPath = join(OUT, '_noData.json'), noData = readJson(noDataPath, {});   // Yahoo 回空的代號 → 7 日內不再補洞
  for (const [c, m] of Object.entries(U.market)) if (m && !suffix[c]) suffix[c] = m === 'otc' ? '.TWO' : '.TW';
  const codes = CODES || U.active;
  const tradingDays = Object.keys(U.expected).sort();
  log(`▶ Yahoo 分K 收集｜宇宙 ${codes.length} 檔（官方最後資料日 ${U.panelLastDay}）｜週期 ${ONLY.join('/')}${flag('--backfill') ? '｜回補' : ''}`);

  const run = { start: new Date().toISOString(), mode: flag('--backfill') ? 'backfill' : 'daily', universe: codes.length, panelLastDay: U.panelLastDay, intervals: {} };
  for (const iv of ONLY) {
    if (!IV[iv]) { console.error('未知週期', iv); continue; }
    const back = flag('--backfill') || listDays(iv).length === 0;
    const stat = { ok: 0, files: 0, empty: new Set(), err: new Set() };
    const t0 = Date.now();
    log(`── ${iv}：${back ? '回補' : '每日增量'}`);
    await collect(iv, codes, back ? IV[iv].backfill() : IV[iv].daily(), suffix, stat);
    // 補洞：保留期內官方有成交、本地沒有的（排除本輪 Yahoo 回空的代號），限 REPAIR_CAP 次
    let repaired = 0;
    if (!aborted && !CODES) {
      const cov = coverage(iv, U.expected, tradingDays);
      const skip = c => stat.empty.has(c) || (noData[c] && Date.now() - Date.parse(noData[c]) < NODATA_DAYS * 864e5);
      const need = [...new Set(cov.filter(r => r.missingCount > 0).flatMap(r => r.missing))].filter(c => !skip(c));
      if (need.length) {
        const todo = need.slice(0, Math.floor(REPAIR_CAP / IV[iv].backfill().length));
        log(`  補洞 ${todo.length} 檔（缺口代號共 ${need.length}）`);
        await collect(iv, todo, IV[iv].backfill(), suffix, stat); repaired = todo.length;
      }
    }
    run.intervals[iv] = { mode: back ? 'backfill' : 'daily', ok: stat.ok, filesWritten: stat.files, yahooEmpty: stat.empty.size, errors: stat.err.size, errorCodes: [...stat.err].slice(0, 30), repaired, sec: Math.round((Date.now() - t0) / 1000), days: listDays(iv).length };
    log(`  ${iv} 完成：成功 ${stat.ok}、Yahoo 無資料 ${stat.empty.size}、錯誤 ${stat.err.size}、寫檔 ${stat.files}、本地共 ${listDays(iv).length} 日、${run.intervals[iv].sec}s`);
    for (const c of stat.empty) noData[c] = new Date().toISOString();
    for (const c of Object.keys(noData)) if (Date.now() - Date.parse(noData[c]) >= NODATA_DAYS * 864e5) delete noData[c];
    writeJson(suffixPath, suffix); writeJson(noDataPath, noData);
    if (aborted) break;
  }

  // 覆蓋率與警示
  const covAll = {}, alerts = [];
  for (const iv of Object.keys(IV)) {
    covAll[iv] = coverage(iv, U.expected, tradingDays);
    for (const r of covAll[iv]) {
      if (r.ratio !== null && r.ratio < ALERT_RATIO && r.left <= ALERT_LEFT)
        alerts.push({ level: 'critical', interval: iv, day: r.day, ratio: r.ratio, missingCount: r.missingCount, left: r.left, msg: `${iv} ${r.day} 覆蓋率 ${(r.ratio * 100).toFixed(1)}%（缺 ${r.missingCount} 檔），約 ${r.left} 天後 Yahoo 端過期就補不回來` });
    }
  }
  if (aborted) alerts.push({ level: 'critical', msg: `本輪中止：${aborted}；已收部分已落盤，下一輪會接著補` });
  run.end = new Date().toISOString(); run.requests = nReq; run.aborted = aborted;
  writeJson(join(OUT, '_coverage.json'), { built: run.end, panelLastDay: U.panelLastDay, note: '分母＝官方當日有成交（panel.npz V>0）；只列 Yahoo 保留期內的日子', intervals: covAll });
  writeJson(join(OUT, '_alerts.json'), { built: run.end, alerts });
  writeJson(join(OUT, '_runs', `${run.start.slice(0, 10)}_${run.start.slice(11, 19).replace(/:/g, '')}.json`), run);
  for (const iv of Object.keys(IV)) {
    const c = covAll[iv].filter(r => r.ratio !== null), worst = c.slice().sort((a, b) => a.ratio - b.ratio)[0];
    if (c.length) log(`覆蓋率 ${iv}：${c.length} 日、最低 ${worst.day} ${(worst.ratio * 100).toFixed(1)}%、最新 ${c.at(-1).day} ${(c.at(-1).ratio * 100).toFixed(1)}%`);
  }
  log(`✓ 結束｜請求 ${nReq}｜警示 ${alerts.length}${aborted ? `｜中止：${aborted}` : ''}`);
  process.exit(aborted ? 2 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
