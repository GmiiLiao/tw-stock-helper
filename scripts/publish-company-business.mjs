#!/usr/bin/env node
// 上市／上櫃公司「主要經營業務」（官方：公開資訊觀測站 t05st03 公司基本資料）→ Firestore companyBusiness/latest，
//   供個股頁「公司資訊」顯示（2026-10-10 使用者：「上市/櫃主要業務的資料都沒有提供正確，請補齊」；官方公司輪廓第二批）。
//   來源只讀本機第二大腦：second-brain/wiki/.cache/mops-t05st03/{代號}.json（股票 wiki 夜間／月更續抓，零上游請求）。
//   文件內容＝gzip＋base64 的 { 代號: 主要經營業務 }（約 2,300 檔；大文件一律壓縮·feedback_large_doc_compress_shard），只有後端可讀。
//   factsGz（2026-10-10 L13 補齊）：{ stocks: { 代號: { ind: 官方產業別, products: [{ n, s? }] } }, industries: { 產業: { count, pe, pb, yield, revYoY, chains[] } } }
//     · ind＝股票 wiki 的官方產業別（MOPS t05st03 industryCategory，缺則證交所 t187ap03）——興櫃也有
//     · products 只收「每一項都出自 2025 年報」的產品（profile.products[].src＝annual-report-2025），AI 知識補的不收（裁定：AI 輪廓驗證後才補）
//     · industries 解析 wiki 產業頁（render-hubs：官方產業別檔數＋站內同業表中位數＋相關產業鏈），不含任何展望
//   內容 sha256 沒變只更新 updatedAt（＝最後確認時刻，給 audit-data-sources 的新鮮度閘門；每晚 1 讀 1 小寫）。
//   node scripts/publish-company-business.mjs [--dry-run] [--force] [--root <second-brain>]
import admin from 'firebase-admin';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampAfterPublish } from './lib/writer-version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const ri = argv.indexOf('--root');
const ROOT = ri >= 0 ? argv[ri + 1] : join(HERE, '..', 'second-brain');
const DIR = join(ROOT, 'wiki', '.cache', 'mops-t05st03');
const MIN_ROWS = 1800;   // 上市＋上櫃約 2,000 檔；少於此數視為快取殘缺，不覆蓋線上（總數 > 0 不是完整性條件）
const MAX_BYTES = 900_000;
const WIKI = join(ROOT, 'wiki');
const MAX_PRODUCTS = 8;

/** 官方原文整理：去頭尾空白、連續空白與換行併成一個空格；不改寫內容 */
export const cleanBusiness = s => String(s ?? '').replace(/\s+/g, ' ').trim();

export function buildBusinessMap(dir) {
  const map = {}; let newest = 0, oldest = Infinity, bad = 0;
  for (const f of readdirSync(dir).filter(x => /^\d{4,6}\.json$/.test(x)).sort()) {
    let j; try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { bad++; continue; }
    const code = f.replace(/\.json$/, '');
    const text = cleanBusiness(j?.data?.mainBusiness);
    if (j?.data?.stockId && String(j.data.stockId).trim() !== code) { bad++; continue; }   // 檔名與內容代號不符＝不採用
    if (!text) continue;
    map[code] = text;
    if (j.fetchedAt > 0) { newest = Math.max(newest, j.fetchedAt); oldest = Math.min(oldest, j.fetchedAt); }
  }
  return { map, n: Object.keys(map).length, bad, newest: newest || null, oldest: Number.isFinite(oldest) ? oldest : null };
}

