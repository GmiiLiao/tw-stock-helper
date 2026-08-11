#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 波段第 2 套預選機制：PID 斜率曲線分型
//
// 使用者需求（2026-08-11）：
//   「用 PID 演算法找出 5 日與 20 日最高勝率漲幅的斜率曲線，至少 5 種曲線，
//     依這個曲線相似度來預選推薦股，設為第 2 套預選機制，
//     並做 60 日的記錄後看是哪一種的勝率高」
//
// 為什麼這個提法比前一版（screen-swing-analog.mjs）好——兩個關鍵差異：
//   ① **目標改成勝率，不是最大漲幅**。MFE 天生隨波動度上升，前一版六種排行鍵
//      全部敗在「輸給直接照波動度排序」。勝率（淨報酬>0 的比例）對波動度近乎中性，
//      不會出現「亂跳的股票自動排前面」。
//   ② **PID 分解是低維且可解釋的**。前一版是自由形狀的 k-NN，維度高、
//      相似度被單一主導因子吃掉還看不出來。PID 只有四個數字，每一個都有物理意義，
//      而且分型中心可以直接畫成一條曲線給使用者看。
//
// PID 對價格軌跡的定義（窗長 L=20 個交易日，全部除以該檔自身日波動 σ ⇒ 形狀化）：
//   以窗內起點為基準的累積對數報酬 r_t，對 t 做最小平方直線 fit：
//     D  (微分·斜率)   = 迴歸斜率 / σ            → 平均每天走幾個 σ
//     D2 (二階·加速度) = (後半段斜率 − 前半段斜率) / σ → 加速上升 or 減速轉折
//     P  (比例·現況)   = (r_0 − 直線在 t=0 的值) / σ  → 現在在自己趨勢線的上方還下方
//     I  (積分·累積)   = 窗內殘差平均 / σ            → 長期偏離趨勢線的方向
//   ⇒ 除以 σ 是這支腳本能成立的前提：不除的話 D 大就只是波動大，
//     又會重蹈前一版的覆轍。
//
// 分型：對 (P,I,D,D2) 逐日橫斷面 z-score 後做 k-means。
//   ⚠ **分型中心只用訓練窗擬合**，之後固定不動再套用到後面兩個窗——
//     若每個窗各自分群，等於讓分型偷看未來，勝率會虛高。
//
// 准入標準（沿用本專案規矩）：主窗前半／主窗後半／獨立 OOT 三窗
//   淨報酬與勝率都要勝過同窗可交易宇宙基準，方向一致才算通過。
//   另外必查每個分型的平均 vol20——若最強分型只是高波動族群，一律標記。
//
// 用法：node scripts/screen-swing-pid.mjs
// 非投資建議。
// ─────────────────────────────────────────────────────────────────────────

import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { loadArchive, buildMatrix } from './screen-swing-analog.mjs';

const L = 20;             // PID 觀察窗
const WARM = 60;
const FWD5 = 5, FWD20 = 20;
const COST = 0.4425;      // 來回手續費＋證交稅（與 bt-core 同口徑）
const MIN_VOL = 300;
const NCLUST = 8;         // 分型數（使用者要求至少 5 種，取 8 讓弱型也現形）
const NF = 4;
const F_NAMES = ['P', 'I', 'D', 'D2'];

const log = (...a) => console.log(...a);
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null || !isFinite(x) ? '—' : x.toFixed(2));
const pct = (n, d) => (d ? (n / d * 100) : null);

