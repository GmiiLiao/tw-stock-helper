#!/usr/bin/env node
// API route 封閉世界普查（wm-ci-guardrails Closed-World Gate·WM-SCAN F7·2026-09-04）
//
// 宇宙＝src/app/api/**/route.ts 機械列舉；每支 route 依原始碼判定欄位：
//   methods（GET/POST/PUT/PATCH/DELETE）· auth（requireAdmin/requirePremium/verifyIdToken/cron-auth）· rateLimit · cache 宣告 · upstream
// 規則：
//   ❌ mutating method（POST/PUT/PATCH/DELETE）既無 auth 也無 rateLimit → 違規（除非 route-policy.json 明列豁免＋理由）
//   ⚠ GET 無任何 cache 宣告（cacheHeader/latestDoc/Cache-Control/no-store）→ 警告（Ratchet：數量只能降）
//   ❌ 打外部上游（route 本身或它 import 的 src 模組含已登錄上游網域字面）卻沒有 rateLimit
//      → 違規，除非 route-policy.json 的 exemptUpstreamRateLimit 明列豁免＋理由（2026-10-04·WM-SCAN G1-19／wm-security-model）
//      已知未修的列在 upstreamNoRateLimitKnown（雙向：補上 rateLimit 後要刪掉那一列）
//   ❌ route-policy.json 裡的豁免／已知路徑已不存在或已不適用 → 過期紀錄必須刪（雙向）
//   ❌ 宇宙為 0 → 守衛失效（Vacuous Guard 防護）
// 「上游網域」＝scripts/source-registry.json 中 category 為 official／market-data／news 的 host（infra／self 不算）。
// 用法：node scripts/audit-routes.mjs [--table] [--root <dir>]   exit 1 = 有違規
//   --root：改掃該目錄（pre-commit 以 staged 快照目錄呼叫；預設＝本 repo 工作樹）
//   --selftest：上游偵測與 auth 判定的合成樣本自測
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argVal = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = resolve(argVal('--root') || fileURLToPath(new URL('..', import.meta.url)));
const API = join(ROOT, 'src/app/api');
const POLICY_PATH = join(ROOT, 'scripts/route-policy.json');
const REGISTRY_PATH = join(ROOT, 'scripts/source-registry.json');
const TABLE = process.argv.includes('--table');
const UPSTREAM_CATEGORIES = new Set(['official', 'market-data', 'news']);

