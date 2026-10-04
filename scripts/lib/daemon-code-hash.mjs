// ─────────────────────────────────────────────────────────────────────────────
// daemon 程式碼雜湊（2026-09-28 WM-SCAN G4-02）：ai-daemon.mjs ＋ 它（遞迴）import 的 scripts/lib/*.mjs。
//   舊版只雜湊 ai-daemon.mjs 本檔 ⇒ 只改 scripts/lib 不會觸發「daemon 落後於程式碼」警告。
//   daemon 啟動時寫進 system/daemonBuild；audit-data-sources 用同一個函式算磁碟版比對——兩端必須共用這一份。
//   只追相對路徑的靜態／動態 import（'./lib/x.mjs'、'./x.mjs'），不含 node_modules。
//
// 2026-10-04（WM-SCAN G4-30）：也納入 daemon 以 execScript('x.mjs', …) 拉起的子腳本（及其遞迴 import）。
//   子腳本每次都從磁碟執行（audit-data-sources、backup-brain…），改了它們卻沒重啟 daemon 時，舊版雜湊照樣一致。
//   清單由 ai-daemon.mjs 原始碼**機械推導**（execScript 第一個參數的字串字面值）；推導失敗——
//   有任何呼叫點的第一個參數不是字串字面值、或推導出的檔案不存在、或一個都推不出來——就退回「scripts/ 頂層全部 .mjs」，
//   寧可多算（多報一次落後）也不漏算。結果帶 derivation 說明走哪一條。
// ⚠ 本函式改了口徑後，執行中 daemon（舊口徑寫的 codeHash）與稽核（新口徑）必然不一致——那正確地代表
//   「磁碟上的雜湊程式已變、daemon 尚未重啟」（本檔本身就在雜湊集合內），重啟後即一致。
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+\.mjs)['"]/g;
// execScript 呼叫點：第一個參數（到逗號或右括號為止）
const EXEC_CALL_RE = /\bexecScript\(\s*([^,)]*)/g;
const LITERAL_RE = /^(['"])([\w./-]+\.mjs)\1$/;

/** 去掉整行或行尾的 // 註解（前面須是行首或空白，避免誤砍 'https://'），讓註解裡的 `execScript(...)` 不被當成呼叫點 */
const stripLineComments = src => src.replace(/(^|\s)\/\/.*$/gm, '$1');

/**
 * 由 daemon 原始碼推導 execScript 子腳本清單。
 * @returns {{ scripts: string[], ok: boolean, reason: string }} scripts＝相對 daemon 目錄的檔名（已去重排序）
 */
export function deriveExecScripts(daemonSrc, exists = () => true) {
  const src = stripLineComments(String(daemonSrc));
  const names = new Set(); const bad = [];
  for (const m of src.matchAll(EXEC_CALL_RE)) {
    const before = src.slice(Math.max(0, m.index - 9), m.index);
    if (/function\s*$/.test(before)) continue;   // function execScript(name, …) 定義本身
    const arg = m[1].trim();
    const lit = arg.match(LITERAL_RE);
    if (lit) names.add(lit[2]); else bad.push(arg.slice(0, 40) || '(空)');
  }
  const scripts = [...names].sort();
  if (bad.length) return { scripts, ok: false, reason: `非字面值參數 ${bad.length} 處（例 ${bad[0]}）` };
  if (!scripts.length) return { scripts, ok: false, reason: '推導出 0 支子腳本' };
  const missing = scripts.filter(s => !exists(s));
  if (missing.length) return { scripts, ok: false, reason: `推導出的子腳本不存在：${missing.slice(0, 3).join('、')}` };
  return { scripts, ok: true, reason: `由 execScript 字面值推導 ${scripts.length} 支` };
}

/** 回傳 { hash, files, children, derivation }；files 為納入雜湊的絕對路徑（已排序），hash 取 sha256 前 16 碼 */
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

  const dir = dirname(resolve(daemonPath));
  let children = [], derivation;
  try {
    const d = deriveExecScripts(readFileSync(daemonPath, 'utf8'), n => existsSync(join(dir, n)));
    if (d.ok) { children = d.scripts; derivation = d.reason; }
    else {
      children = readdirSync(dir).filter(n => n.endsWith('.mjs')).sort();
      derivation = `推導失敗（${d.reason}）⇒ 退回納入 scripts/ 頂層全部 ${children.length} 支 .mjs`;
    }
  } catch (e) {
    children = existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.mjs')).sort() : [];
    derivation = `推導例外（${(e.message || '').slice(0, 60)}）⇒ 退回納入 scripts/ 頂層全部 ${children.length} 支 .mjs`;
  }
  for (const c of children) walk(join(dir, c));

  const files = [...seen].sort();
  const h = createHash('sha256');
  for (const f of files) h.update(f.slice(f.lastIndexOf('/scripts/') + 1)).update('\0').update(readFileSync(f)).update('\0');
  return { hash: h.digest('hex').slice(0, 16), files, children, derivation };
}
