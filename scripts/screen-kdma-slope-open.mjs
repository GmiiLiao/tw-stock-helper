// ─────────────────────────────────────────────────────────────────────────
// KD 斜率 × MA 斜率 —— **明開賣（隔日沖）口徑補測** —— 2026-08-02
//
// 為什麼要補：screen-kdma-slope.mjs 整份只跑 5 日持有。但使用者做的是隔日沖，
//   本專案鐵律是「明開賣是隔日沖 edge 的全部」（retO = nextOpen/close − 1）。
//   5 日尺度沒過，不代表 1 日尺度沒過；反之亦然。兩個口徑必須各測各的。
//
// 同時把 5 日回測裡**唯一在兩窗同號**的線索拉出來嚴格檢定：
//   KD 斜率的十分位頭尾差，主窗 -0.211、OOT -1.621 —— 都是負的，
//   意思是「KD 曲線在漲 → 未來報酬更差」，方向與教科書相反（均值回歸）。
//   但主窗單調只有 5/9、量級差 7.7 倍，先別信，用完整關卡打一次。
//
// 關卡（每組都要過，缺一淘汰）：
//   ① 主窗前後兩半 Δ vs 基準 同號且 |Δ|≥0.05
//   ② 第三獨立窗 OOT 同號
//   ③ 中位數與均數同號（防少數暴衝股灌水）
//   ④ 多頭日／空頭日 regime 同向
// 口徑：可交易宇宙（排除 chg>8.5%）、扣費稅 0.4425%。非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';

const P = 9;
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
        const kS = slope([...s.kh.slice(-4), s.k]);
        const m5S = m5 > 0 ? slope(s.m5.slice(-5)) / m5 * 100 : null;
        const m20S = m20 > 0 ? slope(s.m20.slice(-11)) / m20 * 100 : null;
        const m60S = m60 > 0 ? slope(s.m60.slice(-21)) / m60 * 100 : null;
        out[`${i}_${c}`] = { k: s.k, kSlope: kS, ma5Slope: m5S, ma20Slope: m20S, ma60Slope: m60S };
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
  for (const s of samples) Object.assign(s, ind[`${s.di}_${s.code}`] || {});
  return samples.filter(s => s.tradable && s.kSlope != null && s.ma20Slope != null && s.netOpen != null);
};

const 主窗 = await load({ days: 480 });
const OOT = await load({ days: 250, to: '2023-07-31' });

const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };
const pct = (n, d) => (d ? +(n / d * 100).toFixed(1) : 0);

/** 一組條件在一個窗裡的完整體檢（Δ 一律 vs 該窗可交易宇宙基準） */
function evalGroup(w, cond, key) {
  const h = [w.filter(s => s.half === 0), w.filter(s => s.half === 1)];
  const bAll = avg(w.map(s => s[key])), bMed = med(w.map(s => s[key]));
  const sel = w.filter(cond);
  if (sel.length < 600) return { n: sel.length, thin: true };
  const dHalf = h.map(x => {
    const b = avg(x.map(s => s[key])), g = x.filter(cond);
    return g.length >= 300 ? avg(g.map(s => s[key])) - b : null;
  });
  const both = dHalf.every(v => v != null);
  const same = both && Math.sign(dHalf[0]) === Math.sign(dHalf[1]) && Math.min(...dHalf.map(Math.abs)) >= 0.05;
  // regime
  const rg = [true, false].map(bull => {
    const u = w.filter(s => s.bull === bull), g = u.filter(cond);
    return g.length >= 300 ? avg(g.map(s => s[key])) - avg(u.map(s => s[key])) : null;
  });
  return {
    n: sel.length,
    dMean: +(avg(sel.map(s => s[key])) - bAll).toFixed(3),
    dMed: +(med(sel.map(s => s[key])) - bMed).toFixed(3),
    win: pct(sel.filter(s => s[key] > 0).length, sel.length),
    baseWin: pct(w.filter(s => s[key] > 0).length, w.length),
    dHalf, same,
    rgSame: rg.every(v => v != null) && Math.sign(rg[0]) === Math.sign(rg[1]),
    rg,
  };
}

function line(name, cond, key) {
  const A = evalGroup(主窗, cond, key), B = evalGroup(OOT, cond, key);
  if (A.thin || B.thin) { console.log(`  ${name.padEnd(30)} 樣本不足（主${A.n}/OOT${B.n}）`); return; }
  const f = v => (v == null ? ' --- ' : String(r3(v)).padStart(6));
  // 四道關卡
  const g1 = A.same;
  const g2 = Math.sign(A.dMean) === Math.sign(B.dMean) && Math.abs(B.dMean) >= 0.05;
  const g3 = Math.sign(A.dMean) === Math.sign(A.dMed) && Math.sign(B.dMean) === Math.sign(B.dMed);
  const g4 = A.rgSame;
  const pass = g1 && g2 && g3 && g4;
  console.log(
    `  ${name.padEnd(30)} 主窗Δ均${f(A.dMean)} Δ中位${f(A.dMed)} 勝${A.win}%(基${A.baseWin}%) 兩半[${f(A.dHalf[0])}/${f(A.dHalf[1])}]${g1 ? '✓' : '✗'}` +
    ` ｜OOTΔ均${f(B.dMean)} Δ中位${f(B.dMed)}${g2 ? '✓' : '✗'} ｜regime[${f(A.rg[0])}/${f(A.rg[1])}]${g4 ? '✓' : '✗'} ｜n=${A.n.toLocaleString()}/${B.n.toLocaleString()} ${pass ? '✅通過' : '❌'}`
  );
}

