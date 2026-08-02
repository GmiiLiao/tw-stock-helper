// ─────────────────────────────────────────────────────────────────────────
// 波段口徑：RSI5 與 RSI10「雙高 / 同步上穿 80」× KD交叉 × MA5/10 —— 2026-08-02
//
// 使用者第二次指正覆蓋不足：上一輪雖然測了「RSI5>80 ∧ RSI10>80」，
//   但**只在單獨那一段**；一進到 KD／MA／波動的組合，每一格都只用了
//   RSI5 或 RSI10 其中一個，雙高從來沒進過組合空間。本輪補齊。
//
// 「同上80」兩種讀法都測，避免再猜錯：
//   Ａ 同時 **大於** 80（水位）：rsi5>80 ∧ rsi10>80
//   Ｂ 同時 **上穿** 80（事件）：昨日 ≤80、今日 >80，兩條同一天發生
//      ＋放寬版：兩條都在最近 3 日內上穿（同步突破但不必同一天）
//
// 沿用三條已付出代價換來的紀律：
//   ① 拆解：真起漲 = 「後5日不破今低」∧「後5日曾漲≥5%」，兩成分分開報
//      （只有「漲≥5%」上升才算漲幅訊號；只有「不破底」上升＝風險訊號）
//   ② vol20 五分層控制（防代理變數）
//   ③ 過關者一律再跑觸價出場，確認機率能不能換成錢
// 口徑：進場今收／出場第5日收／扣費稅 0.4425%／可交易宇宙／主窗480日＋OOT。
// 只跑波段，不碰隔日沖。非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';
const COST = 0.4425, P = 9;

