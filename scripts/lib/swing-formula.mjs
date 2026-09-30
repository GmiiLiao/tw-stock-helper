// ─────────────────────────────────────────────────────────────────────────────
// 波段選股公式（標靶公式：多頭／空頭兩組係數）——研究與影子模式共用的計算核心（2026-09-30 自 swing-formula-lab.mjs 抽出，邏輯不變）
//   研究：scripts/swing-formula-lab.mjs（滾動前進驗證）；影子：scripts/swing-formula-shadow.mjs（每日盤後記錄、前瞻對答案）。
//   兩邊必須用同一份計算，否則影子量到的不是研究驗證過的公式。
//   資料：chipArchive 逐日 closeJson {code:[收,量(張),開,高,低]}、instJson {code:[外資,投信](張)}、
//         marginJson {code:[融資餘額,融券餘額](張)}、dayTradeJson {code:當沖張數}（**只有上市**；上櫃無逐檔資料＝缺值）。
//   時點：特徵只用 t 日晚間已公布資料（法人 16:47、資券 21:30 後）；月營收 M 月自 M+1 月 11 日起才可用。
// ─────────────────────────────────────────────────────────────────────────────

export const LOOK = 60, LIMIT = 0.095, MIN_UNI = 100;
export const FEATS = [
  ['rev5', '5 日報酬（短期反轉）'], ['ovn20', '20 日隔夜報酬累計'], ['intra20', '20 日盤中報酬累計'], ['mom60_20', '中期動能（t−60→t−20）'],
  ['vol20', '20 日波動'], ['max20', '20 日最大單日漲幅'], ['hi60', '距 60 日高點'], ['dMa20', '距 20 日均線'],
  ['volX', '量比（今量÷20 日均量）'], ['liq', '流動性（20 日均額，對數）'], ['logP', '股價水準（對數）'], ['clv', '收盤在當日區間位置'],
  ['gap0', '今日跳空'], ['fi5', '外資 5 日買超÷均量'], ['fi20', '外資 20 日買超÷均量'], ['tr5', '投信 5 日買超÷均量'],
  ['tr20', '投信 20 日買超÷均量'], ['mgChg5', '融資 5 日增減÷均量'], ['mgLvl', '融資餘額÷均量'], ['shRatio', '券資比'],
  ['dt20', '20 日當沖比'], ['revYoY', '月營收年增率（已公布）'], ['revAcc', '營收年增加速（本月−前三月平均）'], ['indMom20', '同產業 20 日動能'],
];
export const BASE_P = FEATS.length;

export const mean = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };

/** 置中排名（−0.5~0.5，並列取平均；NaN→0＝中性） */
export function centeredRank(vals) {
  const idx = []; for (let i = 0; i < vals.length; i++) if (Number.isFinite(vals[i])) idx.push(i);
  idx.sort((a, b) => vals[a] - vals[b]);
  const out = new Float64Array(vals.length); const m = idx.length; if (m < 2) return out;
  for (let i = 0; i < m;) { let j = i; while (j + 1 < m && vals[idx[j + 1]] === vals[idx[i]]) j++; const r = (i + j) / 2 / (m - 1) - 0.5; for (let k = i; k <= j; k++) out[idx[k]] = r; i = j + 1; }
  return out;
}

/** 兩段式建陣列（避免同時持有上千日的解析物件）：先收代號，再逐日填入 Float64Array（索引 ci*N+t）；殘缺日（<1500 檔）略過 */
export function buildArrays(rows) {
  const codeIdx = new Map(), codes = [], good = [];
  for (const r of rows) {
    const m = JSON.parse(r.closeJson); if (Object.keys(m).length < 1500) continue; good.push(r);
    for (const c in m) if (/^\d{4}$/.test(c) && !c.startsWith('00') && !codeIdx.has(c)) { codeIdx.set(c, codes.length); codes.push(c); }
  }
  const N = good.length, K = codes.length, mk = () => new Float64Array(K * N).fill(NaN);
  const A = { cR: mk(), oR: mk(), hR: mk(), lR: mk(), v: mk(), fo: mk(), tr: mk(), mg: mk(), sh: mk(), dt: mk() };
  const put = (json, fn) => { if (!json) return; const o = JSON.parse(json); for (const c in o) { const ci = codeIdx.get(c); if (ci != null) fn(ci, o[c]); } };
  good.forEach((r, t) => {
    put(r.closeJson, (ci, x) => { const i = ci * N + t; if (x[0] > 0) A.cR[i] = x[0]; A.v[i] = x[1] || 0; if (x[2] > 0) A.oR[i] = x[2]; if (x[3] > 0) A.hR[i] = x[3]; if (x[4] > 0) A.lR[i] = x[4]; });
    put(r.instJson, (ci, x) => { if (Array.isArray(x)) { A.fo[ci * N + t] = x[0] || 0; A.tr[ci * N + t] = x[1] || 0; } });
    put(r.marginJson, (ci, x) => { if (Array.isArray(x)) { A.mg[ci * N + t] = x[0] || 0; A.sh[ci * N + t] = x[1] || 0; } });
    put(r.dayTradeJson, (ci, x) => { if (Number.isFinite(+x)) A.dt[ci * N + t] = +x; });
  });
  return { N, K, codes, codeIdx, dates: good.map(r => r.date), A };
}

