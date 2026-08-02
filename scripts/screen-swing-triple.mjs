// ─────────────────────────────────────────────────────────────────────────
// 波段口徑：KD交叉 × MA5/MA10 × RSI5/RSI10 三指標合流檢定 —— 2026-08-02
//
// 使用者指定：「同測波段漲幅成功率，加入波段技能不加入隔日沖技能」
//   ⇒ 全程只跑 net5（持有5日）與真起漲率，**完全不看明開賣**。
//
// 為什麼值得再測一次（前面 KD 已被打槍七輪）：
//   前幾輪測的是 KD **單獨**或 KD×MA 兩兩。使用者這次指定的是**三者合流**
//   ——「KD 交叉給時點、均線給方向、RSI 給位階」。合流訊號有可能在單獨全滅
//   的情況下成立（各自的雜訊互相抵銷），這是合理假設，值得用資料回答。
//
// ⚠多重比較風險（先講在前面）：本腳本會測 ~40 個組合。純機率下，40 個組合裡
//   出現幾個「兩窗同向」是必然的。所以判準比平常更嚴：
//     ① 5日均為正 ∧ 中位數為正（兩窗都要）
//     ② 真起漲率高於**該窗基準**（兩窗都要）
//     ③ 主窗前後兩半同向且都為正
//     ④ **波動控制**：在 vol20 五分層內部效應仍在（上一輪 MA20 溫吞區就是死在這關）
//     ⑤ 樣本量足夠（主窗≥400、OOT≥150）
//   ①~⑤ 全過才算數。過關者還要再做「疊在 ⭐三重確認 之上有無增量」。
//
// 口徑：進場今日收盤／出場第5日收盤／扣費稅 0.4425%／可交易宇宙(chg≤8.5%)
//       真起漲＝後5日最低 ≥ 今日最低 ∧ 後5日最高 ≥ 今日收盤×1.05
//       主窗 480 日 ＋ 第三獨立窗 OOT（2022-07~2023-07，訊號設計時未見過）
// 非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';

const P = 9;
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
      // 20日已實現波動（波動控制用·與 screen-swing-vol.mjs 同口徑）
      const w = s.cs.slice(-21), rt = [];
      for (let t = 1; t < w.length; t++) if (w[t - 1] > 0) rt.push((w[t] - w[t - 1]) / w[t - 1] * 100);
      const mu = rt.reduce((a, b) => a + b, 0) / rt.length;
      const vol20 = Math.sqrt(rt.reduce((a, b) => a + (b - mu) ** 2, 0) / rt.length);
      out[`${i}_${c}`] = {
        k: s.k, d: s.d,
        kGold: pk <= pd && s.k > s.d,          // KD 黃金交叉
        kDead: pk >= pd && s.k < s.d,          // KD 死亡交叉
        kUp: s.k > pk, kSpread: s.k - s.d,
        m5, m10,
        aboveM5: cl > m5, aboveM10: cl > m10,
        m5AboveM10: m5 > m10,
        maGold: s.pm5 != null && s.pm10 != null && s.pm5 <= s.pm10 && m5 > m10,   // 均線黃金交叉
        maDead: s.pm5 != null && s.pm10 != null && s.pm5 >= s.pm10 && m5 < m10,
        m5Up: s.pm5 != null && m5 > s.pm5,
        vol20,
      };
      s.pm5 = m5; s.pm10 = m10;
    }
  }
  return out;
}
function buildRSI(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = days[i].close[code]?.[0]; if (!(c > 0)) continue;
      const s = (st[code] ||= { p: null, u5: 0, d5: 0, u10: 0, d10: 0, n: 0 });
      if (s.p != null) {
        const ch = c - s.p, g = Math.max(ch, 0), l = Math.max(-ch, 0);
        s.n++;
        if (s.n <= 5) { s.u5 += g / 5; s.d5 += l / 5; } else { s.u5 = (s.u5 * 4 + g) / 5; s.d5 = (s.d5 * 4 + l) / 5; }
        if (s.n <= 10) { s.u10 += g / 10; s.d10 += l / 10; } else { s.u10 = (s.u10 * 9 + g) / 10; s.d10 = (s.d10 * 9 + l) / 10; }
        if (s.n >= 10) out[`${i}_${code}`] = {
          rsi5: s.u5 + s.d5 > 0 ? (s.u5 / (s.u5 + s.d5)) * 100 : 50,
          rsi10: s.u10 + s.d10 > 0 ? (s.u10 / (s.u10 + s.d10)) * 100 : 50,
        };
      }
      s.p = c;
    }
  }
  return out;
}
function buildFwd(days) {
  const out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      let lo = Infinity, hi = -Infinity, ok = true;
      for (let k = 1; k <= 5; k++) {
        const rr = days[i + k]?.close?.[code];
        if (!rr || rr.length < 5) { ok = false; break; }
        if (rr[4] < lo) lo = rr[4];
        if (rr[3] > hi) hi = rr[3];
      }
      if (ok) out[`${i}_${code}`] = { fwdLo: lo, fwdHi: hi };
    }
  }
  return out;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const ind = buildInd(days), rsi = buildRSI(days), fw = buildFwd(days);
  for (const s of samples) Object.assign(s, ind[`${s.di}_${s.code}`] || {}, rsi[`${s.di}_${s.code}`] || {}, fw[`${s.di}_${s.code}`] || {});
  const uni = samples.filter(s => s.tradable && s.k != null && s.rsi5 != null && s.fwdLo != null && s.net5 != null && s.vol20 > 0);
  for (const s of uni) s.realStart = s.fwdLo >= s.l && s.fwdHi >= s.c * 1.05;
  return uni;
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
for (const k in W) for (const s of W[k]) s._w = k;

