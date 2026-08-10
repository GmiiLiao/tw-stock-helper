#!/usr/bin/env node
// ── 集保（TDCC）股權分散表 週歸檔 ────────────────────────────────────
//
// 事故（2026-08-10 四源稽核發現）：
//   daemon 的 computeMajorHoldersChange 只寫 `majorHolders/latest`，且是
//   `{ merge: false }` **整份覆蓋**。它保留的歷史深度是「本週 + 上週」兩點，
//   再往前的每一週都被寫掉了。集保是**每週一次**的資料，一年只有 52 個觀測點，
//   覆蓋等於把最稀有的籌碼序列丟進垃圾桶。
//
// ⚠ 三年回補在物理上做不到，這點不要再重試：
//   ① `openapi.tdcc.com.tw/v1/opendata/1-5`（全市場 2.3MB）**忽略 date 參數**
//      ——實測帶 `&date=20250815` 回來的仍是最新週 20260807。
//   ② `www.tdcc.com.tw/portal/zh/smWeb/qryStock` 有歷史週下拉，但
//      **只保留 51 週**（實測最早 2025-08-15），而且是**逐檔查詢**：
//      2,000 檔 × 51 週 = 10 萬次請求，既打不完也不該打。
//   ⇒ 結論：集保的三年歷史**官方就不存在**。唯一正解是從今天起每週存下來，
//     這支腳本存的第一筆就是這條序列的起點。不要在報表上假裝有更早的資料。
//
// 存法：整份分佈壓成一個 doc。每檔存 15 個分級的占比（2 位小數）＋總股東人數，
//       約 200KB，遠低於 Firestore 1MB 單 doc 上限，而且**不丟資訊**——
//       只留「千張比例」這種摘要，之後想回頭算別的分級就沒料了。

import admin from 'firebase-admin';
import { pathToFileURL } from 'node:url';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const URL = 'https://openapi.tdcc.com.tw/v1/opendata/1-5';

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

export async function archiveTdccWeekly(logFn = console.log) {
  let rows = [];
  try {
    const r = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) });
    if (r.ok) rows = await r.json();
  } catch (e) { logFn(`✗ 集保歸檔：抓取失敗 ${e.message}`); return; }
  if (!rows.length) { logFn('✗ 集保歸檔：來源空白'); return; }

  // 來源自報的資料日（BOM 有時黏在第一個欄名上，兩種都要試）——
  // 一律用來源日期當 doc id，絕不用 Date.now()，否則健康稽核會對不上。
  const rawDate = String(rows[0]['﻿資料日期'] ?? rows[0]['資料日期'] ?? '').trim();
  if (!/^\d{8}$/.test(rawDate)) { logFn(`✗ 集保歸檔：資料日期異常 "${rawDate}"`); return; }
  const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;

  // code → { ratios: [15 個分級占比], people: 總股東人數 }
  const byCode = {};
  for (const x of rows) {
    const code = String(x['證券代號'] ?? '').trim().replace(/^0+/, '');
    if (!/^\d{4}$/.test(code)) continue;                       // 濾掉 ETF/權證/受益憑證等非 4 碼
    const lv = parseInt(String(x['持股分級'] ?? ''), 10);
    if (!(lv >= 1 && lv <= 15)) continue;                      // 16/17 是合計列，會重複計人數
    const e = byCode[code] || (byCode[code] = { r: new Array(15).fill(0), p: 0 });
    e.r[lv - 1] = +num(x['占集保庫存數比例%']).toFixed(2);
    e.p += Math.round(num(x['人數']));
  }

  const codes = Object.keys(byCode);
  if (codes.length < 800) { logFn(`✗ 集保歸檔：只解析出 ${codes.length} 檔，疑似來源異常，不寫入`); return; }

  const payload = {};
  for (const c of codes) payload[c] = { r: byCode[c].r, p: byCode[c].p };
  const json = JSON.stringify(payload);

  await db.collection('tdccArchive').doc(date).set({
    date, n: codes.length, distJson: json, bytes: json.length, at: Date.now(),
  });

  // 已存在的舊週不會被這支覆蓋（doc id 是資料日），重跑同一週是冪等的。
  logFn(`✓ 集保週歸檔 ${date}：${codes.length} 檔 × 15 分級，${(json.length / 1024).toFixed(0)}KB`);
}

// ⚠ 本專案路徑含中文（.../股票助手app/...），`file://${process.argv[1]}` 拼出來的字串
//   與 import.meta.url 的**百分比編碼**版本永遠不相等 → 直接跑會靜默什麼都不做。
//   必須經 pathToFileURL 正規化後再比。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  archiveTdccWeekly().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