/** 還原（事件日「之前」的價格 × factor；量不動）→ cA/oA/hA/lA；門檻另用未還原的 cR */
export function adjust({ N, codeIdx, dates, A }, items) {
  const cA = Float64Array.from(A.cR), oA = Float64Array.from(A.oR), hA = Float64Array.from(A.hR), lA = Float64Array.from(A.lR);
  for (const ev of items) {
    const ci = codeIdx.get(ev.code); if (ci == null || !(ev.factor > 0)) continue;
    let e = 0; while (e < N && dates[e] < ev.date) e++;
    for (let t = 0; t < e; t++) { const i = ci * N + t; cA[i] *= ev.factor; oA[i] *= ev.factor; hA[i] *= ev.factor; lA[i] *= ev.factor; }
  }
  return { cA, oA, hA, lA };
}

/** 月營收可用月份：M 月資料自 M+1 月 11 日起可用（法定 10 日前公告） */
export function revenueAvailFrom(month) {
  const [y, mo] = month.split('-').map(Number); const ny = mo === 12 ? y + 1 : y, nm = mo === 12 ? 1 : mo + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-11`;
}
/** revenueArchive 各月 → (日期) → (代號) → [年增率, 年增加速]；該日尚無可用月份回 null */
export function revenueIndex(rev) {
  const months = rev.map(r => r.month).sort();
  const yoy = Object.fromEntries(rev.map(r => [r.month, Object.fromEntries(JSON.parse(r.rowsJson || '[]').map(x => [x.c, x.yoy]))]));
  return date => {
    const ok = months.filter(m => revenueAvailFrom(m) <= date); if (!ok.length) return null;
    const M = ok.at(-1), prev = ok.slice(-4, -1);
    return code => {
      const y = yoy[M]?.[code]; if (!Number.isFinite(y)) return [NaN, NaN];
      const ps = prev.map(m => yoy[m]?.[code]).filter(Number.isFinite);
      return [y, ps.length === 3 ? y - ps.reduce((a, b) => a + b, 0) / 3 : NaN];
    };
  };
}

/** 可交易宇宙判斷與 24 特徵（原始值） */
export function makeFeatureFn(D, adj) {
  const { N, A } = D, { cA, oA, hA, lA } = adj;
  const inUniverse = (ci, t) => {
    if (t < LOOK) return false;
    const b = ci * N; if (!(A.cR[b + t] >= 10)) return false;
    for (let k = 0; k <= LOOK; k++) if (!(cA[b + t - k] > 0)) return false;
    if (Math.abs(cA[b + t] / cA[b + t - 1] - 1) >= LIMIT) return false;
    let amt = 0; for (let k = 1; k <= 20; k++) amt += A.cR[b + t - k] * (A.v[b + t - k] || 0) * 1000;
    return amt / 20 >= 5e7;
  };
  const sumN = (arr, b, t, n, minHave) => { let s = 0, h = 0; for (let k = 0; k < n; k++) { const x = arr[b + t - k]; if (Number.isFinite(x)) { s += x; h++; } } return h >= minHave ? (s * n) / h : NaN; };
  const feats = (ci, t, rev) => {
    const b = ci * N, C = k => cA[b + t - k], O = k => oA[b + t - k], f = new Array(BASE_P).fill(NaN);
    f[0] = C(0) / C(5) - 1;
    let ov = 0, id = 0, okO = true; for (let k = 0; k < 20; k++) { const o = O(k); if (!(o > 0)) { okO = false; break; } ov += Math.log(o / C(k + 1)); id += Math.log(C(k) / o); }
    if (okO) { f[1] = ov; f[2] = id; }
    f[3] = C(20) / C(60) - 1;
    let s = 0, s2 = 0, mx = -Infinity; for (let k = 0; k < 20; k++) { const r = C(k) / C(k + 1) - 1; s += r; s2 += r * r; if (r > mx) mx = r; }
    f[4] = Math.sqrt(Math.max(0, s2 / 20 - (s / 20) ** 2)); f[5] = mx;
    let hi = 0; for (let k = 0; k <= 60; k++) hi = Math.max(hi, C(k)); f[6] = C(0) / hi - 1;
    let ma = 0; for (let k = 0; k < 20; k++) ma += C(k); f[7] = C(0) / (ma / 20) - 1;
    let vs = 0, amt = 0; for (let k = 1; k <= 20; k++) { vs += A.v[b + t - k] || 0; amt += A.cR[b + t - k] * (A.v[b + t - k] || 0) * 1000; }
    const av = vs / 20;
    f[8] = av > 0 ? (A.v[b + t] || 0) / av : NaN; f[9] = Math.log(amt / 20); f[10] = Math.log(A.cR[b + t]);
    const H = hA[b + t], L = lA[b + t]; f[11] = H > 0 && L > 0 ? (H > L ? (C(0) - L) / (H - L) : 0.5) : NaN;
    f[12] = O(0) > 0 ? O(0) / C(1) - 1 : NaN;
    if (av > 0) { f[13] = sumN(A.fo, b, t, 5, 3) / av; f[14] = sumN(A.fo, b, t, 20, 12) / av; f[15] = sumN(A.tr, b, t, 5, 3) / av; f[16] = sumN(A.tr, b, t, 20, 12) / av; }
    const m0 = A.mg[b + t], m5 = A.mg[b + t - 5], s0 = A.sh[b + t];
    if (av > 0 && Number.isFinite(m0) && Number.isFinite(m5)) f[17] = (m0 - m5) / av;
    if (av > 0 && Number.isFinite(m0)) f[18] = m0 / av;
    if (m0 > 0 && Number.isFinite(s0)) f[19] = s0 / m0;
    let dts = 0, dth = 0, vv = 0; for (let k = 0; k < 20; k++) { const x = A.dt[b + t - k]; if (Number.isFinite(x)) { dts += x; dth++; vv += A.v[b + t - k] || 0; } }
    if (dth >= 12 && vv > 0) f[20] = dts / vv;
    if (rev) { const [y, acc] = rev(D.codes[ci]); f[21] = y; f[22] = acc; }
    return f;
  };
  return { inUniverse, feats };
}

/**
 * 單日橫斷面：宇宙（可排除代號，例如處置股）、24 特徵原始值 F、置中排名 X、同產業動能、市況（前 20 日宇宙等權報酬 >0＝多頭）。
 * 宇宙不足 MIN_UNI 檔回 null。
 */
export function daySection(D, adj, fn, t, rev, ind, exclude = null) {
  const { N, K } = D, { cA } = adj;
  const cis = []; for (let ci = 0; ci < K; ci++) if (!(exclude && exclude.has(D.codes[ci])) && fn.inUniverse(ci, t)) cis.push(ci);
  if (cis.length < MIN_UNI) return null;
  const F = cis.map(ci => fn.feats(ci, t, rev));
  // 同產業 20 日動能（等權、排除自己；同業 ≥3 檔）
  const r20 = cis.map(ci => cA[ci * N + t] / cA[ci * N + t - 20] - 1), g = {};
  cis.forEach((ci, k) => { const key = ind[D.codes[ci]]; if (key) { (g[key] ||= { s: 0, n: 0 }); g[key].s += r20[k]; g[key].n++; } });
  cis.forEach((ci, k) => { const x = g[ind[D.codes[ci]]]; F[k][23] = x && x.n >= 3 ? (x.s - r20[k]) / (x.n - 1) : NaN; });
  const X = FEATS.map((_, j) => centeredRank(F.map(f => f[j])));
  const bull = mean(r20) > 0;
  const up = mean(cis.map(ci => cA[ci * N + t] / cA[ci * N + t - 1] - 1)) > 0;
  return { cis, F, X, bull, up };
}

/** h 日超額標籤 %：D+1 開盤買、第 h 日收盤賣，減當日宇宙等權平均；D+1 開盤漲停（買不到）或未到期＝NaN */
export function labelsAt(D, adj, cis, t, h) {
  const { N } = D, { cA, oA } = adj;
  const raw = cis.map(ci => {
    if (t + h >= N) return NaN; const b = ci * N, o1 = oA[b + t + 1], ch = cA[b + t + h];
    if (!(o1 > 0) || !(ch > 0) || o1 / cA[b + t] - 1 >= LIMIT) return NaN;
    return (ch / o1 - 1) * 100;
  });
  const mu = mean(raw);
  return raw.map(x => (Number.isFinite(x) ? x - mu : NaN));
}

/** 分數＝Σ 係數 × 置中排名（係數 0／缺值略過） */
export function scoreWith(X, coef) {
  const n = X[0]?.length || 0, sc = new Float64Array(n);
  for (let j = 0; j < coef.length && j < X.length; j++) { const w = coef[j]; if (!w) continue; const col = X[j]; for (let i = 0; i < n; i++) sc[i] += w * col[i]; }
  return sc;
}
