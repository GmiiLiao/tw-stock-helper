#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Tier-2 細化回測：把 Tier-1 過關/邊際參數做交叉與門檻掃描
//
// 前視守衛：炒作傾向分類「只用回測窗之前的資料」計算（instVolShare 前40%
// 且 chipLeadCorr>0.05），不用全期 chipCharacter 標籤。
// 交易語意同前：訊號日收盤買、次日收盤賣，扣費稅 0.4425%。120 日＋前後半窗。
//
// R1 新高突破 × 炒作傾向/非炒作     R2 新高突破 × 強尾盤(pos≥0.7)
// R3 新高突破 × 量增(vol≥1.5×20日均) R4 軋空啟動 × 炒作傾向
// R5 投信買超 × 炒作傾向 / 投信連2日買
// R6 弱尾盤門檻掃描(≤0.1/0.2/0.3)——警示濾網定門檻用
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const COST = 0.004425;
const WINDOW = parseInt(process.env.BT_WINDOW || '120');
const OFFSET = parseInt(process.env.BT_OFFSET || '0');
const MIN_VOL = 300;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stat = (a) => a.length ? { n: a.length, win: +(a.filter((r) => r > 0).length / a.length * 100).toFixed(1), avg: +(mean(a) * 100).toFixed(2) } : { n: 0, win: 0, avg: 0 };
const fmt = (s) => `n=${String(s.n).padStart(6)} 勝率${String(s.win).padStart(5)}% 均${String(s.avg).padStart(6)}%${s.n >= 30 && s.avg > 0 ? ' ✅' : ''}`;
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length); if (n < 10) return 0;
  const mx = mean(xs), my = mean(ys); let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

