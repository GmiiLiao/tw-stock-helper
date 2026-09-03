#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 🔄 反向做多實驗（2026-09-03·⑦-v2 的延伸假說）
//
// v2 發現：空方候選（弱勢股）比同宇宙隨機股「更不跌」（負選股）
// ⇒ 鏡像假說：**做多這批弱勢股**應該相對隨機有正超額（reversal alpha）。
// 本實驗量化它——絕對報酬（扣多方成本 0.38%/趟）與相對隨機的超額，
// 持有期 1/3/5 日，主窗/OOT。若成立，行動是接進站上抄底體系（另議）。
//
// 選股=v2 A 版（同款重演）；進場=t+1 開盤；PIT 同前。
// ─────────────────────────────────────────────────────────────────────────
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))) });
const db = getFirestore();

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const COST_LONG = 0.38;   // 現股多方來回（稅0.3%+2.8折手續費雙邊）

console.log('載入 chipArchive…');
const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(400).get();
const days = snap.docs.map(d => d.data()).filter(a => a.closeJson)
  .map(a => ({
    date: a.date, close: JSON.parse(a.closeJson),
    margin: a.marginJson ? JSON.parse(a.marginJson) : null,
    inst: a.instJson ? JSON.parse(a.instJson) : null,
    lend: a.lendingJson ? JSON.parse(a.lendingJson) : null,
  })).reverse();

let dtMap = {};
try {
  const dt = (await db.collection('dayTradeEligible').doc('latest').get()).data();
  if (dt?.codesJson) dtMap = JSON.parse(dt.codesJson);
} catch { /* 同 v2 */ }

function pagodaDir(closes) {
  const pag = [];
  for (const c of closes) {
    if (pag.length < 3) { pag.push({ hi: c, lo: c, dir: 0 }); continue; }
    const l3 = pag.slice(-3);
    const hi3 = Math.max(...l3.map(p => p.hi)), lo3 = Math.min(...l3.map(p => p.lo));
    const prev = pag[pag.length - 1];
    let dir = prev.dir;
    if (c > hi3) dir = 1; else if (c < lo3) dir = -1;
    if (dir !== prev.dir) pag.push({ hi: c, lo: c, dir });
    else pag.push({ hi: Math.max(prev.hi, c), lo: Math.min(prev.lo, c), dir });
  }
  return pag[pag.length - 1]?.dir ?? 0;
}

const WARM = 21, MAXH = 5;
const rows = [];
for (let t = WARM; t < days.length - MAXH; t++) {
  const D = days[t];
  const prevMargin = days[t - 1].margin, prevLend = days[t - 1].lend, prev2Lend = days[t - 2].lend;
  const universe = [], picks = [];
  for (const code of Object.keys(D.close)) {
    const r = D.close[code];
    if (!Array.isArray(r) || !(r[0] > 0)) continue;
    const price = r[0];
    const ser = [];
    for (let k = t - WARM; k <= t; k++) { const x = days[k].close[code]; if (Array.isArray(x) && x[0] > 0) ser.push(x); }
    if (ser.length < 21) continue;
    const avgAmt = ser.slice(-20).reduce((s, x) => s + x[0] * (x[1] || 0) * 1000, 0) / 20;
    if (avgAmt < 50_000_000) continue;
    if (Object.keys(dtMap).length && dtMap[code] !== 1) continue;
    const mg = prevMargin?.[code];
    const sr = Array.isArray(mg) && mg[0] > 0 ? (mg[1] || 0) / mg[0] * 100 : null;
    if (sr != null && sr > 15) continue;
    const closes = ser.map(x => x[0]);
    const c5ago = closes.length >= 6 ? closes[closes.length - 6] : null;
    const ret5 = c5ago > 0 ? (price - c5ago) / c5ago * 100 : 0;
    if (sr != null && sr > 10 && ret5 > 5) continue;
    universe.push(code);
    const prevC = closes[closes.length - 2];
    const chg = prevC > 0 ? (price - prevC) / prevC * 100 : 0;
    const ma = n => closes.slice(-n).reduce((s, x) => s + x, 0) / n;
    const ma5 = ma(5), ma20 = ma(20);
    const low20 = Math.min(...closes.slice(-21, -1));
    let score = 0, sig = 0;
    if (chg < -2) { score += 2; sig++; }
    if (ma5 < ma20 && price < ma20) { score += 4; sig++; }
    if (price < low20) { score += 3; sig++; }
    if (pagodaDir(closes) === -1) { score += 5; sig++; }
    let streak = 0;
    for (let k = t - 1; k >= t - 8 && k >= 0; k--) {
      const iv = days[k].inst?.[code];
      if (Array.isArray(iv) && (iv[0] || 0) < 0) streak++; else break;
    }
    if (streak >= 3) { score += Math.min(8, streak * 2); sig++; }
    const ln = prevLend?.[code], lp = prev2Lend?.[code];
    if (ln != null && lp != null) {
      const avgVol = ser.slice(-20).reduce((s, x) => s + (x[1] || 0), 0) / 20 * 1000;
      if (avgVol > 0 && ln > lp && ln - lp > avgVol * 0.1) { score += 4; sig++; }
    }
    if (score >= 8 && sig >= 2) picks.push({ code, score });
  }
  picks.sort((a, b) => b.score - a.score);
  rows.push({ t, date: D.date, universe, picks: picks.slice(0, 20) });
}
console.log(`重演完成：${rows.length} 交易日`);