const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };
const qcut = (w, f, qs) => { const v = w.map(f).filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b); return qs.map(q => v[Math.floor(v.length * q)]); };
const VQ = {}; for (const k in W) VQ[k] = qcut(W[k], s => s.vol20, [.2, .4, .6, .8]);

for (const [wn, w] of Object.entries(W)) {
  console.log(`【${wn}】可交易宇宙基準：真起漲 ${pct(w, x => x.realStart)}%·5日均 ${r3(avg(w.map(x => x.net5)))}%·中位 ${med(w.map(x => x.net5))}%·淨勝 ${pct(w, x => x.net5 > 0)}%（n=${w.length.toLocaleString()}）`);
}

const passed = [];
/** 五道關卡；回傳是否全過 */
function test(name, cond, { quiet = false } = {}) {
  const R = Object.entries(W).map(([wn, w]) => {
    const sel = w.filter(cond);
    const need = wn === '主窗' ? 400 : 150;
    if (sel.length < need) return { thin: true, n: sel.length, wn };
    const half = [0, 1].map(h => {
      const g = w.filter(s => s.half === h).filter(cond);
      return g.length >= 100 ? r3(avg(g.map(s => s.net5))) : null;
    });
    return {
      wn, n: sel.length,
      m: r3(avg(sel.map(s => s.net5))), md: med(sel.map(s => s.net5)),
      rs: pct(sel, x => x.realStart), bRs: pct(w, x => x.realStart),
      win: pct(sel, x => x.net5 > 0), half,
    };
  });
  if (R.some(x => x.thin)) {
    if (!quiet) console.log(`  ${name.padEnd(44)} 樣本不足（${R.map(x => `${x.wn}:${x.n ?? '-'}`).join(' ')}）`);
    return false;
  }
  const [A, B] = R;
  const g1 = A.m > 0 && B.m > 0 && A.md > 0 && B.md > 0;
  const g2 = A.rs > A.bRs && B.rs > B.bRs;
  const g3 = A.half.every(v => v != null && v > 0);
  // ④ 波動控制：五分層裡至少 4 層的層內 Δ 為正（兩窗都要）
  const volOk = Object.entries(W).every(([wn, w]) => {
    let good = 0, valid = 0;
    for (let t = 0; t < 5; t++) {
      const c = VQ[wn];
      const L = w.filter(s => t === 0 ? s.vol20 < c[0] : t === 4 ? s.vol20 >= c[3] : s.vol20 >= c[t - 1] && s.vol20 < c[t]);
      const g = L.filter(cond);
      if (L.length < 1000 || g.length < 80) continue;
      valid++;
      if (avg(g.map(s => s.net5)) - avg(L.map(s => s.net5)) > 0) good++;
    }
    return valid >= 3 && good >= valid - 1;
  });
  const ok = g1 && g2 && g3 && volOk;
  const f = v => (v == null ? '  ---' : String(v).padStart(7));
  if (!quiet || ok) {
    console.log(`  ${name.padEnd(44)} 主窗 真起漲${String(A.rs).padStart(5)}%(基${A.bRs}) 均${f(A.m)} 中位${f(A.md)} 淨勝${String(A.win).padStart(5)}% 兩半[${f(A.half[0])}/${f(A.half[1])}]${g3 ? '✓' : '✗'}｜OOT 真起漲${String(B.rs).padStart(5)}%(基${B.bRs}) 均${f(B.m)} 中位${f(B.md)} 淨勝${String(B.win).padStart(5)}%｜波動控制${volOk ? '✓' : '✗'}｜n=${A.n.toLocaleString()}/${B.n.toLocaleString()} ${ok ? '✅通過' : '❌'}`);
  }
  if (ok) passed.push({ name, cond });
  return ok;
}

