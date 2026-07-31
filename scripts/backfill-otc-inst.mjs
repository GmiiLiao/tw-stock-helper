#!/usr/bin/env node
// 補回 chipArchive.instJson 的上櫃法人（daemon 期 2026-02-26 起缺失）
// TPEx dailyTrade：斜線日期＋回聲驗證（8位數會被靜默忽略回最新——已知陷阱）
import admin from 'firebase-admin';
process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp(); const db = admin.firestore();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const _i = v => parseInt(String(v ?? '0').replace(/,/g, ''), 10) || 0;
const OTC_PROBE = ['6274', '8069', '3260', '5347', '3105'];

const snap = await db.collection('chipArchive').where('date', '>=', '2026-02-20').get();
const targets = [];
snap.forEach(d => {
  const x = d.data(); if (!x.instJson) return;
  const m = JSON.parse(x.instJson);
  if (!OTC_PROBE.some(c => m[c])) targets.push(d.id);
});
targets.sort();
console.log(`[otc-inst] 缺上櫃法人 ${targets.length} 日（${targets[0]} → ${targets[targets.length - 1]}）`);
let ok = 0, skip = 0;
for (const iso of targets) {
  const d8 = iso.replace(/-/g, '');
  const dSlash = `${d8.slice(0, 4)}/${d8.slice(4, 6)}/${d8.slice(6, 8)}`;
  try {
    const r = await fetch(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(dSlash)}&id=&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tpex.org.tw/' } });
    if (!r.ok) { skip++; await sleep(2500); continue; }
    const j = await r.json();
    if (String(j?.date || '') !== d8) { skip++; await sleep(1200); continue; }   // 回聲驗證
    const rows = j?.tables?.[0]?.data || [];
    const add = {};
    for (const row of rows) { const c = String(row[0] || '').trim(); if (/^\d{4}$/.test(c)) add[c] = [Math.round(_i(row[10]) / 1000), Math.round(_i(row[13]) / 1000)]; }
    if (Object.keys(add).length < 100) { skip++; await sleep(1200); continue; }
    const ref = db.collection('chipArchive').doc(iso);
    const cur = JSON.parse((await ref.get()).data().instJson);
    for (const c in add) if (!cur[c]) cur[c] = add[c];
    await ref.set({ instJson: JSON.stringify(cur), otcInstFixedAt: Date.now() }, { merge: true });
    ok++;
    if (ok % 20 === 0) console.log(`[otc-inst] ${ok}/${targets.length}（至 ${iso}·+${Object.keys(add).length} 檔）`);
  } catch (e) { console.log(`[otc-inst] ✖ ${iso}: ${e.message}`); await sleep(4000); }
  await sleep(1500);
}
console.log(`[otc-inst] 完成：補 ${ok}／跳過 ${skip}`);
process.exit(0);
