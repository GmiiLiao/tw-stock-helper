#!/usr/bin/env node
// T1 分軌前向影子：多個交易日的收盤歸檔到齊狀態（唯讀；結果印到 stdout 的 JSON，不寫檔、不碰 Firestore、不發網路）。
// 讀 SURGE_CACHE（＝共用快取，a37_tracks_score.basis_for 以環境變數帶入）的 chipArchive.json.gz 一次，逐日交給
// a35_shadow_meta.basisOf（＝canonical-gate.archiveDayStatus＋第三方補洞標記＋模型輸入），與起漲影子名單同一支判斷。
// 用法：SURGE_CACHE=<共用快取> node scripts/surge-lab/a37_tracks_basis.mjs 2026-10-02 2026-10-05 …
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basisOf } from './a35_shadow_meta.mjs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SP = process.env.SURGE_CACHE || fileURLToPath(new URL('./.surge-cache/', import.meta.url));

function main() {
  const days = process.argv.slice(2);
  const bad = days.filter(d => !DAY_RE.test(d));
  if (!days.length || bad.length) throw new Error(`用法：a37_tracks_basis.mjs YYYY-MM-DD …（不合格：${bad.join(',') || '沒有日期'}）`);
  const arr = JSON.parse(gunzipSync(readFileSync(join(SP, 'chipArchive.json.gz'))).toString('utf8'));
  const byDate = new Map((Array.isArray(arr) ? arr : []).filter(x => x && typeof x.date === 'string').map(x => [x.date, x]));
  const out = Object.fromEntries(days.map(d => [d, basisOf(d, byDate.get(d))]));
  process.stdout.write(JSON.stringify(out));
}

try { main(); } catch (e) { console.error(String(e?.message || e)); process.exit(1); }
