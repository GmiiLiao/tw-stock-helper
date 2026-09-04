#!/usr/bin/env node
// API route 封閉世界普查（wm-ci-guardrails Closed-World Gate·WM-SCAN F7·2026-09-04）
//
// 宇宙＝src/app/api/**/route.ts 機械列舉；每支 route 依原始碼判定四欄：
//   methods（GET/POST/PUT/PATCH/DELETE）· auth（requireAdmin/verifyIdToken/cron-auth）· rateLimit · cache 宣告
// 規則：
//   ❌ mutating method（POST/PUT/PATCH/DELETE）既無 auth 也無 rateLimit → 違規（除非 route-policy.json 明列豁免＋理由）
//   ⚠ GET 無任何 cache 宣告（cacheHeader/latestDoc/Cache-Control/no-store）→ 警告（Ratchet：數量只能降）
//   ❌ route-policy.json 裡的豁免路徑已不存在 → 過期紀錄必須刪（雙向）
//   ❌ 宇宙為 0 → 守衛失效（Vacuous Guard 防護）
// 用法：node scripts/audit-routes.mjs [--table]   exit 1 = 有違規
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = join(ROOT, 'src/app/api');
const POLICY_PATH = join(ROOT, 'scripts/route-policy.json');
const TABLE = process.argv.includes('--table');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name === 'route.ts') out.push(p);
  }
  return out;
}
const files = walk(API);
if (files.length === 0) { console.error('❌ route 宇宙為 0——守衛失效'); process.exit(1); }

const policy = existsSync(POLICY_PATH) ? JSON.parse(readFileSync(POLICY_PATH, 'utf8')) : { exemptMutating: {}, getNoCacheBaseline: 0 };
const rows = files.map(f => {
  const src = readFileSync(f, 'utf8');
  const route = '/' + relative(API, f).replace(/\/route\.ts$/, '');
  const methods = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1]);
  const auth = /requireAdmin\(|verifyIdToken\(|cron-auth|CRON_SECRET|requireCron\(/.test(src);
  const rl = /rateLimit\(/.test(src);
  const cache = /cacheHeader\(|latestDoc\(|Cache-Control|no-store/.test(src);
  return { route, methods, auth, rl, cache };
});

const violations = [], warns = [];
for (const r of rows) {
  const mutating = r.methods.some(m => m !== 'GET');
  if (mutating && !r.auth && !r.rl) {
    if (policy.exemptMutating[r.route]) continue;
    violations.push(`${r.route} [${r.methods.join(',')}] 無 auth 也無 rateLimit（要豁免請在 scripts/route-policy.json 寫理由）`);
  }
  if (r.methods.includes('GET') && !r.cache) warns.push(r.route);
}
for (const p of Object.keys(policy.exemptMutating)) if (!rows.some(r => r.route === p)) violations.push(`route-policy.json 豁免 ${p} 已不存在——過期紀錄請刪除`);
if (warns.length > policy.getNoCacheBaseline) violations.push(`GET 無 cache 宣告 ${warns.length} 支 > 基線 ${policy.getNoCacheBaseline}（Ratchet 只能降；新 route 請加 cacheHeader）`);
if (warns.length < policy.getNoCacheBaseline) violations.push(`GET 無 cache 宣告 ${warns.length} 支 < 基線 ${policy.getNoCacheBaseline}——請把 route-policy.json 的 getNoCacheBaseline 降到 ${warns.length}（雙向 Ratchet）`);

if (TABLE) {
  console.log('route | methods | auth | rateLimit | cache');
  for (const r of rows) console.log(`${r.route} | ${r.methods.join(',') || '-'} | ${r.auth ? '✓' : '-'} | ${r.rl ? '✓' : '-'} | ${r.cache ? '✓' : '-'}`);
}
console.log(`routes ${rows.length}｜mutating ${rows.filter(r => r.methods.some(m => m !== 'GET')).length}｜GET 無 cache 宣告 ${warns.length}（基線 ${policy.getNoCacheBaseline}）`);
if (warns.length && TABLE) console.log('GET 無 cache：' + warns.join(' '));
for (const v of violations) console.log('❌ ' + v);
if (violations.length) process.exit(1);
console.log('✓ route 普查通過');
