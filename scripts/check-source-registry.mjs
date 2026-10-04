#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 外部資料來源登錄檢查（wm-source-legitimacy·2026-09-28，WM-SCAN G4-10）
//   掃 src/ 與 scripts/ 的程式碼（git 追蹤＋未追蹤但未忽略的檔，不含測試），抽出所有 http(s) 網域，
//   與 scripts/source-registry.json 比對：
//     ✖ 程式碼出現未登錄的網域                → 失敗（新來源要先登錄並取得使用者裁定）
//     ✖ 登錄但 legitimacy.status 不是 approved → 失敗（pending／rejected 不得上線）
//     ⚠ 登錄了但程式碼已不再使用              → 只提醒（下線的來源可移出登錄）
//   用法：node scripts/check-source-registry.mjs [--selftest] [--root <dir>]
//     --root：改掃該目錄樹（pre-commit 以 staged 快照目錄呼叫——只含已暫存內容，2026-10-04 WM-SCAN G3-30）；
//             預設＝本 repo 的 git 追蹤＋未追蹤但未忽略的檔（人工全掃用）
//   掃描範圍（2026-10-04 WM-SCAN G4-34 起含 .json／.py）：抓取設定也可能放在 JSON（例：官方鏡像 snapshot-registry.json 375 個網址）
//     或 Python 研究腳本。排除的是「資料／產物」而非抓取設定，見 EXCLUDE（每條附理由）。
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const _rootArg = process.argv.indexOf('--root');
const ROOT = resolve(_rootArg > 0 ? process.argv[_rootArg + 1] : join(dirname(fileURLToPath(import.meta.url)), '..'));
const FS_MODE = _rootArg > 0;
const HOST_RE = /https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
const CODE_FILE = /\.(ts|tsx|mjs|js|sh|json|py)$/;
// 不掃的路徑（相對 repo 根）：資料快照、研究產物、本表自己。新增排除要寫理由；抓取設定（會被程式拿去發請求的網址清單）不可排除。
export const EXCLUDE = [
  [/(^|\/)out\//, '研究／建置產物目錄（例 scripts/surge-lab/out），內容是輸出資料不是抓取設定'],
  [/(^|\/)\.surge-cache\//, '起漲研究本機快取（gitignored）'],
  [/(^|\/)node_modules\//, '套件'],
  [/^scripts\/data\//, 'daemon 產出的資料檔（例 attention-calibration.json）'],
  [/^src\/lib\/t187ap03_L_fallback\.json$/, '上游 t187ap03_L 資料快照：580 個網址是各公司官網欄位（資料內容），程式不抓'],
  [/^scripts\/official-mirror\/inventory-[\d-]+\.json$/, '官方資料盤點清單（人讀的盤點，build-registry 只取它的分級／頻率欄位）；實際抓取清單是 snapshot-registry.json 與 adapters-dated.mjs，兩者都在掃描範圍內'],
  [/^scripts\/source-registry\.json$/, '登錄表本身'],
  [/^scripts\/check-source-registry\.mjs$/, '本檢查程式（自測樣本含假網域）'],
  [/\.test\.mjs$/, '測試夾具'],
];
export const isExcluded = rel => EXCLUDE.some(([re]) => re.test(rel));
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

function walkFs(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walkFs(p, out); else out.push(relative(ROOT, p));
  }
  return out;
}

function codeFiles() {
  const all = FS_MODE
    ? [...walkFs(join(ROOT, 'src')), ...walkFs(join(ROOT, 'scripts'))]
    : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
  return all.filter(f => f && CODE_FILE.test(f) && !isExcluded(f));
}

function selftest() {
  const used = new Map([['a.com', ['x']], ['b.com', ['y']]]);
  const r = checkRegistry(used, { sources: [{ host: 'a.com', legitimacy: { status: 'approved' } }, { host: 'c.com', legitimacy: { status: 'pending' } }] });
  const ok = r.unregistered.join() === 'b.com' && r.notApproved.join() === 'c.com' && r.unused.join() === 'c.com'
    && [...hostsIn("fetch('https://Foo.Bar.tw/x'); 'http://localhost:3000' 'https://a.example.org'")].join() === 'foo.bar.tw'
    && CODE_FILE.test('scripts/official-mirror/snapshot-registry.json') && CODE_FILE.test('scripts/surge-lab/x.py')
    && !isExcluded('scripts/official-mirror/snapshot-registry.json') && !isExcluded('scripts/surge-lab/revenue_official.py')
    && isExcluded('scripts/surge-lab/out/shadow_2026-10-03.json') && isExcluded('scripts/data/attention-calibration.json');
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
