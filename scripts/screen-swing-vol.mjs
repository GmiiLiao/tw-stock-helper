// ─────────────────────────────────────────────────────────────────────────
// 波段口徑（持有5日）× 波動 vol20 檢定 —— 2026-08-02
//
// 背景：vol20<1.5% 低波動避開已入**隔日沖**綜合評分（明開賣口徑·十分位兩窗
//   9/9 單調·24 個控制分層全同向）。使用者要求把它加入**波段操作技能**。
//
// 但本專案鐵律：**5 日持有語意與隔日沖口徑隔離**（SWING_SKILL 開頭就寫著
//   「隔日開賣 -0.06%／持有5日 +1.10%——edge 全在第5日」）。
//   同一個變數在兩個口徑可以完全相反，明開賣過關**不能**推論波段也過關。
//   故本輪用波段自己的口徑與自己的成功定義重驗。
//
// 口徑（與 screen-kd-confirm.mjs / SWING_SKILL 完全一致）：
//   進場＝今日收盤、出場＝第5日收盤、扣費稅 0.4425%
//   真起漲＝後5日最低 ≥ 今日最低 ∧ 後5日最高 ≥ 今日收盤×1.05
//   ⭐三重確認 BASE＝RSI5<20 ∧ 法人t-1買超(inst5Ratio>0.05) ∧ 量比>1.5 ∧ 空頭日
//
// 四段：
//   ① vol20 十分位 × 真起漲率／5日淨均／中位數（兩窗並列，看是否單調）
//   ② vol20 單獨過不過四道關卡（波段口徑）
//   ③ **增量**：疊在 ⭐三重確認 之上，能不能提升真起漲率與 5 日報酬
//   ④ 補做第一輪缺的：KD/MA 斜率候選在波段口徑下、**控制波動之後**還在不在
// 非投資建議。
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

