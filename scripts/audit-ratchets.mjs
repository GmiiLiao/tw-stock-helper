#!/usr/bin/env node
// 已知壞 idiom 的雙向 Ratchet 普查（wm-ci-guardrails Ratchet Inventory·WM-SCAN F15·2026-09-04）
// 目前一條：前端含 setInterval( 但沒接任何輪詢 gate/標準件的檔案數（CLAUDE.md「前端輪詢：加 gate」的量測面）。
// 雙向：多於基線＝新漂移（紅）；少於基線＝基線過期，必須把 scripts/route-policy.json 的 pollNoGateBaseline 降下來（也紅）。
// 用法：node scripts/audit-ratchets.mjs [--list]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const POLICY_PATH = join(ROOT, 'scripts/route-policy.json');
const LIST = process.argv.includes('--list');
const GATE = /shouldPollNow\(|isForeground\(\)|startLiveLoop\(|liveQuoteInterval\(|useSharedPoll\(/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);
if (!files.length) { console.error('❌ src 宇宙為 0——守衛失效'); process.exit(1); }
const stripped = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // 註解裡提到 setInterval 不算
const offenders = files.filter(f => { const s = stripped(readFileSync(f, 'utf8')); return /setInterval\(/.test(s) && !GATE.test(s); }).map(f => relative(ROOT, f));
const policy = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
const base = policy.pollNoGateBaseline ?? 0;
console.log(`setInterval 未接 gate：${offenders.length} 檔（基線 ${base}）`);
if (LIST) for (const f of offenders) console.log('  ' + f);
if (offenders.length > base) { console.log(`❌ 多於基線——新增輪詢請接 shouldPollNow/startLiveLoop（見 CLAUDE.md 前端輪詢）`); process.exit(1); }
if (offenders.length < base) { console.log(`❌ 少於基線——請把 route-policy.json 的 pollNoGateBaseline 降到 ${offenders.length}（雙向 Ratchet）`); process.exit(1); }
console.log('✓ ratchet 通過');
