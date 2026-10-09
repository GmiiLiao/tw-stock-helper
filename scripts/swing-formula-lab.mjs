#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 波段選股公式研究（2026-09-30 使用者：「請數學科學家協助精準算出能找到對答案時的正確股票的公式」）
//   唯讀研究：Firestore 歸檔（收盤／法人／資券／當沖）＋月營收歸檔＋官方除權息還原；不寫 Firestore、不動任何榜單。
//
//   【預先宣告——第一次執行前寫死，看到結果後不改（只修程式錯誤，且須在報告揭露）】
//   公式族：預期超額_i ＝ Σ_j β_j × R_j(i)。R_j＝特徵 j 當日橫斷面排名（−0.5~0.5，缺值 0）。
//   β：每日 Fama–MacBeth 橫斷面迴歸（y＝h 日超額的當日排名；小 ridge 只為數值穩定）的係數平均；
//      滾動前進：預測日 t 只用標籤已實現（s ≤ t−h）的日子；每 5 個交易日重估；最少 250 日才開始預測。
//      A＝係數平均；B＝係數 × max(0, 1−4/t²)（t＝Newey–West，lag h−1；|t|<2 歸零）。
//   試驗：h ∈ {5, 10, 20} × {A, B}＝6 組，全部列出、不另試。
//   通過（全部成立）：① 樣本外日 IC 平均>0 且 NW t≥3.0（Harvey–Liu–Zhu 2016；涵蓋 6 組多重檢定）；
//      ② D10−D1>0（整段，且每個樣本外 ≥60 日的年度）；③ 多頭日、空頭日 IC 皆>0；④ 安慰劑 |IC| < 真實÷3；
//      ⑤ 經濟：Top20（D+1 開盤漲停買不到者剔除、不遞補）平均超額 − 0.38%（2.8 折來回成本）> 0。
//   【修訂 2026-09-30（看過第一、二階段結果後，依使用者指示）】「計算結果不可扣成本的方式來比對——成本依持有方式
//      （當沖／隔日沖／波段天數）比例不同」⇒ ⑤ 取消，通過＝①~④；報告只列未扣成本的結果，成本另依持有方式列參考表。
//   宇宙：四碼普通股、t 日**實際**收盤≥10、20 日實際均額≥5,000 萬、近 60 日齊全、t 日未收在漲跌停（±9.5%）。
//   標籤：D+1 開盤買、第 h 個交易日收盤賣（與 AI 波段同口徑）；超額＝減當日宇宙等權平均。
//   時點：所有特徵只用 t 日晚間（法人 16:47、資券 21:30 後）已公布的資料；月營收 M 月自 M+1 月 11 日起才可用。
//   用法：LAB_CACHE=<快取檔> node scripts/swing-formula-lab.mjs [--refresh]
//   輸出：docs/SWING-FORMULA-RESEARCH-<資料日>.md
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mergeFactorItems } from './lib/exright-source.mjs';
import { LOOK, FEATS, BASE_P, mean, centeredRank, buildArrays, adjust, revenueIndex, makeFeatureFn, daySection, labelsAt } from './lib/swing-formula.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.LAB_CACHE || join(tmpdir(), 'swing-formula-lab-cache.ndjson');
const REFRESH = process.argv.includes('--refresh');
const MIN_TRAIN = 250, REFIT_EVERY = 5, HS = [5, 10, 20], TOP = 20, MIN_UNI = 100;   // 宇宙／特徵／標籤的常數與計算在 lib/swing-formula.mjs（與影子模式共用）
const T_GATE = 3.0, PLACEBO_N = 20;
// 成本參考（不作比對、不作門檻）：手續費 0.1425% 買賣各一次（2.8 折＝使用者券商）；證交稅賣出收：當沖 0.15%、其餘 0.3%
const FEE_PCT = 0.1425, FEE_DISC = 0.28;
const COST_STYLES = [['當沖（同日買賣）', 0.15, 0], ['隔日沖（持有 1 日）', 0.3, 1], ...HS.map(h => [`波段持有 ${h} 日`, 0.3, h])];
// 【第二階段預先宣告（2026-09-30 使用者問「是否用函數加乘提高準確率」；第一階段結果出來之前寫死）】
//   C＝24 特徵 ＋ 5 個有經濟意義的乘積項 ＋ 3 個平方項（兩端極端），B 版收縮；D＝24 特徵、依市況（前 20 日宇宙等權報酬 >0＝多頭）分開估係數，B 版收縮。
//   h ∈ {5,10,20} × {C,D}＝6 組；與第一階段合計 12 組（t≥3 仍高於 12 組 Bonferroni 的 2.87）。門檻與第一階段相同。
//   乘積理由：跌深×波動（反轉集中在高波動股）、中期動能×外資（有資訊的動能才延續）、跌深×外資短買（法人逢低承接）、
//            營收年增×中期動能（基本面與價格同向）、距高點×量比（帶量逼近高點）。平方：波動、量比、短期漲跌的「兩端」效應。
const STAGE2 = process.argv.includes('--stage2');
// 【第三階段預先宣告（2026-09-30 使用者提案「標靶公式：三種狀況各一條」；執行前寫死並 commit）】
//   多頭／空頭公式＝第二階段 D 的兩組係數（依前 20 日宇宙等權報酬自動切換）。第三條＝投機避開名單：
//   投機分數＝下列 6 特徵當日排名（−0.5~0.5）的**等權平均**（只平均有值者、至少 4 項；不調參數），最高 10% 列入避開。
//   門檻（h=5 為主，10／20 日並列）：① 每個 ≥60 日的年度，避開名單「超額>0」比例都低於全宇宙；② 避開名單平均超額 < 0 且 NW t ≤ −2。
//   另報（不作門檻）：D 的 Top20 與避開名單重疊比例；Top20 剔除避開名單後依序遞補的超額與勝率。
//   揭露：6 個特徵是看過第一階段結果後挑的（都屬「投機／受注目」一類），真正乾淨的考試仍是影子模式前瞻資料。
const STAGE3 = process.argv.includes('--stage3');
const SPEC = ['dt20', 'vol20', 'volX', 'gap0', 'ovn20', 'max20'], AVOID_FRAC = 0.10, SPEC_MIN = 4;
const INTERACT = [['rev5', 'vol20'], ['mom60_20', 'fi20'], ['rev5', 'fi5'], ['revYoY', 'mom60_20'], ['hi60', 'volX']];
const SQUARE = ['vol20', 'volX', 'rev5'];
const fIdx = k => FEATS.findIndex(f => f[0] === k);
const EXT = [...FEATS, ...INTERACT.map(([a, b]) => [`${a}×${b}`, `${FEATS[fIdx(a)][1]} × ${FEATS[fIdx(b)][1]}`]), ...SQUARE.map(a => [`${a}²`, `${FEATS[fIdx(a)][1]}（平方＝兩端）`])];

