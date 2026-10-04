#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts 單元測試＋「測試數不得低於基線」（2026-10-04·WM-SCAN G3-29／G3-25；wm-ci-guardrails Wiring Guard）
//   ① 遞迴收集 scripts/**/*.test.mjs（舊 hook 只收 scripts/lib/*.test.mjs，stock-wiki/ 3 檔 54 例永遠不在閘門內）
//   ② 全部跑完（node --test，TAP 輸出）：有失敗＝紅
//   ③ 檔數與測試例數不得低於 scripts/test-baseline.json（防「刪測試讓閘門變綠」）；高於基線只提醒，不擋
//
// 用法：node scripts/check-test-count.mjs [--root <dir>] [--update] [--selftest]
//   --root：改在該目錄樹跑（pre-commit 以 staged 快照目錄呼叫——未追蹤的別人測試不算、staged 刪掉的測試會被抓到）
//   --update：全部通過時，把基線改成目前的檔數／例數（新增測試後順手更新；刻意刪測試時要在 commit 訊息寫理由）
// 基線檔更新方法：node scripts/check-test-count.mjs --update && git add scripts/test-baseline.json
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const argVal = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = resolve(argVal('--root') || join(dirname(fileURLToPath(import.meta.url)), '..'));
const BASELINE = join(ROOT, 'scripts', 'test-baseline.json');
const SKIP_DIR = /^(node_modules|\.surge-cache|out|\.cache)$/;

/** 遞迴找 *.test.mjs（相對 root、排序） */
export function findTests(root) {
  const out = [];
  const walk = d => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP_DIR.test(n)) walk(p); } else if (n.endsWith('.test.mjs')) out.push(relative(root, p));
    }
  };
  walk(join(root, 'scripts'));
  return out.sort();
}

/** 解析 node --test 的 TAP 摘要（# tests N／# pass N／# fail N） */
export function parseTap(text) {
  const num = k => { const m = String(text).match(new RegExp(`^# ${k} (\\d+)`, 'm')); return m ? Number(m[1]) : null; };
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), cancelled: num('cancelled') };
}

/** 與基線比較：回傳 { ok, problems[], notes[] } */
export function compareBaseline(cur, base) {
  const problems = [], notes = [];
  if (!base) problems.push('找不到 scripts/test-baseline.json（基線遺失＝下限失效）');
  else {
    if (cur.files < base.files) problems.push(`測試檔 ${cur.files} < 基線 ${base.files}——測試檔被刪或沒被收集到`);
    if (cur.tests < base.tests) problems.push(`測試例 ${cur.tests} < 基線 ${base.tests}——測試縮水（刻意刪除請 --update 並在 commit 訊息寫理由）`);
    if (cur.files > base.files || cur.tests > base.tests) notes.push(`高於基線（檔 ${base.files}→${cur.files}、例 ${base.tests}→${cur.tests}）——請 node scripts/check-test-count.mjs --update 把下限跟上`);
  }
  return { ok: !problems.length, problems, notes };
}

function selftest() {
  const tap = 'TAP version 13\nok 1 - a\n# tests 12\n# suites 0\n# pass 12\n# fail 0\n# cancelled 0\n';
  const p = parseTap(tap);
  const a = compareBaseline({ files: 3, tests: 12 }, { files: 3, tests: 12 });
  const b = compareBaseline({ files: 3, tests: 11 }, { files: 3, tests: 12 });
  const c = compareBaseline({ files: 2, tests: 20 }, { files: 3, tests: 12 });
  const d = compareBaseline({ files: 4, tests: 13 }, { files: 3, tests: 12 });
  const ok = p.tests === 12 && p.fail === 0 && a.ok && !b.ok && !c.ok && d.ok && d.notes.length === 1 && !compareBaseline({ files: 1, tests: 1 }, null).ok;
  console.log(ok ? '✓ selftest 通過（TAP 解析、低於基線必紅、高於基線只提醒、基線遺失必紅）' : '✖ selftest 失敗');
  process.exit(ok ? 0 : 1);
}

function main() {
  const files = findTests(ROOT);
  if (!files.length) { console.log('❌ 收集到 0 個測試檔——守衛失效（Vacuous Guard）'); process.exit(1); }
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  const sum = parseTap(r.stdout);
  if (sum.tests == null) { console.log((r.stdout || '').slice(-3000), r.stderr || ''); console.log('❌ 讀不到 node --test 摘要（# tests N）——無法判定，視為失敗'); process.exit(1); }
  if (r.status !== 0 || sum.fail || sum.cancelled) {
    const failLines = String(r.stdout).split('\n').filter(l => /^\s*not ok /.test(l)).slice(0, 20);
    console.log(failLines.join('\n'));
    console.log(`❌ scripts 單元測試失敗：${sum.fail ?? '?'} 例失敗、${sum.cancelled ?? 0} 例取消（共 ${sum.tests}）——node --test ${files.length > 3 ? 'scripts/**/*.test.mjs' : files.join(' ')}`);
    process.exit(1);
  }
  const cur = { files: files.length, tests: sum.tests };
  if (process.argv.includes('--update')) {
    const doc = { files: cur.files, tests: cur.tests, measured: new Date().toISOString().slice(0, 10),
      _doc: '測試數下限（scripts/check-test-count.mjs 讀）。更新：node scripts/check-test-count.mjs --update && git add scripts/test-baseline.json。低於本值 pre-commit 會擋；刻意刪測試要在 commit 訊息寫理由。' };
    writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n');
    console.log(`✓ 基線已更新：${cur.files} 檔 ${cur.tests} 例 → scripts/test-baseline.json`);
    process.exit(0);
  }
  let base = null;
  try { base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null; } catch { base = null; }
  const cmp = compareBaseline(cur, base);
  for (const n of cmp.notes) console.log('ℹ ' + n);
  for (const p of cmp.problems) console.log('❌ ' + p);
  if (!cmp.ok) process.exit(1);
  console.log(`✓ scripts 單元測試通過：${cur.files} 檔 ${cur.tests} 例（基線 ${base.files} 檔 ${base.tests} 例）`);
}

if (process.argv.includes('--selftest')) selftest();
else main();
