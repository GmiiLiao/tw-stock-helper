#!/usr/bin/env node
// 起漲特徵實驗·尾盤五檔歸檔匯出（唯讀）：Firestore bookDepthArchive（daemon 13:20~13:35 累積窗的最後一筆五檔）→ .surge-cache/bookdepth.json.gz
//   每日 { date, mode:'raw'|'slim', byCode:{ code:{bid:[[價,張]…],ask:[[價,張]…]} 或 [委買總張,委賣總張] } }；跳過紀錄（skipped）照列以便看缺漏。
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
const OUT = process.argv[2] || process.env.SURGE_CACHE || join(process.cwd(), '.surge-cache');
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!getApps().length) initializeApp(credPath ? { credential: cert(JSON.parse(readFileSync(credPath, 'utf8'))) } : {});
const docs = (await getFirestore().collection('bookDepthArchive').orderBy('date', 'asc').get()).docs.map(d => d.data());
const out = docs.map(d => ({ date: d.date, mode: d.mode || null, n: d.n ?? 0, skipped: !!d.skipped, byCode: d.byCodeJson ? JSON.parse(d.byCodeJson) : null }));
writeFileSync(join(OUT, 'bookdepth.json.gz'), gzipSync(JSON.stringify(out)));
console.log(`bookDepthArchive ${out.length} 日 ${out[0]?.date} ~ ${out.at(-1)?.date}；有資料 ${out.filter(x => x.byCode).length} 日；raw ${out.filter(x => x.mode === 'raw').length}／slim ${out.filter(x => x.mode === 'slim').length}；跳過 ${out.filter(x => x.skipped).length}`);
process.exit(0);
