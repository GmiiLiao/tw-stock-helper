#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 技術評分 v3 驗證器（規範 docs/SCORING-SPEC-v3.md §5；2026-09-30 使用者核可）
//   唯讀 Firestore（chipArchive 收盤＋法人、priceEvents 還原係數），不打上游、不寫 Firestore、不動 v2。
//   流程：逐日橫斷面（宇宙→子因子百分位→因子）＋超額標籤 → 訓練／禁區／樣本外切分 → 因子 IC 閘門 → 權重
//        → 總分 IC、D10−D1、十分位、市況分層、安慰劑 → 報告與權重檔。
//   用法：node scripts/scoring-v3-validate.mjs [--days 1100] [--dry]
//   輸出：docs/SCORING-V3-VALIDATION-<資料日>.md、scripts/data/scoring-v3-weights.json（--dry 只印摘要）
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { V3_FACTORS, V3_FACTOR_LABEL, SUB, crossSection, labelsFor, excess, spearman, compositePct, meanT } from './lib/scoring-v3.mjs';
import { applyPriceFactors, factorsFromItems } from './lib/price-factors.mjs';
import { mergeFactorItems } from './lib/exright-source.mjs';

const argv = process.argv.slice(2);
const DAYS = +(argv[argv.indexOf('--days') + 1] || 0) || 1100;
const DRY = argv.includes('--dry');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 'scoring-v3.0';
const TRAIN_FRAC = 0.75, EMBARGO = 20, MIN_TRAIN = 480, MIN_OOT = 120;
const T_MIN = 2, ORTHO_MAX = 0.5, PLACEBO_N = 20, REVIEW_DAYS = 90;
const ROUND_TRIP_COST = 0.1425 * 2 + 0.3;   // %，全額手續費＋證交稅（經濟意義段落用）
const LABEL_STEP = { S: 1, W5: 5, W20: 20, I1: 1 };
const LABEL_NAME = { S: '隔日跳空（開[t+1]÷收[t]）', W5: '5 日（收[t+5]÷開[t+1]）', W20: '20 日（收[t+20]÷開[t+1]）', I1: '隔日盤中（收[t+1]÷開[t+1]，診斷）' };
// 兩套分數：S 以隔日跳空定權；W 以 5 日定權（與 AI 波段口徑同），20 日為補充檢驗（照同一門檻列出）
// 補充標籤只列出、不作門檻：S 看隔日開盤後是否回吐（I1）；W 看 20 日
const SCORES = { S: { label: 'S', extra: ['I1'] }, W: { label: 'W5', extra: ['W20'] } };
const SUB_KEYS = Object.values(SUB).flat();

const avg = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const median = xs => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const sameSign = (a, b) => a != null && b != null && Math.sign(a) === Math.sign(b) && a !== 0;

function initDb() {
  if (!getApps().length) {
    const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    initializeApp(p ? { credential: cert(JSON.parse(readFileSync(p, 'utf8'))) } : {});
  }
  return getFirestore();
}

// ── 1. 資料：殘缺日（<1500 檔）不進驗證集 ──
async function loadDays(db) {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS).select('date', 'closeJson', 'instJson').get();
  const raw = snap.docs.map(d => d.data()).filter(a => a?.closeJson)
    .map(a => ({ date: a.date, m: JSON.parse(a.closeJson), inst: a.instJson ? JSON.parse(a.instJson) : null }))
    .filter(d => Object.keys(d.m).length >= 1500).reverse();
  // 還原係數＝官方除權息歷史（backfill-exright-history.mjs）＋ priceEvents 的減資／面額變更；同檔同日以官方除權息為準（不重複乘）
  const ex = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'exright-history.json'), 'utf8'));
  const merged = mergeFactorItems(ex.items, (await db.collection('priceEvents').doc('latest').get()).data()?.items);
  return { days: applyPriceFactors(raw, factorsFromItems(merged)), nEvents: merged.length, exRange: [ex.from, ex.to] };
}

