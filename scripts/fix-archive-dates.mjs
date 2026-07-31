#!/usr/bin/env node
// ── chipArchive closeJson 日期偏移遷移 ──────────────────────────────────
// 背景：archiveChipDaily 原以「執行日」戳記 closeJson，凌晨執行時裝到 D 的其實是
// D-1 收盤 → 大多數 doc 偏移 +1；instJson/marginJson 因帶官方日期參數，正確。
// 方法：以官方 STOCK_DAY(月檔) 取 2330/2317/2454 三檔逐日收盤做指紋，比對每個
// doc 的 closeJson → 找出真實資料日 → closeJson 搬到正確 doc；inst/margin 不動。
// dry-run 預設；--apply 才寫入。
import admin from 'firebase-admin';
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();
const APPLY = process.argv.includes('--apply');

// 官方逐日收盤（STOCK_DAY 月檔，民國日期）
const FP_CODES = ['2330', '2317', '2454'];
async function officialCloses(code) {
  const map = {}; // iso -> close
  for (const ym of ['20260201', '20260301', '20260401', '20260501', '20260601', '20260701']) {
    try {
      const r = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}&stockNo=${code}&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      for (const row of (j?.data || [])) {
        const [y, m, d] = String(row[0]).split('/');
        const iso = `${+y + 1911}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        const c = parseFloat(String(row[6]).replace(/,/g, ''));
        if (c > 0) map[iso] = c;
      }
    } catch { /* skip month */ }
    await new Promise(res => setTimeout(res, 800));
  }
  return map;
}
console.log('抓官方收盤指紋（2330/2317/2454 × 6個月）…');
const off = {};
for (const c of FP_CODES) off[c] = await officialCloses(c);
const dates = Object.keys(off['2330']).sort();
console.log(`官方 ${dates.length} 交易日：${dates[0]} → ${dates[dates.length - 1]}`);
const fpOf = iso => FP_CODES.map(c => off[c][iso]).join('|');
const fpMap = {}; for (const d of dates) fpMap[fpOf(d)] = d;

// 逐 doc 判定真實日期
const snap = await db.collection('chipArchive').orderBy('date', 'asc').get();
const moves = []; // {fromId, trueDate, closeJson}
let ok = 0, shifted = 0, unknown = 0;
for (const doc of snap.docs) {
  const x = doc.data(); if (!x.closeJson) continue;
  const close = JSON.parse(x.closeJson);
  const fp = FP_CODES.map(c => close[c]?.[0]).join('|');
  const trueDate = fpMap[fp];
  if (!trueDate) { unknown++; console.log(`  ? ${doc.id} 指紋無匹配（${fp}）`); continue; }
  if (trueDate === doc.id) ok++;
  else { shifted++; moves.push({ fromId: doc.id, trueDate, closeJson: x.closeJson }); }
}
console.log(`\n判定：正確 ${ok} · 偏移 ${shifted} · 無法判定 ${unknown}`);
for (const m of moves.slice(0, 8)) console.log(`  ${m.fromId} 的收盤其實是 ${m.trueDate}`);
if (moves.length > 8) console.log(`  …共 ${moves.length} 筆`);

if (!APPLY) { console.log('\n(dry-run，加 --apply 執行搬移)'); process.exit(0); }

// 搬移：由「最舊」開始，closeJson 寫到 trueDate doc；來源 doc 的 closeJson 欄位
// 若沒有別的 doc 要搬進來，將由搬入者覆蓋；最後檢查孤兒（doc 有 closeJson 但無人搬入且原本偏移）。
const byTrue = new Map(moves.map(m => [m.trueDate, m]));
let written = 0;
for (const m of moves) {
  await db.collection('chipArchive').doc(m.trueDate).set({ date: m.trueDate, closeJson: m.closeJson, closeFixedAt: Date.now() }, { merge: true });
  written++;
}
// 清除「來源日沒有任何人搬入」的殘留錯誤 closeJson（該 doc 的正確收盤由別的來源搬入；
// 若無人搬入=該日收盤已遺失→刪除錯誤資料避免污染，寧缺勿錯）
let cleared = 0;
for (const m of moves) {
  if (!byTrue.has(m.fromId)) {
    await db.collection('chipArchive').doc(m.fromId).update({ closeJson: admin.firestore.FieldValue.delete(), closeClearedAt: Date.now() });
    cleared++;
    console.log(`  ⚠ ${m.fromId} 無正確收盤來源，已清除錯誤資料（寧缺勿錯）`);
  }
}
console.log(`\n搬移完成：寫入 ${written}、清除孤兒 ${cleared}`);
// 抽驗最近 5 日
for (const d of dates.slice(-5)) {
  const doc = (await db.collection('chipArchive').doc(d).get()).data();
  const c = doc?.closeJson ? JSON.parse(doc.closeJson)['2330']?.[0] : null;
  console.log(`  驗 ${d}: 庫內2330=${c} vs 官方=${off['2330'][d]} ${c === off['2330'][d] ? '✓' : '✗'}`);
}
process.exit(0);
