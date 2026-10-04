#!/usr/bin/env node
// ── 月營收零網路回補：第二大腦官方鏡像（MOPS t21sc03 _0／_1）→ Firestore revenueArchive（2026-10-04）──────
//
// 為什麼：舊回補器只抓 _0（本國），外國公司（-KY／DR）在 _1 ⇒ 歸檔每月缺上市 KY 78~93 檔、上櫃 KY 27~30 檔；
//   舊版「≥1700 檔就永久略過」又讓 2026-07／08 漏了次月 10 日後才上表的金控／保險等 17~22 檔。
//   鏡像（second-brain/official/mopsov.twse.com.tw/mops_t21sc03{,_ky}）已有 2022-06 起的原頁，可零網路補。
//
// 規則（使用者／協調者裁定 2026-10-04）：
//   · 只動「既有」月份（--from 預設 2023-08 起，不建新月份、不改研究基期）；鏡像頁未定版（final:false，例 2026-09）的月份整月略過。
//   · 既有列一律不動（只補缺：KY 列、--domestic-gaps 時加上歸檔沒有的本國代號）；
//     唯一例外 --fix-fabricated-zero：歸檔是 0 而官方頁同代號該格留白 ⇒ 改 null（逐檔列出）。
//   · 每頁都驗回音（市場＋民國年＋月＋本國／外國表尾）；鏡像缺頁（例 2026-03 上市 _0／_1 內容過短）⇒ 照補其他頁、標 final:false 並列報。
//   · 合併後筆數 < 既有、或 rowsJson > 900,000 bytes ⇒ 拒寫。寫入用 update＋lastUpdateTime 前置條件（daemon 同時改寫就放棄這個月）。
//   · 定版看資料：只有「4 頁皆可用且含本國補缺（--domestic-gaps）」的鏡像觀測才記入 fetchLog；
//     單一觀測不定版——要等 daemon／backfill-mops-revenue 在 ≥3 日後再抓一次、筆數沒增加才定版。
//
// 用法（預設 dry-run，只讀 Firestore）：
//   GOOGLE_APPLICATION_CREDENTIALS=<daemon plist 的憑證路徑> node scripts/backfill-revenue-from-mirror.mjs \
//     [--domestic-gaps] [--fix-fabricated-zero] [--from 2023-08] [--to YYYY-MM] [--out report.json] [--write]
//   鏡像根目錄：OFFICIAL_ROOT（預設 <repo>/second-brain/official）。
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as C from './lib/official-mirror.mjs';
import {
  T21_PAGES, parseT21sc03, echoOk, t21Echo, combinePages, mergeRows, composition, rowsOf, appendFetchLog,
  revenueFinal, fixFabricatedZeros, isOpenapiDoc, REV_DOC_VERSION, MAX_DOC_BYTES,
} from './lib/mops-revenue.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'mopsov.twse.com.tw';
const DATASET = { 0: 'mops_t21sc03', 1: 'mops_t21sc03_ky' };

export function parseArgs(argv) {
  const a = { write: false, domesticGaps: false, fixZero: false, from: '2023-08', to: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--write') a.write = true; else if (k === '--dry-run') a.write = false;
    else if (k === '--domestic-gaps') a.domesticGaps = true; else if (k === '--fix-fabricated-zero') a.fixZero = true;
    else if (k === '--from') a.from = argv[++i]; else if (k === '--to') a.to = argv[++i]; else if (k === '--out') a.out = argv[++i];
    else throw new Error(`未知參數：${k}`);
  }
  for (const [k, v] of [['--from', a.from], ['--to', a.to]]) if (v != null && !/^\d{4}-\d{2}$/.test(v)) throw new Error(`${k} 要是 YYYY-MM：${v}`);
  return a;
}

/** 讀鏡像一頁：{state: ok|nonfinal|missing|echo, rows, at(ms), note}。只讀本機檔、0 請求。 */
export function loadMirrorPage(root, mans, id, p) {
  const key = `${id}.${p.mkt}`; const row = mans[p.page].rows?.[key];
  if (!row || row.status !== 'ok' || !row.file) return { state: 'missing', note: row ? `${row.status}${row.note ? `·${row.note}` : ''}` : '鏡像未抓' };
  if (row.final === false) return { state: 'nonfinal', note: '鏡像未定版' };
  let html;
  try { html = C.decodeBody(C.readEntry(root, HOST, DATASET[p.page], row.file), 'big5'); }
  catch (e) { return { state: 'missing', note: `讀檔失敗 ${e.message}` }; }
  const [y, m] = id.split('-').map(Number);
  if (!echoOk(html, p.mkt, y - 1911, m, p.page)) return { state: 'echo', note: `回音不符 ${JSON.stringify(t21Echo(html))}` };
  const at = Date.parse(row.at);
  return { state: 'ok', rows: parseT21sc03(html), at: Number.isFinite(at) ? at : null };
}

