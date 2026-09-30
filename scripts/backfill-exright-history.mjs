#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 除權息歷史還原係數回補（2026-09-30；技術評分 v3 驗證用）
//   起因：priceEvents/latest 只收 ±20% 的結構事件（減資／面額變更），一般除權息（2~6%）從未還原 ⇒
//        高殖利率股在除息日呈現假跳空，污染隔日跳空與 N 日報酬標籤。
//   來源與係數定義見 lib/exright-source.mjs。輸出 scripts/data/exright-history.json（items＝[日期, 代號, factor]）；
//   不寫 Firestore、不動 priceEvents。
//   用法：node scripts/backfill-exright-history.mjs [--from 2022-07-01] [--to 今天]
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchExright } from './lib/exright-source.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const FROM = arg('--from', '2022-07-01');
const TO = arg('--to', new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'data', 'exright-history.json');

const { counts, items } = await fetchExright(FROM, TO);
const doc = { from: FROM, to: TO, fetchedAt: new Date().toISOString(), n: items.length, counts,
  fields: ['除權息日期', '代號', 'factor＝參考價÷前收盤'],
  note: '官方除權除息計算結果表（上市 TWT49U、上櫃 exDailyQ）。事件日之前的價格 × factor ≈ 事件後口徑。',
  items };
writeFileSync(OUT, JSON.stringify(doc) + '\n');
console.log(`✓ 除權息歷史 ${FROM}~${TO}：上市 ${counts.twse.used}/${counts.twse.raw}、上櫃 ${counts.tpex.used}/${counts.tpex.raw}，合計 ${items.length} 件 → scripts/data/exright-history.json`);
