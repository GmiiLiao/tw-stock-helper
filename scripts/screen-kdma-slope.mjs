// ─────────────────────────────────────────────────────────────────────────
// KD 曲線 × MA 曲線「相對值／斜率」回測 —— 2026-08-02
//
// 承前六輪。已知：
//   · KD 固定門檻（80/20、金叉死叉）→ 起漲端全滅，只有避開端 K>90 可用
//   · KD **相對值** → 十分位曲線乾淨（K 斜率 OOT 單調 9/9、頭尾差 -1.215%），
//     但主窗兩半換號；價量 16 分層、大盤 10 種環境都救不起來
//   · MA 只測過**位置**（價 vs MA20、多頭排列、糾結）——**斜率從未測過**
//
// 本輪補上缺的那塊，並做二維：
//   ① MA5/MA20/MA60 斜率（正規化為 %/日，跨股可比）的十分位單調性
//   ② KD 斜率 × MA20 斜率 的 4×4 網格 —— 找「短線回檔但趨勢向上」這類背離格
//   ③ 兩者的相對關係（KD 斜率 − MA 斜率的標準化差）
//   ④ 若 orderFlowArchive 已回補，用「市場委託失衡」當 regime gate 再切一次
//      （前面用大盤報酬/波動/漲跌家數都抓不到那個時間開關，換一個維度試）
//
// 口徑：5 日持有（相對值的訊息都在波段尺度，隔日沖尺度前面已證實無效）
//       可交易宇宙、扣費稅、兩半窗 + 第三獨立窗 OOT、中位數同列（防極端值灌水）
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';
import admin from 'firebase-admin';

const P = 9;
/** 線性回歸斜率（等距 x=0..n-1） */
const slope = a => {
  const n = a.length; if (n < 2) return null;
  const sx = (n - 1) * n / 2, sxx = (n - 1) * n * (2 * n - 1) / 6;
  let sy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sy += a[i]; sxy += i * a[i]; }
  const d = n * sxx - sx * sx;
  return d ? (n * sxy - sx * sy) / d : null;
};

function buildInd(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const c in days[i].close) {
      if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
      const r = days[i].close[c];
      if (!r || r.length < 5) continue;
      const [cl, , , h, l] = r;
      if (!(cl > 0 && h > 0 && l > 0 && h >= l)) continue;
      const s = (st[c] ||= { k: 50, d: 50, hs: [], ls: [], cs: [], kh: [], m5: [], m20: [], m60: [] });
      s.hs.push(h); s.ls.push(l); if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
      s.cs.push(cl); if (s.cs.length > 60) s.cs.shift();
      if (s.hs.length < P || s.cs.length < 60) continue;
      const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
      const rsv = hn === ln ? 50 : ((cl - ln) / (hn - ln)) * 100;
      s.k = (s.k * 2) / 3 + rsv / 3; s.d = (s.d * 2) / 3 + s.k / 3;
      const ma = n => { const a = s.cs.slice(-n); return a.reduce((x, y) => x + y, 0) / n; };
      const m5 = ma(5), m20 = ma(20), m60 = ma(60);
      s.m5.push(m5); if (s.m5.length > 12) s.m5.shift();
      s.m20.push(m20); if (s.m20.length > 22) s.m20.shift();
      s.m60.push(m60); if (s.m60.length > 32) s.m60.shift();
      if (s.kh.length >= 60 && s.m20.length >= 21 && s.m60.length >= 21) {
        const kS = slope([...s.kh.slice(-4), s.k]);                       // KD 斜率（K 值/日）
        // MA 斜率正規化成 %/日：除以當前 MA 水位 → 跨股跨價位可比
        const m5S = m5 > 0 ? slope(s.m5.slice(-5)) / m5 * 100 : null;
        const m20S = m20 > 0 ? slope(s.m20.slice(-11)) / m20 * 100 : null;
        const m60S = m60 > 0 ? slope(s.m60.slice(-21)) / m60 * 100 : null;
        out[`${i}_${c}`] = {
          k: s.k, kSlope: kS, ma5Slope: m5S, ma20Slope: m20S, ma60Slope: m60S,
          // KD 斜率標準化（K 值域 0~100，除以 10 讓量級接近 MA 的 %/日）
          kdMaGap: kS != null && m20S != null ? kS / 10 - m20S : null,
        };
      }
      s.kh.push(s.k); if (s.kh.length > 80) s.kh.shift();
    }
  }
  return out;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const ind = buildInd(days);
  for (const s of samples) { Object.assign(s, ind[`${s.di}_${s.code}`] || {}); s.date = days[s.di].date; }
  return samples.filter(s => s.tradable && s.kSlope != null && s.ma20Slope != null && s.net5 != null);
};

