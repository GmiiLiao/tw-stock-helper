// ─────────────────────────────────────────────────────────────────────────
// 候選因子「震盪盤 × KD 超賣」增量檢定 —— 2026-08-02
//
// 候選來源：screen-kd-playbook.mjs 的反直覺發現——教學說「KD 在震盪盤準」，
// 實測相反：K<20 出現在**窄幅盤整股**（20日振幅<15%）時四格全負
//   主窗 -0.238%[-0.316/-0.176] 勝34.7%／OOT -0.173%[-0.163/-0.176] 勝35.3%
//   （基準 -0.129%/-0.125%·勝41.5%/38.5%）
//
// 但過關不等於可用。與 K>90 入權重時同一套標準：
//   Q1 **2×2 拆解**：效果是 KD 帶來的，還是「震盪盤」本身就有？
//      —— 若「震盪∧K<20」≈「震盪∧K≥20」，KD 無增量，該記的是振幅不是 KD。
//   Q2 **冷門股代理嫌疑**（最大嫌疑）：窄幅盤整是不是就是低量冷門股？
//      專案已知：週轉率<0.5% 冷門股明開賣兩窗同向負（nextdaySop 已納入排除型濾網）。
//      若控制成交量後效果消失 → 這只是冷門股濾網的另一種寫法，不該重複計分。
//   Q3 控制其他既有因子（今日漲幅／5日漲幅／RSI5／60日位階）後是否仍成立。
//   Q4 與現行評分既有扣分項是否重疊（強尾/跟風/過熱/接棒 已各自計分）。
//
// 判準：Q1 必須顯示 KD 有獨立貢獻；Q2 必須在各量能層都成立；
//       Q3 各層兩窗同向；任一關不過即不入權重（寧可不加，不硬塞）。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';

const P = 9;
function buildKD(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = days[i].close[code];
      if (!r || r.length < 5) continue;
      const [c, , , h, l] = r;
      if (!(c > 0 && h > 0 && l > 0 && h >= l)) continue;
      const s = (st[code] ||= { k: 50, d: 50, hs: [], ls: [] });
      s.hs.push(h); s.ls.push(l);
      if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
      if (s.hs.length < P) continue;
      const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
      const rsv = hn === ln ? 50 : ((c - ln) / (hn - ln)) * 100;
      s.k = (s.k * 2) / 3 + rsv / 3; s.d = (s.d * 2) / 3 + s.k / 3;
      out[`${i}_${code}`] = s.k;
    }
  }
  return out;
}
function buildRSI(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = days[i].close[code]?.[0];
      if (!(c > 0)) continue;
      const s = (st[code] ||= { p: null, u: 0, d: 0, n: 0 });
      if (s.p != null) {
        const ch = c - s.p, g = Math.max(ch, 0), l = Math.max(-ch, 0);
        s.n++;
        if (s.n <= 5) { s.u += g / 5; s.d += l / 5; } else { s.u = (s.u * 4 + g) / 5; s.d = (s.d * 4 + l) / 5; }
        if (s.n >= 5) out[`${i}_${code}`] = s.u + s.d > 0 ? (s.u / (s.u + s.d)) * 100 : 50;
      }
      s.p = c;
    }
  }
  return out;
}
/** 20日振幅% + 20日均量（張），後者用於冷門股控制 */
function buildRange(days) {
  const h = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = days[i].close[code];
      if (!r || !(r[0] > 0)) continue;
      const H = (h[code] ||= { c: [], v: [] });
      H.c.push(r[0]); H.v.push(r[1] || 0);
      if (H.c.length > 20) { H.c.shift(); H.v.shift(); }
      if (H.c.length === 20) {
        const hi = Math.max(...H.c), lo = Math.min(...H.c);
        out[`${i}_${code}`] = {
          rng20: lo > 0 ? ((hi - lo) / lo) * 100 : null,
          av20: H.v.reduce((a, b) => a + b, 0) / 20,
        };
      }
    }
  }
  return out;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const kd = buildKD(days), rsi = buildRSI(days), rg = buildRange(days);
  for (const s of samples) {
    s.k = kd[`${s.di}_${s.code}`];
    s.rsi5 = rsi[`${s.di}_${s.code}`];
    const g = rg[`${s.di}_${s.code}`];
    if (g) { s.rng20 = g.rng20; s.av20 = g.av20; }
  }
  return { all: samples.filter(s => s.tradable && s.k != null && s.rng20 != null && s.av20 != null && s.netOpen != null) };
};

const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const M = a => (a.length ? avg(a.map(s => s.netOpen)) : null);
const WR = a => (a.length ? +((a.filter(s => s.netOpen > 0).length / a.length) * 100).toFixed(1) : null);
const NARROW = s => s.rng20 < 15;
const OVERSOLD = s => s.k < 20;