/**
 * 一個月的計畫（純計算，不寫）：回傳 { action: write|skip|refuse, reason, doc, report }。
 * old：既有 revenueArchive 文件資料；pages：T21_PAGES 順序的 loadMirrorPage 結果。
 */
export function planMonth(id, old, pages, { domesticGaps, fixZero, now = Date.now() }) {
  const report = { id, oldN: old?.n ?? null, pages: Object.fromEntries(T21_PAGES.map((p, i) => [p.label, pages[i].state === 'ok' ? pages[i].rows.length : `${pages[i].state}（${pages[i].note}）`])) };
  if (pages.some(p => p.state === 'nonfinal')) return { action: 'skip', reason: '鏡像頁未定版（整月略過）', report };
  if (isOpenapiDoc(old)) return { action: 'refuse', reason: '既有文件是 openapi 薄版（混未上市 _P）——改用 backfill-mops-revenue.mjs 整份重抓', report };
  let oldRows;
  try { oldRows = rowsOf(old); } catch (e) { return { action: 'refuse', reason: `既有 rowsJson 無法解析（${e.message}）`, report }; }
  const ok = T21_PAGES.map((p, i) => ({ ...p, ...pages[i] })).filter(p => p.state === 'ok');
  const { rows: official, srcOf, dup } = combinePages(ok);
  const officialBy = new Map(official.map(r => [String(r.c), r]));
  const oldCodes = new Set(oldRows.map(r => String(r.c)));
  const want = official.filter(r => srcOf.get(String(r.c)).endsWith('KY') || domesticGaps);
  let merged = mergeRows(oldRows, want, { override: false });
  const added = merged.filter(r => !oldCodes.has(String(r.c)));
  const addBy = Object.fromEntries(T21_PAGES.map(p => [p.label, added.filter(r => srcOf.get(String(r.c)) === p.label).map(r => String(r.c))]));
  let fixed = { yoy: [], mom: [] };
  if (fixZero) { const f = fixFabricatedZeros(merged, officialBy); merged = f.rows; fixed = { yoy: f.yoy, mom: f.mom }; }
  const allPages = ok.length === T21_PAGES.length;
  const retained = merged.filter(r => !officialBy.has(String(r.c))).map(r => String(r.c));
  const rowsJson = JSON.stringify(merged); const bytes = Buffer.byteLength(rowsJson);
  const { bySrc, kyN } = composition(merged, srcOf);
  Object.assign(report, { newN: merged.length, add: addBy, fixYoy: fixed.yoy, fixMom: fixed.mom, retained, dup, bytes, kyN, bySrc, allPages });
  const oldN = old?.n ?? oldRows.length;
  if (merged.length < oldN) return { action: 'refuse', reason: `合併後 ${merged.length} < 既有 ${oldN}`, report };
  if (bytes > MAX_DOC_BYTES) return { action: 'refuse', reason: `rowsJson ${bytes} bytes > ${MAX_DOC_BYTES}`, report };
  const changed = added.length || fixed.yoy.length || fixed.mom.length;
  // 鏡像觀測算一次「抓取」的條件：4 頁皆可用，且文件已與 4 頁聯集（含本國補缺）——否則不是完整觀測
  const pageAts = ok.map(p => p.at).filter(Number.isFinite);
  const obsAt = allPages && domesticGaps && pageAts.length === T21_PAGES.length ? Math.max(...pageAts) : null;
  const oldLog = Array.isArray(old?.fetchLog) ? old.fetchLog : [];
  const already = obsAt != null && oldLog.some(e => e?.src === 'mirror' && Number(e.at) === obsAt);   // 重跑不重複記同一次鏡像觀測
  const fetchLog = obsAt != null && !already ? appendFetchLog(oldLog, { at: obsAt, n: merged.length, src: 'mirror' }, { monthId: id }) : oldLog;
  const final = allPages && revenueFinal(id, fetchLog);
  Object.assign(report, { final, observed: obsAt != null });
  if (!changed && Number(old?.v) >= REV_DOC_VERSION && (obsAt == null || already)) return { action: 'skip', reason: '無變更（已是 v2）', report };
  const doc = { n: merged.length, rowsJson, bytes, bySrc, kyN, fetchLog, final, v: REV_DOC_VERSION, at: now,
    pages: Object.fromEntries(Object.entries(report.pages).map(([k, v]) => [k, typeof v === 'number' ? v : `鏡像 ${v}`])) };
  return { action: 'write', reason: allPages ? '' : '有頁缺（final:false）', doc, report };
}

