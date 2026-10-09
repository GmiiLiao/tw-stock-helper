#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 相對 import 存在性檢查（2026-10-04 審查 M3）
//   事故型：只暫存 ai-daemon.mjs、它 import 的新 lib 還是未追蹤 ⇒ commit 照過，HEAD 的 daemon 缺檔、launchd 拉起即 crash。
//   pre-commit 以 staged 快照（--root）呼叫：快照裡只有 index 的內容，未暫存的新檔不存在 ⇒ 這裡會紅並列出。
// 規則：
//   scripts/**/*.mjs|js：相對 import（'./' '../'）依 Node ESM 規則——**必須寫明副檔名**、路徑必須是存在的檔案（不做 index／副檔名補全）。
//   src/**/*.ts|tsx：相對與 '@/'（→ src/）依 TS bundler 解析——原樣、.ts、.tsx、.d.ts、.js、.mjs、.json、/index.ts(x)；寫明副檔名者照原樣找。
//   套件（'next/server'、'node:fs'）不檢查；字串樣板組的動態 import 不檢查（只認字串字面值）。註解裡的 import 不算。
// 用法：node scripts/check-imports.mjs [--root <dir>] [--selftest]
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argVal = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = resolve(argVal('--root') || join(dirname(fileURLToPath(import.meta.url)), '..'));
const SKIP_DIR = /^(node_modules|\.surge-cache|out|\.cache|\.next)$/;
// 靜態：行首 import／export … from '...'（可跨行，中間不含引號）與副作用 import '...'；動態：import('...')。
// 測試夾具／自測樣本把 import 寫在字串裡——動態 import 前面同一行若有奇數個 " 或 `，視為在字串內不算。
const STATIC_RE = /^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1|^\s*import\s*(['"])([^'"\n]+)\3/gm;
const DYN_RE = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const inString = (src, idx) => { const line = src.slice(src.lastIndexOf('\n', idx) + 1, idx); return ((line.match(/"/g) || []).length % 2 === 1) || ((line.match(/`/g) || []).length % 2 === 1); };

/** 去掉區塊註解與「行首或空白後」的 // 註解（不誤砍 'https://'） */
export const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, '$1');

export function specsIn(src) {
  const t = stripComments(src);
  const out = [];
  for (const m of t.matchAll(STATIC_RE)) out.push({ i: m.index, s: m[2] ?? m[4] });
  for (const m of t.matchAll(DYN_RE)) if (!inString(t, m.index)) out.push({ i: m.index, s: m[2] });
  return out.sort((a, b) => a.i - b.i).map(x => x.s);
}

const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };

/** 回傳缺檔原因字串，或 null（存在／非本地 import） */
export function checkSpec(root, file, spec, exists = isFile) {
  const isSrc = /\.(ts|tsx)$/.test(file);
  let base;
  if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(file), spec);
  else if (isSrc && spec.startsWith('@/')) base = join(root, 'src', spec.slice(2));
  else return null;
  if (!isSrc) {
    // .ts／.mts：Node ≥22.18／23.6 內建型別剝除可直接載入（例：scripts/verify-surge-v2-format.mjs 測 src/lib 的純函式）——有寫明副檔名就照樣驗存在
    if (!/\.(mjs|js|cjs|json|ts|mts)$/.test(spec)) return `「${spec}」沒寫副檔名（Node ESM 不補全）`;
    return exists(base) ? null : `「${spec}」找不到 ${relative(root, base)}`;
  }
  const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}.js`, `${base}.mjs`, `${base}.json`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return cands.some(c => exists(c)) ? null : `「${spec}」找不到 ${relative(root, base)}（.ts/.tsx/index 皆無）`;
}

function walk(dir, re, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP_DIR.test(n)) walk(p, re, out); } else if (re.test(n) && !n.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

export function runCheck(root = ROOT) {
  const files = [...walk(join(root, 'scripts'), /\.(mjs|js)$/), ...walk(join(root, 'src'), /\.(ts|tsx)$/)];
  const problems = [];
  for (const f of files) {
    let src; try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const s of specsIn(src)) { const why = checkSpec(root, f, s); if (why) problems.push(`${relative(root, f)}：${why}`); }
  }
  return { files: files.length, problems };
}

function selftest() {
  const have = new Set(['/r/scripts/lib/a.mjs', '/r/src/lib/x.ts', '/r/src/c/index.tsx', '/r/scripts/data/d.json']);
  const ex = p => have.has(p);
  const src = ["import { a } from './lib/a.mjs';", 'import b', "  from './lib/b.mjs';", "// import z from './lib/zz.mjs';", "const c = await import('./lib/c');",
    "import 'node:fs';", "export * from './lib/a.mjs';", "const u = 'https://x.example'; /* import('./gone.mjs') */", 'const fx = "import q from \'./lib/q.mjs\'; await import(\'./lib/q2.mjs\')";'].join('\n');
  const specs = specsIn(src);
  const miss = specs.map(s => checkSpec('/r', '/r/scripts/m.mjs', s, ex)).filter(Boolean);
  const ok = specs.join() === './lib/a.mjs,./lib/b.mjs,./lib/c,node:fs,./lib/a.mjs'
    && miss.length === 2 && miss.some(m => m.includes('b.mjs')) && miss.some(m => m.includes('副檔名'))
    && checkSpec('/r', '/r/src/app/p.tsx', '@/lib/x', ex) === null && checkSpec('/r', '/r/src/app/p.tsx', '../c', ex) === null
    && checkSpec('/r', '/r/src/app/p.tsx', '@/lib/missing', ex) !== null && checkSpec('/r', '/r/scripts/m.mjs', './data/d.json', ex) === null
    && checkSpec('/r', '/r/scripts/m.mjs', '../src/lib/x.ts', ex) === null && /找不到/.test(checkSpec('/r', '/r/scripts/m.mjs', '../src/lib/y.ts', ex) || '');
  console.log(ok ? '✓ selftest 通過（缺檔、缺副檔名、註解不算、@/ 與 index 解析、scripts 明寫 .ts）' : `✖ selftest 失敗 ${JSON.stringify({ specs, miss })}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--selftest')) selftest();
else {
  const { files, problems } = runCheck();
  if (!files) { console.log('❌ 掃描到 0 個檔案——守衛失效'); process.exit(1); }
  if (problems.length) {
    console.log(`❌ 相對 import 指向不存在的檔 ${problems.length} 處（staged 快照裡沒有——新檔忘了 git add？）：`);
    for (const p of problems.slice(0, 50)) console.log('  ' + p);
    process.exit(1);
  }
  console.log(`✓ 相對 import 存在性：${files} 檔全數解析得到`);
}