/** vol20（20日日報酬標準差%）＋ MA20 斜率（%/日）＋ KD 斜率 */
function buildInd(days) {
  const st = {}, out = {};
  const P = 9;
  for (let i = 0; i < days.length; i++) {
    for (const c in days[i].close) {
      if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
      const r = days[i].close[c]; if (!r || r.length < 5) continue;
      const [cl, , , hi, lo] = r; if (!(cl > 0 && hi > 0 && lo > 0 && hi >= lo)) continue;
      const s = (st[c] ||= { cs: [], m20: [], k: 50, d: 50, hs: [], ls: [], kh: [] });
      s.cs.push(cl); if (s.cs.length > 60) s.cs.shift();
      s.hs.push(hi); s.ls.push(lo); if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
      if (s.hs.length === P) {
        const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
        const rsv = hn === ln ? 50 : ((cl - ln) / (hn - ln)) * 100;
        s.k = (s.k * 2) / 3 + rsv / 3; s.d = (s.d * 2) / 3 + s.k / 3;
      }
      if (s.cs.length < 21) { s.kh.push(s.k); if (s.kh.length > 20) s.kh.shift(); continue; }
      const w = s.cs.slice(-21), rt = [];
      for (let k = 1; k < w.length; k++) if (w[k - 1] > 0) rt.push((w[k] - w[k - 1]) / w[k - 1] * 100);
      const mu = rt.reduce((a, b) => a + b, 0) / rt.length;
      const vol20 = Math.sqrt(rt.reduce((a, b) => a + (b - mu) ** 2, 0) / rt.length);
      const m20 = s.cs.slice(-20).reduce((x, y) => x + y, 0) / 20;
      s.m20.push(m20); if (s.m20.length > 12) s.m20.shift();
      const rec = { vol20 };
      if (s.m20.length >= 11 && m20 > 0) rec.ma20Slope = slope(s.m20.slice(-11)) / m20 * 100;
      if (s.kh.length >= 4) rec.kSlope = slope([...s.kh.slice(-4), s.k]);
      out[`${i}_${c}`] = rec;
      s.kh.push(s.k); if (s.kh.length > 20) s.kh.shift();
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
  const uni = samples.filter(s => s.tradable && s.vol20 > 0 && s.rsi5 != null && s.fwdLo != null && s.net5 != null);
  for (const s of uni) {
    s.realStart = s.fwdLo >= s.l && s.fwdHi >= s.c * 1.05;
    s.willFall = s.fwdLo <= s.c * 0.95;
  }
  return uni;
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
for (const k in W) for (const s of W[k]) s._w = k;

const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };
const qcut = (w, f, qs) => { const v = w.map(f).filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b); return qs.map(q => v[Math.floor(v.length * q)]); };

// ── ① 十分位 ──────────────────────────────────────────────────────────
console.log('══ ① vol20 十分位 × 波段口徑（左=最低波動 → 右=最高波動）\n');
for (const [wn, w] of Object.entries(W)) {
  const cut = qcut(w, s => s.vol20, [.1, .2, .3, .4, .5, .6, .7, .8, .9]);
  const b = Array.from({ length: 10 }, () => []);
  for (const s of w) { let i = 0; while (i < 9 && s.vol20 >= cut[i]) i++; b[i].push(s); }
  console.log(`  【${wn}】基準：真起漲 ${pct(w, x => x.realStart)}%·5日均 ${r3(avg(w.map(x => x.net5)))}%·中位 ${med(w.map(x => x.net5))}%·淨勝 ${pct(w, x => x.net5 > 0)}%（n=${w.length.toLocaleString()}）`);
  console.log(`    真起漲%${b.map(x => String(pct(x, y => y.realStart)).padStart(7)).join('')}`);
  console.log(`    5日均  ${b.map(x => String(r3(avg(x.map(y => y.net5)))).padStart(7)).join('')}`);
  console.log(`    5日中位${b.map(x => String(med(x.map(y => y.net5))).padStart(7)).join('')}`);
  console.log(`    淨勝%  ${b.map(x => String(pct(x, y => y.net5 > 0)).padStart(7)).join('')}`);
}

// ── 四道關卡（波段口徑：均、中位、真起漲率同時看）──────────────────
function gauntlet(name, cond) {
  const r = Object.entries(W).map(([wn, w]) => {
    const sel = w.filter(cond);
    if (sel.length < 400) return { thin: true, n: sel.length, wn };
    const half = [0, 1].map(h => {
      const u = w.filter(s => s.half === h), g = u.filter(cond);
      return g.length >= 150 ? +(avg(g.map(s => s.net5)) - avg(u.map(s => s.net5))).toFixed(3) : null;
    });
    return {
      wn, n: sel.length,
      m: r3(avg(sel.map(s => s.net5))), md: med(sel.map(s => s.net5)),
      rs: pct(sel, x => x.realStart), bRs: pct(w, x => x.realStart),
      win: pct(sel, x => x.net5 > 0), half,
      same: half.every(v => v != null) && Math.sign(half[0]) === Math.sign(half[1]) && Math.min(...half.map(Math.abs)) >= 0.05,
    };
  });
  if (r.some(x => x.thin)) { console.log(`  ${name.padEnd(30)} 樣本不足（${r.map(x => `${x.wn}${x.n ?? 0}`).join('/')}）`); return false; }
  const [A, B] = r; const f = v => (v == null ? '  ---' : String(v).padStart(7));
  // 波段判準：均為正 ∧ 中位為正 ∧ 真起漲率高於基準 ∧ 兩半同向 ∧ OOT 同樣成立
  const ok = A.m > 0 && B.m > 0 && A.md > 0 && B.md > 0 && A.rs > A.bRs && B.rs > B.bRs && A.same;
  console.log(`  ${name.padEnd(30)} 主窗 真起漲${String(A.rs).padStart(5)}%(基${A.bRs}%) 均${f(A.m)} 中位${f(A.md)} 淨勝${String(A.win).padStart(5)}% 兩半[${f(A.half[0])}/${f(A.half[1])}]${A.same ? '✓' : '✗'}｜OOT 真起漲${String(B.rs).padStart(5)}%(基${B.bRs}%) 均${f(B.m)} 中位${f(B.md)} 淨勝${String(B.win).padStart(5)}%｜n=${A.n.toLocaleString()}/${B.n.toLocaleString()} ${ok ? '✅' : '❌'}`);
  return ok;
}

const CQ = {}; for (const k in W) CQ[k] = qcut(W[k], s => s.vol20, [.2, .4, .6, .8]);
const VQ = n => s => { const c = CQ[s._w]; return n === 1 ? s.vol20 < c[0] : n === 5 ? s.vol20 >= c[3] : s.vol20 >= c[n - 2] && s.vol20 < c[n - 1]; };

console.log('\n══ ② vol20 單獨（波段口徑四道關卡）\n');
for (let i = 1; i <= 5; i++) gauntlet(`vol20 第${i}五分位${i === 1 ? '(最低波動)' : i === 5 ? '(最高波動)' : ''}`, VQ(i));
gauntlet('vol20 < 1.5%（隔日沖採用門檻）', s => s.vol20 < 1.5);
gauntlet('vol20 > 4%（高波動）', s => s.vol20 > 4);

// ── ③ 增量：疊在 ⭐三重確認 之上 ──────────────────────────────────
const BASE = s => s.rsi5 < 20 && s.inst5Ratio != null && s.inst5Ratio > 0.05 && s.volX > 1.5 && s.bull === false;
console.log('\n══ ③ 增量：疊在 ⭐三重確認（RSI5<20 ∧ 法人買超 ∧ 量比>1.5 ∧ 空頭日）之上\n');
for (const [wn, w] of Object.entries(W)) {
  const b = w.filter(BASE);
  console.log(`  【${wn}】⭐基準組：真起漲 ${pct(b, x => x.realStart)}%·5日均 ${r3(avg(b.map(x => x.net5)))}%·中位 ${med(b.map(x => x.net5))}%·淨勝 ${pct(b, x => x.net5 > 0)}%（n=${b.length.toLocaleString()}）`);
  const cuts = qcut(b, s => s.vol20, [.25, .5, .75]);
  for (let t = 1; t <= 4; t++) {
    const g = b.filter(s => t === 1 ? s.vol20 < cuts[0] : t === 4 ? s.vol20 >= cuts[2] : t === 2 ? s.vol20 >= cuts[0] && s.vol20 < cuts[1] : s.vol20 >= cuts[1] && s.vol20 < cuts[2]);
    if (g.length < 60) { console.log(`    ⭐內 vol20 第${t}分位  樣本不足(${g.length})`); continue; }
    console.log(`    ⭐內 vol20 第${t}分位(${r3(t === 1 ? 0 : cuts[t - 2])}~${t === 4 ? '∞' : r3(cuts[t - 1])}%)  真起漲${String(pct(g, x => x.realStart)).padStart(5)}%  5日均${String(r3(avg(g.map(x => x.net5)))).padStart(7)}%  中位${String(med(g.map(x => x.net5))).padStart(7)}%  淨勝${String(pct(g, x => x.net5 > 0)).padStart(5)}%  n=${g.length.toLocaleString()}`);
  }
}
console.log('\n  ── 具體候選條件（要進技能必須兩窗都優於 ⭐基準組）──');
for (const [lab, extra] of [['⭐ ∧ vol20≥1.5%', s => s.vol20 >= 1.5], ['⭐ ∧ vol20≥2%', s => s.vol20 >= 2],
  ['⭐ ∧ vol20≥2.5%', s => s.vol20 >= 2.5], ['⭐ ∧ vol20≥3%', s => s.vol20 >= 3], ['⭐ ∧ vol20<1.5%（對照·應較差）', s => s.vol20 < 1.5]]) {
  const out = Object.entries(W).map(([wn, w]) => {
    const b = w.filter(BASE), g = b.filter(extra);
    if (g.length < 60) return `${wn} 樣本不足(${g.length})`;
    const dR = +(pct(g, x => x.realStart) - pct(b, x => x.realStart)).toFixed(1);
    const dM = r3(avg(g.map(x => x.net5)) - avg(b.map(x => x.net5)));
    return `${wn} 真起漲${String(pct(g, x => x.realStart)).padStart(5)}%(Δ${String(dR).padStart(5)}pp) 均${String(r3(avg(g.map(x => x.net5)))).padStart(6)}%(Δ${String(dM).padStart(6)}) 中位${String(med(g.map(x => x.net5))).padStart(6)}% 淨勝${String(pct(g, x => x.net5 > 0)).padStart(5)}% 留存${String(pct(b, extra)).padStart(5)}% n=${g.length}`;
  });
  console.log(`  ${lab.padEnd(24)} ${out.join('  ｜  ')}`);
}

// ── ④ KD/MA 斜率候選：波段口徑 ∧ 控制波動 ────────────────────────
console.log('\n══ ④ 第一輪缺的補測：KD/MA 斜率候選在波段口徑下、控制波動之後\n');
const MQ = {}; for (const k in W) MQ[k] = qcut(W[k], s => s.ma20Slope, [.25, .75]);
const MID = s => s.ma20Slope != null && s.ma20Slope >= MQ[s._w][0] && s.ma20Slope < MQ[s._w][1];
const DIV = s => s.kSlope != null && s.kSlope < 0 && s.ma20Slope != null && s.ma20Slope > 0;
for (const [nm, cond] of [['MA20斜率中間半(溫吞)', MID], ['背離格 KD↓×MA20↑', DIV],
  ['順勢格 KD↑×MA20↑', s => s.kSlope > 0 && s.ma20Slope > 0], ['雙弱格 KD↓×MA20↓', s => s.kSlope < 0 && s.ma20Slope < 0]]) {
  console.log(`  ── ${nm} ──`);
  gauntlet(`    未控制波動`, cond);
  for (let t = 1; t <= 5; t++) {
    const inT = VQ(t);
    const out = Object.entries(W).map(([wn, w]) => {
      const L = w.filter(inT), g = L.filter(cond);
      if (L.length < 2000 || g.length < 300) return `${wn} 不足`;
      return `${wn} 層內Δ均${String(r3(avg(g.map(s => s.net5)) - avg(L.map(s => s.net5)))).padStart(7)} Δ真起漲${String((pct(g, x => x.realStart) - pct(L, x => x.realStart)).toFixed(1)).padStart(5)}pp`;
    });
    console.log(`      波動第${t}五分位  ${out.join('  ｜  ')}`);
  }
}

// ── ⑤ 波段追強（強勢整理）母體：vol20 是否同樣成立 ────────────────
// 追強的母體是 RSI5 75~90 的強勢股，與 ⭐起漲（RSI5<20 跌深股）完全相反，
// 不可假設同樣成立——必須各測各的。
const STR = s => s.rsi5 >= 75 && s.rsi5 < 90 && s.rsi10 > s.rsi5 && s.inst5Ratio != null && s.inst5Ratio > 0.05;
console.log('\n══ ⑤ 波段追強（RSI5 75~90 ∧ RSI10>RSI5 ∧ 法人5日買超）母體上的 vol20\n');
for (const [wn, w] of Object.entries(W)) {
  const b = w.filter(STR);
  if (b.length < 100) { console.log(`  【${wn}】追強基準組樣本不足 ${b.length}`); continue; }
  const half = g => [0, 1].map(h => { const x = g.filter(s => s.half === h); return x.length >= 20 ? r3(avg(x.map(s => s.net5))) : null; });
  console.log(`  【${wn}】追強基準組：5日均 ${r3(avg(b.map(x => x.net5)))}%·中位 ${med(b.map(x => x.net5))}%·淨勝 ${pct(b, x => x.net5 > 0)}%·兩半[${half(b).join('/')}]（n=${b.length.toLocaleString()}）`);
  for (const [lab, f] of [['∧vol20≥1.5%', s => s.vol20 >= 1.5], ['∧vol20≥2%', s => s.vol20 >= 2], ['∧vol20<1.5%（對照）', s => s.vol20 < 1.5]]) {
    const g = b.filter(f);
    if (g.length < 60) { console.log(`    ${lab.padEnd(20)} 樣本不足 ${g.length}`); continue; }
    console.log(`    ${lab.padEnd(20)} 5日均${String(r3(avg(g.map(x => x.net5)))).padStart(7)}%(Δ${String(r3(avg(g.map(x => x.net5)) - avg(b.map(x => x.net5)))).padStart(6)}) 中位${String(med(g.map(x => x.net5))).padStart(7)}% 淨勝${String(pct(g, x => x.net5 > 0)).padStart(5)}% 兩半[${half(g).join('/')}] 留存${String(pct(b, f)).padStart(5)}% n=${g.length}`);
  }
}

console.log('\n判準（波段口徑）：5日均為正 ∧ 中位為正 ∧ 真起漲率高於基準 ∧ 主窗兩半同向 ∧ OOT 同樣成立。');
console.log('要疊進 ⭐三重確認：兩窗的真起漲率與 5 日均都必須優於 ⭐基準組，且留存率不能低到失去實用性。非投資建議。');
process.exit(0);