function ind(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) for (const c in days[i].close) {
    if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
    const r = days[i].close[c]; if (!r || r.length < 5) continue;
    const [cl, , , hi, lo] = r; if (!(cl > 0 && hi > 0 && lo > 0 && hi >= lo)) continue;
    const s = (st[c] ||= { cs: [], k: 50, d: 50, hs: [], ls: [], pm5: null, pm10: null });
    s.cs.push(cl); if (s.cs.length > 40) s.cs.shift();
    s.hs.push(hi); s.ls.push(lo); if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
    const pk = s.k, pd = s.d;
    if (s.hs.length === P) {
      const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
      const rsv = hn === ln ? 50 : ((cl - ln) / (hn - ln)) * 100;
      s.k = (s.k * 2) / 3 + rsv / 3; s.d = (s.d * 2) / 3 + s.k / 3;
    }
    if (s.cs.length < 21) continue;
    const ma = n => { const a = s.cs.slice(-n); return a.reduce((x, y) => x + y, 0) / n; };
    const m5 = ma(5), m10 = ma(10);
    const w = s.cs.slice(-21), rt = [];
    for (let t = 1; t < w.length; t++) if (w[t - 1] > 0) rt.push((w[t] - w[t - 1]) / w[t - 1] * 100);
    const mu = rt.reduce((a, b) => a + b, 0) / rt.length;
    out[`${i}_${c}`] = {
      k: s.k, kGold: pk <= pd && s.k > s.d, kDead: pk >= pd && s.k < s.d,
      aboveM5: cl > m5, aboveM10: cl > m10, m5AboveM10: m5 > m10,
      m5Up: s.pm5 != null && m5 > s.pm5,
      vol20: Math.sqrt(rt.reduce((a, b) => a + (b - mu) ** 2, 0) / rt.length),
    };
    s.pm5 = m5; s.pm10 = m10;
  }
  return out;
}
/** RSI5/RSI10 ＋ 上穿 80 事件（今日>80 且 昨日≤80），另記最近幾日內是否上穿 */
function rsiOf(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const c = days[i].close[code]?.[0]; if (!(c > 0)) continue;
    const s = (st[code] ||= { p: null, u5: 0, d5: 0, u10: 0, d10: 0, n: 0, p5: null, p10: null, x5: 99, x10: 99 });
    if (s.p != null) {
      const ch = c - s.p, g = Math.max(ch, 0), l = Math.max(-ch, 0); s.n++;
      if (s.n <= 5) { s.u5 += g / 5; s.d5 += l / 5; } else { s.u5 = (s.u5 * 4 + g) / 5; s.d5 = (s.d5 * 4 + l) / 5; }
      if (s.n <= 10) { s.u10 += g / 10; s.d10 += l / 10; } else { s.u10 = (s.u10 * 9 + g) / 10; s.d10 = (s.d10 * 9 + l) / 10; }
      if (s.n >= 10) {
        const r5 = s.u5 + s.d5 > 0 ? (s.u5 / (s.u5 + s.d5)) * 100 : 50;
        const r10 = s.u10 + s.d10 > 0 ? (s.u10 / (s.u10 + s.d10)) * 100 : 50;
        const cx5 = s.p5 != null && s.p5 <= 80 && r5 > 80;
        const cx10 = s.p10 != null && s.p10 <= 80 && r10 > 80;
        s.x5 = cx5 ? 0 : s.x5 + 1;            // 距上次 RSI5 上穿80 幾日
        s.x10 = cx10 ? 0 : s.x10 + 1;
        out[`${i}_${code}`] = { rsi5: r5, rsi10: r10, cross5: cx5, cross10: cx10, since5: s.x5, since10: s.x10,
          r5Up: s.p5 != null && r5 > s.p5, r10Up: s.p10 != null && r10 > s.p10 };
        s.p5 = r5; s.p10 = r10;
      }
    }
    s.p = c;
  }
  return out;
}
function fwd(days) {
  const out = {};
  for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const path = []; let ok = true;
    for (let k = 1; k <= 5; k++) {
      const rr = days[i + k]?.close?.[code];
      if (!rr || rr.length < 5) { ok = false; break; }
      path.push([rr[0], rr[3], rr[4]]);
    }
    if (ok) out[`${i}_${code}`] = path;
  }
  return out;
}
const load = async o => {
  const d = await loadDays(o); const sm = buildSamples(d);
  const a = ind(d), rs = rsiOf(d), pt = fwd(d);
  for (const s of sm) { Object.assign(s, a[`${s.di}_${s.code}`] || {}, rs[`${s.di}_${s.code}`] || {}); s.path = pt[`${s.di}_${s.code}`] || null; }
  const u = sm.filter(s => s.tradable && s.k != null && s.rsi5 != null && s.path && s.net5 != null && s.vol20 > 0);
  for (const s of u) {
    let lo = Infinity, hi = -Infinity;
    for (const [, h, l] of s.path) { if (l < lo) lo = l; if (h > hi) hi = h; }
    s.noBreak = lo >= s.l; s.up5 = hi >= s.c * 1.05; s.realStart = s.noBreak && s.up5;
    // 觸價出場（目標+5%／停損破今低／同日雙觸取停損）
    const tgt = s.c * 1.05; s.x5r = null;
    for (const [cl, h, l] of s.path) {
      if (l <= s.l) { s.x5r = (s.l - s.c) / s.c * 100 - COST; break; }
      if (h >= tgt) { s.x5r = 5 - COST; break; }
    }
    if (s.x5r == null) s.x5r = (s.path[4][0] - s.c) / s.c * 100 - COST;
  }
  return u;
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };
const qc = (w, f, qs) => { const v = w.map(f).filter(x => Number.isFinite(x)).sort((a, b) => a - b); return qs.map(q => v[Math.floor(v.length * q)]); };
const VQ = {}; for (const k in W) VQ[k] = qc(W[k], s => s.vol20, [.2, .4, .6, .8]);

for (const [wn, w] of Object.entries(W))
  console.log(`【${wn}】基準：漲≥5% ${pct(w, x => x.up5)}%·不破底 ${pct(w, x => x.noBreak)}%·真起漲 ${pct(w, x => x.realStart)}%·5日均 ${r3(avg(w.map(x => x.net5)))}%·中位 ${med(w.map(x => x.net5))}%·觸價出場均 ${r3(avg(w.map(x => x.x5r)))}%（n=${w.length.toLocaleString()}）`);

