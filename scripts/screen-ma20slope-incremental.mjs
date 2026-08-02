// ─────────────────────────────────────────────────────────────────────────
// MA20 斜率「溫吞區」增量檢定 —— 2026-08-02（第七輪 KD/MA 系列收尾）
//
// 前一步（screen-kdma-slope-open.mjs）在 24 組裡只有 1 組過四道關卡：
//   MA20斜率 Q2 → 明開賣 Δ均 -0.059、Δ中位 -0.049、勝 37.5%（基 41.3%）
//   兩半 [-0.074/-0.053]✓、OOT [-0.062/-0.067]✓、regime [-0.065/-0.055]✓
// 但四分位排出來是 **U 形**：Q1 +0.076、Q2 -0.059、Q3 -0.062、Q4 +0.045
//   ⇒ 真正的結構不是「斜率越大越好」，而是「兩端好、中間差」。
//   直覺：兩端＝方向明確（大跌後反彈動能／強勢續攻），中間＝溫吞盤整無動能。
//
// 但 MA20 斜率本質上就是**中期動能的平滑版**，而 5 日漲幅(ret5)、60日位階
//   (posture60)、當日漲跌(chg) 早就在權重裡。若 U 形只是它們的換包裝，
//   加進去等於同一件事算兩次——會過度加權、放大該因子的失效風險。
//
// 本輪要回答三題：
//   ① U 形是真結構嗎？（十分位曲線，兩窗並列）
//   ② 中間半（Q2∪Q3）能不能過四道關卡？
//   ③ **增量**：控制住 ret5／posture60／chg／volX 之後，效應還在嗎？
//      在每個既有變數的分層內部各測一次；若層層都在＝獨立貢獻，
//      若只在某一層才在＝那個效應其實屬於該既有變數。
// 口徑：明開賣 netOpen（隔日沖主口徑）、可交易宇宙、扣費稅。非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';

const slope = a => {
  const n = a.length; if (n < 2) return null;
  const sx = (n - 1) * n / 2, sxx = (n - 1) * n * (2 * n - 1) / 6;
  let sy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sy += a[i]; sxy += i * a[i]; }
  const d = n * sxx - sx * sx;
  return d ? (n * sxy - sx * sy) / d : null;
};

function buildMa(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const c in days[i].close) {
      if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
      const r = days[i].close[c]; if (!r || r.length < 5) continue;
      const cl = r[0]; if (!(cl > 0)) continue;
      const s = (st[c] ||= { cs: [], m20: [] });
      s.cs.push(cl); if (s.cs.length > 60) s.cs.shift();
      if (s.cs.length < 20) continue;
      const m20 = s.cs.slice(-20).reduce((x, y) => x + y, 0) / 20;
      s.m20.push(m20); if (s.m20.length > 22) s.m20.shift();
      if (s.m20.length >= 11 && m20 > 0) out[`${i}_${c}`] = { ma20Slope: slope(s.m20.slice(-11)) / m20 * 100, ma20: m20 };
    }
  }
  return out;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const ma = buildMa(days);
  for (const s of samples) Object.assign(s, ma[`${s.di}_${s.code}`] || {});
  return samples.filter(s => s.tradable && s.ma20Slope != null && Number.isFinite(s.ma20Slope) && s.netOpen != null);
};

const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
for (const k in W) for (const s of W[k]) s._w = k;

const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };
const pct = (n, d) => (d ? +(n / d * 100).toFixed(1) : 0);
const qcut = (w, f, qs) => { const v = w.map(f).filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b); return qs.map(q => v[Math.floor(v.length * q)]); };

