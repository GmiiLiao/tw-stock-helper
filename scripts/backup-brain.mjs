#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 第二大腦備份：Firestore → second-brain/backup/（本地災難備援）
//
// 動機（實案 2026-07-17）：TPEx 歷史 API 靜默污染事件——若當時有本地備份，
// 不需重抓 70 分鐘、也不怕來源改版斷檔。雲端資料的最後一道保險。
//
// 策略（增量、可重跑、冪等）：
//   dated 集合（chipArchive/chipDaily/newsDaily/morningNote/marketReports/
//     premarketBrief/picksHistory）：每 doc 一檔 JSON；已存在即跳過，
//     但「最近 7 天」一律重抓（同日 doc 可能被 daemon 事後修正）。
//   users：每次全量深度匯出（含子集合）——帳號/持倉不可再生，最高優先。
//   大型半靜態集合（finReports/stockHistory/stockPeBand/stockAI/finSummary）：
//     每 doc 一檔，內容變更才寫（比對序列化結果）。
//   singleton latest（其餘 1-doc 集合）：整包寫入 singletons.json（覆蓋）。
//   activity_logs：略過（log 噪音、可捨棄）。
//
// 用法：node scripts/backup-brain.mjs [--full]（--full 忽略「已存在即跳過」）
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'second-brain', 'backup');
const FULL = process.argv.includes('--full');

const DATED = ['chipArchive', 'chipDaily', 'newsDaily', 'morningNote', 'marketReports', 'premarketBrief', 'picksHistory', 'limitUpForecast', 'marketWind', 'sectorWind'];
const CONTENT_DIFF = ['finReports', 'stockHistory', 'stockPeBand', 'stockAI', 'userPerf'];
const SKIP = new Set(['activity_logs', 'users', ...DATED, ...CONTENT_DIFF]);

const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });
const stat = { written: 0, skipped: 0, unchanged: 0 };

function writeIfChanged(file, obj) {
  const next = JSON.stringify(obj);
  try { if (fs.readFileSync(file, 'utf8') === next) { stat.unchanged++; return; } } catch { /* 不存在 */ }
  fs.writeFileSync(file, next);
  stat.written++;
}

// dated：doc id 即日期/期別，舊檔不變；近 7 天重抓（同日可能被修正）
async function backupDated(colId) {
  const dir = path.join(ROOT, colId); ensure(dir);
  const recentCut = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const snap = await db.collection(colId).get();
  for (const d of snap.docs) {
    const file = path.join(dir, `${d.id.replace(/[^\w.-]/g, '_')}.json`);
    const isRecent = d.id >= recentCut; // 日期型 id 字典序即可；非日期 id 永遠視為 recent
    if (!FULL && !isRecent && fs.existsSync(file)) { stat.skipped++; continue; }
    writeIfChanged(file, d.data());
  }
  console.log(`[backup] ${colId}: ${snap.size} docs`);
}

// 內容比對型：每 doc 一檔，變更才寫
async function backupContentDiff(colId) {
  const dir = path.join(ROOT, colId); ensure(dir);
  const snap = await db.collection(colId).get();
  for (const d of snap.docs) writeIfChanged(path.join(dir, `${d.id.replace(/[^\w.-]/g, '_')}.json`), d.data());
  console.log(`[backup] ${colId}: ${snap.size} docs`);
}

// users：深度匯出（含子集合，一層）
async function backupUsers() {
  const dir = path.join(ROOT, 'users'); ensure(dir);
  const snap = await db.collection('users').get();
  for (const d of snap.docs) {
    const out = { _doc: d.data(), _sub: {} };
    for (const sub of await d.ref.listCollections()) {
      const ss = await sub.get();
      out._sub[sub.id] = Object.fromEntries(ss.docs.map((x) => [x.id, x.data()]));
    }
    writeIfChanged(path.join(dir, `${d.id}.json`), out);
  }
  console.log(`[backup] users: ${snap.size} 帳號（含子集合）`);
}

// singleton latest 們：整包一檔
async function backupSingletons() {
  const cols = await db.listCollections();
  const out = {};
  for (const c of cols) {
    if (SKIP.has(c.id)) continue;
    const snap = await c.limit(25).get();
    out[c.id] = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
  }
  ensure(ROOT);
  fs.writeFileSync(path.join(ROOT, 'singletons.json'), JSON.stringify(out));
  console.log(`[backup] singletons.json: ${Object.keys(out).length} 集合`);
}

async function main() {
  const t0 = Date.now();
  ensure(ROOT);
  await backupUsers();                                  // 最高優先：不可再生
  for (const c of DATED) await backupDated(c);
  for (const c of CONTENT_DIFF) await backupContentDiff(c);
  await backupSingletons();
  // 摘要與索引
  const manifest = { at: new Date().toISOString(), stat, full: FULL };
  fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`[backup] 完成：寫入 ${stat.written}、未變 ${stat.unchanged}、跳過 ${stat.skipped}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  process.exit(0);
}
main().catch((e) => { console.error('[backup] 失敗:', e); process.exit(1); });
