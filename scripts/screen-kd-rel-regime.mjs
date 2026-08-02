// ─────────────────────────────────────────────────────────────────────
// KD 相對值（斜率）失效期 × 大盤環境 對照 —— 2026-08-02
// 前輪：16 個價量分層全部主窗兩半換號、形狀一致（前半 -0.8~-1.35%／後半 +0.19~+1.57%）
//       → 失效來源是「時間」不是「股票類型」。本輪找出那個時間開關。
// 大盤指標（全部由 chipArchive 全市場算，PIT 安全）：
//   等權指數水位 vs MA20／MA60、20日報酬、20日波動、上漲家數比、指數距60日高
// ─────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';
const P = 9;
function buildSlope(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) for (const c in days[i].close) {
    if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
    const r = days[i].close[c]; if (!r || r.length < 5) continue;
    const [cl, , , h, l] = r; if (!(cl > 0 && h > 0 && l > 0 && h >= l)) continue;
    const s = (st[c] ||= { k: 50, d: 50, hs: [], ls: [], kh: [] });
    s.hs.push(h); s.ls.push(l); if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
    if (s.hs.length < P) continue;
    const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
    const rsv = hn === ln ? 50 : ((cl - ln) / (hn - ln)) * 100;
    s.k = (s.k * 2) / 3 + rsv / 3; s.d = (s.d * 2) / 3 + s.k / 3;
    if (s.kh.length >= 60) {
      const p5 = [...s.kh.slice(-4), s.k]; let sy = 0, sxy = 0;
      for (let t = 0; t < 5; t++) { sy += p5[t]; sxy += t * p5[t]; }
      out[`${i}_${c}`] = (5 * sxy - 10 * sy) / 50;
    }
    s.kh.push(s.k); if (s.kh.length > 80) s.kh.shift();
  }
  return out;
}
/** 大盤等權指數與環境指標（逐日） */
function market(days) {
  const idx = []; let lvl = 100;
  for (let i = 0; i < days.length; i++) {
    const P0 = days[i - 1]; let sum = 0, n = 0, up = 0;
    if (P0) for (const c in days[i].close) {
      if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
      const a = days[i].close[c]?.[0], b = P0.close?.[c]?.[0];
      if (a > 0 && b > 0) { sum += a / b - 1; n++; if (a > b) up++; }
    }
    if (n > 300) lvl *= 1 + sum / n;
    idx.push({ lvl, upRatio: n ? up / n * 100 : null });
  }
  const out = [];
  for (let i = 0; i < idx.length; i++) {
    const w20 = idx.slice(Math.max(0, i - 19), i + 1).map(x => x.lvl);
    const w60 = idx.slice(Math.max(0, i - 59), i + 1).map(x => x.lvl);
    const ma20 = w20.reduce((a, b) => a + b, 0) / w20.length;
    const ma60 = w60.reduce((a, b) => a + b, 0) / w60.length;
    const ret20 = i >= 20 ? (idx[i].lvl / idx[i - 20].lvl - 1) * 100 : null;
    let vol = null;
    if (i >= 20) { const rs = []; for (let k = i - 19; k <= i; k++) rs.push(idx[k].lvl / idx[k - 1].lvl - 1);
      const m = rs.reduce((a, b) => a + b, 0) / rs.length;
      vol = Math.sqrt(rs.reduce((s, x) => s + (x - m) ** 2, 0) / rs.length) * 100; }
    out.push({ lvl: idx[i].lvl, ma20, ma60, ret20, vol, upRatio: idx[i].upRatio,
      aboveMA20: i >= 20 ? idx[i].lvl > ma20 : null,
      aboveMA60: i >= 60 ? idx[i].lvl > ma60 : null,
      offHigh60: i >= 60 ? (idx[i].lvl / Math.max(...w60) - 1) * 100 : null });
  }
  return out;
}
const load = async o => {
  const days = await loadDays(o); const s = buildSamples(days); const sl = buildSlope(days); const mk = market(days);
  for (const x of s) { x.kSlope5 = sl[`${x.di}_${x.code}`]; Object.assign(x, { mk: mk[x.di] }); x.date = days[x.di].date; }
  return { rows: s.filter(x => x.tradable && x.kSlope5 != null && x.net5 != null && x.mk?.ret20 != null), days };
};
const A = await load({ days: 480 }), B = await load({ days: 250, to: '2023-07-31' });
const all = [...A.rows, ...B.rows];
const cutA = A.rows.map(x => x.kSlope5).sort((a, b) => a - b)[Math.floor(A.rows.length * 0.3)];
const cutB = B.rows.map(x => x.kSlope5).sort((a, b) => a - b)[Math.floor(B.rows.length * 0.3)];
for (const x of A.rows) x.sig = x.kSlope5 <= cutA;
for (const x of B.rows) x.sig = x.kSlope5 <= cutB;

