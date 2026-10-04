#!/usr/bin/env node
// ── MOPS 月營收「逐檔逐月」歷史回補 ──────────────────────────────────
//
// 事故（2026-08-10 四源稽核發現）：
//   daemon 的 computeRevenue 只寫 `revenue/latest`，內容是 { month, topYoY, topMoM }
//   ——**兩張 20 名排行榜**。全市場 1,900 檔的當月營收、上月、去年同月、累計，
//   抓下來算完排行就丟了。想回頭問「這檔去年 3 月營收多少」→ 沒有。
//
// 好消息是這一源**真的可以補三年**：MOPS 的月營收彙總表是靜態 HTML，
//   https://mopsov.twse.com.tw/nas/t21/{sii|otc}/t21sc03_{民國年}_{月}_{0|1}.html
//   _0＝本國公司、_1＝外國公司（-KY／DR）——**兩張都要抓**（2026-10-04：只抓 _0 ⇒ KY 月營收全缺）。
//   實測 112_8（2023-08）仍為 43 萬 bytes 有效內容。
//
// ⚠ 踩過的坑，改這支之前先讀（解析與回音在 scripts/lib/mops-revenue.mjs，有單元測試）：
//   ① 編碼是 **big5**，不是 UTF-8。用 `new TextDecoder('big5')`，
//      直接 `res.text()` 會拿到一堆亂碼且公司名全毀。
//   ② 頁面有 68 個 <table>（排版用巢狀表），不能用「第 N 個表格」定位，
//      要**用列的欄數與內容特徵**篩：11 欄、第 1 欄是 4 碼代號。
//   ③ 民國年 = 西元 − 1911。月份**不補零**（是 `_8_` 不是 `_08_`）。
//   ④ 外國公司在 _1 表；每頁都要驗標題回音（市場＋年＋月）與表尾「全部國內／國外…合計」，錯月、錯頁不收。
//   ⑤ 舊版「既有 ≥1700 檔就永久略過」讓次月 10 日後才上表的晚申報者（金控／保險）永久漏掉——
//      定版改看資料（lib isMonthFinal）：4 頁皆成功＋名冊完整（上月有申報的代號本月缺 ≤5 檔）＋
//      次月 11 日起相隔 ≥3 日的兩次觀測合併筆數沒有增加（fetchLog）。觀測時刻用頁面「出表日期」（MOPS 回快取頁）。
//   ⑥ 增減 % 官方留白（基期為 0）存 null，不補 0（v2 起；舊文件的 0 由 backfill-revenue-from-mirror 修）。
//   ⑦ 既有列只在「還沒有申報期後觀測」時才以新值覆蓋（lib hasSettledObservation）；之後只補缺——
//      事後更正值不回寫歷史（研究以次月 11 日可得使用，回寫＝前視）。舊月份重跑因此只會補 KY／晚申報者。
//
// 存法：`revenueArchive/{YYYY-MM}`，一個月一份 doc，rowsJson 放全市場（合併＝依代號聯集、永不變薄）。
//       doc id 用**資料所屬月份**（不是公布月），與 chipArchive 的 date 語意一致。
//       v2 欄位：n、rowsJson、bytes（UTF-8 位元組）、bySrc（上市／上櫃／上市KY／上櫃KY／留存）、kyN、
//       retained（留存代號）、missingVsPrev（{n,codes} 名冊比對缺檔）、pages（本次各頁筆數或錯誤）、
//       fetchLog（4 頁皆成功的觀測 [{at,gen,n,src}]）、final、v、at。
//
// 用法：node scripts/backfill-mops-revenue.mjs [月數=36] [--dry-run]
//   --dry-run 仍會打 MOPS（每月 4 個請求、間隔 ≥3 秒），只是不寫 Firestore。
//   daemon 每天只跑最近 2 個月；舊月份沒有必要重跑（final 對舊月份沒有消費端；KY 與晚申報者由鏡像零網路補）。

import admin from 'firebase-admin';
import { pathToFileURL } from 'node:url';
import { BLOCK_RE, MIN_GAP_MS } from './lib/official-mirror.mjs';
import {
  T21_PAGES, t21Url, parseT21sc03, t21Codes, echoOk, t21Echo, combinePages, mergeRows, composition, rowsOf,
  shouldSkipMonth, isOpenapiDoc, appendFetchLog, isMonthFinal, missingVsPrev, missingSummary, prevMonthId,
  hasSettledObservation, REV_DOC_VERSION, MAX_DOC_BYTES,
} from './lib/mops-revenue.mjs';

