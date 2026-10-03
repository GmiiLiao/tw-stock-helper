// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki：AI 鋪底的批次輸入／輸出（AI 由 Claude 子代理在對話中執行，這裡只負責檔案契約）
//   輸入  .cache/ai/batches/batch-NNN.json   [{ code, name, fullName, market, industry, mainBusiness, chains, group }]
//   輸出  .cache/ai/out/batch-NNN.json       { code: profile }（子代理寫）
//   入庫  ai-ingest → 驗證後拆成 .cache/profiles/ai/{code}.json
// mainBusiness 是官方錨點：AI 的輪廓必須與它一致，衝突時以官方為準。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { ingestAiBatch, profileDir } from './profiles.mjs';

export const aiDir = (cacheDir, sub) => path.join(cacheDir, 'ai', sub);
const batchName = (i) => `batch-${String(i).padStart(3, '0')}.json`;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** 依代號排序切批；skipDone 時已有 AI 輪廓的代號不再出題 */
export function writeAiBatches(cacheDir, model, { size = 40, skipDone = false } = {}) {
  const dir = aiDir(cacheDir, 'batches'); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^batch-\d+\.json$/.test(f)) fs.unlinkSync(path.join(dir, f));
  const done = skipDone ? new Set(fs.existsSync(profileDir(cacheDir, 'ai')) ? fs.readdirSync(profileDir(cacheDir, 'ai')).map(f => f.replace('.json', '')) : []) : new Set();
  const codes = [...model.stocks.keys()].filter(c => !done.has(c)).sort();
  const batches = [];
  for (let i = 0; i * size < codes.length; i++) {
    const rows = codes.slice(i * size, (i + 1) * size).map(c => {
      const s = model.stocks.get(c);
      return {
        code: c, name: s.name, fullName: s.fullName, market: s.market, industry: s.industry?.name || null,
        mainBusiness: s.mainBusiness, englishName: s.englishName,
        chains: s.chains.map(x => `${x.name}/${x.role}/${x.label}`), group: s.groupId,
      };
    });
    fs.writeFileSync(path.join(dir, batchName(i)), JSON.stringify(rows, null, 1));
    batches.push({ file: batchName(i), first: rows[0].code, last: rows.at(-1).code, n: rows.length, withMainBusiness: rows.filter(r => r.mainBusiness).length });
  }
  return batches;
}

/**
 * 讀所有已完成的輸出批次並入庫：以「輸出裡的代號」為準（不依賴批次切分，宇宙變動也不會錯位）。
 * asOf 取輸出檔的產生月份（不是入庫當天——每晚重入庫不可讓「AI 2026-10」的標籤往後飄）。
 */
export function ingestAllAi(cacheDir, validCodes, { nameToCode } = {}) {
  const inDir = aiDir(cacheDir, 'batches'); const outDir = aiDir(cacheDir, 'out');
  const seen = new Set(); let batches = 0; let written = 0; let empty = 0;
  for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(x => /^batch-\d+\.json$/.test(x)).sort() : []) {
    const file = path.join(outDir, f);
    const out = readJson(file); if (!out || typeof out !== 'object') continue;
    batches++;
    const asOf = new Date(fs.statSync(file).mtimeMs + 8 * 3600000).toISOString().slice(0, 7);
    const codes = Object.keys(out).filter(c => validCodes.has(c));
    const st = ingestAiBatch(cacheDir, out, codes, validCodes, { asOf, nameToCode });
    written += st.written; empty += st.empty; for (const c of codes) seen.add(c);
  }
  const asked = new Set();
  for (const f of fs.existsSync(inDir) ? fs.readdirSync(inDir).filter(x => /^batch-\d+\.json$/.test(x)) : []) for (const r of readJson(path.join(inDir, f)) || []) asked.add(r.code);
  return { batches, written, empty, missing: [...asked].filter(c => !seen.has(c)), pendingBatches: [] };
}