// ── 2. 面板：每日橫斷面＋超額標籤＋市況 ──
function buildPanel(days) {
  const panel = [];
  for (let t = 60; t < days.length - 1; t++) {
    const cs = crossSection(days, t); if (cs.codes.length < 100) continue;
    const lab = cs.codes.map(c => labelsFor(days, t, c));
    const Y = {}; for (const k of Object.keys(LABEL_STEP)) Y[k] = excess(lab.map(l => l[k]));
    panel.push({ date: cs.date, n: cs.codes.length, up: avg(cs.raws.map(r => r.chg1)) > 0,
      missF: cs.raws.filter(r => r.inst5 == null).length / cs.codes.length, factors: cs.factors, subs: cs.subs, Y });
  }
  return panel;
}

// 區段統計：平均取全部日；t 以非重疊抽樣（step 個起點各算一次，取中位數）
function segStats(series, idxs, step) {
  const vals = idxs.map(i => series[i]).filter(Number.isFinite);
  const ts = [];
  for (let o = 0; o < step; o++) { const r = meanT(idxs.filter((_, j) => j % step === o).map(i => series[i])); if (r.t != null) ts.push(r.t); }
  return { n: vals.length, nIndep: Math.floor(vals.length / step), mean: avg(vals), t: median(ts) };
}

function splitIdx(panel) {
  const cut = Math.floor(panel.length * TRAIN_FRAC);
  const train = [], oot = [];
  panel.forEach((_, i) => { if (i < cut) train.push(i); else if (i >= cut + EMBARGO) oot.push(i); });
  return { train, oot, all: [...train, ...oot] };
}

// ── 3. 因子 IC、閘門、正交性 ──
function factorIC(panel, sp) {
  const out = {};
  for (const L of Object.keys(LABEL_STEP)) {
    out[L] = {};
    for (const f of V3_FACTORS) {
      const s = panel.map(p => spearman(p.factors[f], p.Y[L]));
      const st = LABEL_STEP[L];
      const train = segStats(s, sp.train, st), oot = segStats(s, sp.oot, st), all = segStats(s, sp.all, st);
      out[L][f] = { train, oot, all, pass: sameSign(train.mean, oot.mean) && Math.abs(all.t ?? 0) >= T_MIN, passTrainOnly: Math.abs(train.t ?? 0) >= T_MIN };
    }
  }
  return out;
}

// 子因子 IC（診斷，不作門檻）：解讀因子方向由哪個子因子帶動
function subIC(panel, sp, L) {
  const out = {};
  for (const k of SUB_KEYS) {
    const s = panel.map(p => spearman(p.subs[k], p.Y[L]));
    out[k] = { train: segStats(s, sp.train, LABEL_STEP[L]), oot: segStats(s, sp.oot, LABEL_STEP[L]) };
  }
  return out;
}

function corrMatrix(panel, idxs) {
  const M = {};
  for (const a of V3_FACTORS) for (const b of V3_FACTORS) if (a < b) M[`${a}${b}`] = avg(idxs.map(i => spearman(panel[i].factors[a], panel[i].factors[b])));
  return M;
}

// 權重＝訓練期平均 IC（未過閘門＝0）；兩兩 |ρ|≥0.5 時剔除訓練 |t| 較小者
function weightsFor(icL, corr, gateKey) {
  const w = {}; const dropped = [];
  for (const f of V3_FACTORS) w[f] = icL[f][gateKey] ? icL[f].train.mean : 0;
  for (const [pair, r] of Object.entries(corr)) {
    const [a, b] = pair.split('');
    if (!(Math.abs(r ?? 0) >= ORTHO_MAX) || !w[a] || !w[b]) continue;
    const weak = Math.abs(icL[a].train.t ?? 0) < Math.abs(icL[b].train.t ?? 0) ? a : b;
    w[weak] = 0; dropped.push(`${weak}（與 ${a === weak ? b : a} 相關 ${f2(r)}）`);
  }
  return { w, dropped };
}

