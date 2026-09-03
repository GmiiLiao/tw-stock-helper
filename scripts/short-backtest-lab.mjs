#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 🐻 做空風控候選——歷史回測實驗室（2026-09-03·使用者要求）
//
// 目的：用 chipArchive 399 天歷史重演選股規則，回答「這榜準不準」——
// 不取代前瞻累積（shortTraining），只是先給一個有紀律的歷史讀數。
//
// ── 誠實聲明（缺什麼、近似了什麼）──────────────────────────────
//  ✗ AI 利空判別：歷史快照不存在 → 排除（生產版有、回測沒有）
//  ✗ 反轉訊號四清單：dated 快照不存在 → 排除
//  ✗ 處置股歷史名單、除權息歷史回補期 → 排除（影響個股數少）
//  ≈ 當沖先賣資格：用今日名單近似歷史（名單月頻變動、偏差小）
//  ≈ 軋空榜反查：歷史榜不存在 → 用「券資比>10% 且 5日漲>5%」近似
//  ✓ 可完整重演：跌幅/空頭排列/破20日低/寶塔翻黑/外資連賣/借券增/
//    券資比排除/流動性/市況(breadth proxy)
//
// ── PIT 紀律 ──────────────────────────────────────────────
//  · 選股日 t 的定榜時點=盤後 15:10 ⇒ 法人(T86 約16:00出)與資券(21:45出)
//    一律用 **t-1**；價量用 t 當日收盤
//  · 標籤：t+1 開→收(o2c)、t+1 收→收(c2c)、t+1..t+5 c2c
//  · OOT：按日期 70/30 切；安慰劑：每日隨機同量抽樣×200（mulberry32）
//
// 執行：GOOGLE_APPLICATION_CREDENTIALS=... node scripts/short-backtest-lab.mjs
// ─────────────────────────────────────────────────────────────────────────
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))) });
const db = getFirestore();

// mulberry32（2026-08-31 教訓：LCG 精度崩壞讓安慰劑失真）
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('載入 chipArchive 399 天…');
const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(400).get();
const days = snap.docs.map(d => d.data())
  .filter(a => a.closeJson)
  .map(a => ({
    date: a.date,
    close: JSON.parse(a.closeJson),                        // code → [收,量張,開,高,低]
    margin: a.marginJson ? JSON.parse(a.marginJson) : null, // code → [資餘,券餘]
    inst: a.instJson ? JSON.parse(a.instJson) : null,       // code → [外資,投信](張)
    lend: a.lendingJson ? JSON.parse(a.lendingJson) : null, // code → 借券餘(股)
  }))
  .reverse();                                              // 舊→新
console.log(`${days.length} 天（${days[0].date} → ${days[days.length - 1].date}）`);

// 當沖先賣資格（今日名單近似歷史——見頂部聲明）
let dtMap = {};
try {
  const dt = (await db.collection('dayTradeEligible').doc('latest').get()).data();
  if (dt?.codesJson) dtMap = JSON.parse(dt.codesJson);
} catch { /* 缺→資格層少一濾網，會於結果聲明 */ }

// ── 寶塔線(3) 重演：收>前三根寶塔高→紅、收<前三根寶塔低→黑、否則延續 ──
function pagodaFlipDown(closes) {
  // 回傳最後一根是否「翻黑」（前一根非黑、這根黑）
  const pag = [];                                          // {hi, lo, dir}
  for (const c of closes) {
    if (pag.length < 3) { pag.push({ hi: c, lo: c, dir: 0 }); continue; }
    const last3 = pag.slice(-3);
    const hi3 = Math.max(...last3.map(p => p.hi)), lo3 = Math.min(...last3.map(p => p.lo));
    const prev = pag[pag.length - 1];
    let dir = prev.dir;
    if (c > hi3) dir = 1; else if (c < lo3) dir = -1;
    pag.push({ hi: Math.max(prev.hi, c), lo: Math.min(prev.lo, c), dir });
    // 寶塔實體：翻向時重置高低
    if (dir !== prev.dir) { pag[pag.length - 1] = { hi: c, lo: c, dir }; }
  }
  const n = pag.length;
  return n >= 2 && pag[n - 1].dir === -1 && pag[n - 2].dir !== -1;
}

