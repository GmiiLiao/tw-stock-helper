#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// F 段（docs/SQUEEZE-MODEL-VARIABLES §5-F，2026-09-18，使用者「go f」）：正則化線性排序模型
//
// 前提未達（A～E 沒有找到 ≥3 個跨市況穩定因子），本腳本是**誠實實驗**，不進每日管線、不寫 squeezeModel。
//   · 特徵：每日橫截面百分位（只用當天）＋少數二元（首次突破、連漲≥3、多頭日、空頭日、破20日高），約 18 個
//   · 目標：日內去均值的淨報酬（對純動能母體），ridge 回歸（閉式解，純 JS）
//   · 選 λ：訓練段（<OOS_FROM）內 3 摺時間切分交叉驗證，以摺外「每日前 20 名的日層級超額」為準
//   · 驗收：與 v2 同一把尺——樣本外每日前 20 名的日層級超額 CI、淨報酬 CI、市況分層、逐候選置換檢定
//   · 穩定性：各摺權重正負號一致率（不一致的特徵＝雜訊）
// 用法：GOOGLE_APPLICATION_CREDENTIALS=… node scripts/squeeze-model-f.mjs [nextday|daytrade|swing]（預設全跑）
// ─────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { buildSamples, TRADE_MODES, OOS_FROM, evalGroup, dayBaseline, attachCrossSection, permutationTest, prng } from './squeeze-train.mjs';

if (!getApps().length) initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))) });
const db = getFirestore();
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const COST = 0.4425, TOPK = 20;
const CS = ['chg', 'volX', 'instVsVol', 'ret5', 'pos', 'ratio', 'shVsVol', 'relSector', 'sectorSync', 'distHi60', 'distLo60', 'lendVsVol', 'lendChgVsVol'];
const BIN = [['firstBreak20', x => x.f.firstBreak20 === 1], ['upStreak≥3', x => x.f.upStreak >= 3], ['brk20', x => x.f.brk20 === 1], ['bull', x => x.rg === 'bull'], ['bear', x => x.rg === 'bear']];
const FEATS = [...CS.map(k => `cs:${k}`), ...BIN.map(b => b[0])];

function featVec(x) {
  const v = [];
  for (const k of CS) v.push(x.cs?.[k] == null ? 0.5 : x.cs[k] - 0.5);   // 百分位置中；缺值＝中位
  for (const [, fn] of BIN) v.push(fn(x) ? 1 : 0);
  return v;
}
// ridge：w = (XᵀX + λI)⁻¹ Xᵀy（高斯消去）
function ridge(X, y, lambda) {
  const p = X[0].length; const A = Array.from({ length: p }, () => new Array(p).fill(0)); const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) { const xi = X[i]; for (let a = 0; a < p; a++) { b[a] += xi[a] * y[i]; for (let c = a; c < p; c++) A[a][c] += xi[a] * xi[c]; } }
  for (let a = 0; a < p; a++) { for (let c = 0; c < a; c++) A[a][c] = A[c][a]; A[a][a] += lambda; }
  // solve
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < p; i++) {
    let piv = i; for (let r = i + 1; r < p; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r; [M[i], M[piv]] = [M[piv], M[i]];
    const d = M[i][i] || 1e-12; for (let c = i; c <= p; c++) M[i][c] /= d;
    for (let r = 0; r < p; r++) if (r !== i) { const f = M[r][i]; for (let c = i; c <= p; c++) M[r][c] -= f * M[i][c]; }
  }
  return M.map(r => r[p]);
}
const dot = (w, v) => w.reduce((s, wi, i) => s + wi * v[i], 0);
// 每日前 K 名（依分數）的選取器
function topKSelector(set, w, K = TOPK) {
  const byDay = {}; for (const x of set) (byDay[x.date] ||= []).push(x);
  const pick = new Set(); for (const d in byDay) byDay[d].map(x => [dot(w, featVec(x)), x]).sort((a, b) => b[0] - a[0]).slice(0, K).forEach(([, x]) => pick.add(x));
  return x => pick.has(x);
}
function dailyExcessOfTop(set, w, mode, base) {
  const sel = topKSelector(set, w); const byDay = {};
  for (const x of set) if (sel(x)) (byDay[x.date] ||= []).push(mode.ret(x.y));
  return Object.keys(byDay).sort().map(d => mean(byDay[d]) - (base[d] ?? 0));
}

