#!/usr/bin/env node
// a35_shadow 唯讀：讀站上已發佈的漲停預測 limitUpForecast/pred-{日期}，以 JSON 印到 stdout（不寫任何東西、不寫 Firestore）。
// 用法：GOOGLE_APPLICATION_CREDENTIALS=<金鑰檔> node a35_shadow_site.mjs 2026-10-02 [更多日期…]
// 憑證只走環境變數（由 a35_shadow_lib.site_from_firestore 從 daemon 的 launchd plist 取出後帶入，不印出）。
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const days = process.argv.slice(2).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
if (!days.length) { console.error('需要至少一個 YYYY-MM-DD'); process.exit(2); }
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credPath) { console.error('缺 GOOGLE_APPLICATION_CREDENTIALS'); process.exit(2); }
initializeApp({ credential: cert(JSON.parse(readFileSync(credPath, 'utf8'))) });
const db = getFirestore();
const out = {};
for (const d of days) {
  const snap = await db.collection('limitUpForecast').doc(`pred-${d}`).get();   // 唯讀 get
  if (!snap.exists) continue;
  const x = snap.data();
  out[d] = { dataDate: x.dataDate ?? null, at: x.at ?? null, codes: x.codes ?? [], ranks: x.ranks ?? {}, bCodes: x.bCodes ?? [], canonicalAt: x.canonicalAt ?? null, canonicalBasis: x.canonicalBasis ?? null, canonicalForced: x.canonicalForced ?? null };
}
// 管線輸出滿 64KB 後若直接 exit 會被截斷：等 stdout 寫完再結束
process.stdout.write(JSON.stringify(out), () => process.exit(0));
