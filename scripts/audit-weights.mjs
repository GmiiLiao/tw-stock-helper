#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 權重稽核＋2 年回測驗證（產業龍頭名單 × 全市場）
//
// 目的：app 內所有「寫死的」勝率/權重數字，逐一用 2 年 chipArchive 重新量測，
// 與宣稱值對照——揪出沒有證據支撐的數字（幻想），輸出修正建議。
//
// 稽核對象（宣稱值出處）：
//   A. 勝率雷達 tier（daemon chipPhaseTier 硬編碼）：S=59 A=55 B+=52 B=50 watch過熱=47 danger=39
//   B. 綜合評分加減分（lib/composite-score.ts，120日回測效應量）：
//      破高×強尾+5(46.0) 破高+3(43.4) 軋空+4(45.1) 強尾+2(44.0) 弱尾−6(40.1)
//      接棒−4(⚠無隔日證據·波段邏輯外推) 倒貨≥30%−3(⚠無隔日證據)
//   C. 綜合評分整體校準：分數分桶 vs 實際隔日上漲率（分數≈機率概念值的宣稱）
//
// 語意：訊號日收盤 → 次一交易日收盤。「勝率」= 原始隔日上漲機率（與 tier 宣稱
// 同義，不扣費稅）；「淨均」= 扣隔日沖費稅 0.4425% 後平均報酬（交易語意）。
// 濾網：量≥300 張；相鄰交易日（日曆≤4 天）。
// 資料誠實揭露：instJson 僅 [外資,投信] → A tier(需自營商) 只能在 chipDaily
// 覆蓋段(約近6個月)量測；軋空需 marginJson（覆蓋約全期）。
//
// 用法：node audit-weights.mjs [--days 480] [--fixed]（--fixed 用修正後權重跑校準）
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const DAYS = parseInt((process.argv.find(a => a.startsWith('--days')) || '').split('=')[1] || '480');
const USE_FIXED = process.argv.includes('--fixed');
const INCLUDE_LU = process.argv.includes('--all');  // 預設排除漲停(chg>8.5%)：2026-07-19 教訓——含漲停校準產出 watchHot 53 幻覺
const COST = 0.004425;
const MIN_VOL = 300;

const LEADERS = new Set(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'data', 'industry-leaders.json'), 'utf8')).leaders.map(l => l.code));

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stat = a => a.length ? {
  n: a.length,
  win: +(a.filter(r => r > 0).length / a.length * 100).toFixed(1),
  netAvg: +((mean(a) - COST) * 100).toFixed(2),
} : { n: 0, win: 0, netAvg: 0 };
const fmt = (s, claimed) => `n=${String(s.n).padStart(7)} 勝率${String(s.win).padStart(5)}%${claimed != null ? ` (宣稱${claimed})` : ''} 淨均${String(s.netAvg).padStart(6)}%`;

