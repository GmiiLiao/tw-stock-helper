// ─────────────────────────────────────────────────────────────────────────
// 波段「觸價出場」檢定 —— 2026-08-02
//
// 緣起：screen-swing-triple.mjs 發現 KD 黃金交叉把真起漲率從 17.9%→23.5%
//   （OOT 18.3%→22.9%），死叉壓到 13.2%/14.9%，**兩窗鏡像對稱＝真訊號**。
//   但 5 日收盤出場的報酬沒跟上（主窗均-0.42%·中位-0.93%）。
//   原因：真起漲是「路徑」性質，net5 是「第5日收盤」性質——行情走出來了，
//   但機械抱到第5日又還回去。⇒ 缺的是**出場規則**，不是進場條件。
//
// 本輪模型（貼近實際掛單）：
//   進場＝今日收盤 C
//   每日 k=1..5：若最高 ≥ C×(1+T) → 以 C×(1+T) 成交出場（限價單可成立）
//                若最低 ≤ 今日最低 L → 以 L 出場（技能原文的「破前低無條件停損」）
//   未觸發者＝第5日收盤出場
//   ⚠同日同時觸及目標與停損 → **一律認定停損先成交**（盤中路徑不可知，取保守）
//   扣費稅 0.4425%
// 對照：同一組樣本的「抱到第5日」報酬，看出場規則到底值多少。
// 非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';
const COST = 0.4425, P = 9;

function buildInd(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const c in days[i].close) {
      if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
      const r = days[i].close[c]; if (!r || r.length < 5) continue;
      const [cl, , , hi, lo] = r;
      if (!(cl > 0 && hi > 0 && lo > 0 && hi >= lo)) continue;
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
        maGold: s.pm5 != null && s.pm10 != null && s.pm5 <= s.pm10 && m5 > m10,
        vol20: Math.sqrt(rt.reduce((a, b) => a + (b - mu) ** 2, 0) / rt.length),
      };
      s.pm5 = m5; s.pm10 = m10;
    }
  }
  return out;
}
function buildRSI(days) {
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
/** 逐日 OHLC 前瞻 5 日（觸價模擬用） */
function buildPath(days) {
  const out = {};
  for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const path = []; let ok = true;
    for (let k = 1; k <= 5; k++) {
      const rr = days[i + k]?.close?.[code];
      if (!rr || rr.length < 5) { ok = false; break; }
      path.push([rr[0], rr[3], rr[4]]);   // [收, 高, 低]
    }
    if (ok) out[`${i}_${code}`] = path;
  }
  return out;
}
/** 觸價出場：目標 +T%、停損 S（'low'＝今日最低／數字＝-S%／null＝不停損）。
 *  同日雙觸取停損（保守：盤中路徑不可知）。 */
function exitRet(C, L, path, T, S = 'low') {
  const tgt = C * (1 + T / 100);
  const stopP = S === 'low' ? L : S == null ? null : C * (1 - S / 100);
  for (const [cl, hi, lo] of path) {
    if (stopP != null && lo <= stopP) return (stopP - C) / C * 100 - COST;
    if (hi >= tgt) return T - COST;
  }
  return (path[path.length - 1][0] - C) / C * 100 - COST;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const ind = buildInd(days), rsi = buildRSI(days), pth = buildPath(days);
  for (const s of samples) {
    Object.assign(s, ind[`${s.di}_${s.code}`] || {}, rsi[`${s.di}_${s.code}`] || {});
    s.path = pth[`${s.di}_${s.code}`] || null;
  }
  const uni = samples.filter(s => s.tradable && s.k != null && s.rsi5 != null && s.path && s.net5 != null && s.vol20 > 0);
  for (const s of uni) {
    for (const T of [3, 5, 8]) for (const [sk, sv] of [['L', 'low'], ['5', 5], ['8', 8], ['N', null]])
      s[`x${T}${sk}`] = exitRet(s.c, s.l, s.path, T, sv);
    let lo = Infinity, hi = -Infinity;
    for (const [, h, l] of s.path) { if (l < lo) lo = l; if (h > hi) hi = h; }
    s.realStart = lo >= s.l && hi >= s.c * 1.05;
  }
  return uni;
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };

const GROUPS = [
  ['宇宙基準', () => true],
  ['RSI5>80', s => s.rsi5 > 80],
  ['RSI10>80', s => s.rsi10 > 80],
  ['RSI5>80 ∧ RSI10>80', s => s.rsi5 > 80 && s.rsi10 > 80],
  ['RSI10>80 ∧ MA5>MA10', s => s.rsi10 > 80 && s.m5AboveM10],
  ['RSI10>80 ∧ MA5>MA10 ∧ vol≥1.5%', s => s.rsi10 > 80 && s.m5AboveM10 && s.vol20 >= 1.5],
  ['RSI5>80 ∧ MA5>MA10 ∧ vol≥1.5%', s => s.rsi5 > 80 && s.m5AboveM10 && s.vol20 >= 1.5],
  ['RSI10>80 ∧ KD未死叉 ∧ MA5>MA10', s => s.rsi10 > 80 && !s.kDead && s.m5AboveM10],
]
const STOPS = [['破今低', 'L'], ['停損-5%', '5'], ['停損-8%', '8'], ['不停損', 'N']];
for (const T of [3, 5, 8]) {
  console.log(`\n${'═'.repeat(170)}\n══ 目標 +${T}%｜四種停損並列（未觸發者抱到第5日收盤·扣費稅 0.4425%）\n${'═'.repeat(170)}`);
  console.log(`  ${'組合'.padEnd(26)} ${'窗'.padEnd(4)} ${'達標率'.padStart(6)} ${STOPS.map(x => (x[0] + '均').padStart(11)).join('')}  ｜ ${'抱到第5日'.padStart(10)}   最佳停損的主窗兩半`);
  for (const [nm, f] of GROUPS) {
    for (const [wn, w] of Object.entries(W)) {
      const g = w.filter(f);
      if (g.length < 300) { console.log(`  ${nm.padEnd(26)} ${wn.padEnd(4)} 樣本不足 ${g.length}`); continue; }
      const cells = STOPS.map(([, k]) => r3(avg(g.map(s => s[`x${T}${k}`]))));
      const bestI = cells.indexOf(Math.max(...cells));
      const bk = STOPS[bestI][1];
      const h = [0, 1].map(x => { const y = g.filter(s => s.half === x); return y.length >= 100 ? r3(avg(y.map(s => s[`x${T}${bk}`]))) : null; });
      const tgtRate = pct(g, s => Math.abs(s[`x${T}N`] - (T - COST)) < 1e-9);
      console.log(`  ${nm.padEnd(26)} ${wn.padEnd(4)} ${String(tgtRate).padStart(5)}% ${cells.map((c, i) => (String(c) + (i === bestI ? '★' : ' ')).padStart(11)).join('')}  ｜ ${String(r3(avg(g.map(s => s.net5)))).padStart(9)}%   ${STOPS[bestI][0]}[${h[0]}/${h[1]}]  n=${g.length.toLocaleString()}`);
    }
  }
}
console.log('\n判準：觸價出場均與中位兩窗皆正 ∧ 主窗兩半皆正 ∧ 優於抱到第5日 ∧ 真起漲率高於基準。');
console.log('⚠同日同時觸及目標與停損一律算停損（保守假設）；限價單成交假設不含滑價。非投資建議。');
process.exit(0);
