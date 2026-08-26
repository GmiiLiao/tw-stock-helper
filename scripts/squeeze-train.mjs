// ═══════════════════════════════════════════════════════════════════
// 軋空判讀模型 · 訓練/回測引擎（每週二、五 01:00 後由 daemon 觸發）
//
// 產出三份東西：
//   squeezeModel/latest      主判讀模型 + 分支模型（狀態、權重、驗證數字）
//   squeezeTraining/global   國際盤日線歷史（回填 + 每日追加）
//   squeezeReport/{runId}    每次訓練的完整報表（供後台查閱歷史）
//
// 方法論（沿用本站 swing-lab 的驗收標準，不放水）：
//   · 樣本外三段切分，**每一段都要同向**才算過
//   · 必須贏「純動能基準」，只贏全市場基準不算數（軋空的價值在於加值）
//   · 單因子先掃，過關者才進組合；組合不得靠單一時段撐盤
//   · 標的用**隔日開盤報酬**（使用者是隔日沖，收盤報酬拿不到）
// ═══════════════════════════════════════════════════════════════════
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { fetchAllGlobalHistory, alignGlobal, buildStockFeatures, buildLabels, GLOBAL_SYMS } from './lib/squeeze-data.mjs';

function initDb() {
  if (!getApps().length) {
    const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    initializeApp(p ? { credential: cert(JSON.parse(readFileSync(p, 'utf8'))) } : {});
  }
  return getFirestore();
}

const log = (...a) => console.log(...a);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };

// ── 1. 載入台股歸檔並組成樣本 ────────────────────────────────────────
async function loadDays(db, limit) {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(limit).get();
  // ⚠ 排除**歸檔殘缺日**：2026-08-20 那天上櫃整批抓取失敗，closeJson 只有
  //   1,091 檔（正常 ~1,950）。殘缺日會讓「當天沒有任何上櫃股入選」被誤讀成
  //   訊號特性，也會讓 t+1 標的大量落空。少於 1,500 檔一律不進訓練集。
  const docs = snap.docs.map(d => d.data()).filter(a => {
    if (!a?.closeJson) return false;
    try { return Object.keys(JSON.parse(a.closeJson)).length >= 1500; } catch { return false; }
  });
  return docs.reverse().map(d => ({
    date: d.date,
    close: JSON.parse(d.closeJson),
    margin: d.marginJson ? JSON.parse(d.marginJson) : null,
    inst: d.instJson ? JSON.parse(d.instJson) : null,
    lend: d.lendingJson ? JSON.parse(d.lendingJson) : null,
  }));
}

// ── 2. 建樣本（含國際盤對齊）────────────────────────────────────────
export async function buildSamples(db, { days: nDays = 250, minPrice = 10, minAvgVol = 500 } = {}) {
  const days = await loadDays(db, nDays);
  const T = days.length;
  if (T < 40) throw new Error(`歸檔不足：${T} 日`);

  // 國際盤歷史：優先讀第二大腦已存的，缺才抓（訓練時順便補齊）
  let hist = null;
  try {
    const g = (await db.collection('squeezeTraining').doc('global').get()).data();
    if (g?.histJson) hist = JSON.parse(g.histJson);
  } catch { /* 重抓 */ }
  const twDates = days.map(d => d.date);
  const needRefresh = !hist || !hist.sox || !hist.sox[twDates[twDates.length - 1]];
  if (needRefresh) {
    log('  · 國際盤歷史回填中…');
    hist = await fetchAllGlobalHistory('2y');
    await db.collection('squeezeTraining').doc('global').set({
      histJson: JSON.stringify(hist), updatedAt: Date.now(),
      syms: GLOBAL_SYMS.map(([s, k]) => ({ sym: s, key: k })),
      days: Object.keys(hist.sox || {}).length,
    });
    log(`  · 國際盤已存 ${Object.keys(hist.sox || {}).length} 日`);
  }
  const gRows = alignGlobal(hist, twDates);

  const samples = [];
  for (let t = 25; t < T - 1; t++) {
    const g = gRows[days[t].date] || {};
    for (const code in days[t].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const f = buildStockFeatures(days, t, code);
      if (!f || !(f.close > minPrice) || !(f.avgVol >= minAvgVol)) continue;
      const y = buildLabels(days, t, code);
      if (!y) continue;
      samples.push({ t, date: days[t].date, code, f, g, y, seg: t < T / 3 ? 0 : (t < 2 * T / 3 ? 1 : 2) });
    }
  }
  return { samples, days, T, twDates };
}

