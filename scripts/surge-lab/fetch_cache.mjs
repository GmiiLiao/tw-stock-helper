#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 起漲特徵實驗·資料快取（唯讀）：把分析要用的 Firestore 集合匯出成本機檔，之後所有 python 腳本只讀快取。
//   chipArchive（全量）→ chipArchive.json.gz；priceEvents/latest → priceEvents.json；
//   revenueArchive → revenue.json；peerComps/latest.industriesJson → peerComps_industries.json；
//   orderFlowArchive → orderflow.json（大盤委託失衡，僅日層級檢驗用）。
// 不寫入任何 Firestore 文件。用法：node scripts/surge-lab/fetch_cache.mjs [輸出目錄]
//   輸出目錄預設取環境變數 SURGE_CACHE，否則 ./.surge-cache（已列入本目錄 .gitignore）。
// ─────────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const OUT = process.argv[2] || process.env.SURGE_CACHE || join(process.cwd(), '.surge-cache');
mkdirSync(OUT, { recursive: true });
// 憑證只走環境變數 GOOGLE_APPLICATION_CREDENTIALS（不寫死金鑰檔路徑；沒設就用預設應用程式憑證 ADC）
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!getApps().length) initializeApp(credPath ? { credential: cert(JSON.parse(readFileSync(credPath, 'utf8'))) } : {});
const db = getFirestore();

const chip = (await db.collection('chipArchive').orderBy('date', 'asc').get()).docs.map(d => d.data());
writeFileSync(join(OUT, 'chipArchive.json.gz'), gzipSync(JSON.stringify(chip)));
console.log(`chipArchive ${chip.length} 日 ${chip[0]?.date} ~ ${chip.at(-1)?.date}`);

const pe = (await db.collection('priceEvents').doc('latest').get()).data() || null;
writeFileSync(join(OUT, 'priceEvents.json'), JSON.stringify(pe));
console.log(`priceEvents ${pe?.items?.length ?? 0} 件（${pe?.window?.from} ~ ${pe?.window?.to}）`);

const rev = {};
for (const d of (await db.collection('revenueArchive').get()).docs) { const x = d.data(); rev[d.id] = { month: x.month, n: x.n, at: x.at, bySrc: x.bySrc, rows: JSON.parse(x.rowsJson) }; }
writeFileSync(join(OUT, 'revenue.json'), JSON.stringify(rev));
console.log(`revenueArchive ${Object.keys(rev).length} 個月`);

const pc = (await db.collection('peerComps').doc('latest').get()).data();
writeFileSync(join(OUT, 'peerComps_industries.json'), JSON.stringify(JSON.parse(pc.industriesJson)));
console.log('peerComps 產業分類已匯出');

const of = (await db.collection('orderFlowArchive').get()).docs.map(d => ({ id: d.id, ...d.data() }));
writeFileSync(join(OUT, 'orderflow.json'), JSON.stringify(of));
console.log(`orderFlowArchive ${of.length} 日`);
console.log(`→ ${OUT}`);