const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };
const mono = arr => { const d = []; for (let i = 1; i < arr.length; i++) d.push(arr[i] - arr[i - 1]); const p = d.filter(x => x > 0).length, n = d.filter(x => x < 0).length; return Math.max(p, n); };

function deciles(w, f) {
  const v = w.map(f).filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  const cut = []; for (let q = 1; q < 10; q++) cut.push(v[Math.floor(v.length * q / 10)]);
  const b = Array.from({ length: 10 }, () => []);
  for (const s of w) { const x = f(s); if (x == null || !Number.isFinite(x)) continue; let i = 0; while (i < 9 && x >= cut[i]) i++; b[i].push(s); }
  return b;
}
const H = t => console.log(`\n${'═'.repeat(128)}\n══ ${t}\n${'═'.repeat(128)}`);

console.log('5 日持有·可交易宇宙·扣費稅｜MA 斜率已正規化為 %/日（跨股可比）');
for (const [wn, w] of Object.entries(W)) console.log(`  ${wn} 基準：均 ${r3(avg(w.map(s => s.net5)))}% 中位 ${med(w.map(s => s.net5))}% n=${w.length.toLocaleString()}`);

H('① 各曲線斜率的十分位單調性（左=最負斜率 → 右=最正斜率）');
for (const [name, f] of [['KD 斜率', s => s.kSlope], ['MA5 斜率', s => s.ma5Slope],
  ['MA20 斜率', s => s.ma20Slope], ['MA60 斜率', s => s.ma60Slope], ['KD−MA20 相對差', s => s.kdMaGap]]) {
  for (const [wn, w] of Object.entries(W)) {
    const bs = deciles(w, f);
    const ms = bs.map(b => (b.length ? avg(b.map(s => s.net5)) : null));
    const ok = ms.every(m => m != null);
    console.log(`  ${(wn === '主窗' ? name : '').padEnd(14)} ${wn.padEnd(4)} ${ms.map(m => (m == null ? '  --  ' : String(r3(m)).padStart(6))).join(' ')}  單調 ${ok ? mono(ms) : 0}/9  頭尾差 ${ok ? r3(ms[9] - ms[0]) : '--'}`);
  }
}

H('② KD 斜率 × MA20 斜率 4×4 網格（找「短線回檔 × 趨勢向上」的背離格）');
for (const [wn, w] of Object.entries(W)) {
  const q = (arr, f) => { const v = arr.map(f).sort((a, b) => a - b); return [1, 2, 3].map(i => v[Math.floor(v.length * i / 4)]); };
  const kq = q(w, s => s.kSlope), mq = q(w, s => s.ma20Slope);
  const bin = (v, c) => { let i = 0; while (i < 3 && v >= c[i]) i++; return i; };
  console.log(`\n  【${wn}】列＝KD斜率四分位（上:最負→下:最正）  欄＝MA20斜率四分位（左:最負→右:最正）`);
  console.log('        MA20 Q1        MA20 Q2        MA20 Q3        MA20 Q4');
  for (let ki = 0; ki < 4; ki++) {
    const cells = [];
    for (let mi = 0; mi < 4; mi++) {
      const sel = w.filter(s => bin(s.kSlope, kq) === ki && bin(s.ma20Slope, mq) === mi);
      if (sel.length < 200) { cells.push('   不足     '); continue; }
      const h = [0, 1].map(f => avg(sel.filter(s => s.half === f).map(s => s.net5)));
      const same = Math.sign(h[0]) === Math.sign(h[1]);
      cells.push(`${String(r3(avg(sel.map(s => s.net5)))).padStart(7)}%${same ? ' ' : '⚠'}${String(sel.length).padStart(6)}`);
    }
    console.log(`  KD Q${ki + 1}  ${cells.join(' ')}`);
  }
}

