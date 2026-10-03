// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki：產品分類樹（使用者 2026-10-03：一家公司多種產品分佈在不同產業與國家，要能連動）
//
// 問題：AI／年報寫的產品名稱不一致（「銅箔基板(CCL)」「高速銅箔基板」「CCL」各成一頁），
//   名稱比對推導上下游幾乎接不起來；且每家公司只歸一個官方產業，多角化公司（南亞：塑膠＋PCB 材料）
//   在其他產業頁看不到。
// 三段（AI 由 Claude 子代理在對話中執行，這裡只負責檔案契約與驗證）：
//   1. families  全部產品／原料名稱 → 訂「產品族」詞彙表，每族對應 0–2 個官方產業別
//   2. assign    每個名稱歸入一個產品族（依名稱切批）
//   3. canon     同族內的同義詞／寫法變體／窄規格合併成標準名（依族分組切批，同族一定同批才合得起來）
// 建置時 loadTaxonomy 讀三段輸出並驗證（族不在詞彙表、產業不在官方清單 → 丟棄）；查無分類的名稱照舊用原名。
// 分類是 AI 整理，頁面標「AI 分類·待驗」，不進判讀的事實區。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normEntityName } from './profiles.mjs';

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
export const taxDir = (cacheDir, sub = '') => path.join(cacheDir, 'taxonomy', sub);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 1)); };
const nnn = (prefix, i) => `${prefix}-${String(i).padStart(3, '0')}.json`;
const listOut = (dir, prefix) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => new RegExp(`^${prefix}-\\d+\\.json$`).test(f)).sort() : []);
// 新批次編號接在既有輸出之後：輸出檔是唯一儲存，重用 000 會讓子代理覆蓋掉上一輪的結果（2026-10-03 審查）；
// 讀取時依檔名排序、後寫的蓋前面的，所以新一輪的判斷會優先
const nextIndex = (outDir, prefix) => listOut(outDir, prefix).reduce((m, f) => Math.max(m, Number(f.match(/-(\d+)\.json$/)[1]) + 1), 0);
const MAX_FAMILY = 40;
// 不當產品族歸屬目標的官方產業（沒有產品意義）
export const NOT_TARGET = new Set(['其他', '存託憑證']);
const MAX_HOPS = 50;

/** 產品／原料名稱統計：{ name, p: 當產品次數, m: 當原料次數, ex: ['1303 南亞｜塑膠工業', …] }（依出現次數排序） */
export function collectTerms(model) {
  const terms = new Map();
  for (const s of model.stocks.values()) {
    for (const [kind, key] of [['products', 'p'], ['materials', 'm']]) {
      for (const it of s.profile?.[kind] || []) {
        const name = normEntityName(typeof it === 'string' ? it : it?.name);
        if (!name) continue;
        const t = terms.get(name) || terms.set(name, { name, p: 0, m: 0, ex: [] }).get(name);
        t[key]++;
        if (t.ex.length < 3) t.ex.push(`${s.code} ${s.name}｜${s.industry?.name || '未分類'}`);
      }
    }
  }
  return [...terms.values()].sort((a, b) => (b.p + b.m) - (a.p + a.m) || a.name.localeCompare(b.name));
}

export const officialIndustries = (model) => [...model.industries.keys()].filter(n => n !== '未分類' && !NOT_TARGET.has(n));

function copyPrompt(cacheDir, name) {
  const src = path.join(PROMPT_DIR, name);
  if (fs.existsSync(src)) fs.copyFileSync(src, taxDir(cacheDir, name));
}

/** 第 1 段輸入：全部名稱＋官方產業清單 */
export function writeFamilyInput(cacheDir, model) {
  const terms = collectTerms(model);
  fs.mkdirSync(taxDir(cacheDir), { recursive: true });
  // 一行一筆（約 3,000 筆），子代理才讀得完
  fs.writeFileSync(taxDir(cacheDir, 'terms.json'), `[\n${terms.map(t => JSON.stringify([t.name, t.p, t.m])).join(',\n')}\n]\n`);
  writeJson(taxDir(cacheDir, 'industries.json'), officialIndustries(model));
  copyPrompt(cacheDir, 'taxonomy-families.md');
  return { terms: terms.length };
}

