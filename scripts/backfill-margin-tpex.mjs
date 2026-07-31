#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 上櫃資券＋雙市場借券 歷史回填（新→舊，預設近 185 個歸檔日）
//
// 1) TPEx margin/balance   → 併入 chipArchive.marginJson（上櫃 {code:[資餘,券餘]}張）
//    ⚠ TPEx 只認 YYYY/MM/DD＋回應日期回聲驗證（實案教訓）。[6]資餘額、[14]券餘額(張)。
// 2) TPEx margin/sbl [12]  → lendingJson 上櫃借券當日餘額(股→張)
// 3) TWSE TWT93U   [12]    → lendingJson 上市借券當日餘額(股→張)
// chipArchive.{marginJson 併寫, lendingJson 新增}；已處理日跳過（tpexMarginAt 旗標）。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAYS = parseInt(process.env.BF_DAYS || '185');
const THROTTLE = 1300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _f = (s) => { const n = parseFloat(String(s ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const H_TP = { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tpex.org.tw/' } };
const H_TW = { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' } };
const J = async (u, h) => { try { const r = await fetch(u, h); return JSON.parse(await r.text()); } catch { return null; } };

async function main() {
  const snap = await db.collection('chipArchive').get();
  const docs = snap.docs.filter((d) => !d.data().tpexMarginAt).map((d) => d.id).sort().reverse().slice(0, DAYS);
  console.log(`[tpex-mg] 待處理 ${docs.length} 日（新→舊）`);
  let done = 0;
  for (const iso of docs) {
    const d8 = iso.replace(/-/g, '');
    const dSlash = encodeURIComponent(`${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`);
    const [tpm, tps, tw] = [
      await J(`https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${dSlash}&response=json`, H_TP).then(async (x) => { await sleep(THROTTLE); return x; }),
      await J(`https://www.tpex.org.tw/www/zh-tw/margin/sbl?date=${dSlash}&response=json`, H_TP).then(async (x) => { await sleep(THROTTLE); return x; }),
      await J(`https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=${d8}&response=json`, H_TW).then(async (x) => { await sleep(THROTTLE); return x; }),
    ];
    const patch = { tpexMarginAt: Date.now() };
    const ref = db.collection('chipArchive').doc(iso);
    const cur = (await ref.get()).data() || {};

    // 上櫃資券（回聲驗證）
    if (tpm && String(tpm.date || '') === d8 && Array.isArray(tpm.tables?.[0]?.data)) {
      const merged = cur.marginJson ? JSON.parse(cur.marginJson) : {};
      let n = 0;
      for (const r of tpm.tables[0].data) { const c = String(r[0] || '').trim(); if (/^\d{4}$/.test(c)) { merged[c] = [Math.round(_f(r[6])), Math.round(_f(r[14]))]; n++; } }
      if (n > 100) patch.marginJson = JSON.stringify(merged);
    }
    // 借券（上市 TWT93U + 上櫃 sbl，股→張）
    const lend = {};
    if (tw?.stat === 'OK' && Array.isArray(tw.data)) {
      for (const r of tw.data) { const c = String(r[0] || '').trim(); if (/^\d{4}$/.test(c)) lend[c] = Math.round(_f(r[12]) / 1000); }
    }
    if (tps && String(tps.date || '') === d8 && Array.isArray(tps.tables?.[0]?.data)) {
      for (const r of tps.tables[0].data) { const c = String(r[0] || '').trim(); if (/^\d{4}$/.test(c)) lend[c] = Math.round(_f(r[12]) / 1000); }
    }
    if (Object.keys(lend).length > 100) patch.lendingJson = JSON.stringify(lend);

    await ref.set(patch, { merge: true });
    done++;
    if (done % 20 === 0) console.log(`[tpex-mg] ${done}/${docs.length} …最新 ${iso}（資券${patch.marginJson ? '✓' : '—'} 借券${patch.lendingJson ? '✓' : '—'}）`);
  }
  console.log(`[tpex-mg] 完成 ${done} 日。`);
  process.exit(0);
}
main().catch((e) => { console.error('[tpex-mg] 失敗:', e); process.exit(1); });
