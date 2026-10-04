#!/usr/bin/env node
// ── 起漲研究·官方資料回補（只用上市／上櫃官網；寫本機研究快取，不寫 Firestore）──────────────
// 依 .claude/skills/tw-official-data-sources 的規範：每個資料集一支帶日期的官方端點，回應的資料日必須回聲等於請求日，
// 原始表格（fields＋data）gzip 存 .surge-cache/official/{資料集}/{日}.json.gz，之後由 python 重新解析——抓一次、可重算。
//
// 防呆（同一個 IP 也是站上 daemon 的出口，被官網封鎖會打斷站上即時資料）：
//   · 每台主機一條佇列、逐請求間隔（預設與下限 3 秒）＋隨機抖動；上市與上櫃兩台主機並行
//   · 平日 07:30～15:30（台北）不跑（避開盤前、盤中、收盤歸檔）；--force-hours 才放行
//   · HTTP 403／429 或連續 5 次失敗 ⇒ 該主機整條停止；回聲不符或非交易日 ⇒ 記 .skip.json，不重抓
//   · 斷點續傳：已存在的檔案跳過
// 用法：node scripts/surge-lab/official_backfill.mjs --dates <日期清單.json> [--only a,b] [--gap 2500] [--cache <目錄>] [--limit N] [--dry-run]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ADAPTERS } from './official_adapters.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_CONSEC_FAIL = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const a = { dates: null, only: null, gap: 3000, cache: process.env.SURGE_CACHE || join(HERE, '.surge-cache'), limit: Infinity, dryRun: false, forceHours: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dates') a.dates = argv[++i];
    else if (k === '--only') a.only = argv[++i].split(',');
    else if (k === '--gap') a.gap = Math.max(3000, Number(argv[++i]))   // 技能 tw-official-data-sources：同一出口 IP 逐請求 ≥3 秒;
    else if (k === '--cache') a.cache = argv[++i];
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--force-hours') a.forceHours = true;
    else throw new Error(`未知參數：${k}`);
  }
  if (!a.dates) throw new Error('需要 --dates <日期清單.json>（["2022-07-18", ...]）');
  return a;
}

/** 平日 07:30～15:30（台北）不跑：盤前試撮、盤中、收盤歸檔都在這段，daemon 正在用同一個出口打官網。 */
export function inQuietWindow(now = new Date()) {
  const tw = new Date(now.getTime() + 8 * 3600e3);
  const dow = tw.getUTCDay(); const m = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  return dow >= 1 && dow <= 5 && m >= 7 * 60 + 30 && m < 15 * 60 + 30;
}

async function fetchJson(url, referer) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...(referer ? { Referer: referer } : {}) }, signal: AbortSignal.timeout(30000) });
  if (r.status === 403 || r.status === 429) { const e = new Error(`HTTP ${r.status}`); e.fatal = true; throw e; }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`非 JSON 回應（${text.slice(0, 60).replace(/\s+/g, ' ')}）`); }
}

function paths(cache, name, day) {
  const dir = join(cache, 'official', name);
  return { dir, ok: join(dir, `${day}.json.gz`), skip: join(dir, `${day}.skip.json`) };
}

async function runQueue(host, jobs, a, stats) {
  let consec = 0;
  for (const { ad, day } of jobs) {
    if (!a.forceHours && inQuietWindow()) { console.log(`[${host}] 進入平日 07:30～15:30，停止（續跑會從斷點接上）`); return; }
    const p = paths(a.cache, ad.name, day);
    try {
      const j = await fetchJson(ad.url(day), ad.referer);
      const v = ad.validate(j, day);
      if (!v.ok) { writeFileSync(p.skip, JSON.stringify({ day, reason: v.reason })); stats[ad.name].skip++; }
      else { writeFileSync(p.ok, gzipSync(JSON.stringify({ day, source: ad.url(day), raw: v.tables }))); stats[ad.name].ok++; }
      consec = 0;
    } catch (e) {
      stats[ad.name].fail++; consec++;
      console.log(`[${host}] ✖ ${ad.name} ${day}：${e.message}`);
      if (e.fatal || consec >= MAX_CONSEC_FAIL) { console.log(`[${host}] ${e.fatal ? '被拒絕' : `連續失敗 ${consec} 次`}——整條佇列停止`); return; }
      await sleep(a.gap * 4);
    }
    const done = stats[ad.name].ok + stats[ad.name].skip;
    if (done % 50 === 0) console.log(`[${host}] ${ad.name} ${done} 日（至 ${day}）`);
    await sleep(a.gap + Math.floor(Math.random() * 600));
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const days = JSON.parse(readFileSync(a.dates, 'utf8')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const ads = ADAPTERS.filter(ad => !a.only || a.only.includes(ad.name));
  const perAd = new Map(); const stats = {};
  for (const ad of ads) {
    stats[ad.name] = { ok: 0, skip: 0, fail: 0 };
    mkdirSync(paths(a.cache, ad.name, 'x').dir, { recursive: true });
    const todo = days.filter(d => d >= ad.from).filter(d => { const p = paths(a.cache, ad.name, d); return !existsSync(p.ok) && !existsSync(p.skip); }).slice(0, a.limit);
    perAd.set(ad, todo);
    console.log(`${ad.name}（${ad.host}）：待抓 ${todo.length} 日`);
  }
  // 同一主機內各資料集輪流（round-robin），讓單一端點的請求更稀疏
  const byHost = new Map();
  for (const host of new Set(ads.map(ad => ad.host))) {
    const lists = ads.filter(ad => ad.host === host).map(ad => perAd.get(ad).map(day => ({ ad, day })));
    const q = [];
    for (let i = 0; i < Math.max(0, ...lists.map(l => l.length)); i++) for (const l of lists) if (i < l.length) q.push(l[i]);
    byHost.set(host, q);
  }
  if (a.dryRun) { console.log('--dry-run：不送出請求'); return; }
  await Promise.all([...byHost.entries()].map(([host, jobs]) => runQueue(host, jobs, a, stats)));
  console.log('完成：', JSON.stringify(stats));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().then(() => process.exit(0), e => { console.error('✖', e.message); process.exit(1); });