// 分位切點各窗自算（避免用主窗切點去切 OOT 造成分布錯位）
const cuts = (w, f, qs) => { const v = w.map(f).filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b); return qs.map(q => v[Math.floor(v.length * q)]); };
const kq = { 主窗: cuts(主窗, s => s.kSlope, [0.25, 0.5, 0.75]), OOT: cuts(OOT, s => s.kSlope, [0.25, 0.5, 0.75]) };
const mq = { 主窗: cuts(主窗, s => s.ma20Slope, [0.25, 0.5, 0.75]), OOT: cuts(OOT, s => s.ma20Slope, [0.25, 0.5, 0.75]) };
// 條件函式必須自帶「這筆屬於哪個窗」的切點 → 用 s.half 無法判斷，改以樣本上的標記
for (const s of 主窗) s._w = '主窗';
for (const s of OOT) s._w = 'OOT';
const kQ = n => s => { const c = kq[s._w]; return n === 1 ? s.kSlope < c[0] : n === 4 ? s.kSlope >= c[2] : n === 2 ? s.kSlope >= c[0] && s.kSlope < c[1] : s.kSlope >= c[1] && s.kSlope < c[2]; };
const mQ = n => s => { const c = mq[s._w]; return n === 1 ? s.ma20Slope < c[0] : n === 4 ? s.ma20Slope >= c[2] : n === 2 ? s.ma20Slope >= c[0] && s.ma20Slope < c[1] : s.ma20Slope >= c[1] && s.ma20Slope < c[2]; };

for (const key of ['netOpen', 'netClose']) {
  const label = key === 'netOpen' ? '明開賣（隔日沖主口徑）' : '明收賣（對照）';
  console.log(`\n${'═'.repeat(190)}\n══ ${label}｜可交易宇宙·扣費稅 0.4425%｜主窗 n=${主窗.length.toLocaleString()}（基準 均${r3(avg(主窗.map(s => s[key])))}% 中位${med(主窗.map(s => s[key]))}%）／OOT n=${OOT.length.toLocaleString()}（基準 均${r3(avg(OOT.map(s => s[key])))}% 中位${med(OOT.map(s => s[key]))}%）\n${'═'.repeat(190)}`);

  console.log('\n【A】KD 斜率四分位（單因子）');
  for (let q = 1; q <= 4; q++) line(`KD斜率 Q${q}${q === 1 ? '(最負·回落最快)' : q === 4 ? '(最正·上衝最快)' : ''}`, kQ(q), key);

  console.log('\n【B】MA20 斜率四分位（單因子）');
  for (let q = 1; q <= 4; q++) line(`MA20斜率 Q${q}${q === 1 ? '(最負·趨勢最弱)' : q === 4 ? '(最正·趨勢最強)' : ''}`, mQ(q), key);

  console.log('\n【C】二維：背離格與順勢格');
  line('背離格 KD↓ × MA20↑', s => s.kSlope < 0 && s.ma20Slope > 0, key);
  line('背離格(強) KD Q1 × MA20 Q4', s => kQ(1)(s) && mQ(4)(s), key);
  line('順勢格 KD↑ × MA20↑', s => s.kSlope > 0 && s.ma20Slope > 0, key);
  line('順勢格(強) KD Q4 × MA20 Q4', s => kQ(4)(s) && mQ(4)(s), key);
  line('雙殺格 KD↑ × MA20↓', s => s.kSlope > 0 && s.ma20Slope < 0, key);
  line('雙弱格 KD↓ × MA20↓', s => s.kSlope < 0 && s.ma20Slope < 0, key);

  console.log('\n【D】KD 斜率正負（最單純的方向假說）');
  line('KD 斜率 > 0（K線上揚）', s => s.kSlope > 0, key);
  line('KD 斜率 < 0（K線下彎）', s => s.kSlope < 0, key);
  line('KD 斜率 > 2（急拉）', s => s.kSlope > 2, key);
  line('KD 斜率 < -2（急落）', s => s.kSlope < -2, key);

  console.log('\n【E】MA 多層斜率共振');
  line('MA5/20/60 三線斜率皆正', s => s.ma5Slope > 0 && s.ma20Slope > 0 && s.ma60Slope > 0, key);
  line('MA5/20/60 三線斜率皆負', s => s.ma5Slope < 0 && s.ma20Slope < 0 && s.ma60Slope < 0, key);
  line('三線皆正 ∧ KD 斜率<0', s => s.ma5Slope > 0 && s.ma20Slope > 0 && s.ma60Slope > 0 && s.kSlope < 0, key);
  line('三線皆負 ∧ KD 斜率>0', s => s.ma5Slope < 0 && s.ma20Slope < 0 && s.ma60Slope < 0 && s.kSlope > 0, key);
}

console.log(`\n${'═'.repeat(190)}`);
console.log('四道關卡全過才標 ✅：① 主窗前後兩半同號且|Δ|≥0.05  ② OOT 同號且|Δ|≥0.05  ③ 均數與中位數同號  ④ 多頭日/空頭日 regime 同向');
console.log('Δ 一律相對「該窗可交易宇宙基準」，已扣費稅。非投資建議。');
process.exit(0);