// ── PID 特徵 ＋ 前瞻目標 ──────────────────────────────────────────────────
function buildSamples(M) {
  const { dates, codes, nD, nC, C, H, LO, V } = M;
  const feat = [], meta = [], paths = [];
  // 迴歸用的固定 x 統計（t = 0..L-1）
  const xs = Array.from({ length: L }, (_, i) => i);
  const xbar = avg(xs);
  const sxx = xs.reduce((s, x) => s + (x - xbar) ** 2, 0);

  for (let i = 0; i < nC; i++) {
    const base = i * nD;
    for (let d = WARM; d < nD - FWD20; d++) {
      const c0 = C[base + d];
      if (!(c0 > 0) || !(V[base + d] >= MIN_VOL)) continue;
      const cPrev = C[base + d - 1];
      if (!(cPrev > 0) || (c0 / cPrev - 1) * 100 > 8.5) continue;   // 可交易宇宙

      // 窗內累積對數報酬（舊→新）與日波動
      const r = new Array(L);
      const p0 = C[base + d - L + 1];
      if (!(p0 > 0)) continue;
      let bad = false, s = 0, s2 = 0, n = 0;
      for (let k = 0; k < L; k++) {
        const c = C[base + d - L + 1 + k];
        if (!(c > 0)) { bad = true; break; }
        r[k] = Math.log(c / p0);
        if (k > 0) { const lr = r[k] - r[k - 1]; s += lr; s2 += lr * lr; n++; }
      }
      if (bad || n < L - 2) continue;
      const mu = s / n;
      const sigma = Math.sqrt(Math.max(s2 / n - mu * mu, 1e-12));
      if (!(sigma > 1e-6)) continue;

      // 最小平方直線
      let sxy = 0;
      const rbar = avg(r);
      for (let k = 0; k < L; k++) sxy += (xs[k] - xbar) * (r[k] - rbar);
      const slope = sxy / sxx;
      const intercept = rbar - slope * xbar;
      // 前後半段斜率差＝加速度
      const half = (a, b) => {
        let sx = 0, sy = 0, sxx2 = 0, sxy2 = 0, m = 0;
        for (let k = a; k < b; k++) { sx += xs[k]; sy += r[k]; m++; }
        const mx = sx / m, my = sy / m;
        for (let k = a; k < b; k++) { sxx2 += (xs[k] - mx) ** 2; sxy2 += (xs[k] - mx) * (r[k] - my); }
        return sxx2 > 0 ? sxy2 / sxx2 : 0;
      };
      const d2 = half(L / 2, L) - half(0, L / 2);
      // ⚠ 積分項**不能**用「對迴歸線的殘差和」（2026-08-11 第一版的 bug）：
      //   含截距的最小平方，殘差和恆等於 0 —— 八個分型的 I 全部印出 0，
      //   等於整個分群只用了 3 個維度，而且從輸出上看不出來（值是 0 不是 NaN）。
      //   改用控制理論的標準寫法：**誤差對短均線（setpoint）而非對自己的迴歸線**。
      //     e_t = r_t − MA5(r)_t → 站上/跌破短均的程度
      //     P = 當前誤差、I = 窗內誤差平均（持續偏離的方向）、D = 趨勢斜率
      let errSum = 0, errNow = 0, en = 0;
      for (let k = 4; k < L; k++) {
        let ma = 0;
        for (let j = 0; j < 5; j++) ma += r[k - j];
        ma /= 5;
        const e = r[k] - ma;
        errSum += e; en++;
        if (k === L - 1) errNow = e;
      }
      if (!en) continue;

      const P = errNow / sigma;
      const I = (errSum / en) / sigma;
      const D = slope / sigma;
      const D2 = d2 / sigma;
      if (![P, I, D, D2].every(v => isFinite(v))) continue;

      // 目標：持有 5/20 日的淨報酬（扣來回費稅）——勝率＝淨報酬>0
      const c5 = C[base + d + FWD5], c20 = C[base + d + FWD20];
      if (!(c5 > 0) || !(c20 > 0)) continue;
      const net5 = (c5 / c0 - 1) * 100 - COST;
      const net20 = (c20 / c0 - 1) * 100 - COST;
      // 最大累計成長（MFE）與最大回檔（MAE）：使用者要求要有「預期最大累計成長%」。
      // ⚠ 這兩個**必須成對顯示**——MFE 天生隨波動度上升（前一版已實測），
      //   只給 MFE 會讓高波動分型看起來最強，但它同時也是回檔最深的那一群。
      let mfe5 = -Infinity, mae5 = Infinity, mfe20 = -Infinity, mae20 = Infinity;
      for (let k = 1; k <= FWD20; k++) {
        const hh = H[base + d + k], ll = LO[base + d + k];
        if (hh > 0) { const u = (hh / c0 - 1) * 100; if (k <= FWD5 && u > mfe5) mfe5 = u; if (u > mfe20) mfe20 = u; }
        if (ll > 0) { const w = (ll / c0 - 1) * 100; if (k <= FWD5 && w < mae5) mae5 = w; if (w < mae20) mae20 = w; }
      }
      if (!isFinite(mfe5) || !isFinite(mfe20)) continue;

      feat.push([P, I, D, D2]);
      paths.push(r.map(v => v / sigma));      // 形狀化曲線（畫給使用者看）
      meta.push({ d, date: dates[d], code: codes[i], vol20: sigma * 100, net5, net20,
        mfe5, mae5, mfe20, mae20 });
    }
  }
  return { feat, meta, paths };
}

