#!/usr/bin/env node
// ── 原生 localStorage 呼叫封閉世界（wm-ci-guardrails·2026-09-12 R9）──
// 上游 worldmonitor `scripts/enforce-safe-local-storage.mjs` 的本站版：
// src/ 內任何 `localStorage.getItem|setItem|removeItem|clear|key(` 直接呼叫即紅，
// 唯一入口是 src/lib/safe-storage.ts。掃的是「有沒有直接呼叫」，不是「有沒有包 try」——
// 屬性集合軸的閉世界：新寫的程式碼不必知道規則也會被擋下。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --root：改掃該目錄（pre-commit 以 staged 快照目錄呼叫，2026-10-04 G3-30）；預設＝本 repo（舊版用 cwd 的 src，hook 會先 cd 到 repo 根，結果相同）
const _rootArg = process.argv.indexOf('--root');
const ROOT = resolve(_rootArg > 0 ? process.argv[_rootArg + 1] : fileURLToPath(new URL('..', import.meta.url)));

const ALLOW = new Set([
  'src/lib/safe-storage.ts',       // 唯一入口
  'src/app/global-error.tsx',      // 最後一道錯誤邊界：刻意不 import 任何模組，自帶 try
]);
const RE = /(?<![\w.])localStorage\s*\.\s*(getItem|setItem|removeItem|clear|key)\s*\(/;

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

const hits = [];
for (const abs of walk(join(ROOT, 'src'))) {
  const f = relative(ROOT, abs);
  if (ALLOW.has(f)) continue;
  readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('//')) return;
    if (RE.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 110)}`);
  });
}
if (hits.length) {
  console.error(`❌ 原生 localStorage 呼叫 ${hits.length} 處——改用 @/lib/safe-storage 的 storageGet/storageSet/storageRemove：`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('✓ safe-storage：src/ 無原生 localStorage 呼叫（入口唯一）');