// ── ① 十分位曲線 ────────────────────────────────────────────────────────
console.log('══ ① MA20 斜率十分位 × 明開賣淨報酬（左=最負斜率 → 右=最正斜率）\n');
for (const [wn, w] of Object.entries(W)) {
  const cut = qcut(w, s => s.ma20Slope, [.1, .2, .3, .4, .5, .6, .7, .8, .9]);
  const b = Array.from({ length: 10 }, () => []);
  for (const s of w) { let i = 0; while (i < 9 && s.ma20Slope >= cut[i]) i++; b[i].push(s); }
  const base = avg(w.map(s => s.netOpen)), bw = pct(w.filter(s => s.netOpen > 0).length, w.length);
  console.log(`  ${wn} Δ均 ${b.map(x => String(r3(avg(x.map(s => s.netOpen)) - base)).padStart(7)).join('')}   基準 ${r3(base)}%`);
  console.log(`  ${' '.repeat(wn.length)} 勝率 ${b.map(x => String(pct(x.filter(s => s.netOpen > 0).length, x.length)).padStart(7)).join('')}   基準 ${bw}%`);
}

// ── 完整體檢（四道關卡） ───────────────────────────────────────────────
function evalG(w, cond) {
  const sel = w.filter(cond);
  if (sel.length < 600) return { thin: true, n: sel.length };
  const base = avg(w.map(s => s.netOpen)), bMed = med(w.map(s => s.netOpen));
  const dHalf = [0, 1].map(h => {
    const u = w.filter(s => s.half === h), g = u.filter(cond);
    return g.length >= 300 ? +(avg(g.map(s => s.netOpen)) - avg(u.map(s => s.netOpen))).toFixed(3) : null;
  });
  const rg = [true, false].map(bull => {
    const u = w.filter(s => s.bull === bull), g = u.filter(cond);
    return g.length >= 300 ? +(avg(g.map(s => s.netOpen)) - avg(u.map(s => s.netOpen))).toFixed(3) : null;
  });
  return {
    n: sel.length,
    dMean: +(avg(sel.map(s => s.netOpen)) - base).toFixed(3),
    dMed: +(med(sel.map(s => s.netOpen)) - bMed).toFixed(3),
    win: pct(sel.filter(s => s.netOpen > 0).length, sel.length),
    bWin: pct(w.filter(s => s.netOpen > 0).length, w.length),
    dHalf, rg,
    same: dHalf.every(v => v != null) && Math.sign(dHalf[0]) === Math.sign(dHalf[1]) && Math.min(...dHalf.map(Math.abs)) >= 0.05,
    rgSame: rg.every(v => v != null) && Math.sign(rg[0]) === Math.sign(rg[1]),
  };
}
function gauntlet(name, cond) {
  const A = evalG(W.主窗, cond), B = evalG(W.OOT, cond);
  if (A.thin || B.thin) { console.log(`  ${name.padEnd(34)} 樣本不足（主${A.n}/OOT${B.n}）`); return false; }
  const f = v => (v == null ? '  ---' : String(v).padStart(6));
  const g1 = A.same, g2 = Math.sign(A.dMean) === Math.sign(B.dMean) && Math.abs(B.dMean) >= 0.05;
  const g3 = Math.sign(A.dMean) === Math.sign(A.dMed) && Math.sign(B.dMean) === Math.sign(B.dMed);
  const pass = g1 && g2 && g3 && A.rgSame;
  console.log(`  ${name.padEnd(34)} 主窗Δ均${f(A.dMean)} Δ中位${f(A.dMed)} 勝${String(A.win).padStart(4)}%(基${A.bWin}%) 兩半[${f(A.dHalf[0])}/${f(A.dHalf[1])}]${g1 ? '✓' : '✗'}｜OOTΔ均${f(B.dMean)} Δ中位${f(B.dMed)}${g2 ? '✓' : '✗'}｜regime[${f(A.rg[0])}/${f(A.rg[1])}]${A.rgSame ? '✓' : '✗'}｜n=${A.n.toLocaleString()}/${B.n.toLocaleString()} ${pass ? '✅' : '❌'}`);
  return pass;
}

const q = { 主窗: qcut(W.主窗, s => s.ma20Slope, [.25, .5, .75]), OOT: qcut(W.OOT, s => s.ma20Slope, [.25, .5, .75]) };
const MID = s => { const c = q[s._w]; return s.ma20Slope >= c[0] && s.ma20Slope < c[2]; };
const EXT = s => !MID(s);

