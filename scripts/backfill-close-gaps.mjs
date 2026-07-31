#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 收盤歸檔空洞回填：chipArchive 有 doc 但 closeJson 缺失／檔數過少的交易日。
//
// 為什麼會有空洞：fix-archive-dates.mjs（上櫃日期位移修復）把錯置日的 closeJson
// 搬到正確日期後，會把來源 doc 的 closeJson 刪掉並標 closeClearedAt；daemon 也會在
// 非交易日留下沒有 closeJson 的占位 doc。兩者都會在歸檔序列裡佔一個「壞日」名額。
//
// 空洞的傷害是「靜默」的：loadLuArchive 只取 N 筆再濾掉壞日，湊不滿門檻的下游
// （波段起漲 arch.length<62）會直接 return，不報錯、不寫入，功能整個消失。
// 2026-07-10（週五）即為實案：休市日的占位 doc 卡住波段起漲整整不出榜。
//
// 本腳本只補「官方確實有資料」的日子；官方查無資料＝真休市，維持空白不硬寫。
//
// 用法：node scripts/backfill-close-gaps.mjs [--dry] [--from=YYYY-MM-DD]
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DRY = process.argv.includes('--dry');
const FROM = (process.argv.find(a => a.startsWith('--from=')) || '').slice(7) || '2026-01-01';
const MIN_STOCKS = 500;          // 與 loadLuArchive 的有效日門檻一致
const THROTTLE = 1400;           // 官方站台節流

const sleep = ms => new Promise(r => setTimeout(r, ms));
const _f = s => { const n = parseFloat(String(s ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const lots = sh => Math.round(_f(sh) / 1000);
const H_TW = { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' } };
const H_TP = { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tpex.org.tw/' } };
const J = async (u, h) => { try { const r = await fetch(u, h); return JSON.parse(await r.text()); } catch { return null; } };

// 單日官方收盤（上市 MI_INDEX ＋ 上櫃 dailyQuotes），回傳 {code:[收,量張,開,高,低]}
async function fetchOfficialClose(iso) {
  const d8 = iso.replace(/-/g, '');
  const dSlash = encodeURIComponent(`${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`);
  const close = {};

  const mi = await J(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d8}&type=ALLBUT0999&response=json`, H_TW);
  await sleep(THROTTLE);
  const stk = mi && Array.isArray(mi.tables)
    ? mi.tables.find(tb => (tb.fields || []).some(f => /證券代號/.test(f)) && tb.data && tb.data.length > 200)
    : null;
  for (const r of (stk?.data || [])) {
    const c = String(r[0] || '').trim(); if (!/^\d{4}$/.test(c)) continue;
    const cl = _f(r[8]); if (!(cl > 0)) continue;
    close[c] = [cl, lots(r[2]), _f(r[5]), _f(r[6]), _f(r[7])];
  }

  const tp = await J(`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${dSlash}&type=EW&id=&response=json`, H_TP);
  await sleep(THROTTLE);
  // ⚠回音驗證：TPEx 對無效日期會回「最近一個交易日」而不是報錯，不比對就會寫錯日資料
  const tpEcho = String(tp?.date || '');
  const tpOk = tpEcho === d8 && Array.isArray(tp?.tables?.[0]?.data);
  if (tpOk) {
    for (const r of tp.tables[0].data) {
      const c = String(r[0] || '').trim(); if (!/^\d{4}$/.test(c)) continue;
      const cl = _f(r[2]); if (!(cl > 0)) continue;
      close[c] = [cl, lots(r[8]), _f(r[4]), _f(r[5]), _f(r[6])];
    }
  }
  return { close, tseOk: !!stk, tpOk, tpEcho };
}

async function main() {
  const snap = await db.collection('chipArchive').orderBy('date').get();
  const gaps = [];
  snap.forEach(d => {
    const iso = d.id;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso < FROM) return;
    const x = d.data();
    const n = x.closeJson ? Object.keys(JSON.parse(x.closeJson)).length : 0;
    if (n <= MIN_STOCKS) gaps.push({ iso, n, cleared: !!x.closeClearedAt });
  });

  if (!gaps.length) { console.log(`[gap] ${FROM} 起無收盤空洞 ✓`); process.exit(0); }
  console.log(`[gap] 發現 ${gaps.length} 個空洞：` + gaps.map(g => `${g.iso}(${g.n}檔${g.cleared ? '·已清除' : ''})`).join(', '));

  let fixed = 0;
  for (const g of gaps) {
    const { close, tseOk, tpOk, tpEcho } = await fetchOfficialClose(g.iso);
    const n = Object.keys(close).length;
    if (!close['2330'] || n < MIN_STOCKS) {
      // 非交易日（休市/颱風假）也會落到這裡——那是正確結果，不該硬寫
      console.log(`[gap] ⚠ ${g.iso} 官方資料不足（${n} 檔·上市${tseOk ? '✓' : '✗'}/上櫃${tpOk ? '✓' : `✗ echo=${tpEcho || '無'}`}）——可能非交易日，略過`);
      continue;
    }
    if (DRY) { console.log(`[gap] (dry) ${g.iso} 可補 ${n} 檔·2330=${close['2330'][0]}`); continue; }
    await db.collection('chipArchive').doc(g.iso).set(
      { date: g.iso, closeJson: JSON.stringify(close), gapFixedAt: Date.now() },
      { merge: true },
    );
    fixed++;
    console.log(`[gap] ✓ ${g.iso} 補回 ${n} 檔·2330=${close['2330'][0]}`);
  }
  console.log(`[gap] 完成：修復 ${fixed}／${gaps.length}`);
  process.exit(0);
}

main().catch(e => { console.error('[gap] 失敗:', e.message); process.exit(1); });