// ── 4. 總分評估 ──
function shuffled(arr, rnd) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function prng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

function evalComposite(panel, sp, w, L) {
  const step = LABEL_STEP[L];
  const cps = panel.map(p => compositePct(p.factors, w));
  const ic = panel.map((p, i) => spearman(cps[i], p.Y[L]));
  const dec = panel.map((p, i) => {
    const sum = new Array(10).fill(0), cnt = new Array(10).fill(0);
    cps[i].forEach((c, k) => { const y = p.Y[L][k]; if (y == null) return; const d = Math.min(9, Math.floor(c / 10)); sum[d] += y; cnt[d]++; });
    return sum.map((s, d) => (cnt[d] ? s / cnt[d] : null));
  });
  const spread = dec.map(d => (d[9] != null && d[0] != null ? d[9] - d[0] : null));
  const seg = idxs => ({ ic: segStats(ic, idxs, step), spread: segStats(spread, idxs, step),
    deciles: Array.from({ length: 10 }, (_, d) => avg(idxs.map(i => dec[i][d]))) });
  const train = seg(sp.train), oot = seg(sp.oot);
  const upIdx = sp.oot.filter(i => panel[i].up), dnIdx = sp.oot.filter(i => !panel[i].up);
  const regime = { up: segStats(ic, upIdx, step), down: segStats(ic, dnIdx, step) };
  const rnd = prng(20260930); const placebo = [];
  for (let k = 0; k < PLACEBO_N; k++) placebo.push(avg(sp.oot.map(i => spearman(cps[i], shuffled(panel[i].Y[L], rnd)))));
  const placeboAbs = avg(placebo.map(Math.abs));
  const gates = {
    ic: train.ic.mean > 0 && train.ic.t >= T_MIN && oot.ic.mean > 0 && oot.ic.t >= T_MIN,
    spread: train.spread.mean > 0 && oot.spread.mean > 0,
    regime: regime.up.mean > 0 && regime.down.mean > 0,
    placebo: oot.ic.mean > 0 && placeboAbs < oot.ic.mean / 3,
  };
  return { train, oot, regime, placeboAbs, gates, passed: Object.values(gates).every(Boolean) };
}

