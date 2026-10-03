#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki 排程入口（LaunchAgent 直接以 node 執行——與 ai-daemon 同模式；
//   用 /bin/bash 跑 ~/Documents 裡的腳本可能被 macOS TCC 擋，2026-10-03 審查）
//   nightly（每晚 23:40）：MOPS 續抓（新鮮快取直接跳過）→ 年報下載 ≤180 檔 → 等 daemon 夜間補判完成且在 02:00–06:30 內才萃取 → AI 入庫 → 重建
//   monthly（每月 1 日 20:30）：強制重抓官方慢變數 → AI 入庫 → 重建
// 任何一步失敗不擋後面（重建只讀本地；資料不完整時重建自己會拒絕覆蓋）。
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || 'nightly';
const ts = () => new Date().toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' });
const step = (label, args) => {
  console.log(`${ts()} ▶ ${label}`);
  const r = spawnSync(process.execPath, ['scripts/build-stock-wiki.mjs', ...args], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) console.log(`${ts()} ⚠ ${label} 未完成（exit ${r.status ?? r.signal}），下次續跑`);
  return r.status === 0;
};

if (mode === 'monthly') {
  step('月更：官方慢變數', ['crawl', '--refresh', '--max-age', '20']);
} else if (mode === 'nightly') {
  step('MOPS 續抓（只抓缺的／過期的）', ['crawl']);
  step('年報下載', ['annual-fetch', '--max', '180']);
  step('年報萃取（等 daemon 夜間補判完成、02:00–06:30）', ['annual-extract', '--wait-window', '--window', '02:00-06:30']);
} else if (mode !== 'build') {
  console.error(`未知模式 ${mode}（nightly｜monthly｜build）`); process.exit(1);
}
step('AI 入庫', ['ai-ingest']);
step('產品×國家入庫（依最新 AI 輪廓重驗名稱）', ['geo-ingest']);
step('重建 wiki', ['build']);
console.log(`${ts()} ✓ 完成（${mode}）`);