function row(nm, cond) {
  const R = Object.entries(W).map(([wn, w]) => {
    const g = w.filter(cond); const need = wn === '主窗' ? 300 : 100;
    if (g.length < need) return { thin: true, wn, n: g.length };
    const h = [0, 1].map(x => { const y = w.filter(s => s.half === x).filter(cond); return y.length >= 60 ? r3(avg(y.map(s => s.net5))) : null; });
    return { wn, n: g.length, u5: pct(g, x => x.up5), bU5: pct(w, x => x.up5),
      nb: pct(g, x => x.noBreak), bNb: pct(w, x => x.noBreak),
      m: r3(avg(g.map(x => x.net5))), md: med(g.map(x => x.net5)), win: pct(g, x => x.net5 > 0),
      xr: r3(avg(g.map(x => x.x5r))), h };
  });
  if (R.some(x => x.thin)) { console.log(`  ${nm.padEnd(42)} 樣本不足（${R.map(x => `${x.wn}:${x.n ?? '-'}`).join(' ')}）`); return; }
  const [A, B] = R; const f = v => (v == null ? '  ---' : String(v).padStart(7));
  const dd = (a, b) => `${String(a).padStart(5)}(${(a - b >= 0 ? '+' : '') + (a - b).toFixed(1)})`;
  const volOk = Object.entries(W).every(([wn, w]) => {
    let good = 0, valid = 0;
    for (let t = 0; t < 5; t++) {
      const c = VQ[wn];
      const L = w.filter(s => t === 0 ? s.vol20 < c[0] : t === 4 ? s.vol20 >= c[3] : s.vol20 >= c[t - 1] && s.vol20 < c[t]);
      const g = L.filter(cond); if (L.length < 800 || g.length < 60) continue;
      valid++; if (pct(g, x => x.up5) > pct(L, x => x.up5)) good++;
    }
    return valid >= 3 && good >= valid - 1;
  });
  const ok = A.m > 0 && B.m > 0 && A.md > 0 && B.md > 0 && A.h.every(v => v != null && v > 0) && A.u5 > A.bU5 && B.u5 > B.bU5 && volOk;
  console.log(`  ${nm.padEnd(42)} 主窗 漲≥5%${dd(A.u5, A.bU5)} 不破底${dd(A.nb, A.bNb)} 均${f(A.m)} 中位${f(A.md)} 淨勝${String(A.win).padStart(5)}% 觸價${f(A.xr)} 兩半[${f(A.h[0])}/${f(A.h[1])}]｜OOT 漲≥5%${dd(B.u5, B.bU5)} 不破底${dd(B.nb, B.bNb)} 均${f(B.m)} 中位${f(B.md)} 觸價${f(B.xr)}｜波動${volOk ? '✓' : '✗'}｜n=${A.n.toLocaleString()}/${B.n.toLocaleString()} ${ok ? '✅' : '❌'}`);
}

const D80 = s => s.rsi5 > 80 && s.rsi10 > 80;
console.log(`\n${'═'.repeat(236)}\n══ Ａ「同時大於80」水位版：雙高 × KD × MA × 波動（上一輪只在單獨那段測過，組合空間全缺）\n${'═'.repeat(236)}`);
row('雙高 RSI5>80 ∧ RSI10>80', D80);
row('雙高85 RSI5>85 ∧ RSI10>85', s => s.rsi5 > 85 && s.rsi10 > 85);
row('雙高 ∧ KD金叉', s => D80(s) && s.kGold);
row('雙高 ∧ KD死叉', s => D80(s) && s.kDead);
row('雙高 ∧ KD未死叉', s => D80(s) && !s.kDead);
row('雙高 ∧ MA5>MA10', s => D80(s) && s.m5AboveM10);
row('雙高 ∧ MA5>MA10 ∧ MA5上揚', s => D80(s) && s.m5AboveM10 && s.m5Up);
row('雙高 ∧ 站上MA5&MA10', s => D80(s) && s.aboveM5 && s.aboveM10);
row('雙高 ∧ vol≥1.5%', s => D80(s) && s.vol20 >= 1.5);
row('雙高 ∧ MA5>MA10 ∧ vol≥1.5%', s => D80(s) && s.m5AboveM10 && s.vol20 >= 1.5);
row('雙高 ∧ KD未死叉 ∧ MA5>MA10 ∧ vol≥1.5%', s => D80(s) && !s.kDead && s.m5AboveM10 && s.vol20 >= 1.5);
row('雙高 ∧ 兩條RSI都還在上升', s => D80(s) && s.r5Up && s.r10Up);

