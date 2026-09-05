#!/usr/bin/env node
// ───────────────────────────────────────────────────────────
// 🚀 「大漲前四特徵」回測實驗室（2026-09-05·使用者提供影片截圖：諸葛獵人）
//
// 影片主張：主升段前 20 日內同時出現 ①漲停 ②連續陽線（8–9 連陽） ③向上跳空缺口 ④成交量放倍量且持續
// 本站量化定義（台股口徑，A 股影片只能借概念）：
//   ① 漲停：窗內任一日 收盤/昨收 −1 ≥ 9.5%（台股 10% 限制；興櫃無漲跌停不在宇宙）
//   ② 連陽：窗內最長「收>開」連續天數 ≥ K（K=5 寬鬆／8 影片原義）
//   ③ 缺口：窗內任一日 低 > 前一日高（向上跳空）；另測「到 t 仍未回補」
//   ④ 倍量：近 5 日均量 ≥ 2× 前 20 日均量，且近 3 日每日 ≥ 1.5× 基準（持續性）
//   觸發日 t：四訊號皆在 [t−19, t] 內成立，且最近一個訊號落在最近 5 日內（新鮮）
// 可執行口徑：進場 t+1 開盤（t+1 開盤即漲停＝買不到，剔除）；報酬 5/10/20 日收盤；
//   真起漲＝5 日內不破 t 日低 且 期間曾漲 ≥5%（與波段起漲技能同定義）；成本 0.4425% 來回
// 宇宙：20 日均成交額 ≥ 5,000 萬、有完整 OHLC。基準＝宇宙全部 stock-day。
// OOT：日期前 70% 主窗、後 30% OOT。安慰劑：同量隨機（mulberry32）。
// 同檔 10 日內重複觸發只算第一次（去重版）；原始版也列出。
// ───────────────────────────────────────────────────────────
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync } from 'node:fs';

initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))) });
const db = getFirestore();
function mulberry32(seed) { return function () { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const COST = 0.4425;
const W = 20, WARM = 45, FWD = 20;

console.log('載入 chipArchive…');
const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(420).get();
const days = snap.docs.map(d => d.data()).filter(a => a.closeJson).map(a => ({ date: a.date, close: JSON.parse(a.closeJson) })).reverse();
console.log(`${days.length} 天（${days[0].date} → ${days[days.length - 1].date}）`);
let names = {};
try { const s = (await db.collection('marketSnapshot').doc('latest').get()).data(); const q = s?.quotesJson ? JSON.parse(s.quotesJson) : (s?.quotes || {}); for (const k in q) names[k] = q[k].name; } catch { /* 名稱可省 */ }

const pct = (a, b) => b > 0 ? (a - b) / b * 100 : null;
const rows = [];   // 每一筆 stock-day 觀測
for (let t = WARM; t < days.length - FWD; t++) {
  const D = days[t];
  for (const code of Object.keys(D.close)) {
    const ser = [];
    for (let k = t - WARM; k <= t; k++) { const x = days[k].close[code]; if (Array.isArray(x) && x[0] > 0 && x[2] > 0 && x[3] > 0 && x[4] > 0) ser.push(x); else ser.push(null); }
    const win = ser.slice(-W);                          // [t-19..t]
    if (win.some(x => !x)) continue;                     // 窗內必須完整 OHLC
    const pre = ser.slice(-W - 20, -W).filter(Boolean);  // 前 20 日（倍量基準）
    if (pre.length < 15) continue;
    const c = win.map(x => x[0]), v = win.map(x => x[1]), o = win.map(x => x[2]), h = win.map(x => x[3]), l = win.map(x => x[4]);
    const avgAmt = win.reduce((s, x, i) => s + c[i] * v[i] * 1000, 0) / W;
    if (avgAmt < 50_000_000) continue;
    const prevC0 = ser[ser.length - W - 1]?.[0] || null;
    // ① 漲停
    let s1 = -1; for (let i = 0; i < W; i++) { const pc = i === 0 ? prevC0 : c[i - 1]; if (pc > 0 && pct(c[i], pc) >= 9.5) s1 = i; }
    // ② 連陽最長串（收>開）
    let run = 0, best = 0, bestEnd = -1; for (let i = 0; i < W; i++) { if (c[i] > o[i]) { run++; if (run >= best) { best = run; bestEnd = i; } } else run = 0; }
    // ③ 向上跳空
    let s3 = -1, s3open = false; for (let i = 1; i < W; i++) if (l[i] > h[i - 1]) { s3 = i; s3open = c[W - 1] > h[i - 1]; }
    // ④ 倍量（近 5 vs 前 20）＋持續
    const base = pre.reduce((s, x) => s + x[1], 0) / pre.length;
    const last5 = v.slice(-5).reduce((s, x) => s + x, 0) / 5;
    const s4 = base > 0 && last5 >= 2 * base && v.slice(-3).every(x => x >= 1.5 * base);
    const chgT = pct(c[W - 1], c[W - 2]);
    // 前瞻（t+1 開盤進場）
    const n1 = days[t + 1].close[code]; if (!Array.isArray(n1) || !(n1[2] > 0)) continue;
    const entry = n1[2];
    if (pct(entry, c[W - 1]) >= 9.5) continue;            // 開盤即漲停買不到
    const fwd = k => days[t + k]?.close[code]?.[0] || null;
    const r5 = pct(fwd(5), entry), r10 = pct(fwd(10), entry), r20 = pct(fwd(20), entry);
    if (r5 == null || r10 == null || r20 == null) continue;
    let minLow5 = Infinity, maxC20 = -Infinity; for (let k = 1; k <= 5; k++) { const x = days[t + k].close[code]; if (x?.[4] > 0) minLow5 = Math.min(minLow5, x[4]); } for (let k = 1; k <= 20; k++) { const x = days[t + k].close[code]; if (x?.[0] > 0) maxC20 = Math.max(maxC20, x[0]); }
    const trueStart = minLow5 >= l[W - 1] && pct(maxC20, entry) >= 5;
    rows.push({ code, t, date: D.date, s1, runLen: best, runEnd: bestEnd, s3, s3open, s4, chgT, entry, r5, r10, r20, mdd: pct(minLow5, entry), hit10: pct(maxC20, entry) >= 10, trueStart });
  }
}
console.log(`觀測 ${rows.length} 筆 stock-day`);
const splitT = days[WARM + Math.floor((days.length - WARM - FWD) * 0.7)].date;

function fresh(r, K) { const last = Math.max(r.s1, r.runEnd, r.s3); return r.runLen >= K && r.s1 >= 0 && r.s3 >= 0 && r.s4 && last >= W - 5; }
const SETS = {
  '基準（宇宙全部）': () => true,
  '①漲停(窗內)': r => r.s1 >= 0,
  '②連陽≥5': r => r.runLen >= 5,
  '②連陽≥8': r => r.runLen >= 8,
  '③缺口(窗內)': r => r.s3 >= 0,
  '③缺口未回補': r => r.s3 >= 0 && r.s3open,
  '④倍量持續': r => r.s4,
  '①∧③∧④': r => r.s1 >= 0 && r.s3 >= 0 && r.s4,
  '四訊號 K=5': r => r.runLen >= 5 && r.s1 >= 0 && r.s3 >= 0 && r.s4,
  '四訊號 K=5 新鮮(≤5日)': r => fresh(r, 5),
  '四訊號 K=8': r => r.runLen >= 8 && r.s1 >= 0 && r.s3 >= 0 && r.s4,
  '四訊號 K=5 新鮮 ∧ 今日≤3%(未追高)': r => fresh(r, 5) && r.chgT <= 3,
};
function stat(arr) {
  const n = arr.length; if (!n) return null;
  const m = k => arr.reduce((s, r) => s + r[k], 0) / n;
  const win = k => arr.filter(r => r[k] - COST > 0).length / n * 100;
  return { n, r5: m('r5') - COST, r10: m('r10') - COST, r20: m('r20') - COST, w5: win('r5'), w20: win('r20'), ts: arr.filter(r => r.trueStart).length / n * 100, hit10: arr.filter(r => r.hit10).length / n * 100, mdd: m('mdd'), med20: [...arr].sort((a, b) => a.r20 - b.r20)[Math.floor(n / 2)].r20 - COST };
}
const dedup = arr => { const last = {}; return arr.filter(r => { if (last[r.code] != null && r.t - last[r.code] < 10) return false; last[r.code] = r.t; return true; }); };
const fmt = s => s ? `n=${String(s.n).padStart(6)}  5日${s.r5.toFixed(2).padStart(6)}%  10日${s.r10.toFixed(2).padStart(6)}%  20日${s.r20.toFixed(2).padStart(6)}%(中位${s.med20.toFixed(2)}%)  勝5/20 ${s.w5.toFixed(1)}/${s.w20.toFixed(1)}%  真起漲${s.ts.toFixed(1)}%  +10%命中${s.hit10.toFixed(1)}%  5日最深${s.mdd.toFixed(2)}%` : 'n=0';
const out = [];
const P = s => { console.log(s); out.push(s); };
P(`資料 ${days[0].date}→${days[days.length - 1].date}｜主窗 <${splitT}｜OOT ≥${splitT}｜成本 ${COST}%（淨值）`);
for (const [name, f] of Object.entries(SETS)) {
  const all = rows.filter(f);
  P(`\n▶ ${name}`);
  P(`  主窗   ${fmt(stat(all.filter(r => r.date < splitT)))}`);
  P(`  OOT    ${fmt(stat(all.filter(r => r.date >= splitT)))}`);
  if (name !== '基準（宇宙全部）') { const d = dedup(all); P(`  去重   ${fmt(stat(d))}`); }
}
// 安慰劑：與「四訊號 K=5 新鮮」同量隨機
const target = dedup(rows.filter(r => fresh(r, 5)));
const rnd = mulberry32(20260905); const pl = []; const idx = new Set();
while (pl.length < target.length && idx.size < rows.length) { const i = Math.floor(rnd() * rows.length); if (!idx.has(i)) { idx.add(i); pl.push(rows[i]); } }
P(`\n▶ 安慰劑（同量隨機 n=${pl.length}）`); P(`  ${fmt(stat(pl))}`);
// 案例
const cases = target.map(r => ({ ...r, name: names[r.code] || '' })).sort((a, b) => b.r20 - a.r20);
P(`\n▶ 案例（四訊號 K=5 新鮮·去重 n=${cases.length}）——前 12 名與後 6 名（20 日淨報酬）`);
const line = r => `  ${r.date} ${r.code} ${r.name.padEnd(5, '　')} 連陽${r.runLen} 漲停@${r.s1 - W + 1}d 缺口@${r.s3 - W + 1}d${r.s3open ? '未補' : '已補'} 今${r.chgT.toFixed(1)}% → 5日${(r.r5 - COST).toFixed(1)}% 10日${(r.r10 - COST).toFixed(1)}% 20日${(r.r20 - COST).toFixed(1)}% 最深${r.mdd.toFixed(1)}% ${r.trueStart ? '✅真起漲' : ''}`;
for (const r of cases.slice(0, 12)) P(line(r));
P('  …');
for (const r of cases.slice(-6)) P(line(r));
// 月份分布（避免單一事件 artifact）
const byM = {}; for (const r of target) { const m = r.date.slice(0, 7); byM[m] = (byM[m] || 0) + 1; }
P(`\n▶ 觸發月份分布：${Object.entries(byM).sort().map(([m, n]) => `${m}:${n}`).join(' ')}`);
writeFileSync('/tmp/four-signal-lab.out', out.join('\n'));
process.exit(0);
