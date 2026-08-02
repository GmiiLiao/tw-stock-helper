// ─────────────────────────────────────────────────────────────────────────
// 波段口徑：KD交叉 × MA5/10 × **RSI 高檔（>80）** 補測 —— 2026-08-02
//
// 使用者指出上一輪的漏洞：指定的是「rsi5/10」，但 screen-swing-triple.mjs 只測了
//   低檔（RSI5<20、RSI10<25）與中性（40~70），**高檔一格都沒測**。
//   而 KD金叉 ∧ MA5>MA10 ∧ RSI高檔＝「多頭排列中回檔結束再起漲」，
//   與 RSI5<20 的跌深反彈是完全不同的母體，也正是「波段追強」技能的地盤。
//
// 沿用上一輪的教訓（已踩兩次坑）：**複合指標一律拆成成分各測一次**——
//   真起漲 = 「後5日不破今低」∧「後5日曾漲≥5%」，兩者分開報，
//   否則會把 A 的功勞記在 B 頭上（MA20溫吞區＝低波動代理、KD交叉＝不破底代理）。
//   並且每一項都做 vol20 五分層控制。
//
// 口徑：進場今收／出場第5日收／扣費稅 0.4425%／可交易宇宙(chg≤8.5%)
//       主窗 480 日 ＋ 第三獨立窗 OOT。只跑波段，不碰隔日沖。非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';
const P = 9;
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
function rsiOf(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const c = days[i].close[code]?.[0]; if (!(c > 0)) continue;
    const s = (st[code] ||= { p: null, u5: 0, d5: 0, u10: 0, d10: 0, n: 0 });
    if (s.p != null) {
      const ch = c - s.p, g = Math.max(ch, 0), l = Math.max(-ch, 0); s.n++;
      if (s.n <= 5) { s.u5 += g / 5; s.d5 += l / 5; } else { s.u5 = (s.u5 * 4 + g) / 5; s.d5 = (s.d5 * 4 + l) / 5; }
      if (s.n <= 10) { s.u10 += g / 10; s.d10 += l / 10; } else { s.u10 = (s.u10 * 9 + g) / 10; s.d10 = (s.d10 * 9 + l) / 10; }
      if (s.n >= 10) out[`${i}_${code}`] = {
        rsi5: s.u5 + s.d5 > 0 ? (s.u5 / (s.u5 + s.d5)) * 100 : 50,
        rsi10: s.u10 + s.d10 > 0 ? (s.u10 / (s.u10 + s.d10)) * 100 : 50 };
    }
    s.p = c;
  }
  return out;
}
function fwd(days) {
  const out = {};
  for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let k = 1; k <= 5; k++) {
      const rr = days[i + k]?.close?.[code];
      if (!rr || rr.length < 5) { ok = false; break; }
      if (rr[4] < lo) lo = rr[4]; if (rr[3] > hi) hi = rr[3];
    }
    if (ok) out[`${i}_${code}`] = { fwdLo: lo, fwdHi: hi };
  }
  return out;
}
const load = async o => {
  const d = await loadDays(o); const sm = buildSamples(d);
  const a = ind(d), rs = rsiOf(d), f = fwd(d);
  for (const s of sm) Object.assign(s, a[`${s.di}_${s.code}`] || {}, rs[`${s.di}_${s.code}`] || {}, f[`${s.di}_${s.code}`] || {});
  const u = sm.filter(s => s.tradable && s.k != null && s.rsi5 != null && s.fwdLo != null && s.net5 != null && s.vol20 > 0);
  for (const s of u) { s.noBreak = s.fwdLo >= s.l; s.up5 = s.fwdHi >= s.c * 1.05; s.realStart = s.noBreak && s.up5; }
  return u;
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
for (const k in W) for (const s of W[k]) s._w = k;
const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };
const qc = (w, f, qs) => { const v = w.map(f).filter(x => Number.isFinite(x)).sort((a, b) => a - b); return qs.map(q => v[Math.floor(v.length * q)]); };
const VQ = {}; for (const k in W) VQ[k] = qc(W[k], s => s.vol20, [.2, .4, .6, .8]);

for (const [wn, w] of Object.entries(W))
  console.log(`【${wn}】基準：真起漲 ${pct(w, x => x.realStart)}%（不破底 ${pct(w, x => x.noBreak)}%／漲≥5% ${pct(w, x => x.up5)}%）·5日均 ${r3(avg(w.map(x => x.net5)))}%·中位 ${med(w.map(x => x.net5))}%·淨勝 ${pct(w, x => x.net5 > 0)}%（n=${w.length.toLocaleString()}）`);

