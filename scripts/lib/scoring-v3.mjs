// ─────────────────────────────────────────────────────────────────────────────
// 技術評分 v3（規範：docs/SCORING-SPEC-v3.md）——純函式：宇宙、子因子、橫斷面百分位、IC、總分。
//   days＝還原後「舊→新」[{ date, m:{code:[收,量(張),開,高,低]}, inst?:{code:[外資,投信,…](張)} }]
//   一律只用 ≤t 的資料（標籤函式另外取 t+1…，只供驗證）。
// ─────────────────────────────────────────────────────────────────────────────

export const V3_FACTORS = ['M', 'T', 'V', 'F', 'R'];
export const V3_FACTOR_LABEL = { M: '動能', T: '趨勢', V: '量能', F: '籌碼', R: '風險（越低越高分）' };

/** 可交易宇宙＋原始子因子；不在宇宙回 null */
export function rawFactors(days, t, code) {
  if (t < 60) return null;
  const row = days[t].m[code]; if (!row || !(row[0] >= 10)) return null;
  if (!/^\d{4}$/.test(code) || code.startsWith('00')) return null;
  const C = []; for (let k = 60; k >= 0; k--) { const v = days[t - k].m[code]?.[0]; if (!(v > 0)) return null; C.push(v); }
  const n = 60, last = C[n];
  const chg1 = (last / C[n - 1] - 1) * 100;
  if (Math.abs(chg1) >= 9.5) return null;                                   // 收在漲跌停附近：收盤價買不到／賣不掉
  let amt = 0, vs = 0, vk = 0;
  for (let k = 1; k <= 20; k++) { const r = days[t - k].m[code]; if (r?.[0] > 0) { amt += r[0] * (r[1] || 0) * 1000; vs += r[1] || 0; vk++; } }
  if (amt / 20 < 5e7) return null;                                           // 20 日均成交額 < 5,000 萬
  const avgVol = vk ? vs / vk : 0;
  const ma = k => C.slice(n - k + 1).reduce((a, b) => a + b, 0) / k;
  const ma20 = ma(20);
  const rets = []; for (let i = n - 19; i <= n; i++) rets.push(C[i] / C[i - 1] - 1);
  const mu = rets.reduce((a, b) => a + b, 0) / 20;
  const vol20 = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / 20) * 100;
  let up = 0, dn = 0; for (let i = n - 4; i <= n; i++) { const d = C[i] - C[i - 1]; d > 0 ? (up += d) : (dn -= d); }
  const rsi5 = up + dn > 0 ? (up / (up + dn)) * 100 : 50;
  let inst5 = null;
  if (days[t].inst) {
    let s = 0, have = 0;
    for (let k = 0; k < 5; k++) { const x = days[t - k].inst?.[code]; if (Array.isArray(x)) { s += (x[0] || 0) + (x[1] || 0); have++; } }
    if (have >= 3 && avgVol > 0) inst5 = (s * (5 / have)) / avgVol * 100;
  }
  return {
    chg1,
    r20: (last / C[n - 20] - 1) * 100, r60: (last / C[0] - 1) * 100,
    maAbove: [5, 20, 60].filter(k => last > ma(k)).length, dMa20: (last / ma20 - 1) * 100, brk20: last >= Math.max(...C.slice(n - 20, n)) ? 1 : 0,
    volX: avgVol > 0 ? (row[1] || 0) / avgVol : null,
    inst5,
    negVol20: -vol20, dd60: (last / Math.max(...C) - 1) * 100, negRsi5: -rsi5,
  };
}

export const SUB = { M: ['r20', 'r60'], T: ['maAbove', 'dMa20', 'brk20'], V: ['volX'], F: ['inst5'], R: ['negVol20', 'dd60', 'negRsi5'] };

/** 百分位（0–100，並列取平均名次）；null 值回 50（中性） */
export function pctRank(values) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => v != null && Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(50);
  const n = idx.length; if (n < 2) return out;
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const r = ((i + j) / 2) / (n - 1) * 100; for (let k = i; k <= j; k++) out[idx[k][1]] = r; i = j + 1; }
  return out;
}

