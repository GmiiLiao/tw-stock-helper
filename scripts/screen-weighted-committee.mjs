#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 第九輪：參數「權重」——等權 AND/投票 → 加權評分  —— 2026-08-05
//
// 前八輪的組合全是等權（AND＝全有全無、投票＝一人一票）。
// 使用者指示「修正各參數權重提高準確率」——權重確實是還沒動過的自由度。
//
// **巢狀紀律（不可違背）**：
//   權重與切分門檻一律只在【主窗前半窗 half0】上學；
//   後半窗 half1（沒看過）＋ OOT（沒看過）是考場。
//   在考場上挑最好看的那格＝作弊，所以印整條 coverage 曲線並
//   **事先指定主要營運點 = 覆蓋率 0.5%**（與現行凍結規則的觸發頻率同量級）。
//
// 三種權重學法（同一批 17 條件·下跌側·平常日）：
//   M1 邊際權重：w_i = 該條件 half0 單獨命中 − half0 基準（n≥200 才給權重）
//   M2 邏輯迴歸：17+1 參數·half0 梯度下降（權重會自動處理條件間相關性）
//   M3 等權投票：正邊際條件一人一票（＝舊方法，當對照組）
// 目標：T1(5日方向·淨) 與 T3(5日內曾觸-3%低點·毛——第八輪認定的正確題目形式)
// 用法：node scripts/screen-weighted-committee.mjs
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import { loadDays } from './lib/bt-core.mjs';
import { build, POOL, TGT, isOrdinary } from './screen-exit-target80.mjs';

const MAIN = 480, OOT = 240, WARM = 30;
const COVS = [0.02, 0.01, 0.005, 0.0025, 0.001];   // 覆蓋率曲線；主要營運點 0.005
const r1 = x => (x == null ? null : +x.toFixed(1));
const r2 = x => (x == null ? null : +x.toFixed(2));
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

const feats = S => S.map(s => POOL.map(([, , fn]) => (fn(s) ? 1 : 0)));

// 目標向量（null＝forward 不完整，剔除）
const targets = (S, tgt) => S.map(s => { const v = s[tgt.key]; return v == null ? null : (tgt.hit(v) ? 1 : 0); });

function hitOf(S, X, y, sel) {
  let n = 0, w = 0; const days = new Set();
  for (let k = 0; k < S.length; k++) {
    if (y[k] == null || !sel(k)) continue;
    n++; w += y[k]; days.add(S[k].di);
  }
  return n ? { n, hit: +(w / n * 100).toFixed(1), days: days.size } : null;
}

// M2：邏輯迴歸（binary 特徵·稀疏更新·batch GD）
function fitLogistic(X, y, idx, epochs = 400, lr = 1.0) {
  const nf = POOL.length, w = new Float64Array(nf + 1);
  for (let e = 0; e < epochs; e++) {
    const g = new Float64Array(nf + 1);
    for (const k of idx) {
      const xi = X[k];
      let z = w[nf];
      for (let j = 0; j < nf; j++) if (xi[j]) z += w[j];
      const d = 1 / (1 + Math.exp(-z)) - y[k];
      for (let j = 0; j < nf; j++) if (xi[j]) g[j] += d;
      g[nf] += d;
    }
    for (let j = 0; j <= nf; j++) w[j] -= lr * g[j] / idx.length;
  }
  return w;
}