function row(nm, cond) {
  const out = Object.entries(W).map(([wn, w]) => {
    const g = w.filter(cond);
    const need = wn === '主窗' ? 400 : 150;
    if (g.length < need) return { thin: true, wn, n: g.length };
    const h = [0, 1].map(x => { const y = w.filter(s => s.half === x).filter(cond); return y.length >= 100 ? r3(avg(y.map(s => s.net5))) : null; });
    return { wn, n: g.length, rs: pct(g, x => x.realStart), nb: pct(g, x => x.noBreak), u5: pct(g, x => x.up5),
      m: r3(avg(g.map(x => x.net5))), md: med(g.map(x => x.net5)), win: pct(g, x => x.net5 > 0), h,
      bRs: pct(w, x => x.realStart), bNb: pct(w, x => x.noBreak), bU5: pct(w, x => x.up5) };
  });
  if (out.some(x => x.thin)) { console.log(`  ${nm.padEnd(38)} 樣本不足（${out.map(x => `${x.wn}:${x.n ?? '-'}`).join(' ')}）`); return; }
  const [A, B] = out;
  const f = v => (v == null ? '  ---' : String(v).padStart(7));
  const d = (a, b) => `${String(a).padStart(5)}(${(a - b >= 0 ? '+' : '') + (a - b).toFixed(1)})`;
  // 波動控制：對「漲≥5%」在五分層內是否一致為正
  const volOk = Object.entries(W).every(([wn, w]) => {
    let good = 0, valid = 0;
    for (let t = 0; t < 5; t++) {
      const c = VQ[wn];
      const L = w.filter(s => t === 0 ? s.vol20 < c[0] : t === 4 ? s.vol20 >= c[3] : s.vol20 >= c[t - 1] && s.vol20 < c[t]);
      const g = L.filter(cond);
      if (L.length < 1000 || g.length < 80) continue;
      valid++; if (pct(g, x => x.up5) > pct(L, x => x.up5)) good++;
    }
    return valid >= 3 && good >= valid - 1;
  });
  const ok = A.m > 0 && B.m > 0 && A.md > 0 && B.md > 0 && A.h.every(v => v != null && v > 0) && A.u5 > A.bU5 && B.u5 > B.bU5 && volOk;
  console.log(`  ${nm.padEnd(38)} 主窗 真起漲${d(A.rs, A.bRs)} 不破底${d(A.nb, A.bNb)} 漲≥5%${d(A.u5, A.bU5)} 均${f(A.m)} 中位${f(A.md)} 兩半[${f(A.h[0])}/${f(A.h[1])}]｜OOT 真起漲${d(B.rs, B.bRs)} 不破底${d(B.nb, B.bNb)} 漲≥5%${d(B.u5, B.bU5)} 均${f(B.m)} 中位${f(B.md)}｜波動控制${volOk ? '✓' : '✗'}｜n=${A.n.toLocaleString()}/${B.n.toLocaleString()} ${ok ? '✅' : '❌'}`);
}

console.log(`\n${'═'.repeat(230)}\n══ ① RSI 高檔單獨（括號內＝相對該窗基準的 pp 差）\n${'═'.repeat(230)}`);
row('RSI5 > 80', s => s.rsi5 > 80);
row('RSI5 > 85', s => s.rsi5 > 85);
row('RSI5 > 90（極度超買）', s => s.rsi5 > 90);
row('RSI10 > 80', s => s.rsi10 > 80);
row('RSI5>80 ∧ RSI10>80（雙高）', s => s.rsi5 > 80 && s.rsi10 > 80);
row('RSI5 75~90（追強母體）', s => s.rsi5 >= 75 && s.rsi5 < 90);
row('RSI5>80 ∧ RSI10>RSI5（高檔且10日領先）', s => s.rsi5 > 80 && s.rsi10 > s.rsi5);

console.log(`\n${'═'.repeat(230)}\n══ ② RSI 高檔 × KD 交叉\n${'═'.repeat(230)}`);
row('RSI5>80 ∧ KD金叉', s => s.rsi5 > 80 && s.kGold);
row('RSI5>80 ∧ KD死叉', s => s.rsi5 > 80 && s.kDead);
row('RSI10>80 ∧ KD金叉', s => s.rsi10 > 80 && s.kGold);
row('RSI10>80 ∧ KD死叉', s => s.rsi10 > 80 && s.kDead);
row('RSI5>80 ∧ 無交叉(K>D 持續開口)', s => s.rsi5 > 80 && !s.kGold && !s.kDead && s.k > 50);