// ── 主迴圈：t 從 22 到 len-6 ────────────────────────────────
const WARM = 21, LABEL = 5;
const results = [];                                        // {date, picks:[{code,score,o2c,c2c,c5}], universe:[codes], breadth}
for (let t = WARM; t < days.length - LABEL; t++) {
  const D = days[t], D1 = days[t + 1];
  const prevMargin = days[t - 1].margin, prevInst = days[t - 1].inst;
  const prevLend = days[t - 1].lend, prev2Lend = days[t - 2].lend;
  // breadth（市況 proxy）：全市場上漲家數比
  let up = 0, dn = 0;
  for (const c in D.close) {
    const r = D.close[c], p = days[t - 1].close[c];
    if (!Array.isArray(r) || !Array.isArray(p) || !(r[0] > 0) || !(p[0] > 0)) continue;
    if (r[0] > p[0]) up++; else if (r[0] < p[0]) dn++;
  }
  const breadth = up + dn > 0 ? up / (up + dn) * 100 : 50;

  const universe = [], picks = [];
  for (const code of Object.keys(D.close)) {
    const r = D.close[code];
    if (!Array.isArray(r) || !(r[0] > 0)) continue;
    const price = r[0];
    // 序列（含 t）
    const ser = [];
    for (let k = t - WARM; k <= t; k++) { const x = days[k].close[code]; if (Array.isArray(x) && x[0] > 0) ser.push(x); }
    if (ser.length < 21) continue;
    // 資格層
    const avgAmt = ser.slice(-20).reduce((s, x) => s + x[0] * (x[1] || 0) * 1000, 0) / 20;
    if (avgAmt < 50_000_000) continue;
    if (Object.keys(dtMap).length && dtMap[code] !== 1) continue;
    // 風控層（t-1 資券）
    const mg = prevMargin?.[code];
    const sr = Array.isArray(mg) && mg[0] > 0 ? (mg[1] || 0) / mg[0] * 100 : null;
    if (sr != null && sr > 15) continue;
    // 軋空近似排除：券資比>10% 且 5 日漲>5%
    const c5ago = ser.length >= 6 ? ser[ser.length - 6][0] : null;
    const ret5 = c5ago > 0 ? (price - c5ago) / c5ago * 100 : 0;
    if (sr != null && sr > 10 && ret5 > 5) continue;
    universe.push(code);
    // 評分層
    const closes = ser.map(x => x[0]);
    const prevC = closes[closes.length - 2];
    const chg = prevC > 0 ? (price - prevC) / prevC * 100 : 0;
    const ma = n => closes.slice(-n).reduce((s, x) => s + x, 0) / n;
    const ma5 = ma(5), ma20 = ma(20);
    const low20 = Math.min(...closes.slice(-21, -1));
    let score = 0, sig = 0;
    if (chg < -2) { score += 2; sig++; }
    if (ma5 < ma20 && price < ma20) { score += 4; sig++; }
    if (price < low20) { score += 3; sig++; }
    if (pagodaFlipDown(closes)) { score += 5; sig++; }
    // 外資連賣（t-1 起回看）
    let streak = 0;
    for (let k = t - 1; k >= t - 8 && k >= 0; k--) {
      const iv = days[k].inst?.[code];
      if (Array.isArray(iv) && (iv[0] || 0) < 0) streak++; else break;
    }
    if (streak >= 3) { score += Math.min(8, streak * 2); sig++; }
    // 借券增（t-1 vs t-2·>10% 日均量）
    const ln = prevLend?.[code], lp = prev2Lend?.[code];
    if (ln != null && lp != null) {
      const avgVol = ser.slice(-20).reduce((s, x) => s + (x[1] || 0), 0) / 20 * 1000;
      if (avgVol > 0 && ln > lp && ln - lp > avgVol * 0.1) { score += 4; sig++; }
    }
    if (score < 8 || sig < 2) continue;
    picks.push({ code, score });
  }
  picks.sort((a, b) => b.score - a.score);
  const top = picks.slice(0, 20);
  // 標籤
  const label = (code) => {
    const n1 = D1.close[code];
    if (!Array.isArray(n1) || !(n1[0] > 0)) return null;
    const o2c = n1[2] > 0 ? (n1[0] - n1[2]) / n1[2] * 100 : null;
    const c2c = (n1[0] - D.close[code][0]) / D.close[code][0] * 100;
    let c5 = null;
    const n5 = days[t + LABEL]?.close[code];
    if (Array.isArray(n5) && n5[0] > 0) c5 = (n5[0] - D.close[code][0]) / D.close[code][0] * 100;
    return { o2c, c2c, c5 };
  };
  const labeled = top.map(p => ({ ...p, ...label(p.code) })).filter(p => p.c2c != null);
  if (labeled.length) results.push({ date: D.date, picks: labeled, universe, breadth, t });
}
console.log(`重演完成：${results.length} 個交易日有榜`);

