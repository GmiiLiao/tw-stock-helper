#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 🐻 做空回測 v2（2026-09-03·使用者核准方案 C）
//
// v1（short-backtest-lab.mjs·EXPERIMENTS ⑦）的方法論修正——v1 保持原樣可重現。
//
// A. 可執行口徑：進場一律 t+1 開盤價（盤後定榜，昨收價不可得）
//    · 當沖：空方報酬 = -(c(t+1)-o(t+1))/o(t+1)
//    · 5日： 空方報酬 = -(c(t+5)-o(t+1))/o(t+1)
//    · gap 分解：(o(t+1)-c(t))/c(t)——驗證「弱勢股隔日高開」假說
//    · 安慰劑改同量尺；成本模擬（使用者券商 2.8 折）：
//      當沖空：證交稅減半 0.15% + 手續費 0.1425%×0.28×2 ≈ 0.08% → 0.23%/趟
//      5日融券：證交稅 0.3% + 手續費 0.08% + 借券費約 0.05%(5日/年化3%) → 0.43%/趟
//    · 分數梯度：Top5 / 6-10 / 11-20
// B. 因子改造（在 A 量尺上測）：
//    · 去共線：破20日低/空頭排列/寶塔翻黑 合併為「趨勢弱」單一訊號
//    · 去掉「當日跌>2%」追空 → 反彈不過型進場：空頭結構 ∧ 今日收紅反彈
//      ∧ 收盤仍<MA20（反彈不過壓力）∧ 籌碼確認（外資連賣≥3 或 借券增）
//
// PIT 同 v1：法人/資券 t-1；宇宙=資格+風控層通過者。
// known限制同 v1：缺 AI 利空/反轉訊號/處置歷史；當沖資格今日名單近似。
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

const COST_DT = 0.23;   // 當沖空來回成本 %（證交稅減半+2.8折手續費雙邊）
const COST_5D = 0.43;   // 5 日融券來回成本 %

console.log('載入 chipArchive…');
const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(400).get();
const days = snap.docs.map(d => d.data()).filter(a => a.closeJson)
  .map(a => ({
    date: a.date,
    close: JSON.parse(a.closeJson),
    margin: a.marginJson ? JSON.parse(a.marginJson) : null,
    inst: a.instJson ? JSON.parse(a.instJson) : null,
    lend: a.lendingJson ? JSON.parse(a.lendingJson) : null,
  })).reverse();
console.log(`${days.length} 天（${days[0].date} → ${days[days.length - 1].date}）`);

let dtMap = {};
try {
  const dt = (await db.collection('dayTradeEligible').doc('latest').get()).data();
  if (dt?.codesJson) dtMap = JSON.parse(dt.codesJson);
} catch { /* 少一濾網於結果聲明 */ }

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

// ── 每日重演：回傳 {A:[{code,score}], B:[{code,score}], universe} ──
const WARM = 21, LABEL = 5;
const daysOut = [];
for (let t = WARM; t < days.length - LABEL; t++) {
  const D = days[t];
  const prevMargin = days[t - 1].margin;
  const prevLend = days[t - 1].lend, prev2Lend = days[t - 2].lend;
  const universe = [], A = [], B = [];
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
    const pgDir = pagodaDir(closes);
    const bearStruct = (ma5 < ma20 && price < ma20) || price < low20 || pgDir === -1;   // 趨勢弱(合併)
    // 籌碼（t-1）
    let streak = 0;
    for (let k = t - 1; k >= t - 8 && k >= 0; k--) {
      const iv = days[k].inst?.[code];
      if (Array.isArray(iv) && (iv[0] || 0) < 0) streak++; else break;
    }
    let lendUp = false;
    const ln = prevLend?.[code], lp = prev2Lend?.[code];
    if (ln != null && lp != null) {
      const avgVol = ser.slice(-20).reduce((s, x) => s + (x[1] || 0), 0) / 20 * 1000;
      if (avgVol > 0 && ln > lp && ln - lp > avgVol * 0.1) lendUp = true;
    }

    // ── A 版：v1 原評分（追空型）——只換量尺 ──
    {
      let score = 0, sig = 0;
      if (chg < -2) { score += 2; sig++; }
      if (ma5 < ma20 && price < ma20) { score += 4; sig++; }
      if (price < low20) { score += 3; sig++; }
      if (pgDir === -1) { score += 5; sig++; }
      if (streak >= 3) { score += Math.min(8, streak * 2); sig++; }
      if (lendUp) { score += 4; sig++; }
      if (score >= 8 && sig >= 2) A.push({ code, score });
    }
    // ── B 版：反彈不過型（等反彈再空·去共線·籌碼確認必要）──
    {
      const nearMa5 = ma5 > 0 && Math.abs(price - ma5) / ma5 < 0.02;                    // 反彈觸及 MA5 ±2%
      const rebound = chg > 0 || nearMa5;                                               // 今日收紅或回測 MA5
      const belowResist = price < ma20;                                                 // 反彈不過 MA20
      const chipOk = streak >= 3 || lendUp;                                             // 籌碼領先確認
      if (bearStruct && rebound && belowResist && chipOk) {
        let score = 4 + (streak >= 3 ? Math.min(8, streak * 2) : 0) + (lendUp ? 4 : 0) + (chg > 0 ? 2 : 0);
        B.push({ code, score });
      }
    }
  }
  A.sort((a, b) => b.score - a.score);
  B.sort((a, b) => b.score - a.score);
  daysOut.push({ t, date: D.date, universe, A: A.slice(0, 20), B: B.slice(0, 20) });
}
console.log(`重演完成：${daysOut.length} 交易日`);