console.log(`\n${'═'.repeat(230)}\n══ ③ 三指標合流·高檔版（使用者原命題的高檔side）\n${'═'.repeat(230)}`);
row('RSI5>80 ∧ KD金叉 ∧ MA5>MA10', s => s.rsi5 > 80 && s.kGold && s.m5AboveM10);
row('RSI5>80 ∧ KD金叉 ∧ 站上MA5&MA10', s => s.rsi5 > 80 && s.kGold && s.aboveM5 && s.aboveM10);
row('RSI5>80 ∧ MA5>MA10 ∧ MA5上揚', s => s.rsi5 > 80 && s.m5AboveM10 && s.m5Up);
row('RSI10>80 ∧ KD金叉 ∧ MA5>MA10', s => s.rsi10 > 80 && s.kGold && s.m5AboveM10);
row('RSI5>80 ∧ KD死叉 ∧ 跌破MA5（高檔轉弱·避開端）', s => s.rsi5 > 80 && s.kDead && !s.aboveM5);
row('RSI5>80 ∧ KD金叉 ∧ MA5>MA10 ∧ vol≥1.5%', s => s.rsi5 > 80 && s.kGold && s.m5AboveM10 && s.vol20 >= 1.5);
row('RSI5>80 ∧ MA5>MA10 ∧ vol≥1.5%', s => s.rsi5 > 80 && s.m5AboveM10 && s.vol20 >= 1.5);

console.log(`\n${'═'.repeat(230)}\n══ ④ 疊在「波段追強」母體（RSI5 75~90 ∧ RSI10>RSI5 ∧ 法人5日買超>0.05）之上\n${'═'.repeat(230)}`);
const STR = s => s.rsi5 >= 75 && s.rsi5 < 90 && s.rsi10 > s.rsi5 && s.inst5Ratio != null && s.inst5Ratio > 0.05;
for (const [wn, w] of Object.entries(W)) {
  const b = w.filter(STR);
  if (b.length < 100) { console.log(`  【${wn}】追強母體樣本不足 ${b.length}`); continue; }
  const h = g => [0, 1].map(x => { const y = g.filter(s => s.half === x); return y.length >= 20 ? r3(avg(y.map(s => s.net5))) : null; });
  console.log(`  【${wn}】追強基準：真起漲 ${pct(b, x => x.realStart)}%（不破底 ${pct(b, x => x.noBreak)}%／漲≥5% ${pct(b, x => x.up5)}%）·5日均 ${r3(avg(b.map(x => x.net5)))}%·中位 ${med(b.map(x => x.net5))}%·淨勝 ${pct(b, x => x.net5 > 0)}%·兩半[${h(b).join('/')}]（n=${b.length.toLocaleString()}）`);
  for (const [lab, f] of [['＋KD金叉', s => s.kGold], ['＋KD未死叉', s => !s.kDead], ['＋KD死叉(對照)', s => s.kDead],
    ['＋MA5>MA10', s => s.m5AboveM10], ['＋站上MA5&MA10', s => s.aboveM5 && s.aboveM10],
    ['＋MA5上揚', s => s.m5Up], ['＋KD未死叉 ∧ MA5>MA10', s => !s.kDead && s.m5AboveM10]]) {
    const g = b.filter(f);
    if (g.length < 60) { console.log(`    ${lab.padEnd(24)} 樣本不足 ${g.length}`); continue; }
    console.log(`    ${lab.padEnd(24)} 真起漲${String(pct(g, x => x.realStart)).padStart(5)}%(Δ${String((pct(g, x => x.realStart) - pct(b, x => x.realStart)).toFixed(1)).padStart(5)}) 不破底${String(pct(g, x => x.noBreak)).padStart(5)}%(Δ${String((pct(g, x => x.noBreak) - pct(b, x => x.noBreak)).toFixed(1)).padStart(5)}) 漲≥5%${String(pct(g, x => x.up5)).padStart(5)}%(Δ${String((pct(g, x => x.up5) - pct(b, x => x.up5)).toFixed(1)).padStart(5)}) 均${String(r3(avg(g.map(x => x.net5)))).padStart(7)}%(Δ${String(r3(avg(g.map(x => x.net5)) - avg(b.map(x => x.net5)))).padStart(6)}) 中位${String(med(g.map(x => x.net5))).padStart(7)} 淨勝${String(pct(g, x => x.net5 > 0)).padStart(5)}% 兩半[${h(g).join('/')}] 留存${String(pct(b, f)).padStart(5)}% n=${g.length}`);
  }
}
console.log('\n判準：5日均與中位兩窗皆正 ∧ 主窗兩半皆正 ∧ **漲≥5% 成分**高於基準 ∧ vol20 五分層控制通過。');
console.log('⚠拆解報表：真起漲 = 不破底 ∧ 漲≥5%。只有「漲≥5%」那一欄上升才算漲幅訊號；只有「不破底」上升＝風險訊號。非投資建議。');
process.exit(0);