async function main() {
  const snap = await db.collection('chipArchive').get();
  const days = snap.docs.map(d => ({ id: d.id, x: d.data() }))
    .filter(d => d.x.closeJson && d.x.instJson)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(d => ({
      date: d.id,
      close: JSON.parse(d.x.closeJson), inst: JSON.parse(d.x.instJson),
      margin: d.x.marginJson ? JSON.parse(d.x.marginJson) : null,
    }));
  // chipDaily（含自營商）供 A tier 量測
  const cdSnap = await db.collection('chipDaily').get();
  const chipD = {}; cdSnap.forEach(d => { const x = d.data(); if (x.codesJson) chipD[x.date || d.id] = JSON.parse(x.codesJson); });

  const win = days.slice(-(DAYS + 22)); // 需前 20 日(破高/倒貨) + t+1
  console.log(`[audit] 窗 ${win[21]?.date} → ${win[win.length - 2]?.date}（訊號日 ${win.length - 22} 天）· 龍頭 ${LEADERS.size} 檔 · ${USE_FIXED ? '修正後權重' : '現行(生產)權重'}`);
  const adj = i => (new Date(win[i + 1].date) - new Date(win[i].date)) / 86400000 <= 4;

  // 收集器：每個稽核對象 × (全市場/龍頭)
  const B = {}; const BO = {}; // name -> {all:[], lead:[]}
  const push = (name, code, ret) => { (B[name] ||= { all: [], lead: [] }); B[name].all.push(ret); if (LEADERS.has(code)) B[name].lead.push(ret); };
  const pushO = (name, code, retO) => { if (retO == null) return; (BO[name] ||= { all: [] }); BO[name].all.push(retO); };
  const compBuckets = {}; // scoreBucket -> {all:[], lead:[]}
  const pushComp = (score, code, ret) => {
    const b = score < 40 ? '<40' : score < 46 ? '40-45' : score < 52 ? '46-51' : score < 58 ? '52-57' : '≥58';
    (compBuckets[b] ||= { all: [], lead: [] }); compBuckets[b].all.push(ret); if (LEADERS.has(code)) compBuckets[b].lead.push(ret);
  };

  // tier 基底（現行 vs 修正後由 --fixed 切換；修正值於首輪量測後回填此表重跑）
  const TIER_WIN_PROD = { S: 59, A: 55, 'B+': 52, B: 50, watchHot: 47, danger: 39, neutral: 45 };
  const TIER_WIN_FIXED = JSON.parse(process.env.FIXED_TIERS || 'null') || TIER_WIN_PROD;
  const TIER_WIN = USE_FIXED ? TIER_WIN_FIXED : TIER_WIN_PROD;
  // 2026-08-01 修正：原本這裡寫死的是 7/19 修正**前**的舊權重（brkStrong+5/strong+2/weak−6…），
  // 但生產(model-core.adds)早已是 +2/−2/0 —— 稽核工具與生產脫鉤，Section C 的校準
  // 一直在測一套不存在的評分。改為直接讀 model-core（單一真相來源）。
  const MC = JSON.parse(readFileSync(new URL('./data/model-core.json', import.meta.url), 'utf8'));
  const ADD = USE_FIXED ? (JSON.parse(process.env.FIXED_ADDS || 'null') || {}) : {
    brkStrong: MC.adds?.brkStrong?.w ?? 0, brk: MC.adds?.brk?.w ?? 0, sqz: MC.adds?.sqz?.w ?? 0,
    strong: MC.adds?.strongAlone?.w ?? 0, weak: MC.adds?.weak?.w ?? 0,
    bag: MC.adds?.bag?.w ?? 0, dist: MC.adds?.dist30?.w ?? 0,
  };
  console.log('[audit] adds(來自 model-core):', JSON.stringify(ADD));

  for (let i = 21; i < win.length - 1; i++) {
    if (!adj(i)) continue;
    const day = win[i], prev = win[i - 1], next = win[i + 1];
    const cd = chipD[day.date]; // 有自營商資料的日子
    for (const code in day.inst) {
      if (!/^\d{4}$/.test(code)) continue;
      const cl = day.close[code], ncl = next.close[code], pcl = prev.close[code];
      if (!cl || !ncl || !pcl || !(cl[0] > 0) || !(ncl[0] > 0) || !(pcl[0] > 0)) continue;
      const vol = cl[1] || 0; if (vol < MIN_VOL) continue;
      const ret = ncl[0] / cl[0] - 1; // 原始隔日報酬（勝率語意·收盤賣口徑）
      // 開賣口徑（2026-08-01 補）：產品鐵律是「明開賣」（exitModel），
      // 只用收賣口徑稽核會把「edge 在開盤溢價」的訊號誤判成失效。
      const retO = ncl[2] > 0 ? ncl[2] / cl[0] - 1 : null;
      const f = day.inst[code][0] || 0, t = day.inst[code][1] || 0;
      const chg = (cl[0] / pcl[0] - 1) * 100;
      if (!INCLUDE_LU && chg > 8.5) continue;   // 可交易宇宙（收盤買得到）
      const hi = cl[3] || 0, lo = cl[4] || 0;
      const pos = hi > lo ? (cl[0] - lo) / (hi - lo) : null;

      push('基準(全部)', code, ret); pushO('基準(全部)', code, retO);

      // ── A. tier 條件 ──
      const heavy = f >= 500 && f / vol >= 0.10;
      const weak = f < 500 || f / vol < 0.02;
      let tier = 'neutral';
      if (f < 0) { tier = (t > 0 && (f + t) > 0) ? 'B' : 'danger'; }
      else if (heavy && t > 0) tier = 'S';
      else if (cd && f > 0 && t > 0 && (cd[code]?.[2] || 0) > 0) tier = 'A';
      else if (heavy) tier = 'B+';
      else if (chg >= 7 && weak && t <= 0) tier = 'watchHot';
      else if (f > 0) tier = 'B';
      push(`tier:${tier}`, code, ret); pushO(`tier:${tier}`, code, retO);
      if (tier === 'A') { push('tier:A(chipDaily段)', code, ret); pushO('tier:A(chipDaily段)', code, retO); }

      // ── B. composite 加減分成分 ──
      let hi20 = 0; for (let k = i - 20; k < i; k++) { const v = win[k]?.close[code]?.[0]; if (v > hi20) hi20 = v; }
      const brk = hi20 > 0 && cl[0] > hi20 && pcl[0] <= hi20;
      let sqzSetup = false, mgChg = 0;
      const m1 = prev.margin?.[code], m2 = win[i - 2]?.margin?.[code];
      if (m1 && m2) {
        const sChgY = (m1[1] || 0) - (m2[1] || 0), pvol = pcl[1] || 0;
        sqzSetup = pvol >= MIN_VOL && sChgY >= pvol * 0.005;
        mgChg = (m1[0] || 0) - (m2[0] || 0);
      }
      const sqzT = sqzSetup && chg > 2;
      const brkStrong = brk && pos != null && pos >= 0.7;
      const strongAlone = pos != null && pos >= 0.8 && Math.abs(chg) > 1 && !brkStrong;
      const weakClose = pos != null && pos <= 0.2 && Math.abs(chg) > 1;
      const bag = mgChg > 0 && f < 0; // 🪤接棒：昨日融資增＋今日外資賣
      // 倒貨≥30%（近20日 f+t 累計峰值回吐）
      let cum = 0, peak = 0;
      for (let k = i - 19; k <= i; k++) { const v = win[k]?.inst[code]; if (v) { cum += (v[0] || 0) + (v[1] || 0); if (cum > peak) peak = cum; } }
      const distPct = peak > 0 ? ((peak - cum) / peak) * 100 : 0;

      if (brkStrong) { push('破高×強尾(+5宣稱46.0)', code, ret); pushO('破高×強尾(+5宣稱46.0)', code, retO); }
      else if (brk) { push('破高(+3宣稱43.4)', code, ret); pushO('破高(+3宣稱43.4)', code, retO); }
      if (sqzT) { push('軋空觸發(+4宣稱45.1)', code, ret); pushO('軋空觸發(+4宣稱45.1)', code, retO); }
      if (strongAlone) { push('強尾盤(+2宣稱44.0)', code, ret); pushO('強尾盤(+2宣稱44.0)', code, retO); }
      if (weakClose) { push('弱尾盤(−6宣稱40.1)', code, ret); pushO('弱尾盤(−6宣稱40.1)', code, retO); }
      if (bag) { push('接棒(−4·⚠無隔日證據)', code, ret); pushO('接棒(−4·⚠無隔日證據)', code, retO); }
      if (distPct >= 30) { push('倒貨≥30%(−3·⚠無隔日證據)', code, ret); pushO('倒貨≥30%(−3·⚠無隔日證據)', code, retO); }

      // ── C. composite 校準 ──
      let sc = TIER_WIN[tier] ?? 45;
      if (brkStrong) sc += ADD.brkStrong ?? 0;
      else if (brk) sc += ADD.brk ?? 0;
      if (sqzT) sc += ADD.sqz ?? 0;
      if (strongAlone) sc += ADD.strong ?? 0;
      if (weakClose) sc += ADD.weak ?? 0;
      if (bag) sc += ADD.bag ?? 0;
      if (distPct >= 30) sc += ADD.dist ?? 0;
      pushComp(Math.max(5, Math.min(95, Math.round(sc))), code, ret);
    }
  }

  const TB = MC.tierBase || {};
  const CLAIMS = {
    'tier:S': TB.S, 'tier:A(chipDaily段)': TB.A, 'tier:B+': TB['B+'], 'tier:B': TB.B,
    'tier:watchHot': TB.watchHot, 'tier:danger': TB.danger, 'tier:neutral': TB.neutral,
  };
  console.log('\n── A+B. 成分稽核（勝率=原始隔日上漲%·淨均=扣費稅後）──');
  const order = ['基準(全部)', 'tier:S', 'tier:A', 'tier:A(chipDaily段)', 'tier:B+', 'tier:B', 'tier:watchHot', 'tier:danger', 'tier:neutral',
    '破高×強尾(+5宣稱46.0)', '破高(+3宣稱43.4)', '軋空觸發(+4宣稱45.1)', '強尾盤(+2宣稱44.0)', '弱尾盤(−6宣稱40.1)',
    '接棒(−4·⚠無隔日證據)', '倒貨≥30%(−3·⚠無隔日證據)'];
  for (const k of order) {
    if (!B[k]) continue;
    const o = BO[k] ? stat(BO[k].all) : null;
    console.log(`  ${k.padEnd(22, '　')} 全市場 ${fmt(stat(B[k].all), CLAIMS[k])}${o ? `  ｜開賣淨均 ${o.netAvg}%·勝${o.win}%` : ''}`);
    console.log(`  ${''.padEnd(22, '　')} 龍頭65 ${fmt(stat(B[k].lead))}`);
  }

  console.log('\n── C. 綜合評分校準（分數桶 → 實際隔日上漲%；理想：單調遞增且 分數≈勝率）──');
  for (const b of ['<40', '40-45', '46-51', '52-57', '≥58']) {
    if (!compBuckets[b]) continue;
    console.log(`  🧬${b.padEnd(6)} 全市場 ${fmt(stat(compBuckets[b].all))} ｜ 龍頭 ${fmt(stat(compBuckets[b].lead))}`);
  }
  console.log('\n非投資建議；本稽核輸出為修正權重的唯一依據。');
  process.exit(0);
}
main().catch(e => { console.error('[audit] 失敗:', e); process.exit(1); });