// ── 5. 報告 ──
function renderReport(R) {
  const L = [];
  L.push(`# 技術評分 v3 驗證報告（資料日 ${R.dataDate}）`, '');
  L.push(`> 規範：docs/SCORING-SPEC-v3.md §5。版本 ${VERSION}、資料雜湊 \`${R.dataHash}\`。產生：\`node scripts/scoring-v3-validate.mjs\`。`, '');
  L.push('## 結論', '');
  for (const [k, s] of Object.entries(R.scores)) {
    L.push(`- **${k === 'S' ? '短線分數 S' : '波段分數 W'}**（定權標籤 ${s.label}）：${s.eval.passed ? '✅ 通過 §5 全部門檻' : '❌ 未通過'}${s.eval.passed ? '' : `——未過：${Object.entries(s.eval.gates).filter(([, v]) => !v).map(([g]) => GATE_NAME[g]).join('、')}`}`);
  }
  L.push(`- 資料門檻：訓練 ${R.split.trainN} 日（需 ≥${MIN_TRAIN}）、樣本外 ${R.split.ootN} 日（需 ≥${MIN_OOT}）→ ${R.dataOk ? '✅' : '❌'}`, '');
  L.push('## 資料', '');
  L.push(`- 收盤歸檔 ${R.nDays} 日（${R.range[0]} ~ ${R.range[1]}；<1500 檔的殘缺日已剔除），還原事件 ${R.nEvents} 件（官方除權息 ${R.exRange.join('~')}＋priceEvents 減資／面額變更）；面板 ${R.panelN} 日、平均宇宙 ${f2(R.avgUniverse, 0)} 檔。`);
  L.push(`- 切分：訓練 ${R.split.trainRange.join(' ~ ')}｜禁區 ${EMBARGO} 日｜樣本外 ${R.split.ootRange.join(' ~ ')}（日期不重疊，20 日標籤亦不跨段）。`);
  L.push(`- F 籌碼缺值（法人 <3 日，以中性 50 計）平均比例 ${f2(R.missF * 100)}%。`);
  L.push('- 限制：處置股歷史名單沒有逐日歸檔，驗證期宇宙**未排除處置股**（線上影子模式會排除）；成交量未做減資還原。', '');
  L.push('## 因子相關（訓練期日均 Spearman；|ρ| ≥ 0.5 不合正交性）', '', '| 對 | ρ |', '|---|---|');
  for (const [p, r] of Object.entries(R.corr)) L.push(`| ${p[0]}–${p[1]} | ${f2(r)}${Math.abs(r ?? 0) >= ORTHO_MAX ? ' ⚠' : ''} |`);
  L.push('');
  for (const Lk of Object.keys(LABEL_STEP)) {
    L.push(`## 因子 IC：${LABEL_NAME[Lk]}（非重疊抽樣每 ${LABEL_STEP[Lk]} 日取 1 計 t）`, '');
    L.push('| 因子 | 訓練 IC | 訓練 t | 樣本外 IC | 樣本外 t | 合併 t | 閘門（同號＋合併|t|≥2） |', '|---|---|---|---|---|---|---|');
    for (const f of V3_FACTORS) {
      const x = R.ic[Lk][f];
      L.push(`| ${f} ${V3_FACTOR_LABEL[f]} | ${f2(x.train.mean, 4)} | ${f2(x.train.t)} | ${f2(x.oot.mean, 4)} | ${f2(x.oot.t)} | ${f2(x.all.t)} | ${x.pass ? '✅' : '—'}${x.pass && x.train.mean < 0 ? '（反向）' : ''} |`);
    }
    L.push('');
  }
  for (const [k, s] of Object.entries(R.scores)) {
    L.push(`## 總分 ${k}（定權標籤 ${s.label}）`, '');
    L.push(`- 權重：${V3_FACTORS.map(f => `${f} ${f2(s.weights[f], 4)}`).join('、')}${s.dropped.length ? `；正交性剔除 ${s.dropped.join('、')}` : ''}`);
    for (const [lab, e] of [[s.label, s.eval], ...s.extra.map(x => [x.label, x.ev])]) {
      L.push('', `### 標籤 ${LABEL_NAME[lab]}${lab === s.label ? '' : '——補充，不作門檻'}`, '');
      L.push('| 門檻 | 訓練 | 樣本外 | 結果 |', '|---|---|---|---|');
      L.push(`| 平均 IC（t≥2） | ${f2(e.train.ic.mean, 4)}（t ${f2(e.train.ic.t)}、獨立樣本 ${e.train.ic.nIndep}） | ${f2(e.oot.ic.mean, 4)}（t ${f2(e.oot.ic.t)}、獨立樣本 ${e.oot.ic.nIndep}） | ${e.gates.ic ? '✅' : '❌'} |`);
      L.push(`| D10−D1 超額（%） | ${f2(e.train.spread.mean)} | ${f2(e.oot.spread.mean)} | ${e.gates.spread ? '✅' : '❌'} |`);
      L.push(`| 市況分層 IC（樣本外 多方日／空方日） | — | ${f2(e.regime.up.mean, 4)}（${e.regime.up.n} 日）／${f2(e.regime.down.mean, 4)}（${e.regime.down.n} 日） | ${e.gates.regime ? '✅' : '❌'} |`);
      L.push(`| 安慰劑 |平均 IC|（${PLACEBO_N} 次打亂） | — | ${f2(e.placeboAbs, 4)} vs 真實 ÷3 = ${f2((e.oot.ic.mean ?? 0) / 3, 4)} | ${e.gates.placebo ? '✅' : '❌'} |`);
      L.push('', '十分位平均超額（%，D1 最弱 → D10 最強）：', '', '| 區段 | ' + Array.from({ length: 10 }, (_, d) => `D${d + 1}`).join(' | ') + ' |', '|---|' + '---|'.repeat(10));
      L.push(`| 訓練 | ${e.train.deciles.map(x => f2(x)).join(' | ')} |`, `| 樣本外 | ${e.oot.deciles.map(x => f2(x)).join(' | ')} |`);
    }
    const i1 = s.extra.find(x => x.label === 'I1')?.ev;
    if (i1) {
      const g = s.eval.oot.deciles, d = i1.oot.deciles;
      L.push('', `### 經濟意義（樣本外）`, '',
        `- D10（最強十分位）：隔夜超額 ${f2(g[9])}% ＋ 隔日盤中超額 ${f2(d[9])}% ＝ 收盤買到隔日收盤 ${f2((g[9] ?? 0) + (d[9] ?? 0))}%；D1：${f2(g[0])}% ＋ ${f2(d[0])}% ＝ ${f2((g[0] ?? 0) + (d[0] ?? 0))}%。`,
        `- 來回成本約 ${f2(ROUND_TRIP_COST)}%（手續費 0.1425%×2＋證交稅 0.3%，未計折讓）${Math.abs((g[9] ?? 0) - (g[0] ?? 0)) < ROUND_TRIP_COST ? '，大於 D10−D1 隔夜價差 ⇒ **單獨依 S 買賣不足以覆蓋成本**；S 的用途是排序「誰隔日開得相對高」，不是選股買進訊號' : ''}。`);
    }
    L.push('', `### 子因子 IC（標籤 ${s.label}；診斷）`, '', '| 子因子 | 訓練 IC | 訓練 t | 樣本外 IC | 樣本外 t |', '|---|---|---|---|---|');
    for (const [k, x] of Object.entries(s.sub)) L.push(`| ${k} | ${f2(x.train.mean, 4)} | ${f2(x.train.t)} | ${f2(x.oot.mean, 4)} | ${f2(x.oot.t)} |`);
    L.push('', `### 敏感度：因子只用訓練期 |t|≥2 選入（不看樣本外）`, '');
    L.push(`權重 ${V3_FACTORS.map(f => `${f} ${f2(s.sens.weights[f], 4)}`).join('、')} → 樣本外 IC ${f2(s.sens.eval.oot.ic.mean, 4)}（t ${f2(s.sens.eval.oot.ic.t)}）、D10−D1 ${f2(s.sens.eval.oot.spread.mean)}%、全部門檻 ${s.sens.eval.passed ? '✅' : '❌'}`, '');
  }
  L.push('## 解讀須知', '');
  L.push('- §5 因子閘門要求「訓練與樣本外同號」，等於讓樣本外參與了因子篩選，所以總分的樣本外檢定不算完全乾淨。上面的敏感度版本只用訓練期選因子，兩者一致才可信。');
  L.push('- 超額＝減當日宇宙等權平均，成本對所有標的相同故在超額口徑下抵銷；實際交易仍須扣手續費與稅。');
  L.push('- 通過 §5 只代表可進影子模式；上線切換須影子模式累積 ≥20 個交易日且前瞻勝過 v2（§8）。', '', '非投資建議。', '');
  return L.join('\n');
}
const GATE_NAME = { ic: '平均 IC', spread: 'D10−D1', regime: '市況分層', placebo: '安慰劑' };