// ── 資料 ──────────────────────────────────────────────────────────────────
function initDb() {
  if (!getApps().length) { const p = process.env.GOOGLE_APPLICATION_CREDENTIALS; initializeApp(p ? { credential: cert(JSON.parse(readFileSync(p, 'utf8'))) } : {}); }
  return getFirestore();
}
// 產業別：先用站上自家分群 peerComps/latest（不打上游；名稱與 TWSE 產業別同一套），不足 1000 檔才試 openapi（失敗不中止）
async function fetchIndustry(db) {
  const map = {};
  try {
    const pc = (await db.collection('peerComps').doc('latest').get()).data();
    const ind = pc?.industriesJson ? JSON.parse(pc.industriesJson) : {};
    // 只取上市（2026-10-04 peerComps 起含上櫃、每列帶 mkt）：與影子模式同一口徑；要納入上櫃需整套重研究＋使用者核可
    for (const g in ind) for (const it of ind[g] || []) if (/^\d{4}$/.test(it?.code || '') && (it.mkt ?? '上市') === '上市' && !map[it.code]) map[it.code] = g;
  } catch (e) { console.log('⚠ peerComps 產業分群讀取失敗:', (e.message || '').slice(0, 60)); }
  if (Object.keys(map).length >= 1000) return map;
  for (const ep of ['t187ap03_L', 't187ap03_O']) {
    try {
      const r = await fetch(`https://openapi.twse.com.tw/v1/opendata/${ep}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
      const j = r.ok ? JSON.parse(await r.text()) : [];
      for (const x of j) { const c = String(x['公司代號'] || '').trim(), ind = String(x['產業別'] || '').trim(); if (/^\d{4}$/.test(c) && ind && !map[c]) map[c] = ind; }
    } catch (e) { console.log(`⚠ 產業別 ${ep} 取不到（${(e.message || '').slice(0, 40)}），同產業動能以現有 ${Object.keys(map).length} 檔計`); }
    await new Promise(res => setTimeout(res, 2000));
  }
  return map;
}
async function loadRows() {
  if (!REFRESH && existsSync(CACHE)) return readFileSync(CACHE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const db = initDb();
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(1100).select('date', 'closeJson', 'instJson', 'marginJson', 'dayTradeJson').get();
  const rows = snap.docs.map(d => d.data()).filter(a => a?.closeJson).reverse();
  const rev = (await db.collection('revenueArchive').get()).docs.map(d => ({ month: d.id, rowsJson: d.data().rowsJson }));
  const pe = (await db.collection('priceEvents').doc('latest').get()).data()?.items || [];
  const meta = { kind: 'meta', rev, pe, ind: await fetchIndustry(db) };
  console.log(`產業別 ${Object.keys(meta.ind).length} 檔、月營收 ${rev.length} 個月、歸檔 ${rows.length} 日`);
  writeFileSync(CACHE, [JSON.stringify(meta), ...rows.map(r => JSON.stringify(r))].join('\n'));
  return [meta, ...rows];
}

// ── 數學工具 ──────────────────────────────────────────────────────────────
/** Pearson（xs、ys 同長，只取 ys 有值者；用在排名上＝Spearman） */
function corr(xs, ys) {
  let n = 0, sx = 0, sy = 0; for (let i = 0; i < xs.length; i++) if (Number.isFinite(ys[i])) { n++; sx += xs[i]; sy += ys[i]; }
  if (n < 20) return NaN; const mx = sx / n, my = sy / n; let a = 0, bx = 0, by = 0;
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(ys[i])) { const dx = xs[i] - mx, dy = ys[i] - my; a += dx * dy; bx += dx * dx; by += dy * dy; }
  return bx > 0 && by > 0 ? a / Math.sqrt(bx * by) : NaN;
}
/** Spearman：只取 x、y 皆有值的列，於該子集內重新排名 */
function rankIC(x, y) {
  const xs = [], ys = []; for (let i = 0; i < y.length; i++) if (Number.isFinite(y[i]) && Number.isFinite(x[i])) { xs.push(x[i]); ys.push(y[i]); }
  return xs.length < 20 ? NaN : corr(centeredRank(xs), centeredRank(ys));
}
/** 對稱正定解（Cholesky）：(M + λI) x = v */
function cholSolve(M, v, lambda) {
  const p = v.length, L = Array.from({ length: p }, () => new Float64Array(p));
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) {
    let s = M[i][j] + (i === j ? lambda : 0); for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
  }
  const y = new Float64Array(p); for (let i = 0; i < p; i++) { let s = v[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  const x = new Float64Array(p); for (let i = p - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < p; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}
/** 單日 Fama–MacBeth：X 為 p 條置中排名、y 為置中排名（NaN 列略過）；欄位於有效列上再置中 */
function fmDay(X, y) {
  const rows = []; for (let i = 0; i < y.length; i++) if (Number.isFinite(y[i])) rows.push(i);
  if (rows.length < MIN_UNI) return null;
  const mu = X.map(col => rows.reduce((a, i) => a + col[i], 0) / rows.length), my = rows.reduce((a, i) => a + y[i], 0) / rows.length;
  const P = X.length, M = Array.from({ length: P }, () => new Float64Array(P)), v = new Float64Array(P);
  for (const i of rows) { const yi = y[i] - my; for (let a = 0; a < P; a++) { const xa = X[a][i] - mu[a]; v[a] += xa * yi; for (let c = 0; c <= a; c++) M[a][c] += xa * (X[c][i] - mu[c]); } }
  for (let a = 0; a < P; a++) for (let c = 0; c < a; c++) M[c][a] = M[a][c];
  return cholSolve(M, v, 1e-3 * rows.length);
}
/** 平均與 Newey–West t（lag L，Bartlett 權） */
function nwT(xs, L) {
  const v = xs.filter(Number.isFinite), n = v.length; if (n < 10) return { n, mean: NaN, t: NaN };
  const m = v.reduce((a, b) => a + b, 0) / n; const g = l => { let s = 0; for (let i = l; i < n; i++) s += (v[i] - m) * (v[i - l] - m); return s / n; };
  let s2 = g(0); for (let l = 1; l <= L; l++) s2 += 2 * (1 - l / (L + 1)) * g(l);
  return { n, mean: m, t: s2 > 0 ? m / Math.sqrt(s2 / n) : NaN };
}
function prng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }
const f2 = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

// ── 面板：每日宇宙、特徵排名、各期標籤 ─────────────────────────────────────
function buildPanel(D, adj, revAt, ind) {
  const fn = makeFeatureFn(D, adj), panel = [];
  for (let t = LOOK; t < D.N - 1; t++) {
    const sec = daySection(D, adj, fn, t, revAt(D.dates[t]), ind); if (!sec) continue;
    const { cis, F, X, bull, up } = sec;
    if (STAGE2) {
      for (const [a, b2] of INTERACT) { const xa = X[fIdx(a)], xb = X[fIdx(b2)]; X.push(centeredRank(xa.map((v, i) => v * xb[i]))); }
      for (const a of SQUARE) { const xa = X[fIdx(a)]; X.push(centeredRank(xa.map(v => v * v))); }
    }
    let spec = null;
    if (STAGE3) {   // 投機分數：6 特徵排名等權平均（只平均有值者，≥4 項）
      const js = SPEC.map(k => fIdx(k));
      spec = Float64Array.from(cis, (_, i) => { const v = js.filter(j => Number.isFinite(F[i][j])).map(j => X[j][i]); return v.length >= SPEC_MIN ? v.reduce((a, b) => a + b, 0) / v.length : NaN; });
    }
    const Y = {}, YR = {};
    for (const h of HS) { Y[h] = labelsAt(D, adj, cis, t, h); YR[h] = centeredRankKeepNaN(Y[h]); }
    panel.push({ t, date: D.dates[t], n: cis.length, X, Y, YR, up, bull, spec, miss: FEATS.map((_, j) => F.filter(f => !Number.isFinite(f[j])).length / F.length) });
  }
  return panel;
}
function centeredRankKeepNaN(vals) { const r = centeredRank(vals); return Array.from(vals, (v, i) => (Number.isFinite(v) ? r[i] : NaN)); }

// ── 滾動前進：每 5 日以「標籤已實現」的歷史係數重估，預測下一段 ─────────────────
// regime=true：多頭／空頭日各自只用同市況的歷史日估係數（第二階段 D；各需 ≥120 日）
function walkForward(panel, h, regime = false) {
  const B = panel.map(p => fmDay(p.X, p.YR[h]));
  const preds = { A: new Array(panel.length).fill(null), B: new Array(panel.length).fill(null) };
  const groupOf = k => (regime ? (panel[k].bull ? 'bull' : 'bear') : 'all');
  const fitOf = train => {
    const st = panel[0].X.map((_, j) => nwT(train.map(b => b[j]), h - 1));
    return { A: st.map(x => x.mean), B: st.map(x => x.mean * Math.max(0, 1 - 4 / (x.t * x.t || Infinity))) };
  };
  let fits = {};
  for (let k = 0; k < panel.length; k++) {
    if (k % REFIT_EVERY === 0) {
      const tNow = panel[k].t; const train = []; for (let s = 0; s < k; s++) if (B[s] && panel[s].t + h <= tNow) train.push(s);
      if (train.length >= MIN_TRAIN) {
        fits = {};
        for (const g of regime ? ['bull', 'bear'] : ['all']) {
          const sub = train.filter(s => groupOf(s) === g || g === 'all');
          if (sub.length >= (regime ? 120 : MIN_TRAIN)) fits[g] = fitOf(sub.map(s => B[s]));
        }
      }
    }
    const fit = fits[groupOf(k)]; if (!fit) continue;
    for (const v of ['A', 'B']) { const w = fit[v]; const X = panel[k].X; const n = panel[k].n; const sc = new Float64Array(n); for (let j = 0; j < w.length; j++) { const wj = w[j]; if (!wj) continue; const col = X[j]; for (let i = 0; i < n; i++) sc[i] += wj * col[i]; } preds[v][k] = sc; }
  }
  // 現行公式：用到最後一日為止「標籤已實現」的全部日子估一次（報告列出；不參與樣本外評估）
  const tLast = panel.at(-1).t, realized = []; for (let s = 0; s < panel.length; s++) if (B[s] && panel[s].t + h <= tLast) realized.push(s);
  const final = {};
  for (const g of regime ? ['bull', 'bear'] : ['all']) { const sub = realized.filter(s => g === 'all' || groupOf(s) === g); if (sub.length >= (regime ? 120 : MIN_TRAIN)) final[g] = fitOf(sub.map(s => B[s])); }
  return { B, preds, final };
}

// ── 評估 ──────────────────────────────────────────────────────────────────
function evaluate(panel, preds, h) {
  const days = []; const rnd = prng(20260930);
  for (let k = 0; k < panel.length; k++) {
    const sc = preds[k], y = panel[k].Y[h]; if (!sc || !y.some(Number.isFinite)) continue;
    const ic = rankIC(sc, y);
    const order = Array.from(sc.keys()).sort((a, b) => sc[b] - sc[a]);
    const top = order.slice(0, TOP).map(i => y[i]).filter(Number.isFinite);
    const n = sc.length, dec = new Array(10).fill(0), cnt = new Array(10).fill(0);
    order.forEach((i, r) => { if (!Number.isFinite(y[i])) return; const d = 9 - Math.min(9, Math.floor((r / n) * 10)); dec[d] += y[i]; cnt[d]++; });
    const decile = dec.map((s, d) => (cnt[d] ? s / cnt[d] : NaN));
    const placebo = []; for (let q = 0; q < PLACEBO_N; q++) { const yy = y.slice(); for (let i = yy.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [yy[i], yy[j]] = [yy[j], yy[i]]; } placebo.push(rankIC(sc, yy)); }
    const uniHit = y.filter(Number.isFinite);
    const ySd = Math.sqrt(uniHit.reduce((a, x) => a + x * x, 0) / uniHit.length);   // 超額已去平均
    days.push({ date: panel[k].date, up: panel[k].up, ic, top: mean(top), topHit: top.filter(x => x > 0).length / (top.length || NaN), topN: top.length,
      uniHit: uniHit.filter(x => x > 0).length / uniHit.length, ySd, decile, spread: decile[9] - decile[0], placebo });
  }
  const L = h - 1, s = nwT(days.map(d => d.ic), L);
  const years = {}; for (const d of days) (years[d.date.slice(0, 4)] ||= []).push(d);
  const byYear = Object.fromEntries(Object.entries(years).map(([y, ds]) => [y, { n: ds.length, ic: mean(ds.map(d => d.ic)), spread: mean(ds.map(d => d.spread)), top: mean(ds.map(d => d.top)) }]));
  const placeboAbs = mean(Array.from({ length: PLACEBO_N }, (_, q) => Math.abs(mean(days.map(d => d.placebo[q])))));
  const upIC = mean(days.filter(d => d.up).map(d => d.ic)), dnIC = mean(days.filter(d => !d.up).map(d => d.ic));
  const spread = mean(days.map(d => d.spread)), top = mean(days.map(d => d.top));
  const gates = {
    ic: s.mean > 0 && s.t >= T_GATE,
    spread: spread > 0 && Object.values(byYear).every(y => y.n < 60 || y.spread > 0),
    regime: upIC > 0 && dnIC > 0,
    placebo: s.mean > 0 && placeboAbs < s.mean / 3,
  };
  return { n: days.length, from: days[0]?.date, to: days.at(-1)?.date, ic: s.mean, t: s.t, spread, top,
    topHit: mean(days.map(d => d.topHit)), uniHit: mean(days.map(d => d.uniHit)), topN: mean(days.map(d => d.topN)), ySd: mean(days.map(d => d.ySd)),
    decile: Array.from({ length: 10 }, (_, j) => mean(days.map(d => d.decile[j]))), upIC, dnIC, placeboAbs, byYear, gates, passed: Object.values(gates).every(Boolean) };
}

// ── 第三階段：投機避開名單（等權、不調參）＋與 D 公式 Top20 的關係 ─────────────────
const median = xs => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
function avoidOf(p) {
  const idx = []; for (let i = 0; i < p.n; i++) if (Number.isFinite(p.spec?.[i])) idx.push(i);
  idx.sort((a, b) => p.spec[b] - p.spec[a]);
  return new Set(idx.slice(0, Math.max(1, Math.round(idx.length * AVOID_FRAC))));
}
function evaluateAvoid(h) {
  const days = [];
  for (const p of panel) {
    const y = p.Y[h]; if (!p.spec || !y.some(Number.isFinite)) continue;
    const av = [...avoidOf(p)].map(i => y[i]).filter(Number.isFinite), uni = y.filter(Number.isFinite);
    if (av.length < 10) continue;
    days.push({ date: p.date, ex: mean(av), med: median(av), hit: av.filter(x => x > 0).length / av.length, uniHit: uni.filter(x => x > 0).length / uni.length });
  }
  const s = nwT(days.map(d => d.ex), h - 1), years = {};
  for (const d of days) (years[d.date.slice(0, 4)] ||= []).push(d);
  const byYear = Object.fromEntries(Object.entries(years).map(([y, ds]) => [y, { n: ds.length, ex: mean(ds.map(d => d.ex)), med: mean(ds.map(d => d.med)), hit: mean(ds.map(d => d.hit)), uniHit: mean(ds.map(d => d.uniHit)) }]));
  const gates = { hit: Object.values(byYear).every(y => y.n < 60 || y.hit < y.uniHit), mean: s.mean < 0 && s.t <= -2 };
  return { h, n: days.length, ex: s.mean, t: s.t, med: mean(days.map(d => d.med)), hit: mean(days.map(d => d.hit)), uniHit: mean(days.map(d => d.uniHit)), byYear, gates, passed: gates.hit && gates.mean };
}
function runStage3() {
  const res = HS.map(evaluateAvoid);
  for (const r of res) console.log(`避開名單 h=${r.h}：${r.passed ? '✅' : '❌'} 平均超額 ${f2(r.ex)}%（t ${f2(r.t)}）中位 ${f2(r.med)}%｜勝率 ${f2(r.hit * 100, 1)}% vs 宇宙 ${f2(r.uniHit * 100, 1)}%｜${JSON.stringify(r.gates)}`);
  // D（5 日、市況分組）Top20 與避開名單
  const basePanel = panel.map(p => ({ ...p, X: p.X.slice(0, BASE_P) }));
  const d = walkForward(basePanel, 5, true); const rows = [];
  panel.forEach((p, k) => {
    const sc = d.preds.B[k], y = p.Y[5]; if (!sc || !p.spec) return;
    const order = Array.from(sc.keys()).sort((a, b) => sc[b] - sc[a]), avoid = avoidOf(p);
    const top = order.slice(0, TOP), clean = order.filter(i => !avoid.has(i)).slice(0, TOP);
    const v = ids => ids.map(i => y[i]).filter(Number.isFinite);
    rows.push({ overlap: top.filter(i => avoid.has(i)).length / TOP, top: mean(v(top)), clean: mean(v(clean)), topHit: mean(v(top).map(x => (x > 0 ? 1 : 0))), cleanHit: mean(v(clean).map(x => (x > 0 ? 1 : 0))) });
  });
  const dx = { n: rows.length, overlap: mean(rows.map(r => r.overlap)), top: mean(rows.map(r => r.top)), clean: mean(rows.map(r => r.clean)), topHit: mean(rows.map(r => r.topHit)), cleanHit: mean(rows.map(r => r.cleanHit)) };
  console.log(`D Top20：重疊避開名單 ${f2(dx.overlap * 100, 1)}%｜原 ${f2(dx.top)}%／勝率 ${f2(dx.topHit * 100, 1)}% → 剔除遞補 ${f2(dx.clean)}%／${f2(dx.cleanHit * 100, 1)}%（${dx.n} 日）`);
  const L = [`# 標靶公式·第三條：投機避開名單（資料日 ${D.dates.at(-1)}）`, '',
    '> 使用者提案（2026-09-30）：多頭、空頭、投機三種狀況各一條公式。多頭／空頭＝第二階段 D 的兩組係數；本報告驗證第三條。規則與門檻在執行前寫死並 commit；未扣成本。', '',
    `- 投機分數＝${SPEC.join('、')} 當日排名的等權平均（只平均有值者、至少 ${SPEC_MIN} 項；上櫃無逐檔當沖資料＝當沖比缺值）；最高 ${AVOID_FRAC * 100}% 列入避開。`,
    '- 門檻：① 每個 ≥60 日的年度，避開名單「超額>0」比例都低於全宇宙；② 平均超額 < 0 且 NW t ≤ −2。', '',
    '| 持有 | 日數 | 平均超額 % | NW t | 中位超額 % | 避開名單勝率 | 宇宙勝率 | 結果 |', '|---|---|---|---|---|---|---|---|',
    ...res.map(r => `| ${r.h} 日 | ${r.n} | ${f2(r.ex)} | ${f2(r.t)} | ${f2(r.med)} | ${f2(r.hit * 100, 1)}% | ${f2(r.uniHit * 100, 1)}% | ${r.passed ? '✅ 通過' : `❌ ${Object.entries(r.gates).filter(([, v]) => !v).map(([g]) => (g === 'hit' ? '勝率未每年低於宇宙' : '平均超額不顯著為負')).join('、')}`} |`),
    '', '### 各年度', '', '| 持有 | 年 | 日數 | 平均超額 % | 中位超額 % | 避開名單勝率 | 宇宙勝率 |', '|---|---|---|---|---|---|---|',
    ...res.flatMap(r => Object.entries(r.byYear).map(([y, x]) => `| ${r.h} 日 | ${y} | ${x.n} | ${f2(x.ex)} | ${f2(x.med)} | ${f2(x.hit * 100, 1)}% | ${f2(x.uniHit * 100, 1)}% |`)),
    '', '### 與多空公式（D·5 日）的關係（樣本外，不作門檻）', '',
    `- D 的 Top20 平均有 ${f2(dx.overlap * 100, 1)}% 落在避開名單（${dx.n} 日）。`,
    `- 原 Top20：平均超額 ${f2(dx.top)}%、勝率 ${f2(dx.topHit * 100, 1)}%；剔除避開名單後依序遞補：${f2(dx.clean)}%、${f2(dx.cleanHit * 100, 1)}%。`,
    '', '- 揭露：6 個特徵是看過第一階段結果後挑選的「投機／受注目」類特徵；等權、不調參可降低過度擬合，但真正乾淨的考試只有影子模式的前瞻資料。', '', '非投資建議。', ''];
  writeFileSync(join(ROOT, 'docs', `SWING-FORMULA-RESEARCH-${D.dates.at(-1)}-stage3.md`), L.join('\n'));
  console.log(`✓ docs/SWING-FORMULA-RESEARCH-${D.dates.at(-1)}-stage3.md`);
}

// ── 全樣本特徵表（描述用；不作門檻）────────────────────────────────────────
function featureTable(panel, B, h, list = FEATS) {
  return list.map(([key, label], j) => {
    const coef = nwT(B.filter(Boolean).map(b => b[j]), h - 1);
    const ic = nwT(panel.map(p => rankIC(p.X[j], p.Y[h])), h - 1);
    return { key, label, coef: coef.mean, coefT: coef.t, ic: ic.mean, icT: ic.t, miss: mean(panel.map(p => p.miss[j])) };
  });
}

// ── 報告 ──────────────────────────────────────────────────────────────────
const GATE_NAME = { ic: 'IC 且 NW t≥3', spread: 'D10−D1（整段＋各年）', regime: '多空日皆正', placebo: '安慰劑' };
function render(R) {
  const L = [`# 波段選股公式研究${R.stage2 ? '·第二階段（函數與乘積項、市況分組）' : ''}（資料日 ${R.dataDate}）`, '',
    `> 產生：\`node scripts/swing-formula-lab.mjs\`（唯讀）。方法與門檻在第一次執行前寫死於腳本開頭；本報告列出全部 ${R.results.length} 組試驗，沒有另外試過的組合。`, '',
    '## 結論', ''];
  const pass = R.results.filter(r => r.ev.passed);
  L.push(pass.length ? `- **通過全部預先宣告門檻：${pass.map(r => `h=${r.h}／${r.v}`).join('、')}**——可提請進入影子模式做前瞻驗證（歷史通過不等於未來有效）。`
    : `- **${R.results.length} 組都沒有通過全部門檻**——在這批資料與特徵下，找不到統計上站得住、扣成本後仍賺錢的波段選股公式。`);
  L.push(`- 資料：${R.nDays} 個交易日（${R.range.join(' ~ ')}），每日可交易宇宙平均 ${f2(R.avgUni, 0)} 檔；產業別 ${R.indN} 檔；樣本外（滾動前進）自 ${R.results[0]?.ev.from} 起。`);
  L.push(`- 「對答案」基準：隨便挑一檔，h 日超額為正的機率只有 ${R.results.map(r => `h=${r.h} ${f2(r.ev.uniHit * 100, 1)}%`).filter((_, i) => i % 2 === 0).join('、')}（報酬右偏，多數股票低於平均）。`, '');
  L.push(`## ${R.results.length} 組試驗（樣本外，滾動前進）`, '', '| h | 版本 | 日數 | IC | NW t | D10−D1 % | 超額σ % | Top20 超額 % | Top20 勝率 | 宇宙勝率 | 多頭日 IC | 空頭日 IC | 安慰劑 | 未過門檻 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of R.results) {
    const e = r.ev;
    L.push(`| ${r.h} | ${r.v} | ${e.n} | ${f2(e.ic, 4)} | ${f2(e.t)} | ${f2(e.spread)} | ${f2(e.ySd)} | ${f2(e.top)} | ${f2(e.topHit * 100, 1)}% | ${f2(e.uniHit * 100, 1)}% | ${f2(e.upIC, 4)} | ${f2(e.dnIC, 4)} | ${f2(e.placeboAbs, 4)} | ${Object.entries(e.gates).filter(([, v]) => !v).map(([g]) => GATE_NAME[g]).join('、') || '—'} |`);
  }
  L.push('', '> 全部為**未扣成本**的結果（使用者規則：成本依持有方式而異，不以扣成本方式比對）。成本換算見文末參考表。');
  L.push('', '### 各年度（樣本外）', '', '| h | 版本 | 年 | 日數 | IC | D10−D1 % | Top20 超額 % |', '|---|---|---|---|---|---|---|');
  for (const r of R.results) for (const [y, x] of Object.entries(r.ev.byYear)) L.push(`| ${r.h} | ${r.v} | ${y} | ${x.n} | ${f2(x.ic, 4)} | ${f2(x.spread)} | ${f2(x.top)} |`);
  L.push('', '### 十分位平均超額（%，樣本外；D1 最弱 → D10 最強）', '', '| h | 版本 | ' + Array.from({ length: 10 }, (_, d) => `D${d + 1}`).join(' | ') + ' |', '|---|---|' + '---|'.repeat(10));
  for (const r of R.results) L.push(`| ${r.h} | ${r.v} | ${r.ev.decile.map(x => f2(x)).join(' | ')} |`);
  // 現行公式係數：通過者全列；都沒通過則列 5 日 B／D 供參考
  const shown = R.results.filter(r => r.ev.passed);
  const GROUP_NAME = { all: '係數', bull: '多頭時係數', bear: '空頭時係數' };
  L.push('', '## 現行公式係數（全部已實現資料估計；B 版收縮後；特徵先換成當日排名 −0.5~0.5）', '');
  for (const r of (shown.length ? shown : R.results.filter(x => x.h === 5 && (x.v === 'B' || x.v === 'D')))) {
    const groups = Object.keys(r.coef || {}).filter(g => r.coef[g]?.length);
    if (!groups.length) continue;
    const idx = r.names.map((_, j) => j).filter(j => groups.some(g => r.coef[g][j]))
      .sort((p, q) => Math.max(...groups.map(g => Math.abs(r.coef[g][q] || 0))) - Math.max(...groups.map(g => Math.abs(r.coef[g][p] || 0))));
    L.push(`### h=${r.h}／${r.v}${r.ev.passed ? '（通過）' : '（未通過，僅供參考）'}`, '', `| 特徵 | 說明 | ${groups.map(g => GROUP_NAME[g]).join(' | ')} |`, `|---|---|${groups.map(() => '---|').join('')}`);
    for (const j of idx) L.push(`| ${r.names[j][0]} | ${r.names[j][1]} | ${groups.map(g => f2(r.coef[g][j], 4)).join(' | ')} |`);
    L.push('', `用法：每個特徵在當日可交易宇宙中排名、換成 −0.5~0.5；分數＝Σ 係數 × 排名${groups.length > 1 ? '（前 20 日宇宙等權報酬 >0 用多頭係數，否則用空頭係數）' : ''}；分數越高＝預期 ${r.h} 日超額越高。係數 0＝統計上不顯著（|t|<2）而被收縮掉。`, '');
  }
  for (const h of HS) {
    L.push('', `## 特徵（全樣本描述，h=${h}；非門檻，|t|≥3.4 才算穩健（多項同時檢定的 Bonferroni））`, '', '| 特徵 | 說明 | 單變量 IC | t | 多變量係數 | t | 缺值 |', '|---|---|---|---|---|---|---|');
    for (const x of R.feat[h]) L.push(`| ${x.key} | ${x.label} | ${f2(x.ic, 4)} | ${f2(x.icT)}${Math.abs(x.icT) >= 3.4 ? ' ★' : ''} | ${f2(x.coef, 4)} | ${f2(x.coefT)}${Math.abs(x.coefT) >= 3.4 ? ' ★' : ''} | ${f2(x.miss * 100, 0)}% |`);
  }
  L.push('', '## 數學說明', '',
    '- 公式：預期超額_i ＝ Σ_j β_j × R_j(i)，R_j 為特徵 j 的當日排名（−0.5~0.5）。用排名而非原值，是為了讓極端值（例如營建股營收年增 5000%）不主導結果。',
    '- β 以 Fama–MacBeth 估計：每天做一次橫斷面迴歸，再對各日係數取平均；相關的特徵（例如 20 日報酬與距均線）會自動分攤權重，不會像 IC 加權那樣重複計分。',
    '- 重疊標籤（持有 h 日、每天都有新樣本）用 Newey–West（lag h−1）修正 t 值；新因子門檻採 t≥3（Harvey, Liu & Zhu 2016），高於傳統 2，因為同時試了很多組。',
    '- 滾動前進：每個預測日只用當時已經知道答案的歷史估 β，等於每天都在「沒看過的未來」上考試；這比單一切點更接近實盤。',
    '- 為何 IC 顯著、十分位價差卻小：若報酬是常態分布，D10−D1 約為 3.5 × IC × 超額σ；實際 5~20 日報酬厚尾且右偏，少數暴漲股主宰平均數，排名（IC、勝率）改善比平均報酬改善明顯得多。',
    '- 「精準選中對的股票」在數學上不可能：5~20 日報酬的可預測部分很小（IC 0.05 約等於解釋 0.25% 的變異），能做的是讓「選中的一籃」平均勝過大盤、且扣成本後仍為正。',
    '', '## 成本參考（依持有方式；不作比對、不作門檻）', '', '| 持有方式 | 證交稅 | 來回成本（手續費 2.8 折） | 來回成本（全額手續費） | 每持有日攤提（2.8 折） |', '|---|---|---|---|---|',
    ...COST_STYLES.map(([name, tax, d]) => { const disc = FEE_PCT * FEE_DISC * 2 + tax, full = FEE_PCT * 2 + tax; return `| ${name} | ${tax}% | ${f2(disc, 3)}% | ${f2(full, 3)}% | ${d ? `${f2(disc / d, 3)}%` : '—'} |`; }),
    '', '（另有每筆最低手續費；ETF 證交稅 0.1%。實際成本以券商與主管機關公告為準。）',
    '', '## 限制與誠實揭露', '',
    '- 產業別用目前的分類套回過去（公司很少換產業，但仍是輕微未來資訊）；處置股歷史名單沒有逐日歸檔，宇宙未排除處置股。',
    '- 月營收歸檔自 2023-08 起，之前的日子營收特徵為中性。下市股缺後續價格者不計入（輕微存活偏差）。',
    '- 我們（研究者）已經看過 v3 驗證在 2025-11~2026-09 的結果，特徵清單難免受影響；真正乾淨的考試只有影子模式的前瞻資料。',
    '', '非投資建議。', '');
  return L.join('\n');
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const rows = await loadRows();
const meta = rows[0]?.kind === 'meta' ? rows.shift() : null;
if (!meta) throw new Error('快取缺 meta，請加 --refresh');
const IND_MIN = 1000;   // 產業別覆蓋下限：不足就停，不讓「同產業動能」悄悄變中性（審查 2026-09-30）
const indN = Object.keys(meta.ind || {}).length;
if (indN < IND_MIN) throw new Error(`產業別只有 ${indN} 檔（<${IND_MIN}），請加 --refresh 重抓或檢查 peerComps`);
const D = buildArrays(rows);
const ex = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'exright-history.json'), 'utf8'));
const adj = adjust(D, mergeFactorItems(ex.items, meta.pe));
console.log(`資料 ${D.N} 日（${D.dates[0]} ~ ${D.dates.at(-1)}）、${D.K} 檔；建面板…`);
const panel = buildPanel(D, adj, revenueIndex(meta.rev), meta.ind);
console.log(`面板 ${panel.length} 日、平均宇宙 ${f2(mean(panel.map(p => p.n)), 0)} 檔`);
{ // 自我檢查（不進報告）：以真實答案當分數＝全知，IC 應≈1、Top20 超額應遠大於 0；方向若反＝評估程式有錯
  const ev = evaluate(panel, panel.map(p => Float64Array.from(p.Y[5], v => (Number.isFinite(v) ? v : -1e9))), 5);
  console.log(`自我檢查（全知分數）：IC ${f2(ev.ic, 3)}、Top20 超額 ${f2(ev.top)}%、D10−D1 ${f2(ev.spread)}%`);
}
if (STAGE3) { runStage3(); process.exit(0); }
const results = [], feat = {};
const logRes = (h, v, ev) => console.log(`h=${h} ${v}：${ev.passed ? '✅' : '❌'} IC ${f2(ev.ic, 4)} t=${f2(ev.t)}｜D10−D1 ${f2(ev.spread)}%｜Top20 ${f2(ev.top)}%（未扣成本）勝率 ${f2(ev.topHit * 100, 1)}% vs 宇宙 ${f2(ev.uniHit * 100, 1)}%｜${JSON.stringify(ev.gates)}`);
for (const h of HS) {
  if (!STAGE2) {
    const { B, preds, final } = walkForward(panel, h);
    feat[h] = featureTable(panel, B, h);
    for (const v of ['A', 'B']) { const ev = evaluate(panel, preds[v], h); results.push({ h, v, ev, names: FEATS, coef: { all: final.all?.[v] || [] } }); logRes(h, v, ev); }
    continue;
  }
  const c = walkForward(panel, h);                                           // C：擴充特徵（乘積＋平方），B 版收縮
  feat[h] = featureTable(panel, c.B, h, EXT);
  const evC = evaluate(panel, c.preds.B, h); results.push({ h, v: 'C', ev: evC, names: EXT, coef: { all: c.final.all?.B || [] } }); logRes(h, 'C', evC);
  const basePanel = panel.map(p => ({ ...p, X: p.X.slice(0, BASE_P) }));   // D：基本 24 特徵、依市況分組，B 版收縮
  const d = walkForward(basePanel, h, true);
  const evD = evaluate(basePanel, d.preds.B, h); results.push({ h, v: 'D', ev: evD, names: FEATS, coef: { bull: d.final.bull?.B || [], bear: d.final.bear?.B || [] } }); logRes(h, 'D', evD);
}
// 通過全部門檻的 5 日·市況分組（D）→ 權重檔（影子模式只讀此檔，不在線上重估）
const passedD = STAGE2 && results.find(r => r.h === 5 && r.v === 'D' && r.ev.passed);
if (passedD) {
  const r6 = a => a.map(x => +(+x || 0).toFixed(6)), e = passedD.ev, dataDate = D.dates.at(-1);
  writeFileSync(join(ROOT, 'scripts', 'data', 'swing-formula-weights.json'), JSON.stringify({
    version: 'swing-formula-v1', builtAt: new Date().toISOString(), dataDate, h: 5, variant: 'D', passed: true,
    regimeRule: '前 20 日可交易宇宙等權報酬 > 0 ＝ 多頭係數，否則空頭係數（t 日收盤已知）',
    features: FEATS.map(f => f[0]), coef: { bull: r6(passedD.coef.bull), bear: r6(passedD.coef.bear) },
    oos: { from: e.from, to: e.to, n: e.n, ic: +e.ic.toFixed(4), t: +e.t.toFixed(2), spread: +e.spread.toFixed(2), top: +e.top.toFixed(2), topHit: +e.topHit.toFixed(3), uniHit: +e.uniHit.toFixed(3) },
    reviewBy: new Date(Date.parse(dataDate) + 90 * 864e5).toISOString().slice(0, 10),
    note: '研究 docs/SWING-FORMULA-RESEARCH-*-stage2.md（未扣成本口徑）；影子模式只讀此檔、不在線上重估；前瞻 ≥20 個交易日後再評估。非投資建議。',
  }, null, 1) + '\n');
  console.log('✓ scripts/data/swing-formula-weights.json（5 日·市況分組）');
}
const R = { stage2: STAGE2, indN, dataDate: D.dates.at(-1), nDays: D.N, range: [D.dates[0], D.dates.at(-1)], avgUni: mean(panel.map(p => p.n)), results, feat };
const out = `SWING-FORMULA-RESEARCH-${R.dataDate}${STAGE2 ? '-stage2' : ''}.md`;
writeFileSync(join(ROOT, 'docs', out), render(R));
console.log(`✓ docs/${out}`);
process.exit(0);