console.log('\n══ ② 中間半（溫吞區 Q2∪Q3）vs 兩端（Q1∪Q4）四道關卡\n');
gauntlet('MA20斜率 中間半(溫吞·避開端)', MID);
gauntlet('MA20斜率 兩端(方向明確)', EXT);
gauntlet('MA20斜率 中間半 ∧ 空頭日', s => MID(s) && s.bull === false);
gauntlet('MA20斜率 中間半 ∧ 多頭日', s => MID(s) && s.bull === true);

// ── ③ 增量檢定：控制既有變數後效應是否還在 ────────────────────────────
console.log('\n══ ③ 增量檢定：在既有權重變數的分層「內部」重測中間半');
console.log('   （層層都在＝獨立貢獻可加權；只在某一層＝效應其實屬於該既有變數）\n');
const CTRL = [
  ['ret5 5日漲幅', s => s.ret5],
  ['posture60 60日位階', s => s.posture60],
  ['chg 當日漲跌幅', s => s.chg],
  ['volX 量比', s => s.volX],
];
for (const [cname, cf] of CTRL) {
  const cq = { 主窗: qcut(W.主窗, cf, [.25, .5, .75]), OOT: qcut(W.OOT, cf, [.25, .5, .75]) };
  console.log(`  ── 控制 ${cname} ──`);
  for (let t = 1; t <= 4; t++) {
    const inT = s => {
      const v = cf(s); if (v == null || !Number.isFinite(v)) return false;
      const c = cq[s._w];
      return t === 1 ? v < c[0] : t === 4 ? v >= c[2] : t === 2 ? v >= c[0] && v < c[1] : v >= c[1] && v < c[2];
    };
    // 層內 Δ：中間半 vs 同層基準（不是全宇宙基準）——這才是真正的增量
    const A = layerDelta(W.主窗, inT), B = layerDelta(W.OOT, inT);
    const f = v => (v == null ? '  ---' : String(v).padStart(6));
    const ok = A.d != null && B.d != null && Math.sign(A.d) === Math.sign(B.d) && Math.abs(A.d) >= 0.03 && Math.abs(B.d) >= 0.03;
    console.log(`     ${cname.split(' ')[0]} 第${t}分位  層內Δ均 主窗${f(A.d)} OOT${f(B.d)}  層內勝率 主窗${String(A.w).padStart(5)}%(層基${A.bw}%)  n=${A.n.toLocaleString()}/${B.n.toLocaleString()}  ${ok ? '✓效應仍在' : '✗消失'}`);
  }
}
function layerDelta(w, inT) {
  const L = w.filter(inT); if (L.length < 2000) return { d: null, n: L.length, w: 0, bw: 0 };
  const g = L.filter(MID); if (g.length < 600) return { d: null, n: g.length, w: 0, bw: 0 };
  return {
    d: +(avg(g.map(s => s.netOpen)) - avg(L.map(s => s.netOpen))).toFixed(3),
    n: g.length,
    w: pct(g.filter(s => s.netOpen > 0).length, g.length),
    bw: pct(L.filter(s => s.netOpen > 0).length, L.length),
  };
}

// ── ④ 與既有變數的重疊度 ──────────────────────────────────────────────
console.log('\n══ ④ 重疊度：中間半樣本在既有變數上的分布（若嚴重偏斜＝其實是同一件事）\n');
for (const [cname, cf] of CTRL) {
  const w = W.主窗, cq = qcut(w, cf, [.25, .5, .75]);
  const mid = w.filter(MID);
  const dist = [1, 2, 3, 4].map(t => pct(mid.filter(s => {
    const v = cf(s); if (v == null || !Number.isFinite(v)) return false;
    return t === 1 ? v < cq[0] : t === 4 ? v >= cq[2] : t === 2 ? v >= cq[0] && v < cq[1] : v >= cq[1] && v < cq[2];
  }).length, mid.length));
  console.log(`  ${cname.padEnd(20)} 中間半落在各分位：${dist.map(x => `${x}%`.padStart(7)).join('')}   （均勻＝25/25/25/25＝完全獨立）`);
}

console.log('\n判準：② 四道關卡全過 ∧ ③ 四個控制變數的每一分位層內效應都still在 ∧ ④ 分布不極端偏斜 → 才可入權重。非投資建議。');
process.exit(0);
