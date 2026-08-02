// ─────────────────────────────────────────────────────────────────────
// KD 相對值（波段）× 價量 交互檢定 —— 2026-08-02
// 前一輪：KD 近5日線性斜率在 5 日波段口徑有乾淨的十分位單調（OOT 9/9），
// 但主窗兩半窗換號（前半 -1.098%／後半 +0.480%）→ 未入權重。
// 本輪兩個問題：
//   Ⅰ 效果是否**依附價量**？分層後有沒有哪一層兩窗兩半全部同向（＝找到穩定子集）
//   Ⅱ 效果是否**只是價量的代理**？控制價量後 KD 斜率還有沒有獨立貢獻
// 口徑：5 日持有·可交易宇宙·扣費稅；斜率門檻用各窗自身 30 分位（不用固定值）
// ─────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';
const P = 9;
function buildRel(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) for (const c in days[i].close) {
    if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
    const r = days[i].close[c]; if (!r || r.length < 5) continue;
    const [cl, v, , h, l] = r; if (!(cl > 0 && h > 0 && l > 0 && h >= l)) continue;
    const s = (st[c] ||= { k: 50, d: 50, hs: [], ls: [], kh: [], vh: [] });
    s.hs.push(h); s.ls.push(l); if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
    s.vh.push(v || 0); if (s.vh.length > 20) s.vh.shift();
    if (s.hs.length < P) continue;
    const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
    const rsv = hn === ln ? 50 : ((cl - ln) / (hn - ln)) * 100;
    s.k = (s.k * 2) / 3 + rsv / 3; s.d = (s.d * 2) / 3 + s.k / 3;
    const kh = s.kh; let rec = null;
    if (kh.length >= 60 && s.vh.length === 20) {
      const p5 = [...kh.slice(-4), s.k]; let sy = 0, sxy = 0;
      for (let t = 0; t < 5; t++) { sy += p5[t]; sxy += t * p5[t]; }
      rec = { kSlope5: (5 * sxy - 10 * sy) / 50, av20: s.vh.reduce((a, b) => a + b, 0) / 20 };
    }
    kh.push(s.k); if (kh.length > 80) kh.shift();
    if (rec) out[`${i}_${c}`] = rec;
  }
  return out;
}
const load = async o => {
  const d = await loadDays(o); const s = buildSamples(d); const rel = buildRel(d);
  for (const x of s) Object.assign(x, rel[`${x.di}_${x.code}`] || {});
  return s.filter(x => x.tradable && x.kSlope5 != null && x.net5 != null);
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };
const cut30 = w => { const v = w.map(x => x.kSlope5).sort((a, b) => a - b); return v[Math.floor(v.length * 0.3)]; };
function row(label, strat, minN = 300) {
  const cells = [];
  for (const [wn, w] of Object.entries(W)) {
    const c30 = cut30(w);
    const sel = w.filter(x => strat(x) && x.kSlope5 <= c30);
    const base = w.filter(strat);
    if (sel.length < minN) { cells.push(`${wn} 不足(${sel.length})`.padEnd(54)); continue; }
    const h = [0, 1].map(f => r3(avg(sel.filter(x => x.half === f).map(x => x.net5))));
    const same = Math.sign(h[0]) === Math.sign(h[1]) && h[0] > 0;
    const bm = r3(avg(base.map(x => x.net5)));
    cells.push(`${wn} 均${String(r3(avg(sel.map(x => x.net5)))).padStart(7)}% 中位${String(med(sel.map(x => x.net5))).padStart(7)}%[${h[0]}/${h[1]}]${same ? '✓' : '⚠'} 同層基準${String(bm).padStart(7)}% n=${String(sel.length).padStart(6)}`.padEnd(54));
  }
  console.log(`  ${label.padEnd(20)} ${cells.join(' ')}`);
}
const H = t => console.log(`\n${'═'.repeat(140)}\n══ ${t}\n${'═'.repeat(140)}`);
console.log('訊號＝KD 近5日線性斜率 ≤ 各窗 30 分位（K 正在下降）｜5日持有·扣費稅');
console.log('✓＝兩半窗同向且皆為正（前一輪整體是 [-1.098/+0.480]⚠ 換號）\n');
row('【全體·對照】', () => true);
H('Ⅰ-a 依 20 日均量分層');
for (const [l, f] of [['量<500張', x => x.av20 < 500], ['量500~2000', x => x.av20 >= 500 && x.av20 < 2000],
  ['量2000~1萬', x => x.av20 >= 2000 && x.av20 < 10000], ['量≥1萬張', x => x.av20 >= 10000]]) row(l, f);
H('Ⅰ-b 依「今日量比」分層（volX＝今量/昨量）');
for (const [l, f] of [['量比<0.8(縮)', x => x.volX < 0.8], ['量比0.8~1.2', x => x.volX >= 0.8 && x.volX < 1.2],
  ['量比1.2~2', x => x.volX >= 1.2 && x.volX < 2], ['量比≥2(爆量)', x => x.volX >= 2]]) row(l, f);
H('Ⅰ-c 依股價分層');
for (const [l, f] of [['價<20元', x => x.c < 20], ['價20~50', x => x.c >= 20 && x.c < 50],
  ['價50~200', x => x.c >= 50 && x.c < 200], ['價≥200元', x => x.c >= 200]]) row(l, f);
H('Ⅰ-d 依成交值分層（價×量）');
for (const [l, f] of [['成交值<5千萬', x => x.c * x.v * 1000 < 5e7], ['5千萬~3億', x => x.c * x.v * 1000 >= 5e7 && x.c * x.v * 1000 < 3e8],
  ['3億~15億', x => x.c * x.v * 1000 >= 3e8 && x.c * x.v * 1000 < 1.5e9], ['≥15億', x => x.c * x.v * 1000 >= 1.5e9]]) row(l, f);
H('Ⅱ 是否只是價量代理：控制量比後，KD 斜率仍有貢獻嗎？（同層內 低斜率 vs 高斜率）');
for (const [l, f] of [['量比<0.8', x => x.volX < 0.8], ['量比0.8~1.2', x => x.volX >= 0.8 && x.volX < 1.2],
  ['量比1.2~2', x => x.volX >= 1.2 && x.volX < 2], ['量比≥2', x => x.volX >= 2]]) {
  const cells = [];
  for (const [wn, w] of Object.entries(W)) {
    const v = w.map(x => x.kSlope5).sort((a, b) => a - b);
    const lo = v[Math.floor(v.length * 0.3)], hi = v[Math.floor(v.length * 0.7)];
    const A = w.filter(x => f(x) && x.kSlope5 <= lo), B = w.filter(x => f(x) && x.kSlope5 >= hi);
    if (A.length < 300 || B.length < 300) { cells.push(`${wn} 樣本不足`.padEnd(46)); continue; }
    const a = avg(A.map(x => x.net5)), b = avg(B.map(x => x.net5));
    cells.push(`${wn} 低斜率${String(r3(a)).padStart(7)}% 高斜率${String(r3(b)).padStart(7)}% 差${String(r3(a - b)).padStart(7)}pp`.padEnd(46));
  }
  console.log(`  ${l.padEnd(20)} ${cells.join(' ')}`);
}
process.exit(0);
