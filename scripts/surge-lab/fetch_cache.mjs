#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 起漲特徵實驗·資料快取（唯讀）：把分析要用的 Firestore 集合匯出成本機檔，之後所有 python 腳本只讀快取。
//   chipArchive（全量）→ chipArchive.json.gz；priceEvents/latest → priceEvents.json；
//   revenueArchive → revenue.json；peerComps/latest.industriesJson → peerComps_industries.json；
//   orderFlowArchive → orderflow.json（大盤委託失衡，僅日層級檢驗用）。
// 不寫入任何 Firestore 文件。用法：node scripts/surge-lab/fetch_cache.mjs [輸出目錄]（從任何目錄執行皆可）
//   輸出目錄：命令列參數 > 環境變數 SURGE_CACHE > 本檔所在目錄的 .surge-cache（＝panel.py／build.py 的預設讀取處，已 gitignore）。
//   ⚠ 2026-10-04 前預設是 process.cwd()/.surge-cache：在 repo 根目錄執行會寫到未 gitignore 的 tw-stock-app/.surge-cache，
//     研究快取不更新、面板不延伸（RUNBOOK 照抄過這個寫法）。
//   每個檔先寫暫存檔再 rename：panel.py／影子名單同時在讀時不會讀到半套。
//   priceEvents.json 是**累積檔**（2026-10-04 審查）：daemon 的 priceEvents/latest 只是最近約 90 個交易日的滾動視窗、每天整份覆寫，
//     直接覆寫會讓較舊的減資／面額變更事件逐日流失（還原價出現假跳空、被判成結構斷點，訓練列靜默改變）。
//     合併規則見 scripts/lib/surge-shadow-daily.mjs mergePriceEvents：視窗內以 daemon 為準、視窗之前的舊事件永遠保留、讀不到就沿用舊檔。
// ─────────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergePriceEvents } from '../lib/surge-shadow-daily.mjs';

const OUT = process.argv[2] || process.env.SURGE_CACHE || fileURLToPath(new URL('./.surge-cache/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const write = (name, data) => { const p = join(OUT, name); const tmp = `${p}.tmp${process.pid}`; writeFileSync(tmp, data); renameSync(tmp, p); };
// 憑證只走環境變數 GOOGLE_APPLICATION_CREDENTIALS（不寫死金鑰檔路徑；沒設就用預設應用程式憑證 ADC）
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!getApps().length) initializeApp(credPath ? { credential: cert(JSON.parse(readFileSync(credPath, 'utf8'))) } : {});
const db = getFirestore();

const chip = (await db.collection('chipArchive').orderBy('date', 'asc').get()).docs.map(d => d.data());
write('chipArchive.json.gz', gzipSync(JSON.stringify(chip)));
console.log(`chipArchive ${chip.length} 日 ${chip[0]?.date} ~ ${chip.at(-1)?.date}`);

const pe = (await db.collection('priceEvents').doc('latest').get()).data() || null;
const pePath = join(OUT, 'priceEvents.json');
let pePrev = null;
if (existsSync(pePath)) { try { pePrev = JSON.parse(readFileSync(pePath, 'utf8')); } catch (e) { throw new Error(`既有 priceEvents.json 讀不到（${e.message}）——不覆寫累積檔，請人工檢查`); } }
const peM = mergePriceEvents(pePrev, pe);
if (peM.doc) write('priceEvents.json', JSON.stringify(peM.doc));
console.log(peM.staleIfError
  ? `⚠ priceEvents/latest 讀不到或沒有 items——沿用既有累積檔（${peM.kept} 件）`
  : `priceEvents daemon 視窗 ${pe.items.length} 件（${pe.window?.from} ~ ${pe.window?.to}）＋視窗前累積 ${peM.kept} 件 ＝ ${peM.doc.items.length} 件（新增 ${peM.added}、視窗內 daemon 撤銷 ${peM.dropped}）`);

const rev = {};
for (const d of (await db.collection('revenueArchive').get()).docs) { const x = d.data(); rev[d.id] = { month: x.month, n: x.n, at: x.at, bySrc: x.bySrc, rows: JSON.parse(x.rowsJson) }; }
write('revenue.json', JSON.stringify(rev));
console.log(`revenueArchive ${Object.keys(rev).length} 個月`);

const pc = (await db.collection('peerComps').doc('latest').get()).data();
write('peerComps_industries.json', JSON.stringify(JSON.parse(pc.industriesJson)));
console.log('peerComps 產業分類已匯出');

const of = (await db.collection('orderFlowArchive').get()).docs.map(d => ({ id: d.id, ...d.data() }));
write('orderflow.json', JSON.stringify(of));
console.log(`orderFlowArchive ${of.length} 日`);
console.log(`→ ${OUT}`);