// ── 3. 因子檢定 ────────────────────────────────────────────────────
// 通過條件（全部要滿足，缺一不可）：
//   ① n ≥ 80        ② 三段皆同向     ③ 勝率 > 基準勝率
//   ④ 平均報酬 > 純動能基準（不是全市場基準）
function evaluate(sel, samples, baseMomentum, label = 'openRet') {
  const g = samples.filter(sel);
  if (g.length < 80) return { n: g.length, pass: false, why: '樣本不足' };
  const rets = g.map(x => x.y[label]).filter(v => v != null);
  if (rets.length < 80) return { n: rets.length, pass: false, why: '標的缺值' };
  const segs = [0, 1, 2].map(k => {
    const r = g.filter(x => x.seg === k).map(x => x.y[label]).filter(v => v != null);
    return r.length >= 15 ? +mean(r).toFixed(3) : null;
  });
  const m = mean(rets);
  const win = rets.filter(v => v > 0).length / rets.length * 100;
  const segOk = segs.every(v => v != null && v > 0);
  const beatMom = m > baseMomentum.mean;
  return {
    n: rets.length, mean: +m.toFixed(3), win: +win.toFixed(1), segs,
    p25: pct(rets, 0.25), p75: pct(rets, 0.75),
    limitUpRate: +(g.filter(x => x.y.limitUp === 1).length / g.length * 100).toFixed(1),
    squeezeRate: +(g.filter(x => x.y.squeeze === 1).length / g.length * 100).toFixed(1),
    pass: segOk && beatMom && win > baseMomentum.win,
    why: !segOk ? '三段未同向' : !beatMom ? '未贏純動能基準' : win <= baseMomentum.win ? '勝率未過基準' : 'ok',
  };
}

// ── 4. 候選因子（含國際盤連動）──────────────────────────────────────
function factorGrid() {
  const F = [];
  const add = (name, group, sel) => F.push({ name, group, sel });
  // 個股·價
  add('漲≥5%', '價', x => x.f.chg >= 5);
  add('漲3~8.5%（可買區）', '價', x => x.f.chg >= 3 && x.f.chg <= 8.5);
  add('破20日高', '價', x => x.f.brk20 === 1);
  add('收位≥0.8', '價', x => x.f.pos != null && x.f.pos >= 0.8);
  add('5日漲幅≥10%', '價', x => x.f.ret5 != null && x.f.ret5 >= 10);
  // 個股·量
  add('量增≥2x', '量', x => x.f.volX != null && x.f.volX >= 2);
  add('量增 1.5~4x', '量', x => x.f.volX != null && x.f.volX >= 1.5 && x.f.volX <= 4);
  // 個股·籌碼（軋空核心）
  add('券資比10~20%', '券', x => x.f.ratio != null && x.f.ratio >= 10 && x.f.ratio < 20);
  add('券資比10~15%', '券', x => x.f.ratio != null && x.f.ratio >= 10 && x.f.ratio < 15);
  add('券資比≥20%', '券', x => x.f.ratio != null && x.f.ratio >= 20);
  add('融券增≥均量0.5%', '券', x => x.f.shVsVol != null && x.f.shVsVol >= 0.5);
  add('融券增幅≥30%', '券', x => x.f.shGrow != null && x.f.shGrow >= 30);
  add('券資比跳進(<10→10~20)', '券', x => x.f.ratioPrev != null && x.f.ratio != null && x.f.ratioPrev < 10 && x.f.ratio >= 10 && x.f.ratio < 20);
  add('借券增加', '券', x => x.f.lendChg != null && x.f.lendChg > 0);
  add('融資減但券增（空方單邊）', '券', x => x.f.mgnChg != null && x.f.shrtChg != null && x.f.mgnChg < 0 && x.f.shrtChg > 0);
  // 個股·法人
  add('法人淨買>0', '法', x => x.f.instNet != null && x.f.instNet > 0);
  add('法人淨買/均量≥5%', '法', x => x.f.instVsVol != null && x.f.instVsVol >= 5);
  add('外資買超>0', '法', x => x.f.foreign != null && x.f.foreign > 0);
  // 國際盤（PIT 合法：美股 t 日盤早於台股 t+1 開盤）
  add('費半漲>1%', '國際', x => x.g.sox_chg != null && x.g.sox_chg > 1);
  add('費半跌<-1%', '國際', x => x.g.sox_chg != null && x.g.sox_chg < -1);
  add('那斯達克漲>0.5%', '國際', x => x.g.nasdaq_chg != null && x.g.nasdaq_chg > 0.5);
  add('標普漲>0', '國際', x => x.g.sp500_chg != null && x.g.sp500_chg > 0);
  add('VIX<18（風險偏好）', '國際', x => x.g.vix_lvl != null && x.g.vix_lvl < 18);
  add('VIX>25（恐慌）', '國際', x => x.g.vix_lvl != null && x.g.vix_lvl > 25);
  add('日經漲>1%', '國際', x => x.g.n225_chg != null && x.g.n225_chg > 1);
  add('韓股漲>1%', '國際', x => x.g.kospi_chg != null && x.g.kospi_chg > 1);
  add('台股大盤漲>0.5%', '國際', x => x.g.twii_chg != null && x.g.twii_chg > 0.5);
  add('台幣升值', '國際', x => x.g.usdtwd_chg != null && x.g.usdtwd_chg < 0);
  return F;
}