// 逐日橫斷面 z-score（理由同 analog 版：不同年份分布不同，全期標準化＝在背年份）
function zByDay(feat, meta) {
  const byDay = new Map();
  for (let i = 0; i < meta.length; i++) {
    if (!byDay.has(meta[i].d)) byDay.set(meta[i].d, []);
    byDay.get(meta[i].d).push(i);
  }
  const Z = new Float32Array(feat.length * NF);
  for (const [, ids] of byDay) {
    for (let f = 0; f < NF; f++) {
      let s = 0, s2 = 0;
      for (const i of ids) { s += feat[i][f]; s2 += feat[i][f] ** 2; }
      const m = s / ids.length, sd = Math.sqrt(Math.max(s2 / ids.length - m * m, 1e-9));
      for (const i of ids) Z[i * NF + f] = (feat[i][f] - m) / sd;
    }
  }
  return Z;
}

// ── k-means（只用訓練窗擬合；固定種子，結果可重現）────────────────────────
function kmeans(Z, ids, k, iters = 40) {
  // k-means++ 起始，但用固定 LCG 亂數＝可重現（本專案禁止不可重現的研究結果）
  let seed = 20260811;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cent = [];
  cent.push(ids[Math.floor(rnd() * ids.length)]);
  while (cent.length < k) {
    const dist = ids.map(i => {
      let best = Infinity;
      for (const c of cent) { let s = 0; for (let f = 0; f < NF; f++) s += (Z[i * NF + f] - Z[c * NF + f]) ** 2; if (s < best) best = s; }
      return best;
    });
    const tot = dist.reduce((a, b) => a + b, 0);
    let x = rnd() * tot, pick = ids[0];
    for (let j = 0; j < ids.length; j++) { x -= dist[j]; if (x <= 0) { pick = ids[j]; break; } }
    cent.push(pick);
  }
  let C = cent.map(i => Array.from({ length: NF }, (_, f) => Z[i * NF + f]));
  const assign = new Int8Array(ids.length);
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let j = 0; j < ids.length; j++) {
      const i = ids[j]; let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { let s = 0; for (let f = 0; f < NF; f++) s += (Z[i * NF + f] - C[c][f]) ** 2; if (s < bd) { bd = s; best = c; } }
      if (assign[j] !== best) { assign[j] = best; moved++; }
    }
    const sum = Array.from({ length: k }, () => new Float64Array(NF)), cnt = new Int32Array(k);
    for (let j = 0; j < ids.length; j++) { const i = ids[j], a = assign[j]; cnt[a]++; for (let f = 0; f < NF; f++) sum[a][f] += Z[i * NF + f]; }
    for (let c = 0; c < k; c++) if (cnt[c]) for (let f = 0; f < NF; f++) C[c][f] = sum[c][f] / cnt[c];
    if (!moved) break;
  }
  return C;
}

