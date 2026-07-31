#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 當沖統計歷史回填（TWSE TWTB4U·上市·每日每股當日沖銷成交股數）
// 寫入 chipArchive/{date} 的 dayTradeJson {code: 沖銷張}（merge，不動其他欄位）。
// 當沖比率 = 沖銷張 / closeJson 當日量張（screen 時現算，不重複儲存）。
// 防呆：回應 date 回聲必須等於請求日（TWSE 會回聲；非交易日 stat 非 OK 自動跳過）。
// 用法：node scripts/backfill-daytrade.mjs [--days=480] [--force]
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 480);
const FORCE = process.argv.includes('--force');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS).get();
  const targets = snap.docs.map(d => ({ id: d.id, has: !!d.data().dayTradeJson }))
    .filter(d => FORCE || !d.has)
    .sort((a, b) => a.id.localeCompare(b.id));
  console.log(`[daytrade] 待回填 ${targets.length} 日（chipArchive 近 ${DAYS} 日中缺 dayTradeJson 者）`);
  let ok = 0, skip = 0, fail = 0;
  for (const t of targets) {
    const d8 = t.id.replace(/-/g, '');
    try {
      const r = await fetch(`https://www.twse.com.tw/exchangeReport/TWTB4U?response=json&date=${d8}&selectType=All`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/zh/trading/day-trading/statistics-day.html' },
      });
      if (!r.ok) { fail++; await sleep(3000); continue; }
      const j = await r.json();
      if (j.stat !== 'OK' || j.date !== d8) { skip++; await sleep(1200); continue; }   // 回聲驗證
      const tbl = (j.tables || []).find(x => (x.fields || []).includes('證券代號'));
      if (!tbl?.data?.length) { skip++; await sleep(1200); continue; }
      const iCode = tbl.fields.indexOf('證券代號');
      const iVol = tbl.fields.findIndex(f => /成交股數/.test(f));
      const by = {};
      for (const row of tbl.data) {
        const code = String(row[iCode] || '').trim();
        if (!/^\d{4}$/.test(code)) continue;
        const lots = Math.round(parseFloat(String(row[iVol] || '0').replace(/,/g, '')) / 1000);
        if (lots > 0) by[code] = lots;
      }
      if (Object.keys(by).length > 100) {
        await db.collection('chipArchive').doc(t.id).set({ dayTradeJson: JSON.stringify(by) }, { merge: true });
        ok++;
        if (ok % 20 === 0) console.log(`[daytrade] ${ok}/${targets.length}（至 ${t.id}·${Object.keys(by).length} 檔）`);
      } else skip++;
    } catch (e) { fail++; console.log(`[daytrade] ✖ ${t.id}: ${e.message}`); await sleep(5000); }
    await sleep(1500);
  }
  console.log(`[daytrade] 完成：寫入 ${ok}／跳過 ${skip}／失敗 ${fail}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
