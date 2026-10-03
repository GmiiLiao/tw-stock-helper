// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki：AI 層「產品×國家」補充（使用者 2026-10-03 選「AI 層也補產品×國家」）
//   輸入  .cache/ai/geo-batches/geo-NNN.json  [{ code, name, industry, mainBusiness, products:[名稱], plants:[{name,country,location}], markets:[名稱] }]
//   輸出  .cache/ai/geo-out/geo-NNN.json      { code: { products:[{name, madeIn:[], soldTo:[], conf}], plants:[{name, products:[], conf}] } }（子代理寫）
//   入庫  geo-ingest → .cache/profiles/ai-geo/{code}.json；readProfile 把它掛到 AI 層的同名項目上
// 只補「既有項目」的屬性，不新增項目：名稱必須逐字對上該公司 AI 輪廓裡的產品／廠區，對不上的丟掉。
// 只收 conf 高／中；這仍是 AI 整理，頁面照標「AI待驗」，判讀提示詞只放參考區。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normEntityName, normPlace, profileDir, applyGeo } from './profiles.mjs';

const PROMPT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts', 'geo.md');
export const geoDir = (cacheDir, sub) => path.join(cacheDir, 'ai', sub);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const nnn = (i) => `geo-${String(i).padStart(3, '0')}.json`;
const MAX_PLACES = 6;
const MAX_PLANT_PRODUCTS = 8;
const OK_CONF = new Set(['高', '中']);
const place = (s) => normPlace(String(s || '').replace(/\s+/g, '').slice(0, 12));
const names = (arr) => (Array.isArray(arr) ? arr : []).map(x => normEntityName(typeof x === 'string' ? x : x?.name)).filter(Boolean);

/** 只出 AI 輪廓有產品的公司；skipDone 時已入庫的不再出題 */
export function writeGeoBatches(cacheDir, model, { size = 60, skipDone = false } = {}) {
  const dir = geoDir(cacheDir, 'geo-batches'); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^geo-\d+\.json$/.test(f)) fs.unlinkSync(path.join(dir, f));
  const doneDir = profileDir(cacheDir, 'ai-geo');
  const done = skipDone && fs.existsSync(doneDir) ? new Set(fs.readdirSync(doneDir).map(f => f.replace('.json', ''))) : new Set();
  const rows = [];
  for (const code of [...model.stocks.keys()].sort()) {
    if (done.has(code)) continue;
    const ai = readJson(path.join(profileDir(cacheDir, 'ai'), `${code}.json`));
    if (!ai?.products?.length) continue;
    const s = model.stocks.get(code);
    rows.push({
      code, name: s.name, industry: s.industry?.name || null, mainBusiness: s.mainBusiness,
      products: names(ai.products),
      plants: (ai.plants || []).map(p => ({ name: p.name, country: p.country || null, location: p.location || null })),
      markets: names(ai.markets),
    });
  }
  const files = [];
  for (let i = 0; i * size < rows.length; i++) {
    fs.writeFileSync(path.join(dir, nnn(i)), JSON.stringify(rows.slice(i * size, (i + 1) * size), null, 1));
    files.push(nnn(i));
  }
  if (fs.existsSync(PROMPT_FILE)) fs.copyFileSync(PROMPT_FILE, path.join(geoDir(cacheDir, ''), 'PROMPT-geo.md'));
  return { files, stocks: rows.length };
}

/** 驗證單檔輸出：名稱必須對上 AI 輪廓既有的產品／廠區；國家正規化；只收高／中 */
export function sanitizeGeo(raw, aiProfile) {
  if (!raw || typeof raw !== 'object' || !aiProfile) return null;
  const productSet = new Set(names(aiProfile.products));
  const plantSet = new Set(names(aiProfile.plants));
  const places = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(place).filter(Boolean))].slice(0, MAX_PLACES);
  const products = []; const seenP = new Set();
  for (const it of Array.isArray(raw.products) ? raw.products : []) {
    const name = normEntityName(it?.name);
    if (!productSet.has(name) || seenP.has(name) || !OK_CONF.has(it?.conf)) continue;
    const madeIn = places(it.madeIn); const soldTo = places(it.soldTo);
    if (!madeIn.length && !soldTo.length) continue;
    seenP.add(name); products.push({ name, madeIn, soldTo, conf: it.conf });
  }
  const plants = []; const seenL = new Set();
  for (const it of Array.isArray(raw.plants) ? raw.plants : []) {
    const name = normEntityName(it?.name);
    if (!plantSet.has(name) || seenL.has(name) || !OK_CONF.has(it?.conf)) continue;
    const prods = [...new Set(names(it.products).filter(n => productSet.has(n)))].slice(0, MAX_PLANT_PRODUCTS);
    if (!prods.length) continue;
    seenL.add(name); plants.push({ name, products: prods, conf: it.conf });
  }
  return products.length || plants.length ? { products, plants } : null;
}

/** 讀全部輸出批次並入庫（以輸出裡的代號為準） */
export function ingestAllGeo(cacheDir, validCodes) {
  const outDir = geoDir(cacheDir, 'geo-out'); const dest = profileDir(cacheDir, 'ai-geo');
  fs.mkdirSync(dest, { recursive: true });
  const stat = { batches: 0, written: 0, empty: 0 };
  for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(x => /^geo-\d+\.json$/.test(x)).sort() : []) {
    const out = readJson(path.join(outDir, f)); if (!out || typeof out !== 'object') continue;
    stat.batches++;
    for (const [code, raw] of Object.entries(out)) {
      if (!validCodes.has(code)) continue;
      const g = sanitizeGeo(raw, readJson(path.join(profileDir(cacheDir, 'ai'), `${code}.json`)));
      const file = path.join(dest, `${code}.json`);
      if (!g) { stat.empty++; if (fs.existsSync(file)) fs.unlinkSync(file); continue; }
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(g)); fs.renameSync(`${file}.tmp`, file);
      stat.written++;
    }
  }
  return stat;
}

export { applyGeo };