console.log(`\n${'═'.repeat(236)}\n══ Ｂ「同時上穿80」事件版：昨≤80 今>80，兩條同步突破\n${'═'.repeat(236)}`);
row('同日雙上穿（cross5 ∧ cross10）', s => s.cross5 && s.cross10);
row('3日內雙上穿（since5≤3 ∧ since10≤3）', s => s.since5 <= 3 && s.since10 <= 3);
row('5日內雙上穿', s => s.since5 <= 5 && s.since10 <= 5);
row('3日內雙上穿 ∧ MA5>MA10', s => s.since5 <= 3 && s.since10 <= 3 && s.m5AboveM10);
row('3日內雙上穿 ∧ vol≥1.5%', s => s.since5 <= 3 && s.since10 <= 3 && s.vol20 >= 1.5);
row('3日內雙上穿 ∧ MA5>MA10 ∧ vol≥1.5%', s => s.since5 <= 3 && s.since10 <= 3 && s.m5AboveM10 && s.vol20 >= 1.5);
row('僅RSI5上穿(RSI10未過80·對照)', s => s.since5 <= 3 && s.rsi10 <= 80);
row('僅RSI10上穿(RSI5未過80·對照)', s => s.since10 <= 3 && s.rsi5 <= 80);

console.log(`\n${'═'.repeat(236)}\n══ Ｃ 疊在「波段追強」母體（RSI5 75~90 ∧ RSI10>RSI5 ∧ 法人5日買超>0.05）之上\n${'═'.repeat(236)}`);
const STR = s => s.rsi5 >= 75 && s.rsi5 < 90 && s.rsi10 > s.rsi5 && s.inst5Ratio != null && s.inst5Ratio > 0.05;
for (const [wn, w] of Object.entries(W)) {
  const b = w.filter(STR);
  if (b.length < 100) { console.log(`  【${wn}】追強母體不足 ${b.length}`); continue; }
  const h = g => [0, 1].map(x => { const y = g.filter(s => s.half === x); return y.length >= 20 ? r3(avg(y.map(s => s.net5))) : null; });
  console.log(`  【${wn}】追強基準：漲≥5% ${pct(b, x => x.up5)}%·5日均 ${r3(avg(b.map(x => x.net5)))}%·中位 ${med(b.map(x => x.net5))}%·淨勝 ${pct(b, x => x.net5 > 0)}%·兩半[${h(b).join('/')}]（n=${b.length.toLocaleString()}）`);
  for (const [lab, f] of [['＋雙高>80', D80], ['＋RSI10>80', s => s.rsi10 > 80], ['＋雙高 ∧ KD未死叉', s => D80(s) && !s.kDead],
    ['＋3日內雙上穿', s => s.since5 <= 3 && s.since10 <= 3], ['＋兩條RSI都在上升', s => s.r5Up && s.r10Up]]) {
    const g = b.filter(f);
    if (g.length < 50) { console.log(`    ${lab.padEnd(22)} 樣本不足 ${g.length}`); continue; }
    console.log(`    ${lab.padEnd(22)} 漲≥5%${String(pct(g, x => x.up5)).padStart(5)}%(Δ${String((pct(g, x => x.up5) - pct(b, x => x.up5)).toFixed(1)).padStart(5)}) 均${String(r3(avg(g.map(x => x.net5)))).padStart(7)}%(Δ${String(r3(avg(g.map(x => x.net5)) - avg(b.map(x => x.net5)))).padStart(6)}) 中位${String(med(g.map(x => x.net5))).padStart(7)} 淨勝${String(pct(g, x => x.net5 > 0)).padStart(5)}% 兩半[${h(g).join('/')}] 留存${String(pct(b, f)).padStart(5)}% n=${g.length}`);
  }
}
console.log('\n判準：5日均與中位兩窗皆正 ∧ 主窗兩半皆正 ∧ 漲≥5% 成分高於基準 ∧ vol20五分層控制過。');
console.log('「觸價」欄＝目標+5%／停損破今低／同日雙觸算停損 的平均淨報酬，用來檢查機率能否換成錢。非投資建議。');
process.exit(0);