const nearest = (Z, i, C) => {
  let best = 0, bd = Infinity;
  for (let c = 0; c < C.length; c++) { let s = 0; for (let f = 0; f < NF; f++) s += (Z[i * NF + f] - C[c][f]) ** 2; if (s < bd) { bd = s; best = c; } }
  return best;
};

// 依 PID 座標給人看得懂的名字
function nameOf(c) {
  const [P, I, D, D2] = c;
  const dir = D > 0.5 ? '上升' : D < -0.5 ? '下降' : '橫盤';
  const acc = D2 > 0.4 ? '加速' : D2 < -0.4 ? '減速' : '等速';
  const pos = P > 0.5 ? '·強於趨勢' : P < -0.5 ? '·弱於趨勢' : '';
  return `${acc}${dir}${pos}`;
}

async function main() {
  const t0 = Date.now();
  log('▶ 載入本地歸檔…');
  const arch = loadArchive();
  const M0 = buildMatrix(arch);
  const M = { ...M0, LO: M0.L };
  log(`  ${arch.dates.length} 日 × ${M.nC} 檔：${arch.dates[0]} → ${arch.dates[arch.dates.length - 1]}`);

  log('▶ 建 PID 特徵與 5/20 日淨報酬…');
  const { feat, meta, paths } = buildSamples(M);
  log(`  樣本 ${meta.length.toLocaleString()} 筆（窗長 ${L}·扣費稅 ${COST}%）`);
  const Z = zByDay(feat, meta);

  // 三窗切分：訓練窗＝最早 40%（只用來擬合分型中心），其餘為驗證
  const months = [...new Set(meta.map(m => m.date.slice(0, 7)))].sort();
  const trainEnd = months[Math.floor(months.length * 0.4)];
  const ootFrom = months[Math.floor(months.length * 0.8)];
  const idxTrain = [], rest = [];
  for (let i = 0; i < meta.length; i++) (meta[i].date.slice(0, 7) < trainEnd ? idxTrain : rest).push(i);
  log(`▶ k-means 分型（K=${NCLUST}）：訓練窗 < ${trainEnd}（n=${idxTrain.length.toLocaleString()}），驗證窗 ≥ ${trainEnd}`);
  const C = kmeans(Z, idxTrain, NCLUST);

  const lab = new Int8Array(meta.length);
  for (let i = 0; i < meta.length; i++) lab[i] = nearest(Z, i, C);

  // 分型平均曲線（畫圖與上線用）
  const curves = Array.from({ length: NCLUST }, () => new Float64Array(L));
  const cnt = new Int32Array(NCLUST);
  for (let i = 0; i < meta.length; i++) { const a = lab[i]; cnt[a]++; for (let k = 0; k < L; k++) curves[a][k] += paths[i][k]; }
  for (let c = 0; c < NCLUST; c++) if (cnt[c]) for (let k = 0; k < L; k++) curves[c][k] /= cnt[c];

  // ── 逐窗評估 ────────────────────────────────────────────────────────────
  const winOf = (rows, f) => pct(rows.filter(r => f(r) > 0).length, rows.length);
  const windows = [
    ['主窗前半', r => r.date >= trainEnd && r.date.slice(0, 7) < months[Math.floor(months.length * 0.6)]],
    ['主窗後半', r => r.date.slice(0, 7) >= months[Math.floor(months.length * 0.6)] && r.date.slice(0, 7) < ootFrom],
    [`OOT(${ootFrom}起)`, r => r.date.slice(0, 7) >= ootFrom],
  ];
  const stat = {};
  for (const [wl, wf] of windows) {
    const rows = meta.filter(wf);
    const b5 = avg(rows.map(r => r.net5)), b20 = avg(rows.map(r => r.net20));
    const bw5 = winOf(rows, r => r.net5), bw20 = winOf(rows, r => r.net20);
    const bg5 = avg(rows.map(r => r.mfe5)), bg20 = avg(rows.map(r => r.mfe20));
    const ba5 = avg(rows.map(r => r.mae5)), ba20 = avg(rows.map(r => r.mae20));
    log(`\n── ${wl}（n=${rows.length.toLocaleString()}）基準：5日 淨${r2(b5)}%/勝${r2(bw5)}%/最大成長${r2(bg5)}%/最大回檔${r2(ba5)}%`
      + `　20日 淨${r2(b20)}%/勝${r2(bw20)}%/最大成長${r2(bg20)}%/最大回檔${r2(ba20)}% ──`);
    for (let c = 0; c < NCLUST; c++) {
      const g = rows.filter((_, j) => false);   // placeholder（下方用索引法）
      void g;
    }
    // 用索引取分型（meta 與 lab 同序）
    const byC = Array.from({ length: NCLUST }, () => []);
    for (let i = 0; i < meta.length; i++) if (wf(meta[i])) byC[lab[i]].push(meta[i]);
    for (let c = 0; c < NCLUST; c++) {
      const g = byC[c];
      if (g.length < 200) { log(`  曲線${c + 1} ${nameOf(C[c]).padEnd(12)} 樣本不足 ${g.length}`); continue; }
      const m5 = avg(g.map(r => r.net5)), m20 = avg(g.map(r => r.net20));
      const w5 = winOf(g, r => r.net5), w20 = winOf(g, r => r.net20);
      const G5 = avg(g.map(r => r.mfe5)), G20 = avg(g.map(r => r.mfe20));
      const A5 = avg(g.map(r => r.mae5)), A20 = avg(g.map(r => r.mae20));
      const v = avg(g.map(r => r.vol20));
      log(`  曲線${c + 1} ${nameOf(C[c]).padEnd(12)} n=${String(g.length).padStart(6)}`
        + ` │5日 淨${r2(m5).padStart(6)}%(Δ${r2(m5 - b5).padStart(5)}) 勝${r2(w5)}%(Δ${r2(w5 - bw5).padStart(5)}) 長${r2(G5)}%(Δ${r2(G5 - bg5).padStart(5)}) 撤${r2(A5)}%`
        + ` │20日 淨${r2(m20).padStart(6)}%(Δ${r2(m20 - b20).padStart(5)}) 勝${r2(w20)}%(Δ${r2(w20 - bw20).padStart(5)}) 長${r2(G20)}%(Δ${r2(G20 - bg20).padStart(5)}) 撤${r2(A20)}%`
        + ` │σ ${r2(v)}%`);
      (stat[c] ||= []).push({ wl, d5: m5 - b5, dw5: w5 - bw5, d20: m20 - b20, dw20: w20 - bw20,
        g5: G5, g20: G20, dg5: G5 - bg5, dg20: G20 - bg20, a5: A5, a20: A20, vol: v, n: g.length });
    }
  }

  // ── 判定 ────────────────────────────────────────────────────────────────
  // ⚠ 這裡刻意**不做二元通過/淘汰**：使用者的設計是「做 60 日記錄後看哪一種勝率高」，
  //   由前瞻實記當裁判。歷史三窗在這裡的角色是**排序與揭露**，不是准入。
  //   計分＝6 項檢查（3 窗 × {淨報酬Δ, 勝率Δ}）為正的項數，5 日與 20 日分開算。
  log('\n══════ 三窗一致性計分（滿分 6：3窗 × 淨報酬Δ／勝率Δ）══════');
  const passed = [];
  const scored = [];
  for (let c = 0; c < NCLUST; c++) {
    const s = stat[c];
    if (!s || s.length < 3) { log(`  曲線${c + 1} ${nameOf(C[c]).padEnd(12)} 窗數不足`); continue; }
    const sc5 = s.filter(x => x.d5 > 0).length + s.filter(x => x.dw5 > 0).length;
    const sc20 = s.filter(x => x.d20 > 0).length + s.filter(x => x.dw20 > 0).length;
    scored.push({ c, sc5, sc20 });
    const ok5 = s.every(x => x.d5 > 0) && s.every(x => x.dw5 > 0);
    const ok20 = s.every(x => x.d20 > 0) && s.every(x => x.dw20 > 0);
    log(`  曲線${c + 1} ${nameOf(C[c]).padEnd(12)} 計分 5日 ${sc5}/6·20日 ${sc20}/6`
      + ` 5日Δ[${s.map(x => r2(x.d5)).join('/')}] 勝Δ[${s.map(x => r2(x.dw5)).join('/')}] ${ok5 ? '✅' : '❌'}`
      + ` │20日Δ[${s.map(x => r2(x.d20)).join('/')}] 勝Δ[${s.map(x => r2(x.dw20)).join('/')}] ${ok20 ? '✅' : '❌'}`
      + ` │最大成長 5日${r2(avg(s.map(x => x.g5)))}%(Δ${r2(avg(s.map(x => x.dg5)))}) 20日${r2(avg(s.map(x => x.g20)))}%(Δ${r2(avg(s.map(x => x.dg20)))})`
      + ` 回檔 ${r2(avg(s.map(x => x.a5)))}%/${r2(avg(s.map(x => x.a20)))}%`
      + ` │平均σ ${r2(avg(s.map(x => x.vol)))}%`);
    if (ok5 || ok20) passed.push({ c, ok5, ok20 });
  }
  log(`\n  嚴格三窗全正的曲線：${passed.length ? passed.map(p => `曲線${p.c + 1}(${nameOf(C[p.c])})`).join('、') : '無'}`);
  const best5 = [...scored].sort((a, b) => b.sc5 - a.sc5).slice(0, 3);
  const best20 = [...scored].sort((a, b) => b.sc20 - a.sc20).slice(0, 3);
  log(`  一致性最高（5日）：${best5.map(x => `曲線${x.c + 1} ${nameOf(C[x.c])} ${x.sc5}/6`).join('　')}`);
  log(`  一致性最高（20日）：${best20.map(x => `曲線${x.c + 1} ${nameOf(C[x.c])} ${x.sc20}/6`).join('　')}`);
  const worst = [...scored].sort((a, b) => (a.sc5 + a.sc20) - (b.sc5 + b.sc20))[0];
  log(`  一致性最差（可作為排除濾網）：曲線${worst.c + 1} ${nameOf(C[worst.c])} ${worst.sc5 + worst.sc20}/12`);

  // 輸出分型定義（供 daemon 上線分類用）
  const out = {
    version: '2026-08-11', window: L, cost: COST, clusters: NCLUST,
    trainEnd, ootFrom,
    features: F_NAMES,
    centroids: C.map((c, i) => ({
      id: i + 1, name: nameOf(c), z: c.map(v => +v.toFixed(4)),
      curve: Array.from(curves[i], v => +v.toFixed(4)),
      pass5: passed.some(p => p.c === i && p.ok5),
      pass20: passed.some(p => p.c === i && p.ok20),
      score5: scored.find(x => x.c === i)?.sc5 ?? null,
      score20: scored.find(x => x.c === i)?.sc20 ?? null,
      windows: stat[i] || [],
    })),
  };
  // ⚠ 一律用 fileURLToPath，不要用 new URL(...).pathname（2026-08-11 當場踩到）：
  //   本專案路徑含中文「股票助手app」，.pathname 會回百分比編碼的字串，
  //   writeFileSync 就找不到目錄（ENOENT）。這個坑本專案已在 screen-*.mjs 栽過一次
  //   （那次是 import.meta.url 直接比對 argv[1]，三支腳本靜默 no-op）。
  const dst = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'swing-pid-curves.json');
  fs.writeFileSync(dst, JSON.stringify(out, null, 2));
  log(`\n  分型定義已寫入 ${path.relative(process.cwd(), dst)}`);
  log(`耗時 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  log('※ 勝率為扣費稅後淨報酬>0 的比例；歷史統計非未來保證。非投資建議。');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
