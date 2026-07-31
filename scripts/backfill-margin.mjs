#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 融資融券歷史回填 → chipArchive/{date}.marginJson（補齊缺日）
// schema 與 daemon 一致：{code: [融資今日餘額(張), 融券今日餘額(張)]}（上市 MI_MARGN）
// 由新到舊回填：近期 120 日回測窗最先可用。可續跑；TWSE 歷史日期參數正常。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const THROTTLE_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _f = (s) => { const n = parseFloat(String(s ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };

async function main() {
  const snap = await db.collection('chipArchive').get();
  const missing = snap.docs.filter((d) => !d.data().marginJson).map((d) => d.id).sort().reverse(); // 新→舊
  console.log(`[margin] 缺 marginJson 共 ${missing.length} 日，由新到舊回填。`);
  let done = 0, fail = 0;
  for (const iso of missing) {
    const ymd = iso.replace(/-/g, '');
    try {
      const r = await fetch(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd}&selectType=ALL&response=json`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' } });
      const j = JSON.parse(await r.text());
      const mtb = (j?.tables || []).find((t) => (t.data || []).length > 100);
      const margin = {};
      for (const row of (mtb?.data || [])) { const c = (row[0] || '').trim(); if (/^\d{4}$/.test(c)) margin[c] = [Math.round(_f(row[6])), Math.round(_f(row[12]))]; }
      if (Object.keys(margin).length > 100) {
        await db.collection('chipArchive').doc(iso).set({ marginJson: JSON.stringify(margin), marginBackfillAt: Date.now() }, { merge: true });
        done++;
        if (done % 20 === 0) console.log(`[margin] ${done}/${missing.length} …最新補到 ${iso}(${Object.keys(margin).length} 檔)`);
      } else { fail++; console.log(`[margin] ⚠ ${iso} 資料不足(${Object.keys(margin).length})，略過`); }
    } catch (e) { fail++; console.log(`[margin] ⚠ ${iso} 失敗: ${e.message}`); }
    await sleep(THROTTLE_MS);
  }
  console.log(`[margin] 完成：${done} 補齊、${fail} 失敗/不足。`);
  process.exit(0);
}
main().catch((e) => { console.error('[margin] 失敗:', e); process.exit(1); });
