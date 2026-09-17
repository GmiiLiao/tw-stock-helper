// ═══════════════════════════════════════════════════════════════════
// 軋空判讀模型 · 訓練/回測引擎（每週二、五 01:00 後由 daemon 觸發）
//
// 產出三份東西：
//   squeezeModel/latest      主判讀模型 + 分支模型（狀態、權重、驗證數字）
//   squeezeTraining/global   國際盤日線歷史（回填 + 每日追加）
//   squeezeReport/{runId}    每次訓練的完整報表（供後台查閱歷史）
//
// 方法論 v2（2026-09-17 重規畫，docs/SQUEEZE-MODEL-REDESIGN-2026-09-17.md；使用者決定三套交易模式可切換）：
//   · 三套交易定義各自訓練：隔日沖（今收買→明開賣）、當沖（明開買→明收賣）、波段持有（今收買→第5日收賣）
//   · 進場可買先剔除：隔日沖／波段＝t 日收盤未鎖停；當沖＝t+1 開盤未鎖停。舊版把「明開鎖停」當不可買、卻放行「今收鎖停」，
//     剔除後隔日沖純動能基準由 +1.62% 掉到 +0.57%——舊的「有效」有一部分靠鎖停股撐（首次乾跑 2026-09-17 實證）
//   · 切點固定 2026-06-10；三段在**訓練段內**切，各段要贏基準
//   · 統計用日層級超額（對純動能）＋按日區塊自助法 95% CI；狀態三態：有效／無顯著差異／失效
//   · 單因子先掃，過關者才進組合；樣本外同一把尺；分支表每群列前兩名
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
    sbl: d.sblJson ? JSON.parse(d.sblJson) : null,   // E 段：借券賣出餘額 {code: [餘額張, 當日賣出張]}（2026-09-18 起）
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
  // ── 新聞判別（2026-08-31 接入）──────────────────────────
  // 這是模型從沒看過的維度：前面 28 個因子全是價量籌碼，
  // 在同一份固定菜單裡重選，跑再多次也不會進步。
  // ⚠ 判別自 2026-08-27 才開始累積，樣本遠不足 ⇒ **覆蓋率不到門檻就不啟用**。
  //   現在硬跑出來的數字是雜訊，比沒有更糟（見 docs/EXPERIMENTS.md 的紀律）。
  const newsByDate = {};
  try {
    const snap = await db.collection('newsVerdict').orderBy('targetDate', 'desc').limit(400).get();
    for (const d of snap.docs) {
      if (d.id === 'latest') continue;          // 摘要文件不是一個交易日（K 族）
      const x = d.data();
      if (!x?.targetDate || !x.verdictJson) continue;
      newsByDate[x.targetDate] = JSON.parse(x.verdictJson);
    }
  } catch { /* 讀不到就當作沒有新聞維度，不擋訓練 */ }
  const newsDays = Object.keys(newsByDate).length;
  // ⚠ 對齊（2026-09-17 使用者質疑「比分是不是有問題」後查出）：判別文件鍵＝targetDate＝「這批判別給哪個交易日用」。
  //   舊寫法把 targetDate=t 的判別掛在 t 日樣本上，再對 t+1 開盤——晚了一天，於是「利多／中性沒差」。
  //   正確對齊分兩種，依交易模式：
  //     · 當沖（t+1 開買）：用 targetDate=t+1 的判別（t 晚 23:00 盤後趟＋t+1 早 07:00 晨間趟，都在 t+1 開盤前）→ f.newsNext*
  //     · 隔日沖／波段（t 收買）：t 收盤前只知道 targetDate=t 且 pass=intraday 的判別 → f.newsIntra*
  //   舊的 f.newsLabel（targetDate=t，各趟）保留給相容，不再當因子。
  const nextDate = {}; for (let i = 0; i + 1 < twDates.length; i++) nextDate[twDates[i]] = twDates[i + 1];
  const newsNextDays = Object.keys(newsByDate).filter(d => Object.values(nextDate).includes(d)).length;

  // ── 事件股排除（§2.2，使用者 2026-09-17 決定「加入」）──────────────────
  //   減資／面額變更／分割／大額除權的股，事件日前後 ±30 個日曆日（≈20 個交易日）的樣本一律剔除——
  //   不用係數還原（係數誤差會進標籤），直接排除。有沒有係數都排（無來源的 2 件也是跳價，一樣不可信）。
  //   來源：daemon 每日 15:10 寫的 priceEvents/latest（相鄰有收盤日比值超出 ±20%）。
  const evByCode = {};
  try {
    const pe = (await db.collection('priceEvents').doc('latest').get()).data();
    for (const e of (pe?.items || [])) if (e?.code && e?.date) (evByCode[e.code] ||= []).push(Date.parse(e.date));
  } catch { /* 沒有事件表就不排除，報表會顯示 0 */ }
  const EV_WIN = 30 * 86400000;
  const nearEvent = (code, dateIso) => { const arr = evByCode[code]; if (!arr) return false; const t0 = Date.parse(dateIso); return arr.some(ev => Math.abs(t0 - ev) <= EV_WIN); };
  let excludedEvents = 0;

  // ── C 段（docs/SQUEEZE-MODEL-VARIABLES §5-C，2026-09-18）：族群相對強度／同步率、位置／路徑、市況條件 ──
  //   族群對照用 peerComps/latest（同業表，站上既有）；每日算族群中位漲幅、同步率（族群內漲≥3% 比例）、族群排名百分位。
  //   位置／路徑：距 60 日高／低、連漲天數、首次突破 20 日高（昨日未突破、今日突破）。全部只用 ≤t 的收盤。
  const groupOf = {};
  try {
    const pc = (await db.collection('peerComps').doc('latest').get()).data();
    if (pc?.industriesJson) { const ind = JSON.parse(pc.industriesJson); for (const g in ind) for (const it of ind[g]) if (it?.code) groupOf[it.code] = g; }
  } catch { /* 沒有族群表就沒有族群因子（欄位留 null） */ }
  const sectorStatsOf = (t) => {
    const acc = {};
    for (const code in days[t].close) {
      const g = groupOf[code]; if (!g) continue;
      const c = days[t].close[code]?.[C0], p = days[t - 1]?.close[code]?.[C0]; if (!(c > 0) || !(p > 0)) continue;
      (acc[g] ||= []).push((c - p) / p * 100);
    }
    const out = {}; const meds = [];
    for (const g in acc) { const a = acc[g].sort((x, y) => x - y); if (a.length < 3) continue; const med = a[Math.floor(a.length / 2)]; out[g] = { med, sync: a.filter(v => v >= 3).length / a.length, n: a.length }; meds.push(med); }
    meds.sort((x, y) => x - y);
    for (const g in out) out[g].rank = meds.length > 1 ? meds.findIndex(v => v >= out[g].med) / (meds.length - 1) : null;
    return out;
  };

  // ── A 段（docs/SQUEEZE-MODEL-VARIABLES §4-4）：市況 regime＝當日漲家數比的三分位（多頭／中性／空頭）──
  //   用 t 日自己的漲家數比（t 日收盤後已知，PIT 合法）。每筆樣本帶 rg，評估時分層報告，主模型須多頭／空頭兩層都不為負。
  const regimeByDate = {};
  const ratios = [];
  for (let t = 1; t < T; t++) {
    let up = 0, n = 0;
    for (const code in days[t].close) { const c = days[t].close[code]?.[C0], p = days[t - 1].close[code]?.[C0]; if (!(c > 0) || !(p > 0)) continue; n++; if (c > p) up++; }
    const r = n ? up / n : null;
    regimeByDate[days[t].date] = r == null ? null : { upRatio: +r.toFixed(3), rg: 'neutral' };
    if (r != null) ratios.push(r);
  }
  // ⚠ 固定 55%／45% 在台股會把 56% 的日子判成空頭（漲家數比中位數約 0.42，小型股常態偏跌）。
  //   改用視窗自身的三分位：上三分之一多頭、下三分之一空頭，門檻寫進報表（regimeCuts）。
  const rgLo = pct(ratios, 1 / 3), rgHi = pct(ratios, 2 / 3);
  for (const d in regimeByDate) { const x = regimeByDate[d]; if (!x) continue; x.rg = x.upRatio >= rgHi ? 'bull' : x.upRatio <= rgLo ? 'bear' : 'neutral'; }
  const regimeCuts = { lo: +rgLo.toFixed(3), hi: +rgHi.toFixed(3) };

  for (let t = 25; t < T - 1; t++) {
    const g = gRows[days[t].date] || {};
    const nv = newsByDate[days[t].date] || {};
    const rg = regimeByDate[days[t].date]?.rg || 'neutral';
    const sec = sectorStatsOf(t);
    for (const code in days[t].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      if (nearEvent(code, days[t].date)) { excludedEvents++; continue; }
      const f = buildStockFeatures(days, t, code);
      if (!f || !(f.close > minPrice) || !(f.avgVol >= minAvgVol)) continue;
      // C 段：族群
      const grp = groupOf[code]; const st = grp ? sec[grp] : null;
      f.sector = grp || null; f.relSector = st ? +(f.chg - st.med).toFixed(2) : null; f.sectorSync = st ? +st.sync.toFixed(3) : null; f.sectorRank = st?.rank ?? null;
      // C 段：位置／路徑（≤t）
      let hi60 = 0, lo60 = Infinity, hi20prev = 0, up = 0;
      for (let k = 1; k <= 60; k++) { const c = days[t - k]?.close[code]?.[C0]; if (!(c > 0)) continue; if (c > hi60) hi60 = c; if (c < lo60) lo60 = c; if (k >= 2 && k <= 21 && c > hi20prev) hi20prev = c; }
      for (let k = 0; k < 15; k++) { const c = days[t - k]?.close[code]?.[C0], p = days[t - k - 1]?.close[code]?.[C0]; if (c > 0 && p > 0 && c > p) up++; else break; }
      const prevClose = days[t - 1]?.close[code]?.[C0];
      f.distHi60 = hi60 > 0 ? +((f.close / hi60 - 1) * 100).toFixed(2) : null;
      f.distLo60 = Number.isFinite(lo60) && lo60 > 0 ? +((f.close / lo60 - 1) * 100).toFixed(2) : null;
      f.upStreak = up;
      f.firstBreak20 = f.brk20 === 1 && hi20prev > 0 && prevClose > 0 && prevClose <= hi20prev ? 1 : 0;
      const y = buildLabels(days, t, code);
      if (!y) continue;
      const nvi = nv[code];
    if (nvi) { f.newsLabel = nvi.label; f.newsStrength = nvi.strength || null; f.newsPriced = nvi.priced || null; }
    const nvNext = newsByDate[nextDate[days[t].date]]?.[code];
    if (nvNext) { f.newsNextLabel = nvNext.label; f.newsNextStrength = nvNext.strength || null; f.newsNextPriced = nvNext.priced || null; f.newsNextConf = nvNext.confidence || null; f.newsNextCarried = !!nvNext.carriedFrom; }
    if (nvi && nvi.pass === 'intraday') { f.newsIntraLabel = nvi.label; f.newsIntraStrength = nvi.strength || null; f.newsIntraPriced = nvi.priced || null; }
    samples.push({ t, date: days[t].date, code, f, g, y, rg, seg: t < T / 3 ? 0 : (t < 2 * T / 3 ? 1 : 2) });
    }
  }
  return { samples, days, T, twDates, newsDays, newsNextDays, excludedEvents, eventCodes: Object.keys(evByCode).length, regimeByDate, regimeCuts };
}
const C0 = 0;   // closeJson 列格式 [收, 量張, 開, 高, 低]
const COST_PCT = 0.4425;   // 手續費（折讓前）＋證交稅，不含價差；A 段絕對報酬閘門用