console.log('訊號＝KD 近5日斜率 ≤30分位（K在降）｜5日持有·扣費稅\n');
console.log('══ 逐月績效 vs 大盤環境（主窗＋OOT 合併時序）');
console.log('  月份     訊號均報酬  同月基準   超額     大盤20日報酬 大盤波動 上漲家數比 站上MA20');
const byM = {};
for (const x of all) { const m = x.date.slice(0, 7); (byM[m] ||= []).push(x); }
const rowsM = [];
for (const m of Object.keys(byM).sort()) {
  const g = byM[m], sg = g.filter(x => x.sig);
  if (sg.length < 50) continue;
  const s = avg(sg.map(x => x.net5)), b = avg(g.map(x => x.net5));
  const mk = g[0].mk;
  rowsM.push({ m, ex: s - b, ret20: mk.ret20, vol: mk.vol, up: avg(g.map(x => x.mk.upRatio)), a20: avg(g.map(x => x.mk.aboveMA20 ? 1 : 0)) * 100 });
  console.log(`  ${m}  ${String(r3(s)).padStart(8)}% ${String(r3(b)).padStart(8)}% ${String(r3(s - b)).padStart(7)}pp   ${String(r3(mk.ret20)).padStart(8)}% ${String(r3(mk.vol)).padStart(6)}% ${String(r3(avg(g.map(x => x.mk.upRatio)))).padStart(8)}% ${String(r3(avg(g.map(x => x.mk.aboveMA20 ? 1 : 0)) * 100)).padStart(7)}%`);
}
// 相關係數
const corr = (xs, ys) => { const mx = avg(xs), my = avg(ys); let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) { const a = xs[i] - mx, b = ys[i] - my; c += a * b; vx += a * a; vy += b * b; }
  return c / Math.sqrt(vx * vy); };
console.log('\n══ 超額報酬 與 大盤指標的相關係數（逐月，n=' + rowsM.length + '）');
for (const [l, f] of [['大盤20日報酬', r => r.ret20], ['大盤20日波動', r => r.vol], ['上漲家數比', r => r.up], ['站上MA20比例', r => r.a20]])
  console.log(`  ${l.padEnd(14)} ${corr(rowsM.map(f), rowsM.map(r => r.ex)).toFixed(3)}`);

console.log('\n══ 依大盤環境分組（每日樣本歸屬該日大盤狀態）');
function grp(label, f, minN = 500) {
  const cells = [];
  for (const [wn, W] of [['主窗', A.rows], ['OOT', B.rows]]) {
    const sel = W.filter(x => f(x.mk) && x.sig), base = W.filter(x => f(x.mk));
    if (sel.length < minN) { cells.push(`${wn} 不足(${sel.length})`.padEnd(46)); continue; }
    const h = [0, 1].map(k => r3(avg(sel.filter(x => x.half === k).map(x => x.net5))));
    const same = Math.sign(h[0]) === Math.sign(h[1]);
    cells.push(`${wn} 訊號${String(r3(avg(sel.map(x => x.net5)))).padStart(7)}% 基準${String(r3(avg(base.map(x => x.net5)))).padStart(7)}% 超額${String(r3(avg(sel.map(x => x.net5)) - avg(base.map(x => x.net5)))).padStart(6)}pp[${h[0]}/${h[1]}]${same ? '✓' : '⚠'}`.padEnd(46));
  }
  console.log(`  ${label.padEnd(18)} ${cells.join(' ')}`);
}
grp('大盤站上 MA20', m => m.aboveMA20 === true);
grp('大盤跌破 MA20', m => m.aboveMA20 === false);
grp('大盤站上 MA60', m => m.aboveMA60 === true);
grp('大盤跌破 MA60', m => m.aboveMA60 === false);
grp('大盤20日報酬>3%', m => m.ret20 > 3);
grp('大盤20日報酬 -3~3%', m => m.ret20 >= -3 && m.ret20 <= 3);
grp('大盤20日報酬<-3%', m => m.ret20 < -3);
grp('大盤波動 低(<1%)', m => m.vol < 1);
grp('大盤波動 中(1~1.8%)', m => m.vol >= 1 && m.vol < 1.8);
grp('大盤波動 高(≥1.8%)', m => m.vol >= 1.8);
process.exit(0);