/** 第 2 段輸入：名稱切批（skipDone：已歸族的名稱不再出題） */
export function writeAssignBatches(cacheDir, model, { size = 220, skipDone = false } = {}) {
  const dir = taxDir(cacheDir, 'assign'); fs.mkdirSync(dir, { recursive: true });
  for (const f of listOut(dir, 'assign')) fs.unlinkSync(path.join(dir, f));
  // 已完成＝歸到「詞彙表裡現存的族」；歸到已被刪的族不算完成，要重問
  const done = skipDone ? readAssignments(cacheDir, readFamilies(cacheDir)) : new Map();
  const terms = collectTerms(model).filter(t => !done.has(t.name)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  const files = []; const base = nextIndex(taxDir(cacheDir, 'assign-out'), 'assign');
  for (let i = 0; i * size < terms.length; i++) {
    writeJson(path.join(dir, nnn('assign', base + i)), terms.slice(i * size, (i + 1) * size));
    files.push(nnn('assign', base + i));
  }
  copyPrompt(cacheDir, 'taxonomy-assign.md');
  return files;
}

/** 讀第 1 段輸出：產品族詞彙表（給 allowedIndustries 時，產業不在清單的丟掉；建置時由 product-links 再對官方產業過濾一次） */
export function readFamilies(cacheDir, allowedIndustries = null) {
  const allowed = allowedIndustries ? new Set(allowedIndustries) : null;
  const out = new Map();
  for (const f of readJson(taxDir(cacheDir, 'families.json')) || []) {
    const name = normEntityName(String(f?.family || '').trim()).slice(0, MAX_FAMILY);
    if (!name || out.has(name)) continue;
    const industries = [...new Set((Array.isArray(f.industries) ? f.industries : []).filter(i => typeof i === 'string' && (!allowed || allowed.has(i))))].slice(0, 2);
    out.set(name, { name, industries, desc: String(f.desc || '').trim().slice(0, 60) });
  }
  return out;
}

/** 讀第 2 段輸出：名稱 → 產品族（只收詞彙表裡有的族；families 不給就不檢查） */
export function readAssignments(cacheDir, families = null) {
  const out = new Map();
  const dir = taxDir(cacheDir, 'assign-out');
  for (const f of listOut(dir, 'assign')) {
    for (const [name, fam] of Object.entries(readJson(path.join(dir, f)) || {})) {
      const n = normEntityName(name); const fm = normEntityName(String(fam || '')).slice(0, MAX_FAMILY);
      if (!n || !fm || (families && !families.has(fm))) continue;
      out.set(n, fm);
    }
  }
  return out;
}

/** 第 3 段輸入：依族分組切批（同族必在同批，否則跨批的同義詞合不起來） */
export function writeCanonBatches(cacheDir, { maxNames = 320 } = {}) {
  const dir = taxDir(cacheDir, 'canon'); fs.mkdirSync(dir, { recursive: true });
  for (const f of listOut(dir, 'canon')) fs.unlinkSync(path.join(dir, f));
  const byFam = new Map();
  for (const [name, fam] of readAssignments(cacheDir)) (byFam.get(fam) || byFam.set(fam, []).get(fam)).push(name);
  const fams = [...byFam.entries()].filter(([, ns]) => ns.length > 1).sort((a, b) => a[0].localeCompare(b[0], 'zh-Hant'));
  const files = []; let cur = {}; let n = 0; const base = nextIndex(taxDir(cacheDir, 'canon-out'), 'canon');
  const flush = () => { if (!n) return; const f = nnn('canon', base + files.length); writeJson(path.join(dir, f), cur); files.push(f); cur = {}; n = 0; };
  for (const [fam, names] of fams) {
    if (n && n + names.length > maxNames) flush();
    cur[fam] = names.sort((a, b) => a.localeCompare(b, 'zh-Hant')); n += names.length;
  }
  flush();
  copyPrompt(cacheDir, 'taxonomy-canon.md');
  return files;
}

/** 讀第 3 段輸出：名稱 → 標準名 */
export function readCanon(cacheDir) {
  const out = new Map();
  const dir = taxDir(cacheDir, 'canon-out');
  for (const f of listOut(dir, 'canon')) {
    for (const [name, canon] of Object.entries(readJson(path.join(dir, f)) || {})) {
      const n = normEntityName(name); const c = normEntityName(String(canon || '')).slice(0, 40);
      if (n && c && n !== c) out.set(n, c);
    }
  }
  return out;
}

/**
 * 組成查詢器。termOf(name) → { canon, family, industries }；沒分類就 { canon: 原名, family: null, industries: [] }。
 * 標準名可能鏈式指向（a→b→c），一路跟到不動點；遇到環（a→b→a）取環上字典序最小者，
 * 讓環上每個名稱都解析到同一個標準名；跨族的合併不接受（族不同就不是同一個東西）。
 */
export function makeTaxonomy({ families = new Map(), assign = new Map(), canon = new Map() } = {}) {
  const resolve = (n) => {
    const fam = assign.get(n) || null;
    const trail = [n]; let c = n;
    for (let i = 0; i < MAX_HOPS; i++) {
      const next = canon.get(c);
      if (!next || next === c) break;
      const nf = assign.get(next);
      if (fam && nf && nf !== fam) break;
      const seen = trail.indexOf(next);
      if (seen >= 0) { c = trail.slice(seen).sort((a, b) => a.localeCompare(b))[0]; break; }
      trail.push(next); c = next;
    }
    return { canon: c, family: fam || assign.get(c) || null };
  };
  const cache = new Map();
  const termOf = (name) => {
    const n = normEntityName(name);
    if (!cache.has(n)) {
      const r = resolve(n);
      cache.set(n, { ...r, industries: r.family ? families.get(r.family)?.industries || [] : [] });
    }
    return cache.get(n);
  };
  return { families, termOf, size: assign.size };
}

export function loadTaxonomy(cacheDir, allowedIndustries = null) {
  const families = readFamilies(cacheDir, allowedIndustries);
  return makeTaxonomy({ families, assign: readAssignments(cacheDir, families), canon: readCanon(cacheDir) });
}
