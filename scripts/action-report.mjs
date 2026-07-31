#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 模型主場成績單：全市場逐檔重演現行生產模型，列「行動日(🧬≥52)≥10天」個股
// ＋逐月行動日彙總（時間穩定性）。口徑同 leaders-report（可交易宇宙·扣費稅）。
// ─────────────────────────────────────────────────────────────────────────
import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();
const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 480);
const COST = 0.004425, MIN_VOL = 300;
import { readFileSync as _rf } from 'node:fs';
const _MC = JSON.parse(_rf(new URL('./data/model-core.json', import.meta.url), 'utf8'));
const TIER_WIN = _MC.tierBase;   // 單一事實來源：權重只能經稽核腳本更新 model-core
const ADD = Object.fromEntries(Object.entries(_MC.adds).map(([k, v]) => [k, v.w]));
ADD.strong = ADD.strongAlone; ADD.dist = ADD.dist30;

async function main() {
  const snap = await db.collection('chipArchive').get();
  const days = snap.docs.map(d => ({ id: d.id, x: d.data() }))
    .filter(d => d.x.closeJson && d.x.instJson)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(d => ({ date: d.id, close: JSON.parse(d.x.closeJson), inst: JSON.parse(d.x.instJson), margin: d.x.marginJson ? JSON.parse(d.x.marginJson) : null }));
  const cdSnap = await db.collection('chipDaily').get();
  const chipD = {}; cdSnap.forEach(d => { const x = d.data(); if (x.codesJson) chipD[x.date || d.id] = JSON.parse(x.codesJson); });
  const charBy = JSON.parse((await db.collection('chipCharacter').doc('latest').get()).data()?.byCodeJson || '{}');
  const quotes = JSON.parse((await db.collection('marketSnapshot').doc('latest').get()).data()?.quotesJson || '{}');
  const win = days.slice(-(DAYS + 22));
  console.log(`窗 ${win[21]?.date} → ${win[win.length - 2]?.date}·全市場·現行生產權重`);
  const adj = i => (new Date(win[i + 1].date) - new Date(win[i].date)) / 86400000 <= 4;
  const mktRet = {};
  for (let i = 1; i < win.length; i++) {
    let s = 0, n = 0;
    for (const code in win[i].close) { if (!/^\d{4}$/.test(code)) continue; const c = win[i].close[code]?.[0], pc = win[i - 1].close[code]?.[0]; if (c > 0 && pc > 0) { s += (c / pc - 1) * 100; n++; } }
    mktRet[i] = n > 500 ? s / n : null;
  }
  const agg = {}, byMonth = {};
  for (let i = 21; i < win.length - 1; i++) {
    if (!adj(i)) continue;
    const day = win[i], prev = win[i - 1], next = win[i + 1];
    const cd = chipD[day.date];
    for (const code in day.inst) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const cl = day.close[code], ncl = next.close[code], pcl = prev.close[code];
      if (!cl || !ncl || !pcl || !(cl[0] > 0) || !(ncl[0] > 0) || !(pcl[0] > 0)) continue;
      const vol = cl[1] || 0; if (vol < MIN_VOL) continue;
      const ret = ncl[0] / cl[0] - 1;
      const f = day.inst[code][0] || 0, t = day.inst[code][1] || 0;
      const chg = (cl[0] / pcl[0] - 1) * 100;
      if (chg > 8.5) continue;
      const hi = cl[3] || 0, lo = cl[4] || 0;
      const pos = hi > lo ? (cl[0] - lo) / (hi - lo) : null;
      const heavy = f >= 500 && f / vol >= 0.10;
      const weakF = f < 500 || f / vol < 0.02;
      let tier = 'neutral';
      if (f < 0) { tier = (t > 0 && (f + t) > 0) ? 'B' : 'danger'; }
      else if (heavy && t > 0) tier = 'S';
      else if (cd && f > 0 && t > 0 && (cd[code]?.[2] || 0) > 0) tier = 'A';
      else if (heavy) tier = 'B+';
      else if (chg >= 7 && weakF && t <= 0) tier = 'watchHot';
      else if (f > 0) tier = 'B';
      let hi20 = 0; for (let k = i - 20; k < i; k++) { const v = win[k]?.close[code]?.[0]; if (v > hi20) hi20 = v; }
      const brk = hi20 > 0 && cl[0] > hi20 && pcl[0] <= hi20;
      let sqzSetup = false, mgChg = 0;
      const m1 = prev.margin?.[code], m2 = win[i - 2]?.margin?.[code];
      if (m1 && m2) { const sChgY = (m1[1] || 0) - (m2[1] || 0), pvol = pcl[1] || 0; sqzSetup = pvol >= MIN_VOL && sChgY >= pvol * 0.005; mgChg = (m1[0] || 0) - (m2[0] || 0); }
      const sqzT = sqzSetup && chg > 2;
      const brkStrong = brk && pos != null && pos >= 0.7;
      const strongAlone = pos != null && pos >= 0.8 && Math.abs(chg) > 1 && !brkStrong;
      const bag = mgChg > 0 && f < 0;
      let cum = 0, peak = 0;
      for (let k = i - 19; k <= i; k++) { const v = win[k]?.inst[code]; if (v) { cum += (v[0] || 0) + (v[1] || 0); if (cum > peak) peak = cum; } }
      const distPct = peak > 0 ? ((peak - cum) / peak) * 100 : 0;
      const c5 = win[i - 5]?.close[code]?.[0];
      const ret5 = c5 > 0 ? (cl[0] / c5 - 1) * 100 : null;
      const isCore = charBy[code]?.label === '長期核心';
      let sc = TIER_WIN[tier] ?? 45;
      if (brkStrong && !isCore) sc += ADD.brkStrong;
      if (sqzT) sc += ADD.sqz;
      if (strongAlone) sc += ADD.strong;
      if (bag) sc += ADD.bag;
      if (distPct >= 30) sc += ADD.dist;
      if (ret5 != null && ret5 >= 20 && !isCore) sc += ADD.overheat;
      if (mktRet[i] != null && mktRet[i] >= 1 && chg >= 3 && chg - mktRet[i] < 1) sc += ADD.laggard;
      sc = Math.max(5, Math.min(95, Math.round(sc)));
      if (sc >= 52) {
        (agg[code] ||= []).push(ret);
        const mo = day.date.slice(0, 7);
        (byMonth[mo] ||= []).push(ret);
      }
    }
  }
  const st = a => ({ n: a.length, win: +(a.filter(r => r > 0).length / a.length * 100).toFixed(1), net: +((a.reduce((s, x) => s + x, 0) / a.length - COST) * 100).toFixed(2) });
  const rows = Object.entries(agg).filter(([, a]) => a.length >= 10)
    .map(([code, a]) => ({ code, name: (quotes[code]?.name || '').trim(), char: charBy[code]?.label || '?', ...st(a) }))
    .sort((x, y) => y.net - x.net);
  console.log(`\n── 行動日≥10天 個股成績單（${rows.length} 檔）──`);
  console.log('代號 名稱      性格    行動日  勝率    淨均/筆');
  for (const r of rows) console.log(`${r.code} ${r.name.padEnd(5, '　')}${r.char.padEnd(4, '　')} ${String(r.n).padStart(4)}  ${String(r.win).padStart(5)}%  ${String(r.net).padStart(6)}%`);
  const all = Object.values(agg).flat();
  const A = st(all);
  console.log(`\n全市場行動日彙總：n=${A.n.toLocaleString()}·勝率${A.win}%·淨均${A.net}%`);
  console.log('\n── 逐月行動日（時間穩定性）──');
  for (const mo of Object.keys(byMonth).sort()) { const m = st(byMonth[mo]); console.log(`  ${mo}: n=${String(m.n).padStart(4)} 勝率${String(m.win).padStart(5)}% 淨均${String(m.net).padStart(6)}%`); }
  console.log('\n非投資建議。');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