const scoreLin = (X, w) => X.map(xi => {
  let z = w[POOL.length];
  for (let j = 0; j < POOL.length; j++) if (xi[j]) z += w[j];
  return z;
});
const scoreDot = (X, w) => X.map(xi => {
  let z = 0;
  for (let j = 0; j < POOL.length; j++) if (xi[j]) z += w[j];
  return z;
});

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 40 });
  const SM = build(all.slice(-(MAIN + WARM))).filter(isOrdinary);
  const SO = build(all.slice(0, OOT + WARM)).filter(isOrdinary);
  const XM = feats(SM), XO = feats(SO);
  const h0 = SM.map((s, k) => s.half === 0 ? k : -1).filter(k => k >= 0);
  const h1sel = k => SM[k].half === 1;
  console.log('═'.repeat(118));
  console.log(`第九輪：加權委員會（權重只在前半窗學·後半窗＋OOT 考試）｜平常日主窗 ${SM.length.toLocaleString()}（前半 ${h0.length.toLocaleString()}）／OOT ${SO.length.toLocaleString()}`);
  console.log('═'.repeat(118));

  for (const tk of ['T1', 'T3']) {
    const tgt = TGT[tk];
    const yM = targets(SM, tgt), yO = targets(SO, tgt);
    const idx0 = h0.filter(k => yM[k] != null);
    const base0 = hitOf(SM, XM, yM, k => SM[k].half === 0);
    const base1 = hitOf(SM, XM, yM, h1sel);
    const baseO = hitOf(SO, XO, yO, () => true);
    console.log(`\n${'━'.repeat(118)}\n【${tk} ${tgt.name}】基準：前半 ${base0.hit}%｜後半(考場) ${base1.hit}%｜OOT(考場) ${baseO.hit}%\n${'━'.repeat(118)}`);

    // M1 邊際權重（half0 only）
    const wEdge = new Float64Array(POOL.length + 1);
    const edgeRows = [];
    for (let j = 0; j < POOL.length; j++) {
      let n = 0, w = 0;
      for (const k of idx0) if (XM[k][j]) { n++; w += yM[k]; }
      const e = n >= 200 ? w / n * 100 - base0.hit : 0;
      wEdge[j] = e;
      edgeRows.push({ nm: POOL[j][0], n, e });
    }
    console.log('  M1 邊際權重（half0 單獨命中−基準·n≥200 才計）：');
    edgeRows.sort((a, b) => b.e - a.e);
    console.log('    ' + edgeRows.map(r => `${r.nm}${r.e >= 0 ? '+' : ''}${r1(r.e)}`).join('｜'));

    // M2 邏輯迴歸
    const wLog = fitLogistic(XM, yM, idx0);
    const lg = POOL.map(([nm], j) => ({ nm, w: wLog[j] })).sort((a, b) => b.w - a.w);
    if (tk === 'T3') {   // 凍結用：精確權重＋half0 0.5% 切分值（GD 無隨機性·可重現）
      const sAll = scoreLin(XM, wLog);
      const sSorted = idx0.map(k => sAll[k]).sort((a, b) => b - a);
      const cut = sSorted[Math.max(0, Math.floor(sSorted.length * 0.005) - 1)];
      fs.writeFileSync('scripts/data/overheat-weighted-v1.json', JSON.stringify({
        calib: 'wexit-v1', target: 'T3 5日內曾觸-3%低點(毛)', trainedOn: 'half0(主窗前半·平常日)·2026-08-05',
        cut, bias: wLog[POOL.length],
        weights: Object.fromEntries(POOL.map(([nm], j) => [nm, wLog[j]])),
      }, null, 2));
      console.log(`  💾 已凍結精確權重 → scripts/data/overheat-weighted-v1.json（cut=${cut.toFixed(4)}）`);
    }
    console.log('  M2 邏輯迴歸權重（排序）：');
    console.log('    ' + lg.map(r => `${r.nm}${r.w >= 0 ? '+' : ''}${r2(r.w)}`).join('｜'));

    // M3 等權投票（正邊際·n≥200 的條件一人一票）
    const wVote = new Float64Array(POOL.length + 1);
    let nComm = 0;
    for (let j = 0; j < POOL.length; j++) if (wEdge[j] > 0) { wVote[j] = 1; nComm++; }
    console.log(`  M3 等權投票委員 ${nComm} 人（＝M1 正權重者）`);

    const METHODS = [
      ['M1 邊際權重', scoreDot(XM, wEdge), scoreDot(XO, wEdge)],
      ['M2 邏輯迴歸', scoreLin(XM, wLog), scoreLin(XO, wLog)],
      ['M3 等權投票', scoreDot(XM, wVote), scoreDot(XO, wVote)],
    ];
    console.log(`\n  覆蓋率曲線（切分值凍結自 half0 分數分布·★=事先指定的主要營運點 0.5%）`);
    console.log(`  ${pad('方法', 12)}${pad('覆蓋', 8)}${pad('切分值', 10)}${pad('後半窗(考場)', 24)}${pad('OOT(考場)', 24)}超額(後半/OOT)`);
    for (const [nm, sM, sO] of METHODS) {
      const s0 = idx0.map(k => sM[k]).sort((a, b) => b - a);
      for (const cov of COVS) {
        const cut = s0[Math.max(0, Math.floor(s0.length * cov) - 1)];
        const m1 = hitOf(SM, XM, yM, k => h1sel(k) && sM[k] >= cut);
        const mo = hitOf(SO, XO, yO, k => sO[k] >= cut);
        const star = cov === 0.005 ? '★' : ' ';
        console.log(`  ${pad(nm, 12)}${star}${pad((cov * 100) + '%', 6)}${pad(r2(cut), 10)}`
          + `${pad(m1 ? `${m1.hit}%·n=${m1.n}·${m1.days}天` : '樣本不足', 24)}`
          + `${pad(mo ? `${mo.hit}%·n=${mo.n}·${mo.days}天` : '樣本不足', 24)}`
          + `${m1 ? r1(m1.hit - base1.hit) : '-'}pp／${mo ? r1(mo.hit - baseO.hit) : '-'}pp`);
      }
    }
  }
  console.log(`\n${'═'.repeat(118)}\n判讀：加權若有真增量，M1/M2 應在**考場**（後半窗與 OOT）穩定壓過 M3 等權投票；`);
  console.log(`只贏在 half0＝過擬合。切分值凍結自 half0，考場覆蓋率會漂移是正常現象。非投資建議。\n${'═'.repeat(118)}`);
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