console.log(`\n${'═'.repeat(200)}\n══ ① 三個指標各自單獨（先看基本盤，才知道合流有沒有加值）\n${'═'.repeat(200)}`);
test('KD 黃金交叉', s => s.kGold);
test('KD 死亡交叉', s => s.kDead);
test('KD 低檔黃金交叉（K<30）', s => s.kGold && s.k < 30);
test('MA5 上穿 MA10（均線黃金交叉）', s => s.maGold);
test('MA5>MA10（多頭排列）', s => s.m5AboveM10);
test('收盤站上 MA5 ∧ MA10', s => s.aboveM5 && s.aboveM10);
test('RSI5<20（跌深）', s => s.rsi5 < 20);
test('RSI5<20 ∧ RSI10<25', s => s.rsi5 < 20 && s.rsi10 < 25);
test('RSI10>RSI5（10日領先·強勢整理型）', s => s.rsi10 > s.rsi5);

console.log(`\n${'═'.repeat(200)}\n══ ② 兩兩合流\n${'═'.repeat(200)}`);
test('KD金叉 ∧ 站上MA5', s => s.kGold && s.aboveM5);
test('KD金叉 ∧ MA5>MA10', s => s.kGold && s.m5AboveM10);
test('KD金叉 ∧ MA5上揚', s => s.kGold && s.m5Up);
test('KD金叉 ∧ RSI5<20', s => s.kGold && s.rsi5 < 20);
test('KD金叉 ∧ RSI5<30', s => s.kGold && s.rsi5 < 30);
test('KD低檔金叉 ∧ RSI5<30', s => s.kGold && s.k < 30 && s.rsi5 < 30);
test('均線金叉 ∧ RSI5<40', s => s.maGold && s.rsi5 < 40);
test('均線金叉 ∧ KD金叉', s => s.maGold && s.kGold);
test('RSI5<20 ∧ 站上MA5（跌深翻揚）', s => s.rsi5 < 20 && s.aboveM5);

console.log(`\n${'═'.repeat(200)}\n══ ③ 三指標合流（使用者指定的主命題）\n${'═'.repeat(200)}`);
test('KD金叉 ∧ 站上MA5 ∧ RSI5<30', s => s.kGold && s.aboveM5 && s.rsi5 < 30);
test('KD金叉 ∧ 站上MA5 ∧ RSI5<20', s => s.kGold && s.aboveM5 && s.rsi5 < 20);
test('KD金叉 ∧ MA5上揚 ∧ RSI5<30', s => s.kGold && s.m5Up && s.rsi5 < 30);
test('KD金叉 ∧ MA5>MA10 ∧ RSI5<40', s => s.kGold && s.m5AboveM10 && s.rsi5 < 40);
test('KD低檔金叉 ∧ 站上MA5 ∧ RSI10<30', s => s.kGold && s.k < 30 && s.aboveM5 && s.rsi10 < 30);
test('KD金叉 ∧ 均線金叉 ∧ RSI5<40', s => s.kGold && s.maGold && s.rsi5 < 40);
test('KD金叉 ∧ 站上MA5&MA10 ∧ RSI10>RSI5', s => s.kGold && s.aboveM5 && s.aboveM10 && s.rsi10 > s.rsi5);
test('KD金叉 ∧ 站上MA5 ∧ RSI5 40~70（中性位階）', s => s.kGold && s.aboveM5 && s.rsi5 >= 40 && s.rsi5 <= 70);
test('KD金叉 ∧ 站上MA5 ∧ RSI5<30 ∧ 空頭日', s => s.kGold && s.aboveM5 && s.rsi5 < 30 && s.bull === false);
test('KD金叉 ∧ 站上MA5 ∧ RSI5<30 ∧ vol20≥1.5%', s => s.kGold && s.aboveM5 && s.rsi5 < 30 && s.vol20 >= 1.5);