async function main() {
  const snap = await db.collection('chipArchive').get();
  const days = [];
  snap.forEach((d) => {
    const x = d.data();
    if (x.closeJson && x.instJson) days.push({
      date: d.id, close: JSON.parse(x.closeJson), inst: JSON.parse(x.instJson),
      margin: x.marginJson ? JSON.parse(x.marginJson) : null,
    });
  });
  days.sort((a, b) => a.date.localeCompare(b.date));
  const end = OFFSET ? days.length - OFFSET : days.length;
  const start = Math.max(25, end - WINDOW - 1);
  const adj = (i) => (new Date(days[i + 1].date) - new Date(days[i].date)) / 86400000 <= 4;

  // ── 前視安全的炒作傾向：僅用 [0, start) 資料 ──
  const pre = days.slice(0, start);
  const agg = {}; // code -> {absNet, vol, nets[], rets[]}
  for (let i = 0; i < pre.length - 1; i++) {
    const d0 = pre[i], d1 = pre[i + 1];
    for (const c in d0.close) {
      const a = d0.close[c], b = d1.close[c];
      if (!a || !b || !(a[0] > 0) || !(b[0] > 0)) continue;
      const net = d0.inst[c] ? (d0.inst[c][0] + (d0.inst[c][1] || 0)) : 0;
      (agg[c] ||= { absNet: 0, vol: 0, nets: [], rets: [] });
      agg[c].absNet += Math.abs(net); agg[c].vol += a[1] || 0;
      agg[c].nets.push(net); agg[c].rets.push(b[0] / a[0] - 1);
    }
  }
  const shares = Object.entries(agg).filter(([, v]) => v.nets.length >= 60 && v.vol > 0)
    .map(([c, v]) => [c, v.absNet / v.vol]);
  shares.sort((a, b) => a[1] - b[1]);
  const shareCut = shares[Math.floor(shares.length * 0.6)]?.[1] ?? 0; // 前 40%
  const specSet = new Set();
  for (const [c, sh] of shares) {
    if (sh < shareCut) continue;
    const v = agg[c];
    if (pearson(v.nets.slice(0, -0 || undefined), v.rets) > 0.05) specSet.add(c);
  }
  console.log(`[tier2] 窗 ${days[start]?.date}→${days[end - 2]?.date}·前視安全炒作傾向 ${specSet.size} 檔（窗前資料計算）`);

  const arms = {
    'R1 新高×炒作傾向': [], 'R1 新高×非炒作': [], 'R2 新高×強尾盤': [], 'R3 新高×量增1.5x': [],
    'R3b 新高×量增×炒作': [], 'R4 軋空×炒作傾向': [], 'R4b 軋空×非炒作': [],
    'R5 投信買×炒作': [], 'R5b 投信連2買': [], 'R5c 投信連2買×炒作': [],
    'R6 弱尾盤≤0.1': [], 'R6 弱尾盤≤0.2': [], 'R6 弱尾盤≤0.3': [],
  };

  for (let i = start; i < end - 1; i++) {
    if (!adj(i)) continue;
    const day = days[i], prev = days[i - 1], next = days[i + 1];
    for (const code in day.close) {
      const cl = day.close[code], ncl = next.close[code], pcl = prev.close[code];
      if (!cl || !ncl || !pcl || !(cl[0] > 0) || !(ncl[0] > 0) || !(pcl[0] > 0)) continue;
      const vol = cl[1] || 0; if (vol < MIN_VOL) continue;
      const ret = ncl[0] / cl[0] - 1 - COST;
      const chg = (cl[0] / pcl[0] - 1) * 100;
      const hi = cl[3] || 0, lo = cl[4] || 0;
      const pos = hi > lo ? (cl[0] - lo) / (hi - lo) : null;
      const isSpec = specSet.has(code);

      // 新高突破
      let hi20 = 0, volSum = 0, volN = 0;
      for (let k = i - 20; k < i; k++) { const v = days[k]?.close[code]; if (v?.[0] > hi20) hi20 = v[0]; if (v?.[1] > 0) { volSum += v[1]; volN++; } }
      const avg20 = volN ? volSum / volN : 0;
      const isBreak = hi20 > 0 && cl[0] > hi20 && pcl[0] <= hi20;
      if (isBreak) {
        (isSpec ? arms['R1 新高×炒作傾向'] : arms['R1 新高×非炒作']).push(ret);
        if (pos != null && pos >= 0.7) arms['R2 新高×強尾盤'].push(ret);
        if (avg20 > 0 && vol >= avg20 * 1.5) {
          arms['R3 新高×量增1.5x'].push(ret);
          if (isSpec) arms['R3b 新高×量增×炒作'].push(ret);
        }
      }
      // 軋空 × 炒作
      const pm = prev.margin?.[code], ppm = days[i - 2]?.margin?.[code];
      if (pm && ppm) {
        const sChgY = (pm[1] || 0) - (ppm[1] || 0), pvol = pcl[1] || 0;
        if (pvol >= MIN_VOL && sChgY >= pvol * 0.005 && chg > 2) (isSpec ? arms['R4 軋空×炒作傾向'] : arms['R4b 軋空×非炒作']).push(ret);
      }
      // 投信
      const t0 = day.inst[code]?.[1] || 0, t1 = prev.inst[code]?.[1] || 0;
      if (t0 > 0 && t0 / vol >= 0.01) {
        if (isSpec) arms['R5 投信買×炒作'].push(ret);
        if (t1 > 0) { arms['R5b 投信連2買'].push(ret); if (isSpec) arms['R5c 投信連2買×炒作'].push(ret); }
      }
      // 弱尾盤掃描（|chg|>1）
      if (pos != null && Math.abs(chg) > 1) {
        if (pos <= 0.1) arms['R6 弱尾盤≤0.1'].push(ret);
        if (pos <= 0.2) arms['R6 弱尾盤≤0.2'].push(ret);
        if (pos <= 0.3) arms['R6 弱尾盤≤0.3'].push(ret);
      }
    }
  }

  for (const k of Object.keys(arms)) console.log(`  ${k.padEnd(14, '　')}: ${fmt(stat(arms[k]))}`);
  console.log('\n非投資建議。');
  process.exit(0);
}
main().catch((e) => { console.error('[tier2] 失敗:', e); process.exit(1); });
