// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki：經營輪廓（產品／原料／客戶／供應商／設備／廠房／競爭者／市場）的驗證、正規化與分層合併
//
// 兩層來源（使用者 2026-10-03 裁定「AI 先鋪底＋年報逐步覆蓋」）：
//   .cache/profiles/annual/{code}.json   年報「營運概況」萃取（src: annual-report-YYYY）→ 優先
//   .cache/profiles/ai/{code}.json       AI 依知識整理（src: ai-knowledge）→ 只補年報沒有的面向
// 合併以「面向」為單位：年報有該面向就整個用年報的，沒有才用 AI 的；每個項目都保留自己的 src/conf。
// AI 輸出不可信任：一律過 sanitizeProfile（型別、長度、信心度白名單、台股代號必須存在於宇宙）。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['products', 'materials', 'customers', 'suppliers', 'equipment', 'plants', 'competitors', 'markets'];
const MAX_ITEMS = 10;
const MAX_NAME = 40;
const CONF = new Set(['高', '中', '低']);
const ITEM_FIELDS = ['country', 'location', 'share', 'note', 'domestic', 'export'];
// 清單欄位：產品的生產國／銷售地、廠區生產的產品（2026-10-03 產品×國家）
const LIST_FIELDS = { madeIn: 'place', soldTo: 'place', products: 'entity' };
const MAX_LIST = 8;
// 交易對手類欄位（供應商／客戶／競爭者）出現純地名＝萃取錯把「供應來源：日本」當公司
const PLACE_ONLY = /^(臺灣|台灣|中國|中國大陸|大陸|香港|日本|韓國|南韓|美國|歐洲|美洲|亞洲|東南亞|印尼|印度|越南|泰國|馬來西亞|新加坡|菲律賓|德國|法國|英國|荷蘭|墨西哥|其他|其他地區|國內|國外|內銷|外銷|進口|國內廠商|國外廠商)$/;
const COUNTERPARTY = new Set(['suppliers', 'customers', 'competitors']);

const clean = (v, n = MAX_NAME) => {
  const t = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
};

// 實體名稱正規化（讓不同來源的同一實體落在同一頁）：全形括號→半形、中英文交界的空白去掉、地名別名統一
const PLACE_ALIAS = { 台灣: '臺灣', 中國大陸: '中國', 大陸: '中國', 南韓: '韓國', 香港地區: '香港' };
export function normEntityName(s) {
  const t = String(s || '').replace(/（/g, '(').replace(/）/g, ')')
    .replace(/\s*([\u3400-\u9fff])\s*/g, '$1').replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')').trim();
  return PLACE_ALIAS[t] || t;
}
export const normPlace = (s) => { const t = String(s || '').trim(); return PLACE_ALIAS[t] || t; };

/** 單一項目：字串或物件 → { name, conf?, code?, country?, location?, share?, note?, domestic?, export?, madeIn?, soldTo?, products?, src? }；無效回 null */
export function sanitizeItem(it, { validCodes, defaultSrc } = {}) {
  const raw = typeof it === 'string' ? { name: it } : it;
  if (!raw || typeof raw !== 'object') return null;
  const name = normEntityName(clean(raw.name));
  if (!name || /^(無|不明|未知|未揭露|n\/a|none|unknown|-|—)$/i.test(name)) return null;
  const out = { name };
  const code = clean(raw.code, 6);
  if (code && /^\d{4}$/.test(code) && (!validCodes || validCodes.has(code))) out.code = code;
  const conf = clean(raw.conf, 1);
  if (CONF.has(conf)) out.conf = conf;
  for (const f of ITEM_FIELDS) { const v = clean(raw[f], f === 'note' ? 60 : 30); if (v) out[f] = f === 'country' ? normPlace(v) : v; }
  for (const [f, type] of Object.entries(LIST_FIELDS)) {
    if (!Array.isArray(raw[f])) continue;
    const vals = [...new Set(raw[f].map(v => clean(typeof v === 'string' ? v : v?.name, 20)).filter(Boolean)
      .map(v => (type === 'place' ? normPlace(v) : normEntityName(v))))].slice(0, MAX_LIST);
    if (vals.length) out[f] = vals;
  }
  const src = clean(raw.src || defaultSrc, 40);
  if (src) out.src = src;
  return out;
}

