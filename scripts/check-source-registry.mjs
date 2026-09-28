#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 外部資料來源登錄檢查（wm-source-legitimacy·2026-09-28，WM-SCAN G4-10）
//   掃 src/ 與 scripts/ 的程式碼（git 追蹤＋未追蹤但未忽略的檔，不含測試），抽出所有 http(s) 網域，
//   與 scripts/source-registry.json 比對：
//     ✖ 程式碼出現未登錄的網域                → 失敗（新來源要先登錄並取得使用者裁定）
//     ✖ 登錄但 legitimacy.status 不是 approved → 失敗（pending／rejected 不得上線）
//     ⚠ 登錄了但程式碼已不再使用              → 只提醒（下線的來源可移出登錄）
//   用法：node scripts/check-source-registry.mjs [--selftest]
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_RE = /https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
const CODE_FILE = /\.(ts|tsx|mjs|js|sh)$/;
const IGNORE_HOST = /^(localhost|127\.0\.0\.1)$|\.localhost$|\.test$|\.example$|(^|\.)example\.(com|org|net)$/;   // RFC 2606 保留網域

export function hostsIn(text) {
  return new Set([...String(text).matchAll(HOST_RE)].map(m => m[1].toLowerCase()).filter(h => !IGNORE_HOST.test(h)));
}

export function checkRegistry(usedByHost, registry) {
  const reg = new Map((registry.sources || []).map(s => [String(s.host).toLowerCase(), s]));
  const unregistered = [...usedByHost.keys()].filter(h => !reg.has(h)).sort();
  const notApproved = [...reg.values()].filter(s => s.legitimacy?.status !== 'approved').map(s => s.host).sort();
  const unused = [...reg.keys()].filter(h => !usedByHost.has(h)).sort();
  return { unregistered, notApproved, unused };
}

function codeFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(f => CODE_FILE.test(f) && !/\.test\.mjs$/.test(f) && f !== 'scripts/check-source-registry.mjs');
}

function selftest() {
  const used = new Map([['a.com', ['x']], ['b.com', ['y']]]);
  const r = checkRegistry(used, { sources: [{ host: 'a.com', legitimacy: { status: 'approved' } }, { host: 'c.com', legitimacy: { status: 'pending' } }] });
  const ok = r.unregistered.join() === 'b.com' && r.notApproved.join() === 'c.com' && r.unused.join() === 'c.com'
    && [...hostsIn("fetch('https://Foo.Bar.tw/x'); 'http://localhost:3000' 'https://a.example.org'")].join() === 'foo.bar.tw';
  console.log(ok ? '✓ selftest 通過' : '✖ selftest 失敗', ok ? '' : JSON.stringify(r));
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--selftest')) selftest();

const registry = JSON.parse(readFileSync(join(ROOT, 'scripts', 'source-registry.json'), 'utf8'));
const used = new Map();
for (const f of codeFiles()) {
  let text; try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  for (const h of hostsIn(text)) (used.get(h) || used.set(h, []).get(h)).push(f);
}
const { unregistered, notApproved, unused } = checkRegistry(used, registry);
for (const h of unregistered) console.log(`✖ 未登錄的外部來源 ${h}（${used.get(h).slice(0, 3).join('、')}）——先登錄 scripts/source-registry.json 並取得使用者裁定`);
for (const h of notApproved) console.log(`✖ 來源 ${h} 合法性未核准（legitimacy.status ≠ approved）`);
for (const h of unused) console.log(`⚠ 已登錄但程式碼未再使用：${h}（下線可移出登錄）`);
if (unregistered.length || notApproved.length) process.exit(1);
console.log(`✓ 外部來源登錄：程式碼 ${used.size} 個網域全數登錄且已核准（登錄 ${registry.sources.length} 筆）`);