H('③ 背離格深究：KD 斜率為負（短線回落）× MA20 斜率為正（中期向上）');
function row(label, cond, minN = 300) {
  const cells = [];
  for (const [wn, w] of Object.entries(W)) {
    const sel = w.filter(cond);
    if (sel.length < minN) { cells.push(`${wn} 不足(${sel.length})`.padEnd(52)); continue; }
    const h = [0, 1].map(f => r3(avg(sel.filter(s => s.half === f).map(s => s.net5))));
    const same = Math.sign(h[0]) === Math.sign(h[1]);
    const wr = (sel.filter(s => s.net5 > 0).length / sel.length * 100).toFixed(1);
    cells.push(`${wn} 均${String(r3(avg(sel.map(s => s.net5)))).padStart(7)}% 中位${String(med(sel.map(s => s.net5))).padStart(7)}% 勝${String(wr).padStart(5)}%[${h[0]}/${h[1]}]${same ? '✓' : '⚠'} n=${String(sel.length).padStart(6)}`.padEnd(52));
  }
  console.log(`  ${label.padEnd(28)} ${cells.join(' ')}`);
}
row('KD斜率<0 ∧ MA20斜率>0', s => s.kSlope < 0 && s.ma20Slope > 0);
row('KD斜率<0 ∧ MA20斜率>0.1', s => s.kSlope < 0 && s.ma20Slope > 0.1);
row('KD斜率<0 ∧ MA20/MA60皆>0', s => s.kSlope < 0 && s.ma20Slope > 0 && s.ma60Slope > 0);
row('KD斜率>0 ∧ MA20斜率<0', s => s.kSlope > 0 && s.ma20Slope < 0);
row('KD斜率<0 ∧ MA20斜率<0', s => s.kSlope < 0 && s.ma20Slope < 0);
row('KD斜率>0 ∧ MA20斜率>0', s => s.kSlope > 0 && s.ma20Slope > 0);

// ④ 市場委託失衡 regime gate（若已回補）
if (!admin.apps.length) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||= '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
  admin.initializeApp();
}
const ofSnap = await admin.firestore().collection('orderFlowArchive').get();
const OF = {};
for (const d of ofSnap.docs) { const x = d.data(); if (!x.skipped) OF[x.date] = x; }
H(`④ 市場委託失衡 regime gate（orderFlowArchive 現有 ${Object.keys(OF).length} 日）`);
if (Object.keys(OF).length < 200) {
  console.log('  回補尚未完成或涵蓋不足，本節略過（需 ≥200 日才有分組意義）。');
} else {
  for (const w of Object.values(W)) for (const s of w) s.of = OF[s.date] || null;
  const covered = Object.values(W).map(w => w.filter(s => s.of).length);
  console.log(`  可對應委託失衡的樣本：主窗 ${covered[0].toLocaleString()}／OOT ${covered[1].toLocaleString()}`);
  const oq = (() => { const v = Object.values(OF).map(x => x.imbalance).filter(x => x != null).sort((a, b) => a - b); return [v[Math.floor(v.length / 3)], v[Math.floor(v.length * 2 / 3)]]; })();
  console.log(`  收盤委託失衡三分位切點：${r3(oq[0])} / ${r3(oq[1])}\n`);
  const BEST = s => s.kSlope < 0 && s.ma20Slope > 0;   // ③ 的主要背離格
  row('背離格 ∧ 失衡低(買氣弱)', s => BEST(s) && s.of && s.of.imbalance < oq[0], 150);
  row('背離格 ∧ 失衡中', s => BEST(s) && s.of && s.of.imbalance >= oq[0] && s.of.imbalance < oq[1], 150);
  row('背離格 ∧ 失衡高(買氣強)', s => BEST(s) && s.of && s.of.imbalance >= oq[1], 150);
  row('背離格 ∧ 尾盤失衡轉弱', s => BEST(s) && s.of && s.of.tailImbShift < 0, 150);
  row('背離格 ∧ 尾盤失衡轉強', s => BEST(s) && s.of && s.of.tailImbShift >= 0, 150);
}
console.log(`\n${'═'.repeat(128)}`);
console.log('判準：均與中位數皆為正 ∧ 主窗兩半同向(✓) ∧ OOT 同樣成立。單調性 ≥7/9 才視為真結構。');
process.exit(0);
