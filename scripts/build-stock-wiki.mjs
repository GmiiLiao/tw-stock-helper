#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 台股資料 wiki（第二大腦）產生器（2026-10-03）
//
// 產出 second-brain/wiki/：Obsidian 相容的 Markdown vault（[[雙向連結]]）＋ _graph/*.json（給本地 AI／daemon 查）。
// 全部個股（上市／上櫃／興櫃）與 ETF；產業／產業鏈上中下游／同業／集團（法人董監推導）／財務摘要／新聞／重大訊息。
// 每一筆事實都帶來源與可信度（官方／站內推導／AI 待驗），見 wiki/README.md。
//
// 用法：
//   node scripts/build-stock-wiki.mjs crawl            # 抓官方慢變數（openapi 整批＋MOPS 逐檔，可中斷續跑，30 天快取）
//   node scripts/build-stock-wiki.mjs build            # 只用本地快取＋備份重建 vault（零上游請求）
//   node scripts/build-stock-wiki.mjs all              # crawl 後 build
//   node scripts/build-stock-wiki.mjs ai-batches       # 產生 AI 鋪底批次輸入（.cache/ai/batches，--size 40，--skip-done 只出未完成的）
//   node scripts/build-stock-wiki.mjs ai-ingest        # 驗證 AI 輸出（.cache/ai/out）並入庫 profiles/ai
//   node scripts/build-stock-wiki.mjs annual-fetch     # 年報：下載→抽營運概況段落（不用 LLM，任何時段；--max N 本次最多處理 N 檔）
//   node scripts/build-stock-wiki.mjs annual-extract   # 年報：本機 Ollama 萃取（只在 --window 02:00-06:30 內跑；--wait-window 先等到時段開始；--force 忽略時段）
//   node scripts/build-stock-wiki.mjs geo-batches|geo-ingest  # AI 層產品×國家補充（.cache/ai/geo-*，--size 60，--skip-done）
//   node scripts/build-stock-wiki.mjs taxonomy families|assign|canon|status   # 產品分類樹三段（子代理產出，見 lib/stock-wiki/taxonomy.mjs）
//   選項：--refresh（忽略快取重抓 openapi）  --max-age 20（MOPS 快取天數，月排程用 20 確保每月都更新）  --codes 2330,2317（crawl 只抓這些）  --pace 2500（MOPS 間隔 ms）
// ─────────────────────────────────────────────────────────────────────────────
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBackup, stockUniverse } from './lib/stock-wiki/load-local.mjs';
import { loadTwseOpenData, crawlMopsCompanies } from './lib/stock-wiki/sources.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRAIN_DIR = path.join(ROOT, 'second-brain');
export const WIKI_DIR = path.join(BRAIN_DIR, 'wiki');
export const CACHE_DIR = path.join(WIKI_DIR, '.cache');
export const SIGNAL_DIR = path.join(BRAIN_DIR, '.signals');   // daemon 寫的 LLM 忙碌／夜間補判完成訊號

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'build';   // 指令放第一個（--max 5 這種值不會被誤當指令）
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);
const log = (...m) => console.log(new Date().toLocaleTimeString('zh-TW', { hour12: false }), ...m);

export const TWSE_DATASETS = ['t187ap03_L', 't187ap02_L', 't187ap11_L', 't187ap47_L'];

async function crawl() {
  const refresh = flag('refresh');
  for (const ep of TWSE_DATASETS) {
    const r = await loadTwseOpenData(CACHE_DIR, ep, { refresh });
    log(`openapi ${ep}: ${r.rows.length} 筆（${r.from}${r.error ? `，${r.error}` : ''}）`);
    if (r.from === 'net') await new Promise(res => setTimeout(res, 1500));
  }
  const bk = loadBackup(BRAIN_DIR);
  if (bk.missing.length) log('⚠ 備份缺：', bk.missing.join('、'));
  const only = opt('codes', '');
  const codes = only ? only.split(',').map(s => s.trim()).filter(Boolean) : [...stockUniverse(bk).keys()].sort();
  log(`MOPS 公司基本資料：${codes.length} 檔，間隔 ${opt('pace', 2500)}ms`);
  const stat = await crawlMopsCompanies(CACHE_DIR, codes, { paceMs: Number(opt('pace', 2500)), maxAgeDays: Number(opt('max-age', 30)), log });
  log('MOPS 完成', stat);
  if (stat.aborted) process.exitCode = 2;
}