// ── 可執行標籤：entry=o(t+1)；當沖=收(t+1)、5日=收(t+5)。空方報酬取負。──
function execLabel(t, code) {
  const D = days[t], D1 = days[t + 1], D5 = days[t + LABEL];
  const n1 = D1?.close[code];
  if (!Array.isArray(n1) || !(n1[2] > 0) || !(n1[0] > 0)) return null;
  const entry = n1[2];
  const gap = D.close[code][0] > 0 ? (entry - D.close[code][0]) / D.close[code][0] * 100 : null;
  const shortDT = -(n1[0] - entry) / entry * 100;                    // 當沖空報酬%（跌=正）
  let short5 = null;
  const n5 = D5?.close[code];
  if (Array.isArray(n5) && n5[0] > 0) short5 = -(n5[0] - entry) / entry * 100;
  return { gap, shortDT, short5 };
}

const cut = Math.floor(daysOut.length * 0.7);
function collect(rows, key) {
  const out = [];
  for (const r of rows) for (const p of r[key]) { const L = execLabel(r.t, p.code); if (L) out.push({ ...p, ...L, t: r.t }); }
  return out;
}
function stats(arr, label) {
  if (!arr.length) { console.log(`${label}: 無樣本`); return; }
  const wrDT = arr.filter(x => x.shortDT > 0).length / arr.length * 100;
  const avgDT = arr.reduce((s, x) => s + x.shortDT, 0) / arr.length;
  const g = arr.filter(x => x.gap != null);
  const avgGap = g.reduce((s, x) => s + x.gap, 0) / g.length;
  const s5 = arr.filter(x => x.short5 != null);
  const avg5 = s5.reduce((s, x) => s + x.short5, 0) / s5.length;
  const wr5 = s5.filter(x => x.short5 > 0).length / s5.length * 100;
  console.log(`${label}: n=${arr.length} | gap均 ${avgGap >= 0 ? '+' : ''}${avgGap.toFixed(2)}%${avgGap > 0 ? '(高開=空方禮物)' : ''} | 當沖空 勝率${wrDT.toFixed(1)}%·均${avgDT >= 0 ? '+' : ''}${avgDT.toFixed(2)}%·扣成本${(avgDT - COST_DT).toFixed(2)}% | 5日空 勝率${wr5.toFixed(1)}%·均${avg5 >= 0 ? '+' : ''}${avg5.toFixed(2)}%·扣成本${(avg5 - COST_5D).toFixed(2)}%`);
  return { avgDT, avg5 };
}

for (const [key, name] of [['A', 'Ａ版(v1因子·可執行口徑)'], ['B', 'Ｂ版(反彈不過型)']]) {
  console.log(`\n══════ ${name} ══════`);
  stats(collect(daysOut, key), '全期');
  stats(collect(daysOut.slice(0, cut), key), '主窗');
  const oot = collect(daysOut.slice(cut), key);
  stats(oot, 'OOT ');
  // 分數梯度（全期）
  const all = collect(daysOut, key);
  const byRank = { top5: [], r610: [], r1120: [] };
  for (const r of daysOut) {
    r[key].forEach((p, i) => {
      const L = execLabel(r.t, p.code); if (!L) return;
      if (i < 5) byRank.top5.push(L); else if (i < 10) byRank.r610.push(L); else byRank.r1120.push(L);
    });
  }
  for (const [k2, lab] of [['top5', '  梯度 Top1-5 '], ['r610', '  梯度 6-10  '], ['r1120', '  梯度 11-20 ']]) {
    const a = byRank[k2];
    if (a.length) console.log(`${lab}: n=${a.length} 當沖空均 ${(a.reduce((s, x) => s + x.shortDT, 0) / a.length).toFixed(2)}%`);
  }
  // 安慰劑（OOT·同量尺·當沖空口徑·200 輪）
  const ootRows = daysOut.slice(cut);
  const rand = mulberry32(20260903);
  const placebo = [];
  for (let round = 0; round < 200; round++) {
    let sum = 0, n = 0;
    for (const r of ootRows) {
      const k = r[key].length;
      if (!k) continue;
      const pool = r.universe.slice();
      for (let i = 0; i < k && pool.length; i++) {
        const idx = Math.floor(rand() * pool.length);
        const code = pool.splice(idx, 1)[0];
        const L = execLabel(r.t, code);
        if (L) { sum += L.shortDT; n++; }
      }
    }
    if (n) placebo.push(sum / n);
  }
  placebo.sort((a, b) => b - a);                                     // 空方報酬大=好，降冪
  if (oot.length && placebo.length) {
    const strat = oot.reduce((s, x) => s + x.shortDT, 0) / oot.length;
    const pBest = placebo[0], p95 = placebo[Math.floor(placebo.length * 0.05)];
    const pct = placebo.filter(x => x >= strat).length / placebo.length * 100;
    console.log(`  安慰劑(OOT·當沖空)：策略 ${strat.toFixed(2)}% vs 隨機最佳 ${pBest.toFixed(2)}%·95分位 ${p95.toFixed(2)}%·中位 ${placebo[100].toFixed(2)}% → 策略贏過 ${(100 - pct).toFixed(0)}% 的隨機輪`);
    console.log(strat > pBest ? '  → ✅ 超越隨機最佳' : strat > p95 ? '  → 🟡 超越95分位·未超越隨機最佳' : '  → ❌ 未超越95分位');
  }
}
console.log('\n⚠ 缺 AI 利空/反轉訊號/處置歷史；當沖資格今日名單近似。成本假設：當沖 0.23%/5日 0.43%（2.8折）。回測≠未來。非投資建議。');