// ⚠ 絕對不可以在 module 載入時 initializeApp()（2026-08-11 事故）：
//   ai-daemon 會 `import { backfillMopsRevenue }` 這支模組，
//   ESM 的 import 會在 daemon 自己用正式憑證 initializeApp() **之前**執行，
//   於是 daemon 啟動時撞上
//     「A Firebase app named "[DEFAULT]" already exists with a different configuration」
//   直接 exit 1 —— daemon 完全起不來（實際停擺，盤中無人發現，因為
//   marketSnapshot 還留著崩潰前最後一次的內容，看起來只是「有點舊」）。
//   ⇒ 一律改成用到才初始化。任何要被 daemon import 的腳本都適用這條。
let _db = null;
const getDb = () => {
  if (!_db) { if (!admin.apps.length) admin.initializeApp(); _db = admin.firestore(); }
  return _db;
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// MOPS 與第二大腦官方鏡像、daemon 共用同一個出口 IP ⇒ 與鏡像同一節奏：逐請求 ≥3 秒＋抖動
let _lastReq = 0;
async function pace() {
  const wait = _lastReq + MIN_GAP_MS + Math.floor(Math.random() * 500) - Date.now();
  if (wait > 0) await sleep(wait);
  _lastReq = Date.now();
}

const FATAL_HTTP = [301, 302, 303, 307, 308, 401, 403, 429];

const big5 = (buf) => new TextDecoder('big5').decode(buf);

// 抓單一（市場, 年, 月, 頁）→ { rows, codes, gen, err, fatal }；回音不符、封鎖頁、HTTP 錯誤都不收列
async function fetchPage(mkt, rocYear, month, page, { fetchImpl, decode }) {
  let r;
  try {
    r = await fetchImpl(t21Url(mkt, rocYear, month, page), { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  } catch (e) { return { rows: [], codes: [], err: e.message }; }
  if (FATAL_HTTP.includes(r.status)) return { rows: [], codes: [], err: `HTTP ${r.status}`, fatal: true };
  if (!r.ok) return { rows: [], codes: [], err: `HTTP ${r.status}` };
  const html = decode(Buffer.from(await r.arrayBuffer()));
  if (BLOCK_RE.test(html.slice(0, 20000))) return { rows: [], codes: [], err: '封鎖／安全頁', fatal: true };
  const echo = t21Echo(html);
  if (!echoOk(html, mkt, rocYear, month, page)) return { rows: [], codes: [], err: `回音不符 ${JSON.stringify(echo)}（${html.length} 字）` };
  return { rows: parseT21sc03(html), codes: t21Codes(html), gen: echo.gen, err: null };
}

// 定版證據：只有 4 頁皆成功的抓取才記觀測（觀測時刻＝4 頁中最早的「出表日期」；同一份快取頁不算新觀測），
// 名冊比對的參照是上月文件（上月有、本月 4 頁都沒有的代號＝尚未申報或下市）。回傳 { fetchLog, missing, final }
async function observe(db, id, exist, { okPages, allOk, n, at }) {
  const keep = Array.isArray(exist?.fetchLog) ? exist.fetchLog : [];
  if (!allOk) return { fetchLog: keep, missing: null, final: false };
  const gens = okPages.map(p => p.gen);
  const gen = gens.every(Number.isFinite) ? Math.min(...gens) : null;
  const fetchLog = appendFetchLog(keep, { at, ...(gen != null ? { gen } : {}), n, src: 'mops' }, { monthId: id });
  const prevSnap = await db.collection('revenueArchive').doc(prevMonthId(id)).get();
  const missing = missingVsPrev(prevSnap.exists ? prevSnap.data() : null, okPages.flatMap(p => p.codes));
  return { fetchLog, missing, final: isMonthFinal(id, { allPages: true, missing, fetchLog }) };
}

// 一個月：讀既有 → 抓 4 頁 → 合併 → 判定是否可寫與是否定版。回傳 { status, msg, doc?, fatal? }
async function processMonth(id, roc, mo, { dryRun, db, fetchImpl, decode, paceFn, nowMs }) {
  const ref = db.collection('revenueArchive').doc(id);
  const snap = await ref.get();
  const exist = snap.exists ? snap.data() : null;
  if (shouldSkipMonth(exist)) return { status: 'skip' };
  let existRows;
  try { existRows = rowsOf(exist); } catch (e) { return { status: 'fail', msg: `✗ ${id} 既有 rowsJson 無法解析（${e.message}）— 不覆蓋` }; }
  const prevN = exist?.n ?? existRows.length;

  const pages = [];
  for (const p of T21_PAGES) {
    await paceFn();
    const res = await fetchPage(p.mkt, roc, mo, p.page, { fetchImpl, decode });
    pages.push({ ...p, ...res });
    if (res.fatal) return { status: 'fail', fatal: true, msg: `✗ ${id} ${p.label} 頁：MOPS 封鎖／限流訊號（${res.err}）——本輪停止，不再發請求` };
  }
  const per = Object.fromEntries(pages.map(p => [p.label, p.err ? `ERR ${p.err}` : p.rows.length]));
  const domesticOk = pages.filter(p => p.page === '0').every(p => !p.err);
  const allOk = pages.every(p => !p.err);
  // 既有 v2 文件＋本次有頁失敗：失敗頁的代號會被記成「留存」、組成失真（稽核誤報 THIN）——不改寫，下一輪重來
  if (!allOk && Number(exist?.v) >= REV_DOC_VERSION) {
    return { status: 'fail', msg: `✗ ${id}（民國${roc}_${mo}）有頁失敗 ${JSON.stringify(per)} — 既有 v2 文件不以殘缺抓取改寫` };
  }
  const okPages = pages.filter(p => !p.err);
  const { rows: fetched, srcOf, dup } = combinePages(okPages);
  // openapi 薄版（混未上市 _P、沒有上櫃）不當基底：整份由官方 4 頁取代；其餘一律依代號聯集、永不變薄。
  // 已有申報期後觀測的月份只補缺（事後更正值不回寫歷史）；之前（申報期內）以官方新值覆蓋。
  const fromOpenapi = isOpenapiDoc(exist);
  const override = !hasSettledObservation(id, exist);
  const merged = mergeRows(fromOpenapi ? [] : existRows, fetched, { override });
  const minN = Math.max(800, prevN);
  if (!domesticOk || merged.length < minN) {
    return { status: 'fail', msg: `✗ ${id}（民國${roc}_${mo}）合併 ${merged.length} 筆（既有 ${prevN}、門檻 ${minN}）${JSON.stringify(per)} — 不寫入` };
  }
  const rowsJson = JSON.stringify(merged);
  const bytes = Buffer.byteLength(rowsJson);
  if (bytes > MAX_DOC_BYTES) return { status: 'fail', msg: `✗ ${id} rowsJson ${bytes} bytes > ${MAX_DOC_BYTES} — 不寫入（需改壓縮／分片）` };

  const at = nowMs ?? Date.now();
  const { fetchLog, missing, final } = await observe(db, id, exist, { okPages, allOk, n: merged.length, at });
  const { bySrc, kyN } = composition(merged, srcOf);
  const retained = merged.filter(r => !srcOf.has(String(r.c))).map(r => String(r.c));
  const doc = { month: id, n: merged.length, rowsJson, bytes, bySrc, kyN, retained, missingVsPrev: missingSummary(missing), pages: per, fetchLog, final, v: REV_DOC_VERSION, at };
  const note = `${JSON.stringify(per)}${dup.length ? `｜重複代號 ${dup.join(',')}` : ''}${fromOpenapi ? '｜取代 openapi 薄版' : ''}${override ? '' : '｜既有列不動（只補缺）'}`;
  const why = !allOk ? '有頁失敗' : missing == null ? `無上月參照（${prevMonthId(id)}）可比對名冊` : missing.length ? `較上月缺 ${missing.length} 檔 [${missing.slice(0, 8).join(',')}${missing.length > 8 ? '…' : ''}]` : '';
  const msg = `${dryRun ? '（dry-run）' : '✓'} ${id}：${prevN} → ${merged.length} 檔（KY ${kyN}）${note} ${(bytes / 1024).toFixed(0)}KB${final ? '｜已定版' : `｜未定版（${why ? `${why}；` : ''}等 11 日後相隔 ≥3 日的同筆數觀測）`}`;
  if (dryRun) return { status: 'ok', msg, doc };
  // 讀寫之間若有別人（零網路回補）改過這份文件，前置條件失敗 ⇒ 本輪放棄，下一輪重來，不蓋掉對方
  if (snap.exists) await ref.update(doc, { lastUpdateTime: snap.updateTime });
  else await ref.create(doc);
  return { status: 'ok', msg, doc };
}

// months：往回幾個月。logFn 讓 daemon 也能呼叫並吐到自己的 log。
// 第三個參數只有 dryRun 給人用；db／fetchImpl／decode／paceFn／now 是單元測試的注入點（daemon 不傳）。
export async function backfillMopsRevenue(months = 36, logFn = console.log, { dryRun = false, db = null, fetchImpl = fetch, decode = big5, paceFn = pace, now = null } = {}) {
  // 最新一筆可得的是「上個月」的營收（本月 10 日前公布上月）。
  const env = { dryRun, db: db || getDb(), fetchImpl, decode, paceFn, nowMs: now ? now.getTime() : null };
  if (!now) now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  let ok = 0, skip = 0, fail = 0;
  for (let i = 0; i < months; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() - i, 1);
    const y = d.getFullYear(), mo = d.getMonth() + 1;
    const id = `${y}-${String(mo).padStart(2, '0')}`;
    let r;
    try { r = await processMonth(id, y - 1911, mo, env); }
    catch (e) { r = { status: 'fail', msg: `✗ ${id} 失敗：${e.message}` }; }
    if (r.msg) logFn(r.msg);
    if (r.status === 'skip') skip++; else if (r.status === 'ok') ok++; else fail++;
    if (r.fatal) break;
  }
  logFn(`月營收回補完成：${dryRun ? '試算' : '新寫'} ${ok}、已定版略過 ${skip}、失敗 ${fail}`);
  return { ok, skip, fail };
}

// ⚠ 路徑含中文 → 必須用 pathToFileURL 正規化，否則直接執行會靜默不做事。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const unknown = argv.filter(a => a.startsWith('--') && a !== '--dry-run');
  if (unknown.length) { console.error(`未知參數：${unknown.join(' ')}（用法：[月數=36] [--dry-run]）`); process.exit(2); }
  const n = parseInt(argv.find(a => /^\d+$/.test(a)) || '36', 10);
  backfillMopsRevenue(n, console.log, { dryRun: argv.includes('--dry-run') })
    .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