async function aiBatches() {
  const { loadModel } = await import('./lib/stock-wiki/build.mjs');
  const { writeAiBatches } = await import('./lib/stock-wiki/ai-batches.mjs');
  const { model } = loadModel({ brainDir: BRAIN_DIR, cacheDir: CACHE_DIR, log });
  const b = writeAiBatches(CACHE_DIR, model, { size: Number(opt('size', 40)), skipDone: flag('skip-done') });
  log(`AI 批次 ${b.length} 份`); for (const x of b) log(`  ${x.file} ${x.first}–${x.last}（${x.n} 檔，有主要業務 ${x.withMainBusiness}）`);
}

async function aiIngest() {
  const { loadModel } = await import('./lib/stock-wiki/build.mjs');
  const { ingestAllAi } = await import('./lib/stock-wiki/ai-batches.mjs');
  const { model } = loadModel({ brainDir: BRAIN_DIR, cacheDir: CACHE_DIR, log });
  const { makeNameToCode } = await import('./lib/stock-wiki/annual-runner.mjs');
  const r = ingestAllAi(CACHE_DIR, new Set(model.stocks.keys()), { nameToCode: makeNameToCode(model) });
  log(`AI 入庫：${r.batches} 批、寫入 ${r.written}、全空 ${r.empty}、輸出缺漏 ${r.missing.length}${r.missing.length ? `（${r.missing.slice(0, 20).join(',')}…）` : ''}、未完成批次 ${r.pendingBatches.length}`);
}

// AI 層產品×國家補充：geo-batches（出題）→ 子代理寫 .cache/ai/geo-out → geo-ingest（驗證入庫 profiles/ai-geo）
async function geoBatches() {
  const { loadModel } = await import('./lib/stock-wiki/build.mjs');
  const { writeGeoBatches } = await import('./lib/stock-wiki/ai-geo.mjs');
  const { model } = loadModel({ brainDir: BRAIN_DIR, cacheDir: CACHE_DIR, log });
  const r = writeGeoBatches(CACHE_DIR, model, { size: Number(opt('size', 60)), skipDone: flag('skip-done') });
  log(`產品×國家批次 ${r.files.length} 份（${r.stocks} 檔）`);
}
async function geoIngest() {
  const { loadModel } = await import('./lib/stock-wiki/build.mjs');
  const { ingestAllGeo } = await import('./lib/stock-wiki/ai-geo.mjs');
  const { model } = loadModel({ brainDir: BRAIN_DIR, cacheDir: CACHE_DIR, log });
  log('產品×國家入庫', ingestAllGeo(CACHE_DIR, new Set(model.stocks.keys())));
}

// 產品分類樹三段：families（詞彙表輸入）→ assign（歸族批次）→ canon（同族合併批次）；子代理寫輸出，build 時讀
async function taxonomyCmd() {
  const stage = args[1];
  const { loadModel } = await import('./lib/stock-wiki/build.mjs');
  const tax = await import('./lib/stock-wiki/taxonomy.mjs');
  const { model } = loadModel({ brainDir: BRAIN_DIR, cacheDir: CACHE_DIR, log });
  if (stage === 'families') log('產品族詞彙表輸入', tax.writeFamilyInput(CACHE_DIR, model));
  else if (stage === 'assign') { const f = tax.writeAssignBatches(CACHE_DIR, model, { size: Number(opt('size', 220)), skipDone: flag('skip-done') }); log(`歸族批次 ${f.length} 份`); }
  else if (stage === 'canon') { const f = tax.writeCanonBatches(CACHE_DIR); log(`同族合併批次 ${f.length} 份`); }
  else if (stage === 'status') {
    const t = tax.loadTaxonomy(CACHE_DIR, tax.officialIndustries(model));
    const terms = tax.collectTerms(model);
    const mapped = terms.filter(x => t.termOf(x.name).family).length;
    const canons = new Set(terms.map(x => t.termOf(x.name).canon)).size;
    log(`產品族 ${t.families.size}、名稱 ${terms.length}（已歸族 ${mapped}）、合併後 ${canons} 個標準名`);
  } else { console.error('用法：taxonomy families｜assign [--skip-done]｜canon｜status'); process.exitCode = 1; }
}