/** wiki 產業頁 → 官方產業事實（檔數、同業表中位數、相關產業鏈）；格式由 scripts/lib/stock-wiki/render-hubs.mjs 產生 */
export function parseIndustryPage(md) {
  const count = Number(md.match(/^count:\s*(\d+)/m)?.[1]);
  const num = re => { const v = md.match(re)?.[1]; return v != null && v !== '—' && Number.isFinite(Number(v)) ? Number(v) : null; };
  const chainsLine = md.match(/^相關產業鏈：(.*)$/m)?.[1] || '';
  const chains = [...chainsLine.matchAll(/\[\[[^|\]]+\|([^\]]+)\]\]/g)].map(m => m[1]);
  return {
    count: Number.isFinite(count) ? count : null,
    pe: num(/本益比 ([\d.]+)/), pb: num(/股價淨值比 ([\d.]+)/), yield: num(/殖利率 (-?[\d.]+)%/), revYoY: num(/月營收年增 (-?[\d.]+)%/),
    chains,
  };
}
export function buildFacts(wikiDir) {
  const stocks = {}, industries = {};
  const g = JSON.parse(readFileSync(join(wikiDir, '_graph', 'stocks.json'), 'utf8')).stocks || {};
  for (const [code, v] of Object.entries(g)) {
    const products = ((v.profile || {}).products || []).filter(p => p?.src === 'annual-report-2025' && p.name).slice(0, MAX_PRODUCTS)
      .map(p => ({ n: cleanBusiness(p.name), ...(p.share ? { s: String(p.share) } : {}) }));
    if (v.industry || products.length) stocks[code] = { ...(v.industry ? { ind: v.industry } : {}), ...(products.length ? { products } : {}) };
  }
  const dir = join(wikiDir, '產業');
  if (existsSync(dir)) for (const f of readdirSync(dir).filter(x => x.endsWith('.md'))) industries[f.replace(/\.md$/, '')] = parseIndustryPage(readFileSync(join(dir, f), 'utf8'));
  return { stocks, industries };
}

async function main() {
  if (!existsSync(DIR)) { console.error(`找不到 ${DIR}`); return 2; }
  const { map, n, bad, newest, oldest } = buildBusinessMap(DIR);
  if (n < MIN_ROWS) { console.error(`只有 ${n} 檔有主要經營業務（< ${MIN_ROWS}），快取疑似殘缺，不發佈`); return 2; }
  const json = JSON.stringify(map);
  const gz = gzipSync(Buffer.from(json)).toString('base64');
  const facts = buildFacts(WIKI);
  const nInd = Object.values(facts.stocks).filter(x => x.ind).length, nProd = Object.values(facts.stocks).filter(x => x.products).length;
  if (nInd < MIN_ROWS || Object.keys(facts.industries).length < 20) { console.error(`wiki 事實疑似殘缺（產業別 ${nInd} 檔、產業頁 ${Object.keys(facts.industries).length}），不發佈`); return 2; }
  const factsJson = JSON.stringify(facts);
  const sha = createHash('sha256').update(json).update(factsJson).digest('hex');
  const factsGz = gzipSync(Buffer.from(factsJson)).toString('base64');
  const doc = {
    gz, n, factsGz, nIndustry: nInd, nProducts: nProd, sha256: sha, encoding: 'gzip+base64 JSON；gz＝{代號: 主要經營業務}；factsGz＝{ stocks:{代號:{ind,products}}, industries:{產業:{count,pe,pb,yield,revYoY,chains}} }',
    source: '公開資訊觀測站 t05st03 公司基本資料（官方·經股票 wiki 本機快取）',
    fetchedFrom: oldest ? new Date(oldest).toISOString() : null, fetchedTo: newest ? new Date(newest).toISOString() : null,
    updatedAt: Date.now(),
  };
  const bytes = Buffer.byteLength(JSON.stringify(doc));
  console.log(`主要經營業務 ${n} 檔（無法採用 ${bad}）｜官方產業別 ${nInd} 檔｜年報產品 ${nProd} 檔｜產業 ${Object.keys(facts.industries).length}｜原文 ${(json.length / 1024).toFixed(0)}KB → 文件 ${(bytes / 1024).toFixed(0)}KB｜sha ${sha.slice(0, 12)}`);
  if (bytes > MAX_BYTES) { console.error('文件逼近 1MB，改分片後再發佈'); return 2; }
  if (DRY) return 0;
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||= '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
  admin.initializeApp();
  const db = admin.firestore();
  const ref = db.collection('companyBusiness').doc('latest');
  const cur = await ref.get();
  if (!FORCE && cur.exists && cur.data().sha256 === sha) { await ref.set({ updatedAt: Date.now() }, { merge: true }); console.log('內容沒變（sha 相同）：只更新 updatedAt'); return 0; }
  await ref.set(doc);
  await stampAfterPublish(db, 'companyBusiness', 'publish-company-business', join(HERE, '..'), ['scripts/publish-company-business.mjs']);
  console.log(`✓ 已發佈 companyBusiness/latest（${n} 檔）`);
  return 0;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().then(c => process.exit(c), e => { console.error(e?.message || e); process.exit(1); });