// ── 3. 規則 v2（2026-09-17 重規畫·docs/SQUEEZE-MODEL-REDESIGN-2026-09-17.md）──────────────
// 使用者決定：交易定義做成**兩套可切換**（隔日沖／當沖）、切點首版釘 2026-06-10、四段全做。
// 第一、二段落地於此：交易定義與進場可買、日層級統計與區塊自助法信賴區間、三態、三段在訓練段內切、固定切點、
// 資料集雜湊。第三段（門檻分位數化、隨機因子安慰劑、走動式）與第四段（版本化、校準）另行。
import { createHash } from 'node:crypto';

export const TRADE_MODES = {
  // 隔日沖：t 收買 → t+1 開賣。進場限制＝t 日收盤未鎖漲停；t+1 開盤鎖停是最佳出場，不剔除。
  nextday:  { key: 'nextday',  label: '今收買→明開賣（隔日沖）', ret: y => y.openRet, entryOk: y => y.entryLocked === 0 },
  // 當沖：t+1 開買 → t+1 收賣。進場限制＝t+1 開盤未鎖漲停（既有 buyable）。
  daytrade: { key: 'daytrade', label: '明開買→明收賣（當沖）',   ret: y => y.dtRet,   entryOk: y => y.buyable === 1 },
  // 波段持有（使用者 2026-09-17 加）：t 收買 → t+5 收賣。進場限制同隔日沖；連漲多日的股由「5日漲幅≥10%」等因子承接。
  swing:    { key: 'swing',    label: '今收買→第5日收賣（波段持有）', ret: y => y.hold5Ret, entryOk: y => y.entryLocked === 0 },
};
export const OOS_FROM = process.env.OOS_FROM || '2026-06-10';   // 固定切點（§2.4）；季度由人決定是否前移
const MIN_N = 80, MIN_DAYS = 40, BOOT_ITERS = 1000, BOOT_BLOCK = 5;
const STATE_LABEL = { valid: '有效', ns: '無顯著差異', invalid: '失效' };

// 決定性偽隨機（訓練要可重現）
export function prng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// 每日基準：某天「純動能母體（漲≥5% 且進場可買）」的平均報酬。日層級超額都對它算。
export function dayBaseline(set, mode) {
  const acc = {};
  for (const x of set) { const r = mode.ret(x.y); if (r == null) continue; (acc[x.date] ||= []).push(r); }
  const out = {}; for (const d in acc) out[d] = mean(acc[d]);
  return out;
}