let _db = null;
function getDb() {
  if (_db) return _db;
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;   // 憑證只走環境變數（同 surge-lab/fetch_cache.mjs），不寫死路徑
  if (!getApps().length) initializeApp(credPath ? { credential: cert(JSON.parse(readFileSync(credPath, 'utf8'))) } : {});
  _db = getFirestore();
  return _db;
}

const short = (list, k = 12) => (list.length ? `${list.slice(0, k).join(',')}${list.length > k ? `…(+${list.length - k})` : ''}` : '');

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const root = process.env.OFFICIAL_ROOT || join(REPO, 'second-brain', 'official');
  const mans = { 0: C.loadManifest(root, HOST, DATASET[0]), 1: C.loadManifest(root, HOST, DATASET[1]) };
  if (!Object.keys(mans[0].rows || {}).length || !Object.keys(mans[1].rows || {}).length) throw new Error(`鏡像清單是空的：${root}/${HOST}/{${DATASET[0]},${DATASET[1]}}/_manifest.json（設 OFFICIAL_ROOT）`);
  console.log(`${a.write ? '寫入' : 'dry-run（不寫）'}｜鏡像 ${root}｜${a.from} ~ ${a.to || '最新'}｜補 KY${a.domesticGaps ? '＋本國缺漏' : ''}${a.fixZero ? '＋修捏造 0' : ''}`);

  const db = getDb();
  const snap = await db.collection('revenueArchive').get();
  const docs = snap.docs.filter(d => /^\d{4}-\d{2}$/.test(d.id) && d.id >= a.from && (!a.to || d.id <= a.to)).sort((x, y) => (x.id < y.id ? -1 : 1));
  const reports = []; let maxBytes = 0; let maxId = null; const tot = { write: 0, skip: 0, refuse: 0, ky: 0, dom: 0, fixY: 0, fixM: 0 };
  for (const d of docs) {
    const pages = T21_PAGES.map(p => loadMirrorPage(root, mans, d.id, p));
    const plan = planMonth(d.id, d.data(), pages, { domesticGaps: a.domesticGaps, fixZero: a.fixZero });
    const r = plan.report; reports.push({ action: plan.action, reason: plan.reason, ...r });
    tot[plan.action]++;
    if (plan.action !== 'write') { console.log(`${plan.action === 'skip' ? '·' : '✗'} ${d.id} ${plan.action}：${plan.reason}｜頁 ${JSON.stringify(r.pages)}`); continue; }
    const ky = r.add['上市KY'].length + r.add['上櫃KY'].length; const dom = r.add['上市'].length + r.add['上櫃'].length;
    tot.ky += ky; tot.dom += dom; tot.fixY += r.fixYoy.length; tot.fixM += r.fixMom.length;
    if (r.bytes > maxBytes) { maxBytes = r.bytes; maxId = d.id; }
    console.log(`${a.write ? '✓' : '→'} ${d.id}：${r.oldN} → ${r.newN}（+KY 上市 ${r.add['上市KY'].length}／上櫃 ${r.add['上櫃KY'].length}`
      + `${a.domesticGaps ? `｜+本國 上市 ${r.add['上市'].length} [${short(r.add['上市'])}]／上櫃 ${r.add['上櫃'].length} [${short(r.add['上櫃'])}]` : ''}）`
      + `${a.fixZero ? `｜修 0→null yoy ${r.fixYoy.length} [${short(r.fixYoy, 8)}] mom ${r.fixMom.length} [${short(r.fixMom, 8)}]` : ''}`
      + `｜留存 ${r.retained.length}${r.retained.length ? ` [${short(r.retained, 8)}]` : ''}｜${r.bytes} B｜final ${r.final}${plan.reason ? `｜⚠ ${plan.reason} ${JSON.stringify(r.pages)}` : ''}`);
    if (!a.write) continue;
    try {
      await d.ref.update(plan.doc, { lastUpdateTime: d.updateTime });
    } catch (e) { console.log(`  ✗ ${d.id} 寫入失敗（${e.code || ''} ${e.message}）——可能 daemon 剛改寫，重跑即可`); tot.write--; tot.refuse++; }
  }
  console.log(`\n合計：${a.write ? '寫入' : '可寫'} ${tot.write}、略過 ${tot.skip}、拒寫 ${tot.refuse}｜+KY ${tot.ky}、+本國 ${tot.dom}、修 yoy ${tot.fixY}／mom ${tot.fixM}｜最大 rowsJson ${maxBytes} bytes（${maxId}）`);
  if (a.out) { writeFileSync(a.out, JSON.stringify({ args: a, at: new Date().toISOString(), tot, maxBytes, maxId, months: reports }, null, 1)); console.log(`逐月明細 → ${a.out}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), e => { console.error('✖', e.stack || e.message); process.exit(1); });
}