/** 整份輪廓：去掉無效項目、每面向最多 10 項、同名去重；全部面向都空且無摘要回 null */
export function sanitizeProfile(p, { validCodes, defaultSrc } = {}) {
  if (!p || typeof p !== 'object') return null;
  const out = { src: clean(p.src || defaultSrc, 40) || null, asOf: clean(p.asOf, 20) || null };
  const conf = clean(p.conf, 1); if (CONF.has(conf)) out.conf = conf;
  const summary = clean(p.summary, 80); if (summary) out.summary = summary;
  const note = clean(p.note, 120); if (note) out.note = note;
  let any = !!summary;
  for (const k of KINDS) {
    const seen = new Set(); const items = [];
    for (const it of Array.isArray(p[k]) ? p[k] : []) {
      const s = sanitizeItem(it, { validCodes, defaultSrc: out.src });
      if (!s || seen.has(s.name)) continue;
      if (COUNTERPARTY.has(k) && PLACE_ONLY.test(s.name)) continue;
      seen.add(s.name); items.push(s);
      if (items.length >= MAX_ITEMS) break;
    }
    out[k] = items; if (items.length) any = true;
  }
  return any ? out : null;
}

/** 年報優先、AI 補缺（以面向為單位） */
export function mergeProfiles(annual, ai) {
  if (!annual && !ai) return null;
  if (!annual) return ai;
  if (!ai) return annual;
  const out = { ...ai, ...annual, layers: [annual.src, ai.src].filter(Boolean) };
  for (const k of KINDS) out[k] = (annual[k] || []).length ? annual[k] : (ai[k] || []);
  out.summary = annual.summary || ai.summary;
  out.src = [annual.src, ai.src].filter(Boolean).join('＋');
  return out;
}

/** AI 層「產品×國家」補充（.cache/profiles/ai-geo，見 ai-geo.mjs）掛到同名項目上（回新物件，不改輸入） */
export function applyGeo(ai, geo) {
  if (!ai || !geo) return ai;
  const pg = new Map((geo.products || []).map(x => [x.name, x]));
  const lg = new Map((geo.plants || []).map(x => [x.name, x]));
  const withP = (it) => { const g = pg.get(normEntityName(it?.name)); return g ? { ...it, madeIn: g.madeIn, soldTo: g.soldTo } : it; };
  const withL = (it) => { const g = lg.get(normEntityName(it?.name)); return g ? { ...it, products: g.products } : it; };
  return { ...ai, products: (ai.products || []).map(withP), plants: (ai.plants || []).map(withL) };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export const profileDir = (cacheDir, layer) => path.join(cacheDir, 'profiles', layer);
export function readProfile(cacheDir, code) {
  const ai = applyGeo(readJson(path.join(profileDir(cacheDir, 'ai'), `${code}.json`)), readJson(path.join(profileDir(cacheDir, 'ai-geo'), `${code}.json`)));
  return mergeProfiles(readJson(path.join(profileDir(cacheDir, 'annual'), `${code}.json`)), ai);
}

/** AI 層的前處理：代號一律由名稱重新解析（AI 給的代號實測有錯配：「大毅」被標成久正 6167），來源強制 ai-knowledge */
export function normalizeAiProfile(p, nameToCode) {
  if (!p || typeof p !== 'object') return p;
  const out = { ...p, src: 'ai-knowledge' };
  for (const k of KINDS) {
    if (!Array.isArray(p[k])) continue;
    out[k] = p[k].map(it => {
      const o = typeof it === 'string' ? { name: it } : { ...it };
      delete o.src; delete o.code;
      if (COUNTERPARTY.has(k) && nameToCode) { const c = nameToCode(o.name); if (c) o.code = c; }
      return o;
    });
  }
  return out;
}

/**
 * 把 AI 批次輸出（{ code: profile }）驗證後拆成單檔寫入 profiles/ai/。
 * 回 { written, empty, invalid, missing:[code] }——missing 是批次輸入有、輸出沒有的代號（要重跑）。
 */
export function ingestAiBatch(cacheDir, batchOutput, inputCodes, validCodes, { asOf, nameToCode } = {}) {
  const dir = profileDir(cacheDir, 'ai'); fs.mkdirSync(dir, { recursive: true });
  const stat = { written: 0, empty: 0, invalid: 0, missing: [] };
  for (const code of inputCodes) {
    if (!(code in (batchOutput || {}))) { stat.missing.push(code); continue; }
    const p = sanitizeProfile(normalizeAiProfile(batchOutput[code], nameToCode), { validCodes, defaultSrc: 'ai-knowledge' });
    if (!p) { stat.empty++; continue; }
    if (!p.asOf && asOf) p.asOf = asOf;
    const f = path.join(dir, `${code}.json`);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(p)); fs.renameSync(`${f}.tmp`, f);
    stat.written++;
  }
  return stat;
}
