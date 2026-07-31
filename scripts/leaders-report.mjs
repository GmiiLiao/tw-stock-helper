#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 產業龍頭 65 檔逐檔回測成績單（現行生產模型完整重演·權重讀 model-core 單一事實來源）
// 模型：tier 基底(model-core.tierBase)
//   ＋加減分(破高×強尾+2/軋空+2/強尾單獨−2/接棒−2/倒貨≥30%−1/過熱−2/跟風−2)
//   ＋性格條款(長期核心停用破高與過熱·以當前分類近似)
// 口徑：今收買→明收賣·扣0.4425%·相鄰日≤4天·量≥300張。
// 輸出：每檔 基準 vs 行動區(🧬≥52) vs 避開區(≤45)，依行動區淨均排序。非投資建議。
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 480);
const COST = 0.004425, MIN_VOL = 300;
const dirp = dirname(fileURLToPath(import.meta.url));
const LEADERS = JSON.parse(readFileSync(join(dirp, 'data', 'industry-leaders.json'), 'utf8')).leaders;
const LSET = new Set(LEADERS.map(l => l.code));
const _MC = JSON.parse(readFileSync(join(dirp, 'data', 'model-core.json'), 'utf8'));
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

  const win = days.slice(-(DAYS + 22));
  console.log(`窗 ${win[21]?.date} → ${win[win.length - 2]?.date}·現行生產權重·龍頭 ${LEADERS.length} 檔`);
  const adj = i => (new Date(win[i + 1].date) - new Date(win[i].date)) / 86400000 <= 4;

  // 每日市場等權均漲幅（跟風懲罰用·全市場個股）
  const mktRet = {};
  for (let i = 1; i < win.length; i++) {
    let s = 0, n = 0;
    for (const code in win[i].close) {
      if (!/^\d{4}$/.test(code)) continue;
      const c = win[i].close[code]?.[0], pc = win[i - 1].close[code]?.[0];
      if (c > 0 && pc > 0) { s += (c / pc - 1) * 100; n++; }
    }
    mktRet[i] = n > 500 ? s / n : null;
  }

  const agg = {}; // code -> {base:[], act:[], avoid:[], brkN, sqzN}
  for (let i = 21; i < win.length - 1; i++) {
    if (!adj(i)) continue;
    const day = win[i], prev = win[i - 1], next = win[i + 1];
    const cd = chipD[day.date];
    for (const code of LSET) {
      const cl = day.close[code], ncl = next.close[code], pcl = prev.close[code];
      if (!cl || !ncl || !pcl || !(cl[0] > 0) || !(ncl[0] > 0) || !(pcl[0] > 0)) continue;
      const vol = cl[1] || 0; if (vol < MIN_VOL) continue;
      const ret = ncl[0] / cl[0] - 1;
      const f = day.inst[code]?.[0] || 0, t = day.inst[code]?.[1] || 0;
      const chg = (cl[0] / pcl[0] - 1) * 100;
      if (chg > 8.5) continue;                                    // 可交易宇宙
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
      if (m1 && m2) {
        const sChgY = (m1[1] || 0) - (m2[1] || 0), pvol = pcl[1] || 0;
        sqzSetup = pvol >= MIN_VOL && sChgY >= pvol * 0.005;
        mgChg = (m1[0] || 0) - (m2[0] || 0);
      }
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

      const a = (agg[code] ||= { base: [], act: [], avoid: [], brkN: 0, sqzN: 0 });
      a.base.push(ret);
      if (sc >= 52) a.act.push(ret);
      else if (sc <= 45) a.avoid.push(ret);
      if (brkStrong) a.brkN++;
      if (sqzT) a.sqzN++;
    }
  }

  const st = arr => arr.length ? { n: arr.length, win: +(arr.filter(r => r > 0).length / arr.length * 100).toFixed(1), net: +((arr.reduce((s, x) => s + x, 0) / arr.length - COST) * 100).toFixed(2) } : null;
  const rows = LEADERS.map(l => {
    const a = agg[l.code]; if (!a) return null;
    return { ...l, base: st(a.base), act: st(a.act), avoid: st(a.avoid), brkN: a.brkN, sqzN: a.sqzN };
  }).filter(Boolean)
    .sort((x, y) => (y.act?.net ?? -99) - (x.act?.net ?? -99));

  console.log('\n代號 名稱       產業           │ 樣本  基準勝率/淨均   │ 行動日(🧬≥52) 勝率/淨均      │ 避開日(≤45) 勝率 │ 破高×強尾/軋空');
  console.log('─'.repeat(118));
  for (const r of rows) {
    const act = r.act ? `${String(r.act.n).padStart(3)}日 ${String(r.act.win).padStart(5)}%/${String(r.act.net).padStart(6)}%` : '  —（無行動日）  ';
    const av = r.avoid ? `${String(r.avoid.n).padStart(3)}日 ${String(r.avoid.win).padStart(5)}%` : ' —';
    console.log(`${r.code} ${r.name.padEnd(5, '　')}${(r.industry || '').slice(0, 6).padEnd(7, '　')}│ ${String(r.base.n).padStart(3)}  ${String(r.base.win).padStart(5)}%/${String(r.base.net).padStart(6)}% │ ${act} │ ${av} │ ${r.brkN}/${r.sqzN}`);
  }
  const allAct = rows.flatMap(r => r.act ? [r.act] : []);
  const wAct = rows.filter(r => r.act).flatMap(r => agg[r.code].act);
  const wAv = rows.flatMap(r => agg[r.code].avoid);
  const wB = rows.flatMap(r => agg[r.code].base);
  const S = st(wB), A = st(wAct), V = st(wAv);
  console.log('─'.repeat(118));
  console.log(`彙總：基準 n=${S.n} ${S.win}%/${S.net}% ｜ 行動日 n=${A?.n} ${A?.win}%/${A?.net}% ｜ 避開日 n=${V?.n} ${V?.win}%/${V?.net}%`);
  console.log(`行動日淨正檔數：${rows.filter(r => (r.act?.net ?? -1) > 0).length}/${rows.filter(r => r.act).length}（有行動日者）·全 65 檔中無行動日 ${LEADERS.length - rows.filter(r => r.act).length} 檔`);
  console.log('\n※ 行動日樣本少的檔（<10日）數字波動大，參考彙總為主。性格條款以當前分類近似。非投資建議。');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