// 做多標籤：entry=o(t+1)，持有 H 日到 c(t+H)
function longRet(t, code, H) {
  const n1 = days[t + 1]?.close[code];
  if (!Array.isArray(n1) || !(n1[2] > 0)) return null;
  const nH = days[t + H]?.close[code];
  if (!Array.isArray(nH) || !(nH[0] > 0)) return null;
  return (nH[0] - n1[2]) / n1[2] * 100;
}

const cut = Math.floor(rows.length * 0.7);
for (const H of [1, 3, 5]) {
  console.log(`\n══ 持有 ${H} 日（做多·扣成本 ${COST_LONG}%）══`);
  for (const [rs, tag] of [[rows.slice(0, cut), '主窗'], [rows.slice(cut), 'OOT ']]) {
    const arr = rs.flatMap(r => r.picks.map(p => longRet(r.t, p.code, H)).filter(x => x != null));
    if (!arr.length) continue;
    const avg = arr.reduce((s, x) => s + x, 0) / arr.length;
    const wr = arr.filter(x => x > 0).length / arr.length * 100;
    // 隨機對照（50 輪足夠估均值）
    const rand = mulberry32(20260903 + H);
    const pl = [];
    for (let round = 0; round < 50; round++) {
      let sum = 0, n = 0;
      for (const r of rs) {
        const k = r.picks.length; if (!k) continue;
        const pool = r.universe.slice();
        for (let i = 0; i < k && pool.length; i++) {
          const code = pool.splice(Math.floor(rand() * pool.length), 1)[0];
          const v = longRet(r.t, code, H);
          if (v != null) { sum += v; n++; }
        }
      }
      if (n) pl.push(sum / n);
    }
    pl.sort((a, b) => b - a);
    const plAvg = pl.reduce((s, x) => s + x, 0) / pl.length;
    const beat = pl.filter(x => x < avg).length / pl.length * 100;
    console.log(`${tag}: n=${arr.length} 勝率${wr.toFixed(1)}% 均${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%·扣成本${(avg - COST_LONG).toFixed(2)}% | 隨機均${plAvg >= 0 ? '+' : ''}${plAvg.toFixed(2)}%·超額${(avg - plAvg).toFixed(2)}pp | 贏過${beat.toFixed(0)}%隨機輪${avg > pl[0] ? '·✅超越隨機最佳' : avg > pl[Math.floor(pl.length * 0.05)] ? '·🟡超越95分位' : ''}`);
  }
}
console.log('\n⚠ 同 v2 限制（缺事件因子·當沖名單近似）。回測≠未來。非投資建議。');
