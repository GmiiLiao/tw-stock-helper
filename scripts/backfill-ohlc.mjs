#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// OHLC 補齊：daemon 期 chipArchive.closeJson 只有 [收,量] 2 元素（無開高低），
// 尾盤位置等參數在該段算不出（實案：R2/弱尾盤半窗樣本崩塌）。
// 以官方 MI_INDEX(上市)+TPEx dailyQuotes(上櫃) 補成 5 元素 [收,量,開,高,低]。
// 只處理 2 元素的日子；收盤與量以官方值覆蓋（更權威）。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const THROTTLE = 1400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _f = (s) => { const n = parseFloat(String(s ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const lots = (sh) => Math.round(_f(sh) / 1000);
const H_TW = { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' } };
const H_TP = { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tpex.org.tw/' } };
const J = async (u, h) => { try { const r = await fetch(u, h); return JSON.parse(await r.text()); } catch { return null; } };

async function main() {
  const snap = await db.collection('chipArchive').get();
  const targets = [];
  snap.forEach((d) => {
    const x = d.data(); if (!x.closeJson) return;
    const c = JSON.parse(x.closeJson);
    const first = c[Object.keys(c)[0]];
    if (Array.isArray(first) && first.length < 5) targets.push(d.id);
  });
  targets.sort();
  console.log(`[ohlc] 需補 ${targets.length} 日（${targets[0]} → ${targets[targets.length - 1]}）`);
  let done = 0;
  for (const iso of targets) {
    const d8 = iso.replace(/-/g, '');
    const dSlash = encodeURIComponent(`${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`);
    const close = {};
    const mi = await J(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d8}&type=ALLBUT0999&response=json`, H_TW);
    await sleep(THROTTLE);
    const stk = mi && Array.isArray(mi.tables) ? mi.tables.find((tb) => (tb.fields || []).some((f) => /證券代號/.test(f)) && tb.data && tb.data.length > 200) : null;
    for (const r of (stk?.data || [])) {
      const c = String(r[0] || '').trim(); if (!/^\d{4}$/.test(c)) continue;
      const cl = _f(r[8]); if (!(cl > 0)) continue;
      close[c] = [cl, lots(r[2]), _f(r[5]), _f(r[6]), _f(r[7])];
    }
    const tp = await J(`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${dSlash}&type=EW&id=&response=json`, H_TP);
    await sleep(THROTTLE);
    if (tp && String(tp.date || '') === d8 && Array.isArray(tp.tables?.[0]?.data)) {
      for (const r of tp.tables[0].data) {
        const c = String(r[0] || '').trim(); if (!/^\d{4}$/.test(c)) continue;
        const cl = _f(r[2]); if (!(cl > 0)) continue;
        close[c] = [cl, lots(r[8]), _f(r[4]), _f(r[5]), _f(r[6])];
      }
    }
    if (!close['2330'] || Object.keys(close).length < 500) { console.log(`[ohlc] ⚠ ${iso} 官方資料不足，略過`); continue; }
    await db.collection('chipArchive').doc(iso).set({ closeJson: JSON.stringify(close), ohlcFixedAt: Date.now() }, { merge: true });
    done++;
    if (done % 20 === 0) console.log(`[ohlc] ${done}/${targets.length} …${iso}`);
  }
  console.log(`[ohlc] 完成 ${done}/${targets.length}`);
  process.exit(0);
}
main().catch((e) => { console.error('[ohlc] 失敗:', e); process.exit(1); });