export const AUTH_RE = /requireAdmin\(|requirePremium\(|verifyIdToken\(|cron-auth|CRON_SECRET|requireCron\(/;
export const RL_RE = /rateLimit\(/;
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 解析 import 規格到 src 內檔案（@/ 與相對路徑）；套件與找不到的回 null */
function resolveImport(root, fromFile, spec) {
  const base = spec.startsWith('@/') ? join(root, 'src', spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(fromFile), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try { if (statSync(c).isFile()) return c; } catch { /* 下一個候選 */ }
  }
  return null;
}

/** 建立「檔案 → 它（遞迴）碰到的上游網域」查詢；read 可注入以便自測 */
export function makeUpstreamFinder({ root, hosts, read = f => readFileSync(f, 'utf8'), resolver = resolveImport }) {
  const memo = new Map();
  const visit = (file, stack) => {
    if (memo.has(file)) return memo.get(file);
    if (stack.has(file)) return new Set();
    stack.add(file);
    let src = '';
    try { src = read(file); } catch { return new Set(); }
    const found = new Set(hosts.filter(h => src.includes(`://${h}`)));
    for (const m of src.matchAll(IMPORT_RE)) {
      const r = resolver(root, file, m[1] || m[2]);
      if (r) for (const h of visit(r, stack)) found.add(h);
    }
    stack.delete(file);
    memo.set(file, found);
    return found;
  };
  return file => visit(resolve(file), new Set());
}

function selftest() {
  const files = {
    '/r/src/app/api/a/route.ts': "import { x } from '@/lib/up';\nimport type { T } from '@/lib/typesOnly';\nexport async function GET() {}",
    '/r/src/lib/up.ts': "export const x = () => fetch('https://www.twse.com.tw/rwd');",
    '/r/src/lib/typesOnly.ts': "const u = 'https://mis.twse.com.tw/'",
    '/r/src/app/api/b/route.ts': "import { y } from '@/lib/clean';\nexport async function GET() {}",
    '/r/src/lib/clean.ts': "export const y = 1; // https://tw-stock-helper.web.app",
  };
  const resolver = (root, from, spec) => { const p = spec.startsWith('@/') ? `/r/src/${spec.slice(2)}.ts` : null; return p && files[p] ? p : null; };
  const find = makeUpstreamFinder({ root: '/r', hosts: ['www.twse.com.tw', 'mis.twse.com.tw'], read: f => files[f], resolver });
  const a = [...find('/r/src/app/api/a/route.ts')].join(), b = find('/r/src/app/api/b/route.ts').size;
  const ok = a === 'www.twse.com.tw' && b === 0 && AUTH_RE.test('await requirePremium(req)') && !AUTH_RE.test('requirePremiumLevel(x)');
  console.log(ok ? '✓ selftest 通過（上游遞迴偵測、import type 不算、requirePremium 認得）' : `✖ selftest 失敗 a=${a} b=${b}`);
  process.exit(ok ? 0 : 1);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name === 'route.ts') out.push(p);
  }
  return out;
}

function main() {
  const files = existsSync(API) ? walk(API) : [];
  if (files.length === 0) { console.error('❌ route 宇宙為 0——守衛失效'); process.exit(1); }

  const policy = existsSync(POLICY_PATH) ? JSON.parse(readFileSync(POLICY_PATH, 'utf8')) : { exemptMutating: {}, getNoCacheBaseline: 0 };
  const exemptUp = policy.exemptUpstreamRateLimit || {};
  const knownUp = policy.upstreamNoRateLimitKnown || {};
  const registry = existsSync(REGISTRY_PATH) ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) : { sources: [] };
  const upHosts = (registry.sources || []).filter(s => UPSTREAM_CATEGORIES.has(s.category)).map(s => String(s.host).toLowerCase());
  if (!upHosts.length) { console.error('❌ 上游網域清單為 0（scripts/source-registry.json）——上游限流檢查失效'); process.exit(1); }
  const upstreamOf = makeUpstreamFinder({ root: ROOT, hosts: upHosts });

  const rows = files.map(f => {
    const src = readFileSync(f, 'utf8');
    const route = '/' + relative(API, f).replace(/\/route\.ts$/, '');
    const methods = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1]);
    const auth = AUTH_RE.test(src);
    const rl = RL_RE.test(src);
    const cache = /cacheHeader\(|latestDoc\(|Cache-Control|no-store/.test(src);
    const upstream = [...upstreamOf(f)].sort();
    return { route, methods, auth, rl, cache, upstream };
  });

  const violations = [], warns = [], notes = [];
  for (const r of rows) {
    const mutating = r.methods.some(m => m !== 'GET');
    if (mutating && !r.auth && !r.rl && !policy.exemptMutating[r.route]) {
      violations.push(`${r.route} [${r.methods.join(',')}] 無 auth 也無 rateLimit（要豁免請在 scripts/route-policy.json 寫理由）`);
    }
    if (r.methods.includes('GET') && !r.cache) warns.push(r.route);
    if (r.upstream.length && !r.rl) {
      if (exemptUp[r.route]) continue;
      if (knownUp[r.route]) { notes.push(`⚠ 已知未修：${r.route} 打上游（${r.upstream.slice(0, 3).join('、')}）無 rateLimit——${knownUp[r.route]}`); continue; }
      violations.push(`${r.route} 打外部上游（${r.upstream.slice(0, 3).join('、')}${r.upstream.length > 3 ? '…' : ''}）卻沒有 rateLimit——補 rateLimit，或在 route-policy.json exemptUpstreamRateLimit 寫明為何不需要`);
    }
  }
  const byRoute = new Map(rows.map(r => [r.route, r]));
  for (const p of Object.keys(policy.exemptMutating)) if (!byRoute.has(p)) violations.push(`route-policy.json 豁免 ${p} 已不存在——過期紀錄請刪除`);
  for (const [p, why] of Object.entries(exemptUp)) {
    const r = byRoute.get(p);
    if (!r) violations.push(`route-policy.json exemptUpstreamRateLimit ${p} 已不存在——過期紀錄請刪除`);
    else if (!r.upstream.length || r.rl) violations.push(`route-policy.json exemptUpstreamRateLimit ${p} 已不適用（${r.rl ? '已有 rateLimit' : '已不打上游'}）——過期紀錄請刪除（理由原文：${String(why).slice(0, 40)}）`);
  }
  for (const p of Object.keys(knownUp)) {
    const r = byRoute.get(p);
    if (!r) violations.push(`route-policy.json upstreamNoRateLimitKnown ${p} 已不存在——過期紀錄請刪除`);
    else if (!r.upstream.length || r.rl) violations.push(`route-policy.json upstreamNoRateLimitKnown ${p} 已修好（${r.rl ? '已有 rateLimit' : '已不打上游'}）——請刪除這一列（雙向 Ratchet）`);
  }
  if (warns.length > policy.getNoCacheBaseline) violations.push(`GET 無 cache 宣告 ${warns.length} 支 > 基線 ${policy.getNoCacheBaseline}（Ratchet 只能降；新 route 請加 cacheHeader）`);
  if (warns.length < policy.getNoCacheBaseline) violations.push(`GET 無 cache 宣告 ${warns.length} 支 < 基線 ${policy.getNoCacheBaseline}——請把 route-policy.json 的 getNoCacheBaseline 降到 ${warns.length}（雙向 Ratchet）`);

  if (TABLE) {
    console.log('route | methods | auth | rateLimit | cache | upstream');
    for (const r of rows) console.log(`${r.route} | ${r.methods.join(',') || '-'} | ${r.auth ? '✓' : '-'} | ${r.rl ? '✓' : '-'} | ${r.cache ? '✓' : '-'} | ${r.upstream.length ? r.upstream.join(',') : '-'}`);
  }
  const upRows = rows.filter(r => r.upstream.length);
  console.log(`routes ${rows.length}｜mutating ${rows.filter(r => r.methods.some(m => m !== 'GET')).length}｜GET 無 cache 宣告 ${warns.length}（基線 ${policy.getNoCacheBaseline}）｜打上游 ${upRows.length}（有 rateLimit ${upRows.filter(r => r.rl).length}、豁免 ${upRows.filter(r => !r.rl && exemptUp[r.route]).length}、已知未修 ${upRows.filter(r => !r.rl && knownUp[r.route]).length}）`);
  if (warns.length && TABLE) console.log('GET 無 cache：' + warns.join(' '));
  for (const n of notes) console.log(n);
  for (const v of violations) console.log('❌ ' + v);
  if (violations.length) process.exit(1);
  console.log('✓ route 普查通過');
}

if (process.argv.includes('--selftest')) selftest();
else main();
