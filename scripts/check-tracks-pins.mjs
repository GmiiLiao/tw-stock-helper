#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// T1 分軌前向登錄的實作釘選閘門（pre-commit；審查 HIGH「釘選檔被別的工作階段改了，前向凍結就靜默停擺」）。
//   commit 觸及 registration_t1_tracks_forward.json 的 implementation_pins 任一檔時：staged 內容的 sha256 必須等於登錄值，
//   或 staged 版前向偏差紀錄 DEVIATIONS_t1_tracks_forward.md 已有「PIN-UPDATE: <路徑> <新 sha256>」列——否則擋下。
//   這些檔約到 2027-10（G250）都被前向研究釘住；要改請先寫前向偏差（理由、影響、當下已看過哪些前向結果）並經使用者同意。
// 用法：node scripts/check-tracks-pins.mjs [--root <dir>] [--staged-file <每行一個路徑>] [路徑…]
//   --root：pre-commit 以 staged 快照目錄呼叫；沒有 --staged-file 也沒有路徑參數＝檢查全部釘選檔（手動稽核用）。
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REG_JSON, DEV_LOG, parsePinUpdates, pinViolations } from './lib/tracks-pins.mjs';

const argv = process.argv.slice(2);
const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const ROOT = resolve(val('--root') || join(dirname(fileURLToPath(import.meta.url)), '..'));
const stagedFile = val('--staged-file');
const positional = argv.filter((x, i) => !x.startsWith('--') && !['--root', '--staged-file'].includes(argv[i - 1]));

const regPath = join(ROOT, REG_JSON);
if (!existsSync(regPath)) { console.log(`✓ 釘選閘門：沒有前向登錄（${REG_JSON}），略過`); process.exit(0); }
const pins = JSON.parse(readFileSync(regPath, 'utf8'))?.implementation_pins?.files_sha256 || {};
const staged = stagedFile ? readFileSync(stagedFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : positional.length ? positional : Object.keys(pins);
const shaOf = f => { const p = join(ROOT, f); return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null; };
const updates = parsePinUpdates(existsSync(join(ROOT, DEV_LOG)) ? readFileSync(join(ROOT, DEV_LOG), 'utf8') : '');
const bad = pinViolations({ pins, staged, shaOf, updates });
const touched = staged.filter(f => f in pins);
if (!bad.length) {
  console.log(`✓ 釘選閘門：觸及 ${touched.length} 個 T1 分軌前向釘選檔${touched.length ? `（${touched.join('、')}）` : ''}，sha256 皆符合登錄或 PIN-UPDATE`);
  process.exit(0);
}
console.log('✖ 這些檔被 T1 分軌前向登錄 T1-TRACKS-FWD-2026-10-05 釘選（implementation_pins，約到 2027-10）；改了 sha256，前向凍結會停擺、每天變成永不補產的缺口：');
for (const b of bad) console.log(`   ${b.file}\n     登錄 ${b.registered}\n     現在 ${b.now ?? '（刪除）'}`);
console.log(`  若確定要改（只准修實作錯誤，不准改清單、判定規則或門檻）：先在 ${DEV_LOG} 寫一筆前向偏差（日期、理由、影響、當下已看過哪些前向結果），`);
console.log('  並加一行「PIN-UPDATE: <路徑> <新 sha256>」後一起 commit；這是前向研究的偏差，要先取得使用者同意。');
process.exit(1);