async function stockCodes(model) {
  const only = opt('codes', '');
  const codes = only ? only.split(',').map(x => x.trim()).filter(Boolean) : [...model.stocks.keys()].sort();
  const limit = Number(opt('limit', 0));
  return limit > 0 ? codes.slice(0, limit) : codes;
}

async function annualFetchCmd() {
  const { loadModel } = await import('./lib/stock-wiki/build.mjs');
  const { annualFetch } = await import('./lib/stock-wiki/annual-runner.mjs');
  const { model } = loadModel({ brainDir: BRAIN_DIR, cacheDir: CACHE_DIR });
  const st = await annualFetch(CACHE_DIR, await stockCodes(model), { paceMs: Number(opt('pace', 3000)), maxFetch: Number(opt('max', Infinity)), log });
  log('年報下載完成', st);
  if (st.aborted) process.exitCode = 2;
}

async function annualExtractCmd() {
  const { loadModel } = await import('./lib/stock-wiki/build.mjs');
  const { annualExtract } = await import('./lib/stock-wiki/annual-runner.mjs');
  const { model } = loadModel({ brainDir: BRAIN_DIR, cacheDir: CACHE_DIR });
  const win = opt('window', '02:00-06:30');
  const { inWindow, nightBackfillDone } = await import('./lib/stock-wiki/annual-report.mjs');
  inWindow(Date.now(), win);   // 格式錯誤在這裡就丟出
  if (flag('wait-window')) {
    // 等時段開始，且等 daemon 寫出「今晚夜間補判已跑完」（daemon 沒在跑就等到 03:30 為止再開始，仍逐筆檢查忙碌）
    const deadline = Date.now() + 6 * 3600000;
    const fallbackAt = (() => { const t = new Date(Date.now() + 8 * 3600000); t.setUTCHours(3, 30, 0, 0); let ms = t.getTime() - 8 * 3600000; if (ms < Date.now() - 12 * 3600000) ms += 86400000; return ms; })();
    while (Date.now() < deadline) {
      if (inWindow(Date.now(), win) && (nightBackfillDone(SIGNAL_DIR) || Date.now() >= fallbackAt)) break;
      await new Promise(r => setTimeout(r, 60000));
    }
    if (!nightBackfillDone(SIGNAL_DIR)) log('  ⚠ 未見 daemon 夜間補判完成訊號（daemon 可能未運行），改以逐筆忙碌檢查保護');
  }
  const st = await annualExtract(CACHE_DIR, model, await stockCodes(model), { window: win, force: flag('force'), signalDir: SIGNAL_DIR, log });
  log('年報萃取', st);
}

async function build() {
  const { buildWiki } = await import('./lib/stock-wiki/build.mjs');
  const res = await buildWiki({ brainDir: BRAIN_DIR, wikiDir: WIKI_DIR, cacheDir: CACHE_DIR, log });
  log('wiki 完成', res);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {   // 路徑含中文，要比對編碼後的 URL
  const run = { crawl, build, all: async () => { await crawl(); await build(); }, 'ai-batches': aiBatches, 'ai-ingest': aiIngest, 'annual-fetch': annualFetchCmd, 'annual-extract': annualExtractCmd, taxonomy: taxonomyCmd, 'geo-batches': geoBatches, 'geo-ingest': geoIngest }[cmd];
  if (!run) { console.error(`未知指令 ${cmd}（crawl｜build｜all｜ai-batches｜ai-ingest｜annual-fetch｜annual-extract｜taxonomy｜geo-batches｜geo-ingest）`); process.exit(1); }
  run().catch(e => { console.error(e); process.exit(1); });
}
