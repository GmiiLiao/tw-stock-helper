#!/usr/bin/env node
// 把本機定版的每日熱力（second-brain/daily-heatmap/latest.json 指向的那天）發佈到 Firestore，供站上「最後交易日報告頁」讀取。
//   dailyHeatmap/latest ＋ dailyHeatmap/{資料日}；同一份定版（canonicalAt 相同）不重寫。
//   Firestore 不允許巢狀陣列 ⇒ 不發佈緊湊陣列 stocks（只留在本機檔）。只發官方資料衍生的描述，不含任何分數欄位。
//   node scripts/publish-daily-heatmap.mjs [--dry-run] [--force] [--root <second-brain>]
import admin from 'firebase-admin';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { buildReport } from './lib/daily-heatmap/narrative.mjs';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force'); // 同一份定版但發佈內容改版（例如新增 report 欄）時重發
const ri = argv.indexOf('--root');
const ROOT = ri >= 0 ? argv[ri + 1] : join(HERE, '..', 'second-brain');
const DIR = join(ROOT, 'daily-heatmap');

const latestF = join(DIR, 'latest.json');
if (!existsSync(latestF)) { console.error('無 latest.json：尚無定版，不發佈'); process.exit(2); }
const latest = JSON.parse(readFileSync(latestF, 'utf8'));
const man = JSON.parse(readFileSync(join(DIR, '_manifest.json'), 'utf8')).rows[latest.dataDate];
if (!man || man.status !== 'final') { console.error(`${latest.dataDate} manifest 非 final，不發佈`); process.exit(2); }

const payload = JSON.parse(gunzipSync(readFileSync(join(DIR, man.file))).toString('utf8'));
const { stocks: _omit, ...pub } = payload;
const doc = {
  ...pub, dataDate: latest.dataDate, canonicalAt: latest.canonicalAt, usableForNextDayBrief: latest.usableForNextDayBrief,
  degraded: man.degraded || [], groupingAsOf: man.groupingAsOf ?? null, residualGrade: payload.index?.grade ?? null,
  // 文字版盤後分析報告（模板產生、零 LLM、零預測）；頁面「分析報告」分頁直接顯示
  report: buildReport(payload),
};
const bytes = Buffer.byteLength(JSON.stringify(doc));
if (bytes > 900_000) { console.error(`文件 ${bytes}B 逼近 1MB，不發佈（請改壓縮分片）`); process.exit(2); }

if (DRY) { console.log(`dry-run：${latest.dataDate}，${(bytes / 1024).toFixed(0)}KB，欄位 ${Object.keys(doc).join(',')}`); process.exit(0); }

process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();
const cur = await db.collection('dailyHeatmap').doc('latest').get();
if (!FORCE && cur.exists && cur.data().canonicalAt === doc.canonicalAt && cur.data().dataDate === doc.dataDate) {
  console.log(`skip：${doc.dataDate}（canonicalAt 相同）已發佈`); process.exit(0);
}
// 不讓較舊的資料日蓋掉較新的 latest
if (cur.exists && cur.data().dataDate > doc.dataDate) { console.error(`latest 已是較新的 ${cur.data().dataDate}，不覆蓋`); process.exit(2); }
await db.collection('dailyHeatmap').doc(doc.dataDate).set(doc);
await db.collection('dailyHeatmap').doc('latest').set(doc);
console.log(`✓ 已發佈 dailyHeatmap/latest、dailyHeatmap/${doc.dataDate}（${(bytes / 1024).toFixed(0)}KB）`);