// ── 主流程 ──
const db = initDb();
const { days, nEvents, exRange } = await loadDays(db);
console.log(`資料 ${days.length} 日（${days[0]?.date} ~ ${days.at(-1)?.date}），建面板中…`);
const panel = buildPanel(days);
const sp = splitIdx(panel);
const ic = factorIC(panel, sp);
const corr = corrMatrix(panel, sp.train);
const dataDate = days.at(-1).date;
const dataHash = createHash('sha1').update(days.map(d => `${d.date}:${Object.keys(d.m).length}`).join(',') + `|ev${nEvents}|${exRange.join('~')}`).digest('hex').slice(0, 12);
const trainN = sp.train.length, ootN = sp.oot.length;
const dataOk = trainN >= MIN_TRAIN && ootN >= MIN_OOT;

const scores = {};
for (const [k, cfg] of Object.entries(SCORES)) {
  const { w, dropped } = weightsFor(ic[cfg.label], corr, 'pass');
  const ev = evalComposite(panel, sp, w, cfg.label);
  const extra = cfg.extra.map(x => ({ label: x, ev: evalComposite(panel, sp, w, x) }));
  const sensW = weightsFor(ic[cfg.label], corr, 'passTrainOnly').w;
  scores[k] = { label: cfg.label, weights: w, dropped, eval: { ...ev, passed: ev.passed && dataOk }, extra, sub: subIC(panel, sp, cfg.label),
    sens: { weights: sensW, eval: evalComposite(panel, sp, sensW, cfg.label) } };
}