console.log(`\n${'═'.repeat(200)}\n══ ④ 反向（避開端）——合流的空頭版\n${'═'.repeat(200)}`);
test('KD死叉 ∧ 跌破MA5 ∧ RSI5>70', s => s.kDead && !s.aboveM5 && s.rsi5 > 70);
test('KD死叉 ∧ 均線死叉', s => s.kDead && s.maDead);
test('KD死叉 ∧ 跌破MA5&MA10', s => s.kDead && !s.aboveM5 && !s.aboveM10);

console.log(`\n${'═'.repeat(200)}\n══ ⑤ 增量：疊在現行 ⭐三重確認（RSI5<20 ∧ 法人買超 ∧ 量比>1.5 ∧ 空頭日 ∧ vol20≥1.5%）之上\n${'═'.repeat(200)}`);
const STAR = s => s.rsi5 < 20 && s.inst5Ratio != null && s.inst5Ratio > 0.05 && s.volX > 1.5 && s.bull === false && s.vol20 >= 1.5;
for (const [wn, w] of Object.entries(W)) {
  const b = w.filter(STAR);
  const half = g => [0, 1].map(h => { const x = g.filter(s => s.half === h); return x.length >= 20 ? r3(avg(x.map(s => s.net5))) : null; });
  console.log(`  【${wn}】⭐現行（含波動gate）：真起漲 ${pct(b, x => x.realStart)}%·5日均 ${r3(avg(b.map(x => x.net5)))}%·中位 ${med(b.map(x => x.net5))}%·淨勝 ${pct(b, x => x.net5 > 0)}%·兩半[${half(b).join('/')}]（n=${b.length.toLocaleString()}）`);
  for (const [lab, f] of [
    ['＋KD金叉', s => s.kGold], ['＋KD金叉或K上揚', s => s.kGold || s.kUp], ['＋K<30', s => s.k < 30],
    ['＋站上MA5', s => s.aboveM5], ['＋MA5上揚', s => s.m5Up], ['＋MA5>MA10', s => s.m5AboveM10],
    ['＋RSI10<25', s => s.rsi10 < 25], ['＋RSI10>RSI5', s => s.rsi10 > s.rsi5],
    ['＋KD金叉 ∧ 站上MA5', s => s.kGold && s.aboveM5],
  ]) {
    const g = b.filter(f);
    if (g.length < 50) { console.log(`    ${lab.padEnd(22)} 樣本不足 ${g.length}`); continue; }
    const dR = +(pct(g, x => x.realStart) - pct(b, x => x.realStart)).toFixed(1);
    const dM = r3(avg(g.map(x => x.net5)) - avg(b.map(x => x.net5)));
    console.log(`    ${lab.padEnd(22)} 真起漲${String(pct(g, x => x.realStart)).padStart(5)}%(Δ${String(dR).padStart(5)}pp) 均${String(r3(avg(g.map(x => x.net5)))).padStart(7)}%(Δ${String(dM).padStart(6)}) 中位${String(med(g.map(x => x.net5))).padStart(7)}% 淨勝${String(pct(g, x => x.net5 > 0)).padStart(5)}% 兩半[${half(g).join('/')}] 留存${String(pct(b, f)).padStart(5)}% n=${g.length}`);
  }
}

console.log(`\n${'═'.repeat(200)}`);
console.log(`過五關者：${passed.length ? passed.map(p => p.name).join('、') : '無'}`);
console.log('判準：①5日均與中位兩窗皆正 ②真起漲率兩窗皆高於基準 ③主窗兩半皆正 ④vol20五分層內效應仍在 ⑤樣本足夠。');
console.log('⚠本輪測 ~40 組，多重比較下偶然過關的機率不低——過關者仍須看增量段是否對現行 ⭐ 有加值才值得上線。非投資建議。');
process.exit(0);