// ── 統計 ─────────────────────────────────────────────────
const cut = Math.floor(results.length * 0.7);
const report = (rs, tag) => {
  const all = rs.flatMap(r => r.picks);
  if (!all.length) { console.log(`${tag}: 無樣本`); return null; }
  const wr = all.filter(p => p.c2c < 0).length / all.length * 100;
  const avg = all.reduce((s, p) => s + p.c2c, 0) / all.length;
  const o2cOk = all.filter(p => p.o2c != null);
  const wrO = o2cOk.filter(p => p.o2c < 0).length / o2cOk.length * 100;
  const c5Ok = all.filter(p => p.c5 != null);
  const avg5 = c5Ok.reduce((s, p) => s + p.c5, 0) / c5Ok.length;
  // 基準：每日 universe 全體
  let bSum = 0, bN = 0;
  for (const r of rs) {
    const D = days[r.t], D1 = days[r.t + 1];
    for (const code of r.universe) {
      const n1 = D1.close[code];
      if (Array.isArray(n1) && n1[0] > 0 && D.close[code][0] > 0) { bSum += (n1[0] - D.close[code][0]) / D.close[code][0] * 100; bN++; }
    }
  }
  const bench = bN ? bSum / bN : 0;
  console.log(`${tag}: n=${all.length}(${rs.length}日) | 隔日勝率(跌) c2c ${wr.toFixed(1)}% / o2c ${wrO.toFixed(1)}% | 隔日均 ${avg.toFixed(2)}% | 5日均 ${avg5.toFixed(2)}% | 宇宙基準隔日均 ${bench.toFixed(2)}%（超額 ${(avg - bench).toFixed(2)}pp·空方要負值）`);
  return { rs, avg, bench };
};

console.log('\n══ 全期 ══'); report(results, '全期');
console.log('\n══ 主窗/OOT（70/30 按日期切）══');
report(results.slice(0, cut), '主窗');
const oot = report(results.slice(cut), 'OOT ');
console.log('\n══ 市況分組（breadth proxy：<40%=偏空日≈active）══');
report(results.filter(r => r.breadth < 40), '偏空日');
report(results.filter(r => r.breadth >= 40), '其他日');

// ── 安慰劑（OOT 段·每日隨機抽同量×200 輪）──────────────────
console.log('\n══ 安慰劑檢定（OOT 段·200 輪隨機同量抽樣）══');
const ootRs = results.slice(cut);
const rand = mulberry32(20260903);
const placebo = [];
for (let round = 0; round < 200; round++) {
  let sum = 0, n = 0;
  for (const r of ootRs) {
    const D = days[r.t], D1 = days[r.t + 1];
    const k = r.picks.length;
    const pool = r.universe.slice();
    for (let i = 0; i < k && pool.length; i++) {
      const idx = Math.floor(rand() * pool.length);
      const code = pool.splice(idx, 1)[0];
      const n1 = D1.close[code];
      if (Array.isArray(n1) && n1[0] > 0 && D.close[code][0] > 0) { sum += (n1[0] - D.close[code][0]) / D.close[code][0] * 100; n++; }
    }
  }
  if (n) placebo.push(sum / n);
}
placebo.sort((a, b) => a - b);
const stratAvg = ootRs.flatMap(r => r.picks).reduce((s, p) => s + p.c2c, 0) / ootRs.flatMap(r => r.picks).length;
const p5 = placebo[Math.floor(placebo.length * 0.05)];
const pMin = placebo[0];
const beat = placebo.filter(x => x <= stratAvg).length / placebo.length * 100;
console.log(`策略 OOT 隔日均 ${stratAvg.toFixed(2)}% | 隨機 200 輪：最好(最負) ${pMin.toFixed(2)}%·5分位 ${p5.toFixed(2)}%·中位 ${placebo[100].toFixed(2)}%`);
console.log(`策略落在隨機分佈的第 ${beat.toFixed(0)} 百分位（越低越好·空方求跌）`);
console.log(stratAvg < pMin ? '→ ✅ 超越隨機最佳' : stratAvg < p5 ? '→ 🟡 超越 5 分位、未超越隨機最佳' : '→ ❌ 未超越隨機 5 分位——依站規此排序不可宣稱有效');
console.log('\n⚠ 回測缺 AI 利空判別/反轉訊號/處置歷史（生產版有）；當沖資格與軋空反查為近似。回測≠未來。非投資建議。');
