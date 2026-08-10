#!/usr/bin/env node
// ── 資券「過薄日」修補 ────────────────────────────────────────────────
//
// 為什麼既有的兩支回補救不了這些日子（2026-08-10 稽核發現）：
//   backfill-margin.mjs      挑的是 `!d.data().marginJson`      → 有值就跳過
//   backfill-margin-tpex.mjs 挑的是 `!d.data().tpexMarginAt`    → 旗標設過就跳過
//   兩者問的都是「**有沒有**」，不是「**夠不多厚**」。
//   於是 2026-03-10 這種「上市只有 220 檔（正常 871）」的半殘日永遠修不到——
//   它有 marginJson、也有 tpexMarginAt，兩支都禮貌地繞過去。
//
// 這些半殘日的來歷：它們曾被誤判為休市（sync-trading-calendar 的「空洞＝臨時休市」
// 推論），後來用 backfill-missing-days.mjs 救回，但那支只補 close/法人/借券/當沖，
// 資券不在它的守備範圍，於是留下這批只有資券缺角的日子。
//
// 判定門檻用「上市半邊 / 上櫃半邊」分開看，不看總數——
// 總數 780 看起來只是略低於 1200，但拆開是「上市 220 / 上櫃 560」，
// 上市那半塌了 75%。合計數會把單邊塌陷藏起來，這是本專案反覆栽的同一種坑。
//
// 用法：node scripts/repair-margin-thin.mjs [--dry]

import admin from 'firebase-admin';
import { pathToFileURL } from 'node:url';

process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const DRY = process.argv.includes('--dry');
const MIN_TSE = 700, MIN_OTC = 700;      // 正常值約 871 / 953
const THROTTLE = 1600;

const H_TW = { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' } };
const H_TP = { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tpex.org.tw/' } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const _f = (s) => { const n = parseFloat(String(s ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const J = async (url, h) => { try { const r = await fetch(url, { ...h, signal: AbortSignal.timeout(20000) }); return r.ok ? JSON.parse(await r.text()) : null; } catch { return null; } };
const split = (m) => { const k = Object.keys(m); return [k.filter(c => +c < 4000).length, k.filter(c => +c >= 4000).length]; };

async function main() {
  const snap = await db.collection('chipArchive').get();
  const targets = [];
  for (const d of snap.docs) {
    let m = {}; try { m = JSON.parse(d.data().marginJson || '{}'); } catch { /* 壞 JSON 當空 */ }
    const [tse, otc] = split(m);
    if (Object.keys(m).length === 0) continue;          // 全空是另一支的守備範圍
    if (tse < MIN_TSE || otc < MIN_OTC) targets.push({ iso: d.id, tse, otc });
  }
  targets.sort((a, b) => (a.iso < b.iso ? 1 : -1));
  console.log(`[repair-margin] 過薄日 ${targets.length} 天：${targets.map(t => `${t.iso}(${t.tse}/${t.otc})`).join('、')}`);
  if (DRY || !targets.length) return;

  let fixed = 0, failed = 0;
  for (const { iso, tse, otc } of targets) {
    const d8 = iso.replace(/-/g, '');
    const dSlash = encodeURIComponent(`${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`);
    const ref = db.collection('chipArchive').doc(iso);
    const merged = JSON.parse((await ref.get()).data()?.marginJson || '{}');

    // 上市 MI_MARGN：[6]融資今日餘額 [12]融券今日餘額（張）
    if (tse < MIN_TSE) {
      const j = await J(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${d8}&selectType=ALL&response=json`, H_TW);
      await sleep(THROTTLE);
      // ⚠ 回聲驗證：TWSE 對非交易日會回 stat 非 OK，但對「有資料的錯日」也可能回 OK，
      //   所以日期回聲一定要比對，否則會把別天的餘額寫進這一天。
      const tb = (j?.tables || []).find(t => (t.data || []).length > 100);
      if (j?.stat === 'OK' && tb && String(j.date || d8) === d8) {
        for (const r of tb.data) { const c = String(r[0] || '').trim(); if (/^\d{4}$/.test(c)) merged[c] = [Math.round(_f(r[6])), Math.round(_f(r[12]))]; }
      }
    }
    // 上櫃 margin/balance：[6]資餘額 [14]券餘額（張）；TPEx 只認 YYYY/MM/DD ＋ 回聲驗證
    if (otc < MIN_OTC) {
      const j = await J(`https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${dSlash}&response=json`, H_TP);
      await sleep(THROTTLE);
      if (j && String(j.date || '') === d8 && Array.isArray(j.tables?.[0]?.data)) {
        for (const r of j.tables[0].data) { const c = String(r[0] || '').trim(); if (/^\d{4}$/.test(c)) merged[c] = [Math.round(_f(r[6])), Math.round(_f(r[14]))]; }
      }
    }

    const [t2, o2] = split(merged);
    if (t2 <= tse && o2 <= otc) { failed++; console.log(`  ✗ ${iso} 無法加厚（仍 ${t2}/${o2}）——上游該日可能真的沒有這批資料`); continue; }
    await ref.set({ marginJson: JSON.stringify(merged), marginRepairAt: Date.now() }, { merge: true });
    fixed++;
    console.log(`  ✓ ${iso} 資券 ${tse}/${otc} → ${t2}/${o2}`);
  }
  console.log(`[repair-margin] 完成：修好 ${fixed}、無法修 ${failed}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
