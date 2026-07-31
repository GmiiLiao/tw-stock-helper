// 一次性回填：過去 ~90 個交易日的籌碼歷史 → Firestore chipArchive/{date}
// 來源：T86(法人) + MI_MARGN(融資券) + MI_INDEX(全市場收盤) — 皆上市；上櫃自今日起由 daemon 累積。
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp({ credential: applicationDefault(), projectId: 'tw-stock-helper' });
const db = getFirestore();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const _n = v => { const n = parseFloat(String(v ?? '').replace(/[,\s]/g, '')); return isNaN(n) ? 0 : n; };
const J = async (url) => {
  for (let a = 0; a < 2; a++) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' }, signal: ctl.signal }).finally(() => clearTimeout(tm));
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await sleep(2500);
  }
  return null;
};
const today = new Date();
const dates = [];
for (let d = 1; d < 140 && dates.length < 92; d++) {
  const x = new Date(today.getTime() - d * 86400000);
  if (x.getDay() === 0 || x.getDay() === 6) continue;
  dates.push(x);
}
let done = 0, skip = 0;
for (const x of dates.reverse()) { // 舊→新
  const ymd = `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
  const iso = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const exists = await db.collection('chipArchive').doc(iso).get();
  if (exists.exists && exists.data().complete) { skip++; continue; }
  const t86 = await J(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${ymd}&selectType=ALL`); await sleep(1200);
  if (!t86 || t86.stat !== 'OK') { skip++; continue; } // 休市日
  const fIdx = (t86.fields || []).indexOf('外陸資買賣超股數(不含外資自營商)');
  const tIdx = (t86.fields || []).findIndex(f => f.startsWith('投信買賣超'));
  const inst = {};
  for (const r of (t86.data || [])) { const c = (r[0] || '').trim(); if (/^\d{4}$/.test(c)) inst[c] = [Math.round(_n(r[fIdx]) / 1000), Math.round(_n(r[tIdx]) / 1000)]; }
  const mi = await J(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd}&type=ALLBUT0999&response=json`); await sleep(1200);
  const tb = (mi?.tables || []).find(t => (t.data || []).length > 500);
  const close = {};
  for (const r of (tb?.data || [])) { const c = (r[0] || '').trim(); if (/^\d{4}$/.test(c)) { const cl = _n(r[8]); if (cl > 0) close[c] = [cl, Math.round(_n(r[2]) / 1000)]; } }
  const mg = await J(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd}&selectType=ALL&response=json`); await sleep(1200);
  const mtb = (mg?.tables || []).find(t => (t.data || []).length > 100);
  const margin = {};
  for (const r of (mtb?.data || [])) { const c = (r[0] || '').trim(); if (/^\d{4}$/.test(c)) margin[c] = [Math.round(_n(r[6])), Math.round(_n(r[12]))]; } // [融資餘額, 融券餘額](張)
  await db.collection('chipArchive').doc(iso).set({
    date: iso, at: Date.now(), complete: true, market: 'tse',
    instJson: JSON.stringify(inst), closeJson: JSON.stringify(close), marginJson: JSON.stringify(margin),
  });
  done++;
  if (done % 10 === 0) console.log(`… ${done} 天完成（至 ${iso}）`);
}
console.log(`回填完成：新增 ${done} 天、略過 ${skip}（假日/已存在）`);
// 抽查最新一天
const last = await db.collection('chipArchive').orderBy('date', 'desc').limit(1).get();
const d0 = last.docs[0]?.data();
if (d0) { const i = JSON.parse(d0.instJson); const c = JSON.parse(d0.closeJson); console.log(`抽查 ${d0.date}: 法人${Object.keys(i).length}檔 收盤${Object.keys(c).length}檔 2330 外資${i['2330']?.[0]}張/投信${i['2330']?.[1]}張 收${c['2330']?.[0]}`); }
process.exit(0);