const { samples } = await buildSamples(db, { days: 250 });
const want = process.argv[2] ? [process.argv[2]] : ['nextday', 'daytrade', 'swing'];
for (const key of want) {
  const mode = TRADE_MODES[key];
  const isMom = x => x.f.chg >= 5;
  const pool = samples.filter(x => mode.entryOk(x.y) && mode.ret(x.y) != null && isMom(x));
  attachCrossSection(pool, isMom);
  const train = pool.filter(x => x.date < OOS_FROM), oot = pool.filter(x => x.date >= OOS_FROM);
  const baseTr = dayBaseline(train, mode), baseOo = dayBaseline(oot, mode);
  // 目標：日內去均值（對純動能母體）
  const yOf = x => mode.ret(x.y) - (x.date < OOS_FROM ? baseTr[x.date] : baseOo[x.date]);
  const Xtr = train.map(featVec), ytr = train.map(yOf);
  console.log(`\n══ [${key}] ${mode.label}｜訓練 ${train.length}（${new Set(train.map(x => x.date)).size} 日）／樣本外 ${oot.length}（${new Set(oot.map(x => x.date)).size} 日）｜特徵 ${FEATS.length}`);
  // 3 摺時間 CV 選 λ
  const dates = [...new Set(train.map(x => x.date))].sort(); const cut = [dates[Math.floor(dates.length / 3)], dates[Math.floor(dates.length * 2 / 3)]];
  const foldOf = d => (d < cut[0] ? 0 : d < cut[1] ? 1 : 2);
  const lambdas = [1, 10, 100, 1000, 10000]; const cv = {}; const foldW = {};
  for (const lam of lambdas) {
    const outs = [];
    for (let k = 0; k < 3; k++) {
      const tr = train.filter(x => foldOf(x.date) !== k), te = train.filter(x => foldOf(x.date) === k);
      const w = ridge(tr.map(featVec), tr.map(yOf), lam); (foldW[lam] ||= []).push(w);
      outs.push(mean(dailyExcessOfTop(te, w, mode, baseTr)));
    }
    cv[lam] = { folds: outs.map(v => +v.toFixed(3)), mean: +mean(outs).toFixed(3) };
  }
  const best = lambdas.reduce((a, b) => (cv[b].mean > cv[a].mean ? b : a));
  console.log('  λ 交叉驗證（摺外每日前 20 名超額 pp）：', Object.entries(cv).map(([l, v]) => `λ=${l}: ${v.folds.join('/')} → ${v.mean}`).join('｜'), `⇒ 選 λ=${best}`);
  // 權重穩定性
  const W = foldW[best]; const w = ridge(Xtr, ytr, best);
  const stab = FEATS.map((f, i) => { const signs = W.map(ww => Math.sign(ww[i])); const agree = signs.every(s2 => s2 === signs[0] && s2 !== 0); return { f, w: +w[i].toFixed(4), stable: agree }; }).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  console.log('  權重（|w| 排序，✓＝三摺同號）：', stab.slice(0, 10).map(s2 => `${s2.stable ? '✓' : '✗'}${s2.f}=${s2.w}`).join('，'), `｜同號特徵 ${stab.filter(s2 => s2.stable).length}/${FEATS.length}`);
  // 驗收：v2 尺（訓練段分段、樣本外不分段）
  const segOf = d => (d < cut[0] ? 0 : d < cut[1] ? 1 : 2);
  const selTr = topKSelector(train, w), selOo = topKSelector(oot, w);
  const rTr = evalGroup(train.filter(selTr), mode, baseTr, segOf), rOo = evalGroup(oot.filter(selOo), mode, baseOo, null);
  const fmt = r => (r.excess == null ? `n=${r.n} ${r.why}` : `n=${r.n}/${r.days}日 超額 ${r.excess}pp CI[${r.ci}] 淨 ${r.net?.mean}% CI[${r.net?.ci}] 段${JSON.stringify(r.segs)} 多${r.byRegime?.bull?.excess}/空${r.byRegime?.bear?.excess} → ${r.pass ? '✅' : '✗ ' + r.why}`);
  console.log('  訓練段（樣本內，參考）：', fmt(rTr));
  console.log('  樣本外（正式）：', fmt(rOo));
  if (rOo.excess != null) { const perm = permutationTest(oot, baseOo, selOo, mode, rOo.excess); console.log(`  置換檢定：p=${perm?.p}（${perm?.trials} 次）`); }
  // 對照：隨機前 20
  const rnd = prng(99); const rw = FEATS.map(() => rnd() - 0.5); const rR = evalGroup(oot.filter(topKSelector(oot, rw)), mode, baseOo, null);
  console.log('  對照（隨機權重前 20）：', fmt(rR));
}
process.exit(0);