// ── 4.5 樣本外驗證 ────────────────────────────────────────────────
// ⚠ 這一段是整個引擎的良心所在。28 個因子兩兩配對 ≈ 378 組，從中挑「最佳」
//   必然過擬合——第一版實測就選出「那斯達克>0.5% × 券資比跳進」勝率 83.8%，
//   那個數字是挑出來的、不是賺得到的。
//   ⇒ 選因子只准用**訓練段**（前 70%），選定後在**完全沒碰過的樣本外段**
//     （後 30%）驗一次，只有 OOT 也站得住的才准當主模型。
//   ⇒ 另跑安慰劑：把同樣的挑選流程套在隨機分組上，看「最佳組合」能虛高多少，
//     作為過擬合幅度的量尺。
function splitByTime(samples, trainFrac = 0.7) {
  const ts = [...new Set(samples.map(s => s.t))].sort((a, b) => a - b);
  const cut = ts[Math.floor(ts.length * trainFrac)];
  return {
    train: samples.filter(s => s.t < cut),
    oot: samples.filter(s => s.t >= cut),
    cutIdx: cut,
  };
}

function stat(g, label = 'openRet') {
  const r = g.map(x => x.y[label]).filter(v => v != null);
  if (!r.length) return { n: 0, mean: null, win: null };
  // 可買口徑：扣掉「隔日開盤即漲停鎖死」的那些——它們買不到，計進去是自欺。
  const bAll = g.filter(x => x.y.buyable != null);
  const buyRate = bAll.length ? +(bAll.filter(x => x.y.buyable === 1).length / bAll.length * 100).toFixed(1) : null;
  const rb = g.map(x => x.y.openRetBuyable).filter(v => v != null);
  return {
    n: r.length,
    mean: +mean(r).toFixed(3),
    win: +(r.filter(v => v > 0).length / r.length * 100).toFixed(1),
    buyRate,
    nBuyable: rb.length,
    meanBuyable: rb.length ? +mean(rb).toFixed(3) : null,
    winBuyable: rb.length ? +(rb.filter(v => v > 0).length / rb.length * 100).toFixed(1) : null,
    limitUpRate: +(g.filter(x => x.y.limitUp === 1).length / g.length * 100).toFixed(1),
    squeezeRate: +(g.filter(x => x.y.squeeze === 1).length / g.length * 100).toFixed(1),
  };
}