const R = { dataDate, dataHash, nDays: days.length, nEvents, exRange, range: [days[0].date, dataDate], panelN: panel.length,
  avgUniverse: avg(panel.map(p => p.n)), missF: avg(panel.map(p => p.missF)), corr, ic, scores, dataOk,
  split: { trainN, ootN, trainRange: [panel[sp.train[0]].date, panel[sp.train.at(-1)].date], ootRange: [panel[sp.oot[0]].date, panel[sp.oot.at(-1)].date] } };

for (const [k, s] of Object.entries(scores)) {
  const e = s.eval;
  console.log(`${k}：${e.passed ? '✅ 通過' : '❌ 未通過'}｜權重 ${V3_FACTORS.map(f => `${f}=${f2(s.weights[f], 4)}`).join(' ')}｜樣本外 IC ${f2(e.oot.ic.mean, 4)} t=${f2(e.oot.ic.t)}｜D10−D1 訓練 ${f2(e.train.spread.mean)} 樣本外 ${f2(e.oot.spread.mean)}｜閘門 ${JSON.stringify(e.gates)}`);
}
console.log(`資料門檻：訓練 ${trainN}、樣本外 ${ootN} → ${dataOk ? 'OK' : '不足'}`);
if (DRY) process.exit(0);

const md = renderReport(R);
writeFileSync(join(ROOT, 'docs', `SCORING-V3-VALIDATION-${dataDate}.md`), md);
const reviewBy = new Date(Date.parse(dataDate) + REVIEW_DAYS * 864e5).toISOString().slice(0, 10);
const weightsDoc = { version: VERSION, builtAt: new Date().toISOString(), dataDate, dataHash, reviewBy,
  trainRange: R.split.trainRange, ootRange: R.split.ootRange, embargo: EMBARGO,
  scores: Object.fromEntries(Object.entries(scores).map(([k, s]) => [k, { label: s.label, passed: s.eval.passed,
    weights: Object.fromEntries(V3_FACTORS.map(f => [f, +s.weights[f].toFixed(6)])),
    ootIC: +(s.eval.oot.ic.mean ?? 0).toFixed(6), ootT: +(s.eval.oot.ic.t ?? 0).toFixed(3), gates: s.eval.gates }])),
  note: '只有 passed=true 的分數可進影子模式；日常計算只讀此檔，不在線上重估。非投資建議。' };
writeFileSync(join(ROOT, 'scripts', 'data', 'scoring-v3-weights.json'), JSON.stringify(weightsDoc, null, 1) + '\n');
console.log(`✓ 報告 docs/SCORING-V3-VALIDATION-${dataDate}.md、權重 scripts/data/scoring-v3-weights.json`);
process.exit(0);