/** 當日橫斷面：宇宙代號、各因子百分位、原始值 */
export function crossSection(days, t) {
  const codes = [], raws = [];
  for (const code in days[t].m) { const r = rawFactors(days, t, code); if (r) { codes.push(code); raws.push(r); } }
  const subPct = {}; for (const f of V3_FACTORS) for (const s of SUB[f]) subPct[s] = pctRank(raws.map(r => r[s]));
  const factors = {};
  for (const f of V3_FACTORS) factors[f] = codes.map((_, i) => SUB[f].reduce((a, s) => a + subPct[s][i], 0) / SUB[f].length);
  return { date: days[t].date, codes, raws, factors, subs: subPct };
}

/** 驗證標籤（原始報酬 %）：S＝隔日跳空、W5／W20＝D+1 開盤買、第 h 日收盤賣、I1＝D+1 盤中（收÷開，診斷用）；資料不足回 null */
export function labelsFor(days, t, code) {
  const c0 = days[t].m[code]?.[0], d1 = days[t + 1]?.m[code];
  const o1 = d1?.[2] > 0 ? d1[2] : null;                                   // 無開盤價不以收盤充數（口徑會變成收對收）
  const S = c0 > 0 && o1 > 0 ? (o1 / c0 - 1) * 100 : null;
  const W = h => { const x = days[t + h]?.m[code]?.[0]; return o1 > 0 && x > 0 ? (x / o1 - 1) * 100 : null; };
  return { S, W5: W(5), W20: W(20), I1: W(1) };
}

/** 超額：減當日宇宙等權平均（null 保持 null） */
export function excess(arr) {
  const v = arr.filter(x => x != null); if (!v.length) return arr.map(() => null);
  const mu = v.reduce((a, b) => a + b, 0) / v.length; return arr.map(x => (x == null ? null : x - mu));
}

/** Spearman（兩序列同長、略過任一為 null 的列） */
export function spearman(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 20) return null;
  const rx = pctRank(pairs.map(p => p[0])), ry = pctRank(pairs.map(p => p[1]));
  const n = rx.length, mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** 總分百分位：Σ w·P ÷ Σ|w| → 當日百分位 */
export function compositePct(factors, weights) {
  const n = factors.M.length; const tot = V3_FACTORS.reduce((a, f) => a + Math.abs(weights[f] || 0), 0);
  if (!tot) return new Array(n).fill(50);
  const raw = Array.from({ length: n }, (_, i) => V3_FACTORS.reduce((a, f) => a + (weights[f] || 0) * factors[f][i], 0) / tot);
  return pctRank(raw);
}

/** 平均與 t（樣本序列） */
export function meanT(xs) {
  const v = xs.filter(x => x != null && Number.isFinite(x)); const n = v.length; if (n < 3) return { n, mean: null, t: null };
  const m = v.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return { n, mean: m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : null };
}

/** 當日前 n 名（百分位高→低；同分依代號，結果穩定） */
export function topN(codes, pct, n = 20) {
  return codes.map((code, i) => ({ code, pct: pct[i] })).sort((a, b) => b.pct - a.pct || a.code.localeCompare(b.code)).slice(0, n);
}

/** 影子記分板（規範 §8）：逐日 [{date, v3, v2}]（同一標籤的超額 %）→ 平均、差值 95% CI、是否達「提請切換」條件 */
export function shadowBoard(rows, minDays = 20) {
  const both = rows.filter(r => Number.isFinite(r.v3) && Number.isFinite(r.v2));
  const n = both.length;
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!n) return { n: 0, v3: null, v2: null, diff: null, lo: null, hi: null, switchReady: false };
  const diffs = both.map(r => r.v3 - r.v2); const d = mean(diffs);
  const se = n > 1 ? Math.sqrt(diffs.reduce((a, x) => a + (x - d) ** 2, 0) / (n - 1) / n) : null;
  const v3 = mean(both.map(r => r.v3)), v2 = mean(both.map(r => r.v2));
  const lo = se != null ? d - 1.96 * se : null, hi = se != null ? d + 1.96 * se : null;
  const switchReady = n >= minDays && ((lo != null && lo > 0) || (v3 < 0 && v2 < 0 && v3 > v2));
  return { n, v3, v2, diff: d, lo, hi, switchReady };
}
