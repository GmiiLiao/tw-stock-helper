// ─────────────────────────────────────────────────────────────────────────
// 上櫃收盤回填：修復 archiveChipDaily 未回聲驗證 TPEx openapi 造成的
// 「上櫃日K平移一日」（2026-07-22 揭發：15:10 歸檔時 TWSE 已出今日檔、
// TPEx 仍昨日檔，兩者被併進同一文件；影響 daemon 歸檔期的部分交易日）。
// 逐日抓 TPEx dailyQuotes（斜線日期＋回聲驗證——8位數/未出檔會回錯日，已知陷阱），
// 覆寫各日 closeJson 的上櫃檔位（[收,量張,開,高,低]）。
// 用法：node scripts/backfill-otc-close.mjs [--days=120] [--dry]
// ─────────────────────────────────────────────────────────────────────────
import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 120);
const DRY = process.argv.includes('--dry');
const n = s => parseFloat(String(s).replace(/,/g, '')) || 0;

const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS).get();
const docs = snap.docs.filter(d => d.data().closeJson);
console.log(`檢查 ${docs.length} 個交易日（${docs[docs.length - 1]?.id} → ${docs[0]?.id}）${DRY ? '·dry-run' : ''}`);
let fixedDays = 0, totalFixed = 0, skipped = 0;
for (const doc of docs) {
  const iso = doc.id, slash = iso.replace(/-/g, '/'), ymd8 = iso.replace(/-/g, '');
  let j = null;
  try {
    const r = await fetch(`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(slash)}&response=json`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tpex.org.tw/' } });
    j = r.ok ? await r.json() : null;
  } catch { /* retry-less：單日失敗跳過，重跑腳本即補 */ }
  if (!j || String(j.date || '') !== ymd8) { console.log(`${iso} 跳過（回聲日期 ${j?.date ?? '無'} ≠ ${ymd8}）`); skipped++; await sleep(1300); continue; }
  const table = (j.tables || []).find(t => (t.data || []).length > 300);
  if (!table) { console.log(`${iso} 跳過（無行情表）`); skipped++; await sleep(1300); continue; }
  const close = JSON.parse(doc.data().closeJson);
  let fixed = 0, checked = 0;
  for (const r of table.data) {
    const code = String(r[0] || '').trim();
    if (!/^\d{4}$/.test(code)) continue;
    // 欄位：0代號 2收盤 4開盤 5最高 6最低 8成交股數
    const c = n(r[2]), o = n(r[4]), h = n(r[5]), l = n(r[6]), v = Math.round(n(r[8]) / 1000);
    if (!(c > 0)) continue;
    checked++;
    const cur = close[code];
    if (!cur || cur[0] !== c || cur[1] !== v || cur[2] !== o || cur[3] !== h || cur[4] !== l) { close[code] = [c, v, o, h, l]; fixed++; }
  }
  if (fixed > 0) {
    fixedDays++; totalFixed += fixed;
    if (!DRY) await doc.ref.set({ closeJson: JSON.stringify(close), otcPending: false, otcFixedAt: Date.now() }, { merge: true });
  }
  console.log(`${iso} 上櫃 ${checked} 檔 → 修正 ${fixed}`);
  await sleep(1300);
}
console.log(`\n完成：${docs.length} 日中 ${fixedDays} 日有修正（共 ${totalFixed} 檔位）·跳過 ${skipped} 日${DRY ? '·dry-run 未寫入' : ''}`);
process.exit(0);