// 區塊自助法（按日、block=5）：回傳平均超額與 95% CI
function blockBootstrap(daily, iters = BOOT_ITERS, block = BOOT_BLOCK, seed = 7) {
  const n = daily.length; if (!n) return { mean: null, lo: null, hi: null };
  const m = mean(daily);
  if (n < 8) return { mean: +m.toFixed(3), lo: null, hi: null };
  const rnd = prng(seed); const means = [];
  for (let k = 0; k < iters; k++) {
    let s = 0, c = 0;
    while (c < n) { const start = Math.floor(rnd() * n); for (let j = 0; j < block && c < n; j++, c++) s += daily[(start + j) % n]; }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { mean: +m.toFixed(3), lo: +means[Math.floor(iters * 0.025)].toFixed(3), hi: +means[Math.floor(iters * 0.975) - 1].toFixed(3) };
}

// 一組樣本的完整統計（逐筆＋日層級）。base＝dayBaseline；segOf＝日期→段（0/1/2），null 表示不分段
export function evalGroup(g, mode, base, segOf = null) {
  const rows = g.map(x => ({ d: x.date, r: mode.ret(x.y), rg: x.rg || 'neutral', seg: segOf ? segOf(x.date) : null })).filter(x => x.r != null);
  const n = rows.length;
  if (n < MIN_N) return { n, days: 0, mean: null, win: null, excess: null, ci: null, net: null, segs: null, byRegime: null, pass: false, state: 'ns', stateLabel: '樣本不足', why: '樣本不足' };
  const byDay = {}; const rgOf = {}; for (const x of rows) { (byDay[x.d] ||= []).push(x.r); rgOf[x.d] = x.rg; }
  const dates = Object.keys(byDay).sort();
  const daily = dates.map(d => mean(byDay[d]) - (base[d] ?? 0));   // 日層級超額（對純動能）
  const dailyNet = dates.map(d => mean(byDay[d]) - COST_PCT);      // A 段：日層級淨報酬（扣費稅）
  const boot = blockBootstrap(daily);
  const bootNet = blockBootstrap(dailyNet, BOOT_ITERS, BOOT_BLOCK, 11);
  const segs = segOf ? [0, 1, 2].map(k => { const a = dates.filter(d => segOf(d) === k).map(d => mean(byDay[d]) - (base[d] ?? 0)); return a.length >= 8 ? +mean(a).toFixed(3) : null; }) : null;
  // A 段：市況分層（多頭／空頭／中性各自的日層級超額與淨報酬；<8 日的層標 null，不做結論）
  const byRegime = {};
  for (const k of ['bull', 'neutral', 'bear']) {
    const ds = dates.filter(d => rgOf[d] === k);
    byRegime[k] = ds.length >= 8 ? { days: ds.length, excess: +mean(ds.map(d => mean(byDay[d]) - (base[d] ?? 0))).toFixed(3), net: +mean(ds.map(d => mean(byDay[d]) - COST_PCT)).toFixed(3) } : { days: ds.length, excess: null, net: null };
  }
  const win = rows.filter(x => x.r > 0).length / n * 100;
  const state = boot.lo == null ? 'ns' : boot.lo > 0 ? 'valid' : boot.hi < 0 ? 'invalid' : 'ns';
  const segOk = !segs || segs.every(v => v != null && v > 0);
  const netOk = bootNet.lo != null && bootNet.lo > 0;
  const regimeOk = ['bull', 'bear'].every(k => byRegime[k].excess == null || byRegime[k].excess >= 0);   // 兩層都不為負（層太小不計）
  const pass = dates.length >= MIN_DAYS && state === 'valid' && segOk && netOk && regimeOk;
  const why = dates.length < MIN_DAYS ? `交易日不足（${dates.length}<${MIN_DAYS}）` : !segOk ? '三段未皆贏基準' : state !== 'valid' ? (state === 'invalid' ? '顯著輸基準' : 'CI 跨 0（無顯著差異）') : !netOk ? `淨報酬未過（扣費稅後 CI 下界 ${bootNet.lo ?? '—'}）` : !regimeOk ? `市況分層有一層為負（多頭 ${byRegime.bull.excess}／空頭 ${byRegime.bear.excess}）` : 'ok';
  return {
    n, days: dates.length, mean: +mean(rows.map(x => x.r)).toFixed(3), win: +win.toFixed(1),
    excess: boot.mean, ci: [boot.lo, boot.hi], net: { mean: bootNet.mean, ci: [bootNet.lo, bootNet.hi] }, byRegime,
    segs, state, stateLabel: STATE_LABEL[state], pass, why,
    limitUpRate: +(g.filter(x => x.y.limitUp === 1).length / g.length * 100).toFixed(1),
    squeezeRate: +(g.filter(x => x.y.squeeze === 1).length / g.length * 100).toFixed(1),
  };
}

// ── 4. 候選因子 ───────────────────────────────────────────────────
const NEWS_MIN_DAYS = +(process.env.NEWS_MIN_DAYS || 30);
// 第三段（§2.3）：連續型因子另加**分位數門檻**版本，門檻由訓練段母體算出並寫進名稱與報表，不再只靠手寫常數。
//   q＝{ volX:{p20,p80}, ratio:{p80}, instVsVol:{p80}, ret5:{p80}, pos:{p80}, shVsVol:{p80} }（缺就不加）
function factorGrid(newsDays = 0, q = null) {
  const F = [];
  const add = (name, group, sel, dir = '+') => F.push({ name, group, sel, dir });
  if (q) {
    const qq = (k, p) => q[k]?.[p];
    if (qq('volX', 'p80') != null) add(`量比≥P80(${qq('volX', 'p80')})`, '量', x => x.f.volX != null && x.f.volX >= qq('volX', 'p80'));
    if (qq('volX', 'p20') != null) add(`量比<P20(${qq('volX', 'p20')})縮量`, '量', x => x.f.volX != null && x.f.volX < qq('volX', 'p20'));
    if (qq('ratio', 'p80') != null) add(`券資比≥P80(${qq('ratio', 'p80')}%)`, '券', x => x.f.ratio != null && x.f.ratio >= qq('ratio', 'p80'));
    if (qq('shVsVol', 'p80') != null) add(`融券增/均量≥P80(${qq('shVsVol', 'p80')}%)`, '券', x => x.f.shVsVol != null && x.f.shVsVol >= qq('shVsVol', 'p80'));
    if (qq('instVsVol', 'p80') != null) add(`法人淨買/均量≥P80(${qq('instVsVol', 'p80')}%)`, '法', x => x.f.instVsVol != null && x.f.instVsVol >= qq('instVsVol', 'p80'));
    if (qq('ret5', 'p80') != null) add(`5日漲幅≥P80(${qq('ret5', 'p80')}%)`, '價', x => x.f.ret5 != null && x.f.ret5 >= qq('ret5', 'p80'));
    if (qq('pos', 'p80') != null) add(`收位≥P80(${qq('pos', 'p80')})`, '價', x => x.f.pos != null && x.f.pos >= qq('pos', 'p80'));
  }
  add('漲≥5%', '價', x => x.f.chg >= 5);
  add('漲3~8.5%（可買區）', '價', x => x.f.chg >= 3 && x.f.chg <= 8.5);
  add('破20日高', '價', x => x.f.brk20 === 1);
  add('收位≥0.8', '價', x => x.f.pos != null && x.f.pos >= 0.8);
  add('5日漲幅≥10%', '價', x => x.f.ret5 != null && x.f.ret5 >= 10);
  add('量增≥2x', '量', x => x.f.volX != null && x.f.volX >= 2);
  add('量增 1.5~4x', '量', x => x.f.volX != null && x.f.volX >= 1.5 && x.f.volX <= 4);
  // v2 量群補反向（§2.3）：縮量長紅、量價背離
  add('量縮長紅（量比<0.8）', '量', x => x.f.volX != null && x.f.volX < 0.8);
  add('量增但未創20日高（量價背離）', '量', x => x.f.volX != null && x.f.volX >= 1.5 && x.f.brk20 === 0);
  add('券資比10~20%', '券', x => x.f.ratio != null && x.f.ratio >= 10 && x.f.ratio < 20);
  add('券資比10~15%', '券', x => x.f.ratio != null && x.f.ratio >= 10 && x.f.ratio < 15);
  add('券資比≥20%', '券', x => x.f.ratio != null && x.f.ratio >= 20);
  add('融券增≥均量0.5%', '券', x => x.f.shVsVol != null && x.f.shVsVol >= 0.5);
  add('融券增幅≥30%', '券', x => x.f.shGrow != null && x.f.shGrow >= 30);
  add('券資比跳進(<10→10~20)', '券', x => x.f.ratioPrev != null && x.f.ratio != null && x.f.ratioPrev < 10 && x.f.ratio >= 10 && x.f.ratio < 20);
  add('借券增加', '券', x => x.f.lendChg != null && x.f.lendChg > 0);
  add('融資減但券增（空方單邊）', '券', x => x.f.mgnChg != null && x.f.shrtChg != null && x.f.mgnChg < 0 && x.f.shrtChg > 0);
  add('法人淨買>0', '法', x => x.f.instNet != null && x.f.instNet > 0);
  add('法人淨買/均量≥5%', '法', x => x.f.instVsVol != null && x.f.instVsVol >= 5);
  add('外資買超>0', '法', x => x.f.foreign != null && x.f.foreign > 0);
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
  // 新聞因子依交易模式取 PIT 合法的那份：當沖＝newsNext（t+1 開盤前已知）、隔日沖／波段＝newsIntra（t 收盤前已知的盤中判別）
  if (newsDays >= NEWS_MIN_DAYS && q?.newsKey) {
    const K = q.newsKey;   // 'newsNext' | 'newsIntra'
    const L = x => x.f[`${K}Label`], S = x => x.f[`${K}Strength`], P = x => x.f[`${K}Priced`];
    add('新聞判利多', '聞', x => L(x) === '利多');
    add('新聞判利多且強度強以上', '聞', x => L(x) === '利多' && (S(x) === '強' || S(x) === '極強'));
    add('新聞判利多且市場未預期', '聞', x => L(x) === '利多' && P(x) === '否');
    add('新聞非利空', '聞', x => L(x) !== undefined && L(x) !== '利空');
  }
  return F;
}

// 舊介面保留（其他腳本引用）：逐筆統計，含可買口徑
function stat(g, label = 'openRet') {
  const r = g.map(x => x.y[label]).filter(v => v != null);
  if (!r.length) return { n: 0, mean: null, win: null };
  const bAll = g.filter(x => x.y.buyable != null);
  const buyRate = bAll.length ? +(bAll.filter(x => x.y.buyable === 1).length / bAll.length * 100).toFixed(1) : null;
  const rb = g.map(x => x.y.openRetBuyable).filter(v => v != null);
  return {
    n: r.length, mean: +mean(r).toFixed(3), win: +(r.filter(v => v > 0).length / r.length * 100).toFixed(1), buyRate,
    nBuyable: rb.length, meanBuyable: rb.length ? +mean(rb).toFixed(3) : null, winBuyable: rb.length ? +(rb.filter(v => v > 0).length / rb.length * 100).toFixed(1) : null,
    limitUpRate: +(g.filter(x => x.y.limitUp === 1).length / g.length * 100).toFixed(1),
    squeezeRate: +(g.filter(x => x.y.squeeze === 1).length / g.length * 100).toFixed(1),
  };
}

function datasetHash(samples, twDates) {
  const h = createHash('sha1');
  h.update(twDates.join(','));
  let s = 0; for (const x of samples) s += Math.round((x.y.openRet ?? 0) * 100);
  h.update(`|${samples.length}|${s}`);
  return h.digest('hex').slice(0, 12);
}

// 訓練段母體的分位數（純動能母體上算，與因子測試同母體）
function quantiles(set) {
  const q = {};
  const take = (k, ps) => { const a = set.map(x => x.f[k]).filter(v => v != null && Number.isFinite(v)); if (a.length < 200) return; q[k] = {}; for (const p of ps) q[k][`p${Math.round(p * 100)}`] = +pct(a, p).toFixed(2); };
  take('volX', [0.2, 0.8]); take('ratio', [0.8]); take('shVsVol', [0.8]); take('instVsVol', [0.8]); take('ret5', [0.8]); take('pos', [0.8]);
  return q;
}

// 第三段（§2.4 多重比較）：**隨機因子安慰劑**。把每個因子的入選遮罩在「同一天內」隨機打亂（保留每日入選數），
// 用同樣的「訓練段挑最佳 → 樣本外看超額」流程重跑 N 次，得到「亂挑也能挑到多好」的分佈；正式主模型的樣本外超額
// 必須高於安慰劑最佳的 P95。只用日層級平均（不做自助法），成本可控。
function randomFactorPlacebo(train, oot, baseTr, baseOo, grid, mode, trials = 100) {
  const isMom = x => x.f.chg >= 5;
  const byDate = (set) => { const m = {}; for (const x of set) if (isMom(x) && mode.ret(x.y) != null) (m[x.date] ||= []).push(x); return m; };
  const trD = byDate(train), ooD = byDate(oot);
  const dailyExcess = (D, sizes, rnd, base) => {   // sizes: date → 該因子在該日的入選數；隨機抽同數量
    const out = [];
    for (const d in sizes) { const arr = D[d]; if (!arr || !sizes[d]) continue; const k = Math.min(sizes[d], arr.length); let s = 0; const used = new Set(); for (let i = 0; i < k; i++) { let j; do { j = Math.floor(rnd() * arr.length); } while (used.has(j)); used.add(j); s += mode.ret(arr[j].y); } out.push(s / k - (base[d] ?? 0)); }
    return out;
  };
  const sizesOf = (f, D) => { const m = {}; for (const d in D) { const n = D[d].filter(f.sel).length; if (n) m[d] = n; } return m; };
  const trSizes = grid.map(f => sizesOf(f, trD)), ooSizes = grid.map(f => sizesOf(f, ooD));
  const bestOot = [];
  for (let t = 0; t < trials; t++) {
    const rnd = prng(1000 + t);
    let best = null;
    for (let i = 0; i < grid.length; i++) {
      const dtr = dailyExcess(trD, trSizes[i], rnd, baseTr); if (dtr.length < MIN_DAYS) continue;
      const m = mean(dtr); if (best == null || m > best.m) best = { i, m };
    }
    if (!best) continue;
    const doo = dailyExcess(ooD, ooSizes[best.i], rnd, baseOo);
    if (doo.length) bestOot.push(mean(doo));
  }
  bestOot.sort((a, b) => a - b);
  if (!bestOot.length) return null;
  return { trials: bestOot.length, p50: +bestOot[Math.floor(bestOot.length * 0.5)].toFixed(3), p95: +bestOot[Math.floor(bestOot.length * 0.95)].toFixed(3), max: +bestOot[bestOot.length - 1].toFixed(3), note: '隨機因子（同日內打亂遮罩、保留每日入選數）挑最佳後的樣本外日層級超額分佈；只供參考——稀疏因子（每日 2～3 檔）會把 P95 拉高，正式閘門用逐候選置換檢定' };
}

// 逐候選置換檢定（正式閘門）：把**這個候選自己**的遮罩在同日內打亂 N 次（每日入選數不變），
//   得到「同樣稀疏度、純靠運氣」的樣本外超額分佈；p＝隨機超額 ≥ 實際超額的比例。p ≤ 0.05 才採用。
export function permutationTest(oot, baseOo, sel, mode, observed, trials = 200) {
  const isMom = x => x.f.chg >= 5;
  const D = {}; for (const x of oot) if (isMom(x) && mode.ret(x.y) != null) (D[x.date] ||= []).push(x);
  const sizes = {}; for (const d in D) { const n = D[d].filter(sel).length; if (n) sizes[d] = n; }
  let ge = 0, done = 0;
  for (let t = 0; t < trials; t++) {
    const rnd = prng(5000 + t); const out = [];
    for (const d in sizes) { const arr = D[d]; const k = Math.min(sizes[d], arr.length); const used = new Set(); let s = 0; for (let i = 0; i < k; i++) { let j; do { j = Math.floor(rnd() * arr.length); } while (used.has(j)); used.add(j); s += mode.ret(arr[j].y); } out.push(s / k - (baseOo[d] ?? 0)); }
    if (!out.length) continue; done++; if (mean(out) >= observed) ge++;
  }
  return done ? { p: +(ge / done).toFixed(3), trials: done } : null;
}

// 第四段（§2.7）：軋空機率校準表——依「命中幾個籌碼因子」分桶，列樣本外實際軋空率
function squeezeCalibration(oot, grid, mode) {
  const chip = grid.filter(g => g.group === '券');
  const isMom = x => x.f.chg >= 5;
  const buckets = {};
  for (const x of oot) { if (!isMom(x)) continue; const k = Math.min(3, chip.filter(f => f.sel(x)).length); const b = (buckets[k] ||= { n: 0, sq: 0 }); b.n++; if (x.y.squeeze === 1) b.sq++; }
  const rows = Object.keys(buckets).sort().map(k => ({ chipHits: +k === 3 ? '3+' : +k, n: buckets[k].n, squeezeRate: +(buckets[k].sq / buckets[k].n * 100).toFixed(2) }));
  const total = rows.reduce((s, r) => s + r.n, 0);
  return { rows, calibrated: total >= 200, note: total >= 200 ? '樣本外·依命中籌碼因子數分桶' : `樣本外僅 ${total} 筆，未校準` };
}

// ── B 段（docs/SQUEEZE-MODEL-VARIABLES §5-B，2026-09-18）：每日橫截面百分位因子 ──
//   絕對門檻（法人淨買/均量≥5%、量比≥2）在不同市況命中比例天差地遠，沒有 regime 不變性。
//   改成「當天純動能母體內的百分位」：同一天所有可買動能股裡排前 20%／後 20%。只用當天資料，無前視。
const CS_KEYS = { volX: '量', instVsVol: '法', ret5: '價', pos: '價', chg: '價', ratio: '券', shVsVol: '券', relSector: '族群', sectorSync: '族群', distHi60: '位置', distLo60: '位置',
  lendVsVol: '借券', lendChgVsVol: '借券', sblVsVol: '借券', sblChgVsVol: '借券' };   // E 段：可借額度代理（有歷史）＋借券餘額（09-18 起累積）
export function attachCrossSection(pool, isMom) {
  const byDay = {}; for (const x of pool) if (isMom(x)) (byDay[x.date] ||= []).push(x);
  for (const d in byDay) {
    const arr = byDay[d];
    for (const k in CS_KEYS) {
      const vals = arr.map(x => x.f[k]).filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
      if (vals.length < 10) { for (const x of arr) (x.cs ||= {})[k] = null; continue; }
      for (const x of arr) { const v = x.f[k]; (x.cs ||= {})[k] = (v == null || !Number.isFinite(v)) ? null : vals.findIndex(u => u >= v) / (vals.length - 1); }
    }
  }
}
function stageCGrid() {
  const F = [];
  const add = (name, group, sel) => F.push({ name, group, sel });
  // 市況條件（可與其他族群組合：多頭日×法人、空頭日×縮量…）
  add('多頭日', '市況', x => x.rg === 'bull'); add('空頭日', '市況', x => x.rg === 'bear'); add('非多頭日', '市況', x => x.rg !== 'bull');
  // 族群
  add('族群同步率≥30%', '族群', x => x.f.sectorSync != null && x.f.sectorSync >= 0.3);
  add('族群同步率<10%（孤軍）', '族群', x => x.f.sectorSync != null && x.f.sectorSync < 0.1);
  add('族群排名前20%', '族群', x => x.f.sectorRank != null && x.f.sectorRank >= 0.8);
  add('強於族群中位≥3pp', '族群', x => x.f.relSector != null && x.f.relSector >= 3);
  // 位置／路徑
  add('距60日高≥-3%（貼高）', '位置', x => x.f.distHi60 != null && x.f.distHi60 >= -3);
  add('距60日高<-20%（深回）', '位置', x => x.f.distHi60 != null && x.f.distHi60 < -20);
  add('距60日低≤+10%（底部反彈）', '位置', x => x.f.distLo60 != null && x.f.distLo60 <= 10);
  add('首次突破20日高', '位置', x => x.f.firstBreak20 === 1);
  add('連漲1日（首根）', '位置', x => x.f.upStreak === 1);
  add('連漲≥3日', '位置', x => x.f.upStreak >= 3);
  return F;
}
function crossSectionGrid() {
  const F = [];
  for (const k in CS_KEYS) {
    F.push({ name: `${k} 當日前20%`, group: CS_KEYS[k], sel: x => x.cs?.[k] != null && x.cs[k] >= 0.8, dir: '+', cs: true });
    F.push({ name: `${k} 當日後20%`, group: CS_KEYS[k], sel: x => x.cs?.[k] != null && x.cs[k] <= 0.2, dir: '-', cs: true });
  }
  return F;
}

// ── 5. 單一交易模式的完整訓練 ────────────────────────────────────────
function trainMode(mode, samples, twDates, baseGrid, say) {
  // 母體：該模式進場可買者；切點固定
  const pool = samples.filter(x => mode.entryOk(x.y) && mode.ret(x.y) != null);
  const train = pool.filter(x => x.date < OOS_FROM), oot = pool.filter(x => x.date >= OOS_FROM);
  const q = quantiles(train.filter(x => x.f.chg >= 5));
  const newsKey = mode.key === 'daytrade' ? 'newsNext' : 'newsIntra';
  const newsDaysMode = new Set(pool.filter(x => x.f[`${newsKey}Label`]).map(x => x.date)).size;
  attachCrossSection(pool, x => x.f.chg >= 5);   // B 段：每日橫截面百分位（只用當天）
  const grid = [...baseGrid, ...factorGrid(newsDaysMode, { ...q, newsKey }).filter(f => /P[28]0/.test(f.name) || f.group === '聞'), ...crossSectionGrid(), ...stageCGrid()];   // 固定門檻＋分位數門檻＋橫截面百分位＋C 段（市況/族群/位置）＋（達門檻時）新聞
  const trainDates = [...new Set(train.map(x => x.date))].sort();
  const segCut = [trainDates[Math.floor(trainDates.length / 3)], trainDates[Math.floor(trainDates.length * 2 / 3)]];
  const segOf = d => (d < segCut[0] ? 0 : d < segCut[1] ? 1 : 2);   // 三段在訓練段內切（§2.4）
  const isMom = x => x.f.chg >= 5;
  const baseTr = dayBaseline(train.filter(isMom), mode), baseOo = dayBaseline(oot.filter(isMom), mode);
  const lab = mode.key === 'daytrade' ? 'dtRet' : mode.key === 'swing' ? 'hold5Ret' : 'openRet';
  const allTr = stat(train, lab), momTr = stat(train.filter(isMom), lab);
  const allOo = stat(oot, lab), momOo = stat(oot.filter(isMom), lab);
  say(`  ▸ [${mode.key}] ${mode.label}：母體 ${pool.length.toLocaleString()}（剔除進場不可買 ${(samples.length - pool.length).toLocaleString()}）｜訓練 ${train.length.toLocaleString()}（<${OOS_FROM}）｜樣本外 ${oot.length.toLocaleString()}`);
  say(`      基準：訓練段純動能 ${momTr.mean}%/${momTr.win}%（n=${momTr.n}）｜樣本外純動能 ${momOo.mean}%/${momOo.win}%（n=${momOo.n}）`);

  // 單因子（訓練段，疊在純動能上；反向因子方向相反——本版先不設反向，全部視為「要贏基準」）
  const single = grid.map(f => ({ ...evalGroup(train.filter(x => isMom(x) && f.sel(x)), mode, baseTr, segOf), name: f.name, group: f.group }));
  single.sort((a, b) => (b.pass - a.pass) || ((b.excess ?? -9) - (a.excess ?? -9)));
  const passed = single.filter(s => s.pass);
  say(`      單因子：${grid.length} 受測 → ${passed.length} 通過（訓練段·CI 下界>0·三段皆贏）`);

  // 兩兩組合（不同族群）
  const combos = [];
  for (let i = 0; i < passed.length; i++) for (let j = i + 1; j < passed.length; j++) {
    const fi = grid.find(g => g.name === passed[i].name), fj = grid.find(g => g.name === passed[j].name);
    if (!fi || !fj || fi.group === fj.group) continue;
    const r = evalGroup(train.filter(x => isMom(x) && fi.sel(x) && fj.sel(x)), mode, baseTr, segOf);
    if (r.pass) combos.push({ ...r, name: `${fi.name} × ${fj.name}`, parts: [fi.name, fj.name] });
  }
  // C 段：市況是**條件**不是因子——整天入選對同日基準的超額恆為 0，單因子閘門永遠過不了，得直接與通過的單因子配對。
  //   同時把「訓練段通過但只差淨報酬／三段」的位置／族群因子也當條件配對，看是否在條件下成立。
  const conditioners = grid.filter(g => g.group === '市況');
  const conds2 = grid.filter(g => (g.group === '位置' || g.group === '族群') && !passed.some(p => p.name === g.name));
  for (const p of passed) {
    const fp = grid.find(g => g.name === p.name); if (!fp) continue;
    for (const c of [...conditioners, ...conds2]) {
      const r = evalGroup(train.filter(x => isMom(x) && fp.sel(x) && c.sel(x)), mode, baseTr, segOf);
      if (r.pass) combos.push({ ...r, name: `${fp.name} × ${c.name}`, parts: [fp.name, c.name], conditioned: true });
    }
  }
  combos.sort((a, b) => b.excess - a.excess);
  say(`      組合：${combos.length} 通過（含條件配對 ${combos.filter(c => c.conditioned).length}）`);

  // 樣本外：同一把尺（CI 下界>0），不分段
  const selOf = parts => { const fs = parts.map(nm => grid.find(g => g.name === nm)).filter(Boolean); return x => isMom(x) && fs.every(f => f.sel(x)); };
  const cands = [...combos.slice(0, 12), ...passed.slice(0, 8).map(p => ({ ...p, parts: [p.name] }))];
  const validated = cands.map(c => { const o = evalGroup(oot.filter(selOf(c.parts)), mode, baseOo, null); return { name: c.name, parts: c.parts, train: { excess: c.excess, ci: c.ci, mean: c.mean, win: c.win, n: c.n, days: c.days, segs: c.segs }, oot: o, ootPass: o.pass, ootWhy: o.why }; });
  const survivors = validated.filter(v => v.ootPass).sort((a, b) => (b.oot.excess ?? -9) - (a.oot.excess ?? -9));
  say(`      樣本外驗證：${cands.length} 個候選 → ${survivors.length} 個存活`);
  const main = survivors[0] || null;

  // 分支表：每群前兩名（訓練段），各自樣本外三態（§2.5）
  const branches = [];
  for (const gp of ['券', '量', '法', '國際', '價', '聞']) {
    const inGroup = single.filter(s => s.group === gp);
    if (!inGroup.length) continue;
    const top = inGroup.slice().sort((a, b) => (b.excess ?? -9) - (a.excess ?? -9)).slice(0, 2);
    const bestTr = top[0];
    for (const [rank, b] of top.entries()) {
      if (!b.pass) { branches.push({ group: gp, rank: rank + 1, name: b.name, train: { excess: b.excess ?? null, ci: b.ci ?? null, n: b.n, days: b.days ?? 0, segs: b.segs ?? null }, oot: null, state: 'ns', stateLabel: '訓練段未通過', pass: false, why: `${b.why}（訓練段超額 ${b.excess ?? '—'} vs 基準 0；本群 ${inGroup.length} 個因子，最佳 ${bestTr.name} ${bestTr.excess ?? '—'}）` }); continue; }
      const o = evalGroup(oot.filter(selOf([b.name])), mode, baseOo, null);
      branches.push({ group: gp, rank: rank + 1, name: b.name, train: { excess: b.excess, ci: b.ci, mean: b.mean, win: b.win, n: b.n, days: b.days, segs: b.segs }, oot: o, state: o.state, stateLabel: o.stateLabel, pass: o.pass, why: o.why });
    }
  }

  // 軋空機率模型（目標不同：P(t+1 漲≥5% 且融券減少)），必含籌碼因子；母體同樣套進場可買
  const sqRate = (set, sel) => { const g = set.filter(sel); return g.length ? { n: g.length, rate: +(g.filter(x => x.y.squeeze === 1).length / g.length * 100).toFixed(2) } : { n: 0, rate: null }; };
  const baseSqTrain = sqRate(train, isMom), baseSqOot = sqRate(oot, isMom);
  const chipF = grid.filter(g => g.group === '券'), otherF = grid.filter(g => g.group !== '券');
  const sqCands = [];
  for (const cf of chipF) {
    const solo = sqRate(train, x => isMom(x) && cf.sel(x)); if (solo.n >= 60) sqCands.push({ parts: [cf.name], train: solo });
    for (const of2 of otherF) { const r = sqRate(train, x => isMom(x) && cf.sel(x) && of2.sel(x)); if (r.n >= 60) sqCands.push({ parts: [cf.name, of2.name], train: r }); }
  }
  sqCands.sort((a, b) => (b.train.rate ?? -1) - (a.train.rate ?? -1));
  const sqValidated = sqCands.slice(0, 15).map(c => { const o = sqRate(oot, selOf(c.parts)); const pass = o.n >= 25 && o.rate != null && baseSqOot.rate != null && o.rate > baseSqOot.rate; return { name: c.parts.join(' × '), parts: c.parts, train: c.train, oot: o, pass, why: pass ? 'ok' : (o.n < 25 ? '樣本外筆數不足' : '樣本外未贏純動能軋空率') }; });
  const sqBest = sqValidated.filter(v => v.pass).sort((a, b) => b.oot.rate - a.oot.rate)[0] || null;

  // 第三段：隨機因子安慰劑（參考）＋逐候選置換檢定（正式閘門 p ≤ 0.05）；不過就降級 no_edge（誠實）
  const placebo = randomFactorPlacebo(train, oot, baseTr, baseOo, grid, mode);
  let mainFinal = main, perm = null;
  if (main) {
    perm = permutationTest(oot, baseOo, selOf(main.parts), mode, main.oot.excess);
    if (perm && perm.p > 0.05) { say(`      ⚠ 主模型 ${main.name} 樣本外超額 ${main.oot.excess}pp 置換檢定 p=${perm.p} > 0.05 ⇒ 不採用（安慰劑 P95 ${placebo?.p95 ?? '—'}pp 供參）`); mainFinal = null; }
    else say(`      置換檢定 p=${perm?.p ?? '—'}（${perm?.trials ?? 0} 次）｜隨機因子安慰劑 P50 ${placebo?.p50 ?? '—'}／P95 ${placebo?.p95 ?? '—'}pp（參考）`);
  }
  const calibration = squeezeCalibration(oot, grid, mode);

  return {
    tradeMode: mode.key, tradeLabel: mode.label, oosFrom: OOS_FROM, quantiles: q, placebo, permutation: perm, calibration,
    mainRejectedByPlacebo: main && !mainFinal ? { name: main.name, excess: main.oot.excess, p: perm?.p ?? null, placeboP95: placebo?.p95 ?? null } : null,
    label: mode.key === 'daytrade' ? 'dtRet（明開買→明收賣）' : mode.key === 'swing' ? 'hold5Ret（今收買→第5日收賣）' : 'openRet（今收買→明開賣）',
    samples: pool.length, excludedEntry: samples.length - pool.length, trainN: train.length, ootN: oot.length, trainDays: trainDates.length, ootDays: new Set(oot.map(x => x.date)).size,
    baseline: { train: { all: allTr, momentum: momTr }, oot: { all: allOo, momentum: momOo } },
    main: mainFinal ? { name: mainFinal.name, parts: mainFinal.parts, train: mainFinal.train, oot: mainFinal.oot, edgeVsMomentum: mainFinal.oot.excess, ci: mainFinal.oot.ci } : null,
    branches,
    squeezeProb: sqBest ? { name: sqBest.name, parts: sqBest.parts, train: sqBest.train, oot: sqBest.oot, baseline: { train: baseSqTrain, oot: baseSqOot }, lift: +(sqBest.oot.rate - (baseSqOot.rate ?? 0)).toFixed(2) } : { status: 'no_edge', baseline: { train: baseSqTrain, oot: baseSqOot }, note: '無軋空專用組合通過樣本外驗收' },
    squeezeValidated: sqValidated, validated, singleTop: single.slice(0, 16),
    passedCount: passed.length, comboCount: combos.length, survivorCount: survivors.length,
    status: mainFinal ? 'ok' : 'no_edge',
    note: mainFinal ? null : (main ? `本輪最佳 ${main.name} 置換檢定 p=${perm?.p ?? '—'} 未達 0.05，不採用（誠實結果）。` : '本輪沒有任何組合通過樣本外驗收（規則 v2：日層級 CI 下界>0）——誠實結果，不是故障。'),
    _all: { single, combos: combos.slice(0, 30) },
  };
}

// 第四段（§2.6）：換版規則——新版主模型樣本外超額不得低於上一版（同模式）；否則沿用上一版的主模型並註明。
function applyPromotion(modes, prev, say) {
  for (const k of Object.keys(modes)) {
    const cur = modes[k], old = prev?.modes?.[k];
    if (!old?.main) { cur.promotion = { changed: !!cur.main, from: null }; continue; }
    if (!cur.main) { cur.promotion = { changed: true, from: old.main.name, to: null, note: '新版無模型通過，線上不再有主模型（誠實）' }; continue; }
    if ((cur.main.edgeVsMomentum ?? -9) < (old.main.edgeVsMomentum ?? -9)) {
      say(`      ↳ [${k}] 新版 ${cur.main.name}（${cur.main.edgeVsMomentum}pp）低於上一版 ${old.main.name}（${old.main.edgeVsMomentum}pp）⇒ 本輪未換版`);
      cur.candidateMain = cur.main; cur.main = old.main; cur.promotion = { changed: false, kept: old.main.name, candidate: cur.candidateMain.name, note: '本輪未換版：新版樣本外超額低於上一版' };
    } else cur.promotion = { changed: cur.main.name !== old.main.name, from: old.main.name, to: cur.main.name };
  }
}

// ── 跳空漲 × 前一日新聞判別 稽核（使用者 2026-09-17：「回測跳空漲前一日的個股新聞是否佔大量加分比率」）──
//   對「有判別存檔的交易日」：依 t 日判別標籤分組，看 t+1 開盤跳空 ≥2%／≥3%／鎖停的比例與平均開盤報酬；
//   並列「跳空 ≥3% 的組成」——其中前一日被判利多的占幾成。
//   ⚠ 「未判」≠沒有新聞：判別宇宙是來源監看到的 ~150 檔／日；未判只代表不在判別宇宙裡。每日累積，30 日後才有代表性。
function gapNewsAudit(samples) {
  // 對齊：t+1 開盤的跳空，對應 targetDate=t+1 的判別（newsNext），不是 targetDate=t
  const days = new Set(samples.filter(x => x.f.newsNextLabel).map(x => x.date));
  const pool = samples.filter(x => days.has(x.date) && x.y.openRet != null && x.y.entryLocked === 0);
  if (!pool.length) return null;
  const lab = x => (x.f.newsNextLabel === '利多' && x.f.newsNextConf ? `利多·${x.f.newsNextConf}` : x.f.newsNextLabel) || '未判';
  const G = {}; for (const x of pool) { const g = (G[lab(x)] ||= { n: 0, gap2: 0, gap3: 0, lockOpen: 0, ret: 0 }); g.n++; if (x.y.openRet >= 2) g.gap2++; if (x.y.openRet >= 3) g.gap3++; if (x.y.buyable === 0) g.lockOpen++; g.ret += x.y.openRet; }
  const byLabel = {}; for (const k in G) { const g = G[k]; byLabel[k] = { n: g.n, gap2Pct: +(g.gap2 / g.n * 100).toFixed(1), gap3Pct: +(g.gap3 / g.n * 100).toFixed(1), lockOpenPct: +(g.lockOpen / g.n * 100).toFixed(1), avgOpenRet: +(g.ret / g.n).toFixed(2) }; }
  const gaps = pool.filter(x => x.y.openRet >= 3); const comp = {}; for (const x of gaps) comp[lab(x)] = (comp[lab(x)] || 0) + 1;
  const composition = {}; for (const k in comp) composition[k] = { n: comp[k], pct: +(comp[k] / gaps.length * 100).toFixed(1) };
  const bullAll = pool.filter(x => x.f.newsNextLabel === '利多'); const bullGap3 = bullAll.filter(x => x.y.openRet >= 3).length;
  return { days: days.size, pool: pool.length, byLabel, gap3Total: gaps.length, gap3Composition: composition,
    bullAll: { n: bullAll.length, gap3Pct: bullAll.length ? +(bullGap3 / bullAll.length * 100).toFixed(1) : null, share: gaps.length ? +(bullGap3 / gaps.length * 100).toFixed(1) : null },
    alignment: 'targetDate = t+1（t 晚盤後趟＋t+1 晨間趟）→ t+1 開盤跳空',
    note: '跳空＝t+1 開盤相對 t 收。未判≠無新聞（判別宇宙約 150 檔/日）。判別自 2026-08-27 累積，未達 30 日前只供觀察。' };
}

// ── 6. 主流程 ───────────────────────────────────────────────────
export async function runTraining({ days = 250, quiet = false } = {}) {
  const db = initDb();
  const t0 = Date.now();
  const say = (...a) => { if (!quiet) log(...a); };
  say('▶ 軋空判讀模型訓練開始（規則 v2·三套交易模式·固定切點）');
  const { samples, twDates, newsDays, excludedEvents, eventCodes, regimeByDate, regimeCuts } = await buildSamples(db, { days });
  const rgCount = { bull: 0, neutral: 0, bear: 0 }; for (const d in regimeByDate) if (regimeByDate[d]) rgCount[regimeByDate[d].rg]++;
  say(`  · 市況分層（漲家數比三分位：≥${regimeCuts.hi} 多頭／≤${regimeCuts.lo} 空頭）：多頭 ${rgCount.bull} 日、中性 ${rgCount.neutral} 日、空頭 ${rgCount.bear} 日`);
  const hash = datasetHash(samples, twDates);
  say(`  · 樣本 ${samples.length.toLocaleString()} 筆｜期間 ${twDates[0]} ~ ${twDates[twDates.length - 1]}｜資料集 ${hash}｜切點 ${OOS_FROM}｜事件股排除 ${excludedEvents.toLocaleString()} 筆（${eventCodes} 檔·±30 日）`);
  say(`  · 新聞判別覆蓋 ${newsDays} 個交易日${newsDays >= NEWS_MIN_DAYS ? '（已納入因子網格）' : `（未達 ${NEWS_MIN_DAYS} 日門檻，本次不納入）`}`);
  const grid = factorGrid(newsDays);

  // 安慰劑（第一版沿用隨機子集；第三段改隨機因子）
  let placebo = null;
  try {
    const rnd = [];
    for (let k = 0; k < 40; k++) { const pick = samples.filter((_, idx) => (idx * 2654435761 + k * 40503) % 97 < 12); const st = stat(pick); if (st.n >= 80) rnd.push(st.mean); }
    if (rnd.length) placebo = { maxOfRandom: +Math.max(...rnd).toFixed(3), meanOfRandom: +mean(rnd).toFixed(3), trials: rnd.length, note: '隨機子集（第三段改隨機因子）' };
  } catch { /* 不擋 */ }

  const modes = {};
  for (const k of Object.keys(TRADE_MODES)) modes[k] = trainMode(TRADE_MODES[k], samples, twDates, grid, say);
  const gapNews = gapNewsAudit(samples);
  if (gapNews) say(`  · 跳空×前日新聞（${gapNews.days} 日·對齊 targetDate=t+1）：利多 跳空≥3% ${gapNews.bullAll.gap3Pct ?? '—'}%（高 ${gapNews.byLabel['利多·高']?.gap3Pct ?? '—'}／中 ${gapNews.byLabel['利多·中']?.gap3Pct ?? '—'}／低 ${gapNews.byLabel['利多·低']?.gap3Pct ?? '—'}）／中性 ${gapNews.byLabel['中性']?.gap3Pct ?? '—'}%／未判 ${gapNews.byLabel['未判']?.gap3Pct ?? '—'}%；跳空≥3% 中前日判利多占 ${gapNews.bullAll.share ?? 0}%`);

  // 第四段：版本化與換版規則
  let prev = null;
  try { const p = (await db.collection('squeezeModel').doc('latest').get()).data(); if (p?.rules === 'v2') prev = p; } catch { /* 無上一版 */ }
  applyPromotion(modes, prev, say);

  const runId = `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
  const modelVersion = `${runId}@${hash}`;
  const def = modes.nextday;
  const strip = m => { const { _all, ...rest } = m; return rest; };
  const model = {
    runId, modelVersion, updatedAt: Date.now(), trainMs: Date.now() - t0, rules: 'v2', datasetHash: hash,
    eventExclusion: { excluded: excludedEvents, codes: eventCodes, windowDays: 30, source: 'priceEvents/latest' },
    gapNewsAudit: gapNews,
    regime: { rule: '漲家數比三分位（視窗自身）：上三分之一多頭／下三分之一空頭（t 日自身）', cuts: regimeCuts, days: rgCount, costPct: COST_PCT, gates: '超額 CI 下界>0 ＋ 淨報酬(扣費稅) CI 下界>0 ＋ 多頭/空頭兩層皆不為負' },
    period: { from: twDates[0], to: twDates[twDates.length - 1], days: twDates.length, oosFrom: OOS_FROM },
    tradeMode: 'nextday', modes: Object.fromEntries(Object.entries(modes).map(([k, m]) => [k, strip(m)])),
    // 相容：頂層＝預設模式（隔日沖），既有讀者（daemon runId/main.name/squeezeProb.name、管理頁）不需改
    ...strip(def),
    placebo,
  };
  const MIN_PROD_DAYS = 200;
  if (days < MIN_PROD_DAYS && process.env.FORCE_WRITE !== '1') { say(`  ⚠ 訓練窗 ${days} 日 < ${MIN_PROD_DAYS} 日 ⇒ 視為測試，不寫入`); return model; }
  if (process.env.DRY_RUN === '1') { say('  ⚠ DRY_RUN=1：只印不寫'); model.singleAll = Object.fromEntries(Object.entries(modes).map(([k, m]) => [k, m._all.single])); }
  else {
    await db.collection('squeezeModel').doc('latest').set(model);
    await db.collection('squeezeReport').doc(runId).set({ ...model, singleAll: Object.fromEntries(Object.entries(modes).map(([k, m]) => [k, m._all.single])), combosAll: Object.fromEntries(Object.entries(modes).map(([k, m]) => [k, m._all.combos])) });
  }
  for (const k of Object.keys(modes)) {
    const m = modes[k];
    if (m.main) say(`  ✓ [${k}] 主模型：${m.main.name}｜樣本外日層級超額 ${m.main.edgeVsMomentum}pp CI[${m.main.ci}]（${m.main.oot.days} 日）`);
    else say(`  ⚠ [${k}] 無模型通過樣本外（誠實結果）`);
    say(`      分支：${m.branches.map(b => `${b.group}${b.rank}·${b.stateLabel}`).join('｜')}`);
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
