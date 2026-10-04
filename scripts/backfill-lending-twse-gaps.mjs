#!/usr/bin/env node
// 上市借券缺半補洞（2026-10-04）：chipArchive.lendingJson 只有上櫃、缺上市那半的交易日，
// 用官方 TWT93U（可指定日期，回音驗證）補上市借券當日餘額；既有列只補不改。
// 成因：daemon 歸檔只看上櫃樣本判斷「借券已齊」，上市失敗時會把「只有上櫃」定案（已於同日修正觸發條件）。
//
// 用法：node scripts/backfill-lending-twse-gaps.mjs [--since 2026-07-17] [--write]
//   預設 dry-run（只列出缺口與可補筆數，不寫 Firestore）；請求間隔 ≥3 秒（與 daemon／鏡像同一出口 IP）。
import admin from 'firebase-admin';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const SINCE = args.includes('--since') ? args[args.indexOf('--since') + 1] : '2026-07-17';
if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE || '')) throw new Error(`--since 格式錯誤：${SINCE}`);
const GAP_MS = 3000;
const TWSE_SAMPLE = ['2330', '2317', '2454'];
const OTC_SAMPLE = ['6274', '8069', '5483'];
const H_TW = { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' }, signal: AbortSignal.timeout(15000) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => { const n = parseFloat(String(s ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const has = (m, codes) => codes.some((c) => m[c] !== undefined);

async function fetchTwseLending(ymd) {
  const r = await fetch(`https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=${ymd}&response=json`, H_TW);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = JSON.parse(await r.text());
  if (j?.stat !== 'OK') return { rows: null, why: `stat=${j?.stat}` };
  if (String(j?.date || '') !== ymd) return { rows: null, why: `回音 ${j?.date} ≠ ${ymd}` };
  const rows = {};
  for (const row of j.data || []) {
    const c = String(row[0] || '').trim(); const v = num(row[12]);
    if (/^\d{4}$/.test(c) && v !== null) rows[c] = Math.round(v / 1000);   // 股 → 張（與 daemon 同口徑）
  }
  return { rows, why: null };
}

async function main() {
  admin.initializeApp();
  const db = admin.firestore();
  const snap = await db.collection('chipArchive').where(admin.firestore.FieldPath.documentId(), '>=', SINCE).get();
  const gaps = [];
  for (const d of snap.docs) {
    const x = d.data();
    if (!x.lendingJson) continue;
    let m; try { m = JSON.parse(x.lendingJson); } catch { continue; }
    if (!has(m, TWSE_SAMPLE) && has(m, OTC_SAMPLE)) gaps.push({ id: d.id, n: Object.keys(m).length, m });
  }
  console.log(`掃描 ${snap.size} 份（${SINCE} 起）：上市借券缺半 ${gaps.length} 天 ${gaps.map((g) => `${g.id}(${g.n})`).join(' ')}`);
  let wrote = 0;
  for (const g of gaps) {
    const ymd = g.id.replace(/-/g, '');
    const { rows, why } = await fetchTwseLending(ymd);
    await sleep(GAP_MS);
    if (!rows || Object.keys(rows).length < 100 || !has(rows, TWSE_SAMPLE)) { console.log(`  ✖ ${g.id}：上市借券取不到（${why || `僅 ${rows ? Object.keys(rows).length : 0} 檔`}）`); continue; }
    const merged = { ...g.m };
    let add = 0;
    for (const [c, v] of Object.entries(rows)) if (merged[c] === undefined) { merged[c] = v; add++; }
    console.log(`  ${WRITE ? '✓' : '·'} ${g.id}：${g.n} → ${Object.keys(merged).length} 檔（+上市 ${add}）`);
    if (WRITE) { await db.collection('chipArchive').doc(g.id).set({ lendingJson: JSON.stringify(merged) }, { merge: true }); wrote++; }
  }
  console.log(WRITE ? `完成：寫入 ${wrote} 天` : '--dry-run（預設）：未寫入；確認後加 --write');
}

main().catch((e) => { console.error('✖', e.message); process.exit(1); });