// ── 5. 主流程 ──────────────────────────────────────────────────────
export async function runTraining({ days = 250, quiet = false } = {}) {
  const db = initDb();
  const t0 = Date.now();
  const say = (...a) => { if (!quiet) log(...a); };
  say('▶ 軋空判讀模型訓練開始');

  const { samples, twDates } = await buildSamples(db, { days });
  say(`  · 樣本 ${samples.length.toLocaleString()} 筆｜期間 ${twDates[0]} ~ ${twDates[twDates.length - 1]}`);

  // ── 時間切分：選模只用訓練段，樣本外段完全不參與挑選 ──
  const { train, oot, cutIdx } = splitByTime(samples, 0.7);
  const cutDate = twDates[cutIdx] || '?';
  say(`  · 訓練段 ${train.length.toLocaleString()} 筆（~${cutDate} 前）｜樣本外 ${oot.length.toLocaleString()} 筆（${cutDate} 起）`);

  const mkBase = (set) => {
    const all = stat(set);
    const mom = stat(set.filter(x => x.f.chg >= 5));
    return { all, momentum: mom };
  };
  const baseTrain = mkBase(train), baseOot = mkBase(oot);
  say(`  · 訓練段基準：全市場 ${baseTrain.all.mean}%/${baseTrain.all.win}%｜純動能 ${baseTrain.momentum.mean}%/${baseTrain.momentum.win}%`);
  say(`  · 樣本外基準：全市場 ${baseOot.all.mean}%/${baseOot.all.win}%｜純動能 ${baseOot.momentum.mean}%/${baseOot.momentum.win}%（可買口徑 ${baseOot.momentum.meanBuyable}%/${baseOot.momentum.winBuyable}%·可買${baseOot.momentum.buyRate}%）`);

  // 單因子掃描（**只在訓練段**，一律疊在純動能上）
  const grid = factorGrid();
  const single = [];
  for (const f of grid) {
    const r = evaluate(x => x.f.chg >= 5 && f.sel(x), train, baseTrain.momentum);
    single.push({ ...r, name: f.name, group: f.group });
  }
  single.sort((a, b) => (b.pass - a.pass) || ((b.mean ?? -9) - (a.mean ?? -9)));
  const passed = single.filter(s2 => s2.pass);
  say(`  · 單因子（訓練段）：${grid.length} 受測 → ${passed.length} 通過`);

  // 兩兩組合（仍只在訓練段）
  const combos = [];
  for (let i = 0; i < passed.length; i++) {
    for (let j = i + 1; j < passed.length; j++) {
      const fi = grid.find(g => g.name === passed[i].name), fj = grid.find(g => g.name === passed[j].name);
      if (!fi || !fj || fi.group === fj.group) continue;
      const r = evaluate(x => x.f.chg >= 5 && fi.sel(x) && fj.sel(x), train, baseTrain.momentum);
      if (r.pass) combos.push({ ...r, name: `${fi.name} × ${fj.name}`, parts: [fi.name, fj.name] });
    }
  }
  combos.sort((a, b) => b.mean - a.mean);
  say(`  · 組合（訓練段）：${combos.length} 通過`);

  // ── 樣本外驗證：把訓練段挑出的前 N 名拿去沒碰過的區段驗 ──
  const selOf = (parts) => {
    const fs = parts.map(nm => grid.find(g => g.name === nm)).filter(Boolean);
    return x => x.f.chg >= 5 && fs.every(f => f.sel(x));
  };
  const cands = [...combos.slice(0, 12), ...passed.slice(0, 8).map(p => ({ ...p, parts: [p.name] }))];
  const validated = [];
  for (const c of cands) {
    const o = stat(oot.filter(selOf(c.parts)));
    if (o.n < 30) { validated.push({ ...c, oot: o, ootPass: false, ootWhy: '樣本外筆數不足' }); continue; }
    // 用**可買口徑**比較：分子分母都排除開盤鎖死，才是真的拿得到的報酬
    const mBuy = o.meanBuyable, bBuy = baseOot.momentum.meanBuyable;
    const wBuy = o.winBuyable, bwBuy = baseOot.momentum.winBuyable;
    const beat = mBuy != null && bBuy != null && mBuy > bBuy && wBuy > bwBuy && o.nBuyable >= 30;
    validated.push({ ...c, oot: o, ootPass: beat, ootWhy: beat ? 'ok' : (o.nBuyable < 30 ? '可買樣本不足' : '樣本外(可買口徑)未贏純動能') });
  }
  const survivors = validated.filter(v => v.ootPass).sort((a, b) => (b.oot.meanBuyable ?? -9) - (a.oot.meanBuyable ?? -9));
  say(`  · 樣本外驗證：${cands.length} 個候選 → ${survivors.length} 個存活`);

  // 安慰劑：隨機挑選同樣數量的組合，看「最佳」能虛高多少（過擬合量尺）
  let placebo = null;
  try {
    const rnd = [];
    for (let k = 0; k < 40; k++) {
      const pick = train.filter((_, idx) => (idx * 2654435761 + k * 40503) % 97 < 12);   // 決定性偽隨機分組
      const st = stat(pick);
      if (st.n >= 80) rnd.push(st.mean);
    }
    if (rnd.length) placebo = { maxOfRandom: +Math.max(...rnd).toFixed(3), meanOfRandom: +mean(rnd).toFixed(3), trials: rnd.length };
  } catch { /* 安慰劑失敗不擋 */ }

  // ── 軋空機率專用模型（使用者的原始目標：隔日開出軋空的最大機率）──────
  // 與主模型不同的目標函數：主模型最大化「可買隔日開盤報酬」（賺多少），
  // 這條最大化 **P(隔日軋空)**＝隔日漲≥5% 且融券真的減少（空單被迫回補）。
  // 硬性要求：必須含至少一個籌碼(券)因子——否則選出來的只是動能，
  // 叫它「軋空模型」名實不符（第一版就出過這個問題）。
  const sqRate = (set, sel) => {
    const g = set.filter(sel);
    if (!g.length) return { n: 0, rate: null };
    return { n: g.length, rate: +(g.filter(x => x.y.squeeze === 1).length / g.length * 100).toFixed(2) };
  };
  const baseSqTrain = sqRate(train, x => x.f.chg >= 5);
  const baseSqOot = sqRate(oot, x => x.f.chg >= 5);
  const chipFactors = grid.filter(g => g.group === '券');
  const otherFactors = grid.filter(g => g.group !== '券');
  const sqCands = [];
  for (const cf of chipFactors) {
    const solo = sqRate(train, x => x.f.chg >= 5 && cf.sel(x));
    if (solo.n >= 60) sqCands.push({ parts: [cf.name], train: solo });
    for (const of2 of otherFactors) {
      const r = sqRate(train, x => x.f.chg >= 5 && cf.sel(x) && of2.sel(x));
      if (r.n >= 60) sqCands.push({ parts: [cf.name, of2.name], train: r });
    }
  }
  sqCands.sort((a, b) => (b.train.rate ?? -1) - (a.train.rate ?? -1));
  const sqValidated = [];
  for (const c of sqCands.slice(0, 15)) {
    const o = sqRate(oot, selOf(c.parts));
    const pass = o.n >= 25 && o.rate != null && baseSqOot.rate != null && o.rate > baseSqOot.rate;
    sqValidated.push({ name: c.parts.join(' × '), parts: c.parts, train: c.train, oot: o, pass, why: pass ? 'ok' : (o.n < 25 ? '樣本外筆數不足' : '樣本外未贏純動能軋空率') });
  }
  const sqSurvivors = sqValidated.filter(v => v.pass).sort((a, b) => b.oot.rate - a.oot.rate);
  const squeezeModelBest = sqSurvivors[0] || null;
  say(`  · 軋空機率模型：候選 ${sqCands.length} → 驗證 ${sqValidated.length} → 存活 ${sqSurvivors.length}`);
  if (squeezeModelBest) {
    say(`      ${squeezeModelBest.name}`);
    say(`      訓練段軋空率 ${squeezeModelBest.train.rate}%(n=${squeezeModelBest.train.n}) → 樣本外 ${squeezeModelBest.oot.rate}%(n=${squeezeModelBest.oot.n})｜純動能基準 ${baseSqOot.rate}%`);
  } else {
    say('      ⚠ 無軋空專用組合通過樣本外（誠實結果）');
  }

  const main = survivors[0] || null;
  const branches = ['券', '量', '法', '國際', '價'].map(gp => {
    const b = passed.find(p => p.group === gp);
    if (!b) return { group: gp, pass: false, why: '訓練段無因子通過' };
    const o = stat(oot.filter(selOf([b.name])));
    return { group: gp, name: b.name, train: { mean: b.mean, win: b.win, n: b.n, segs: b.segs }, oot: o, pass: o.n >= 30 && o.mean > baseOot.momentum.mean };
  });

  const runId = `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
  const model = {
    runId, updatedAt: Date.now(), trainMs: Date.now() - t0,
    period: { from: twDates[0], to: twDates[twDates.length - 1], days: twDates.length, oosFrom: cutDate },
    samples: samples.length, trainN: train.length, ootN: oot.length,
    label: 'openRet（隔日開盤報酬·隔日沖實際可取得）',
    baseline: { train: baseTrain, oot: baseOot },
    main: main ? {
      name: main.name, parts: main.parts,
      train: { mean: main.mean, win: main.win, n: main.n, segs: main.segs },
      oot: main.oot,
      edgeVsMomentum: +((main.oot.meanBuyable ?? 0) - (baseOot.momentum.meanBuyable ?? 0)).toFixed(3),
    } : null,
    branches,
    squeezeProb: squeezeModelBest ? {
      name: squeezeModelBest.name, parts: squeezeModelBest.parts,
      train: squeezeModelBest.train, oot: squeezeModelBest.oot,
      baseline: { train: baseSqTrain, oot: baseSqOot },
      lift: +(squeezeModelBest.oot.rate - (baseSqOot.rate ?? 0)).toFixed(2),
    } : { status: 'no_edge', baseline: { train: baseSqTrain, oot: baseSqOot }, note: '無軋空專用組合通過樣本外驗收' },
    squeezeValidated: sqValidated,
    validated: validated.map(v => ({ name: v.name, parts: v.parts, trainMean: v.mean, trainWin: v.win, oot: v.oot, ootPass: v.ootPass, ootWhy: v.ootWhy })),
    singleTop: single.slice(0, 16),
    passedCount: passed.length, comboCount: combos.length, survivorCount: survivors.length,
    placebo,
    status: main ? 'ok' : 'no_edge',
    note: main ? null : '本輪沒有任何組合通過樣本外驗收——這是誠實結果，不是故障。訊號可能正在失效，請勿依賴舊模型下單。',
  };
  await db.collection('squeezeModel').doc('latest').set(model);
  await db.collection('squeezeReport').doc(runId).set({ ...model, single, combos: combos.slice(0, 30) });
  if (main) {
    say(`  ✓ 主模型：${main.name}`);
    say(`      樣本外(全部)   ${main.oot.mean}%/${main.oot.win}% n=${main.oot.n}`);
    say(`      樣本外(可買)   ${main.oot.meanBuyable}%/${main.oot.winBuyable}% n=${main.oot.nBuyable}｜可買比例 ${main.oot.buyRate}%`);
    say(`      樣本外淨勝純動能 ${model.main.edgeVsMomentum >= 0 ? '+' : ''}${model.main.edgeVsMomentum}pp`);
  } else {
    say('  ⚠ 本輪無模型通過樣本外驗收（誠實結果）');
  }
  say(`  ✓ 報表 squeezeReport/${runId}`);
  return model;
}

// CLI
// ⚠ 不可用 `import.meta.url === 'file://'+process.argv[1]` 比對：本專案路徑含中文
//   （股票助手app），import.meta.url 會百分比編碼而 argv[1] 不會 ⇒ 永遠不相等，
//   腳本會安靜地什麼都不做、還回 exit 0（實際踩過）。改用解碼後的 pathname 比對。
const _isCli = (() => {
  try { return decodeURIComponent(new URL(import.meta.url).pathname) === process.argv[1]; }
  catch { return false; }
})();
if (_isCli) {
  const n = Number(process.argv[2] || 250);
  runTraining({ days: n }).then(() => process.exit(0)).catch(e => { console.error('✖', e); process.exit(1); });
}
