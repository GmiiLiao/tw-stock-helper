// ─────────────────────────────────────────────────────────────────────────────
// daemon 程式碼雜湊（2026-09-28 WM-SCAN G4-02）：ai-daemon.mjs ＋ 它（遞迴）import 的 scripts/lib/*.mjs。
//   舊版只雜湊 ai-daemon.mjs 本檔 ⇒ 只改 scripts/lib 不會觸發「daemon 落後於程式碼」警告。
//   daemon 啟動時寫進 system/daemonBuild；audit-data-sources 用同一個函式算磁碟版比對——兩端必須共用這一份。
//   只追相對路徑的靜態／動態 import（'./lib/x.mjs'、'./x.mjs'），不含 node_modules。
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+\.mjs)['"]/g;

/** 回傳 { hash, files }；files 為納入雜湊的絕對路徑（已排序），hash 取 sha256 前 16 碼 */
export function daemonCodeHash(daemonPath) {
  const seen = new Set();
  const walk = p => {
    const abs = resolve(p);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    const src = readFileSync(abs, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) walk(join(dirname(abs), m[1]));
  };
  walk(daemonPath);
  const files = [...seen].sort();
  const h = createHash('sha256');
  for (const f of files) h.update(f.slice(f.lastIndexOf('/scripts/') + 1)).update('\0').update(readFileSync(f)).update('\0');
  return { hash: h.digest('hex').slice(0, 16), files };
}