function row(label, cond, minN = 200) {
  const cells = [];
  for (const [wn, w] of Object.entries(W)) {
    const sel = w.all.filter(cond);
    if (sel.length < minN) { cells.push(`${wn} 樣本不足(${sel.length})`.padEnd(40)); continue; }
    const h = [0, 1].map(hf => r3(M(sel.filter(s => s.half === hf))));
    const same = Math.sign(h[0]) === Math.sign(h[1]);
    cells.push(`${wn} ${String(r3(M(sel))).padStart(7)}%[${h[0]}/${h[1]}]${same ? ' ' : '⚠'} 勝${String(WR(sel)).padStart(5)}% n=${String(sel.length).padStart(6)}`.padEnd(40));
  }
  console.log(`  ${label.padEnd(28)} ${cells.join(' ')}`);
}
const H = t => console.log(`\n${'═'.repeat(114)}\n══ ${t}\n${'═'.repeat(114)}`);

console.log('基準（可交易宇宙·明開賣）：');
for (const [wn, w] of Object.entries(W)) console.log(`  ${wn.padEnd(5)} ${r3(M(w.all))}% 勝${WR(w.all)}% n=${w.all.length.toLocaleString()}`);

H('Q1 2×2 拆解：效果是 KD 帶來的，還是「震盪盤」本身就有？');
row('震盪(<15%) ∧ K<20', s => NARROW(s) && OVERSOLD(s));
row('震盪(<15%) ∧ K≥20', s => NARROW(s) && !OVERSOLD(s));
row('非震盪(≥15%) ∧ K<20', s => !NARROW(s) && OVERSOLD(s));
row('非震盪(≥15%) ∧ K≥20', s => !NARROW(s) && !OVERSOLD(s));
row('震盪(<15%) 單獨', s => NARROW(s));

H('Q2 冷門股代理嫌疑：控制 20 日均量後還成立嗎？');
const VOL = [
  ['量<500張', s => s.av20 < 500],
  ['量500~2000張', s => s.av20 >= 500 && s.av20 < 2000],
  ['量2000~1萬張', s => s.av20 >= 2000 && s.av20 < 10000],
  ['量≥1萬張', s => s.av20 >= 10000],
];
for (const [vl, vf] of VOL) {
  console.log(`  ── ${vl} ──`);
  row('  震盪 ∧ K<20', s => vf(s) && NARROW(s) && OVERSOLD(s), 120);
  row('  同層基準(全部)', s => vf(s), 120);
}
console.log('\n  ── 各量能層「震盪∧K<20」相對同層基準的差值 ──');
for (const [vl, vf] of VOL) {
  const cells = [];
  for (const [wn, w] of Object.entries(W)) {
    const sel = w.all.filter(s => vf(s) && NARROW(s) && OVERSOLD(s));
    const base = w.all.filter(vf);
    if (sel.length < 120) { cells.push(`${wn} 不足(${sel.length})`.padEnd(30)); continue; }
    const d = M(sel) - M(base);
    cells.push(`${wn} Δ${String(r3(d)).padStart(7)} ${d < 0 ? '較差✓' : '較好✗'} n=${sel.length}`.padEnd(30));
  }
  console.log(`  ${vl.padEnd(16)} ${cells.join(' ')}`);
}

H('Q3 控制既有因子後（各層 Δ = 震盪∧K<20 相對同層基準）');
const LAYERS = [
  ['chg ≤0%', s => s.chg <= 0], ['chg 0~2%', s => s.chg > 0 && s.chg <= 2], ['chg >2%', s => s.chg > 2],
  ['ret5 ≤0%', s => s.ret5 != null && s.ret5 <= 0], ['ret5 >0%', s => s.ret5 != null && s.ret5 > 0],
  ['RSI5 <20', s => s.rsi5 < 20], ['RSI5 20~40', s => s.rsi5 >= 20 && s.rsi5 < 40], ['RSI5 ≥40', s => s.rsi5 >= 40],
  ['posture60 <0.9', s => s.posture60 != null && s.posture60 < 0.9], ['posture60 ≥0.9', s => s.posture60 != null && s.posture60 >= 0.9],
];
let pass = 0, tot = 0;
for (const [ln, lf] of LAYERS) {
  const cells = [];
  for (const [wn, w] of Object.entries(W)) {
    const sel = w.all.filter(s => lf(s) && NARROW(s) && OVERSOLD(s));
    const base = w.all.filter(lf);
    if (sel.length < 120) { cells.push(`${wn} 不足(${sel.length})`.padEnd(30)); continue; }
    const d = M(sel) - M(base); tot++; if (d < 0) pass++;
    cells.push(`${wn} Δ${String(r3(d)).padStart(7)} ${d < 0 ? '較差✓' : '較好✗'} n=${sel.length}`.padEnd(30));
  }
  console.log(`  ${ln.padEnd(16)} ${cells.join(' ')}`);
}
console.log(`\n  分層通過 ${pass}/${tot}`);

H('判定');
console.log('  Q1 若「震盪∧K<20」與「震盪∧K≥20」接近 → 該記的是振幅不是 KD，不應以 KD 名義加分。');
console.log('  Q2 若低量層才成立、高量層不成立 → 這是冷門股濾網的重複寫法，不可重複計分。');
console.log('  Q3 分層須大多數通過且兩窗同向。任一關不過＝不入權重。');
process.exit(0);
