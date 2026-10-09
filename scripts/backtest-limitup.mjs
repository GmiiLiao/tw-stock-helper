#!/usr/bin/env node
// ── 漲停股預測回測：因子 lift 分析 + walk-forward 驗證 ──────────────────
// 資料：chipArchive(收盤價+量, ~92日) × chipDaily(三大法人, 120日)。全部 PIT 安全：
// 預測 t+1 是否收盤漲停，只用 t 及之前的資料（法人在實盤是 t-1 EOD，這裡同樣只用 ≤t）。
// 標籤：收盤漲停（台股 tick 規則精確判定，偵測不到盤中觸停打開——更嚴格更乾淨）。
// 模型：分桶 lift（該桶漲停率÷基準率）→ log2 加權分。前段訓練、後 20 日驗證。
// 兩標籤：A 全市場明日漲停  B 今日漲停者明日連板。
import admin from 'firebase-admin';
import { isLimitUpByRule, TW_LIMIT_RULE_VERSION } from './lib/tw-limit-price.mjs';

process.env.GOOGLE_APPLICATION_CREDENTIALS ||= '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

// 漲停判定口徑（2026-10-09 使用者裁定統一成交易所口徑，唯一實作 scripts/lib/tw-limit-price.mjs）：
//   --rule 2（預設）＝交易所口徑：升降單位取漲停價本身所在級距、ETF 走 ETF 檔位表；
//   --rule 1＝舊口徑（前收的級距、個股表），只供重現 2026-09-18 定版 LU_LIFT 的舊數字作對照。
//   輸出第一行印口徑；存檔請帶口徑後綴（docs/EXPERIMENTS.md 2026-10-09 段）。
const RULE_ARG = process.argv.indexOf('--rule');
const LIMIT_RULE = RULE_ARG > 0 ? Number(process.argv[RULE_ARG + 1]) : TW_LIMIT_RULE_VERSION;
if (LIMIT_RULE !== 1 && LIMIT_RULE !== 2) { console.error(`--rule 只接受 1 或 2（收到 ${process.argv[RULE_ARG + 1]}）`); process.exit(2); }
const isEtfCode = c => /^00\d{2,4}$/.test(String(c || ''));   // 同 daemon _isEtfCode
const isLimitUp = (c, pc, code) => isLimitUpByRule(LIMIT_RULE, c, pc, LIMIT_RULE === 2 && isEtfCode(code));
console.log(`漲停判定口徑 v${LIMIT_RULE}${LIMIT_RULE === 1 ? '（舊·前收級距，對照用）' : '（交易所口徑）'}`);

console.log('載入 chipArchive（收盤價+量）…');
const archSnap = await db.collection('chipArchive').orderBy('date', 'asc').get();
const days = []; // [{date, close: {code:[close,vol張]}}] 舊→新
for (const d of archSnap.docs) {
  const x = d.data();
  if (!x.closeJson) continue;
  const close = JSON.parse(x.closeJson);
  if (Object.keys(close).length < 500) continue; // 不完整日跳過
  days.push({ date: x.date, close });
}
console.log(`  收盤庫 ${days.length} 日：${days[0].date} → ${days[days.length - 1].date}`);

console.log('載入 chipDaily（三大法人）…');
const cdSnap = await db.collection('chipDaily').orderBy('date', 'asc').get();
const instByDate = {}; // date -> {code:[f,t,d]}
for (const d of cdSnap.docs) { const x = d.data(); if (x.codesJson) instByDate[x.date] = JSON.parse(x.codesJson); }
console.log(`  法人庫 ${Object.keys(instByDate).length} 日`);

// 產業對照＝只有上市（刻意）。openapi.twse 沒有 t187ap03_O（302 到 404.html；2026-10-03 查證），所以 LU_LIFT 的 indLU5／indHot
//   從頭就是用「上櫃一律無產業別」訓練的；daemon 端 getIndustryMap({ listedOnly: true }) 同口徑（2026-10-09 起 daemon 全市場表已含上櫃）。
//   要把上櫃納入族群因子 ⇒ 這裡改讀官方鏡像 tpex_oa_mopsfin_t187ap03_O（scripts/lib/industry-map.mjs parseTpexCompanyRows）重訓並升 LU_VERSION，
//   且 daemon computeLimitUpForecast 拿掉 listedOnly——兩邊要一起換，不可只換一邊。
console.log('載入產業對照（t187ap03_L 上市；與 daemon listedOnly 同口徑）…');
const indMap = {};
for (const ep of ['t187ap03_L']) {
  try {
    const r = await fetch(`https://openapi.twse.com.tw/v1/opendata/${ep}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) for (const x of await r.json()) { const c = (x['公司代號'] || '').trim(), ind = (x['產業別'] || '').trim(); if (/^\d{4}$/.test(c) && ind) indMap[c] = ind; }
  } catch { /* skip */ }
}
console.log(`  產業對照 ${Object.keys(indMap).length} 檔`);

// 預先算每日漲停集合（供 luCnt60 / 族群熱度，避免 O(n²) 重算）
const luSetByDay = []; // i -> Set(code)（i 對 i-1 漲停）
for (let i = 0; i < 92 * 2; i++) luSetByDay.push(null);

// ── 建樣本：i 從 20 到 n-2（需 20 日回看 + t+1 標籤）─────────────────────
const LOOKBACK = 20;
const samples = []; // {date, code, y, cont(今日已漲停), feats:{...}}
const marketLU = days.map(d => 0); // 每日市場漲停家數（i 對 i-1）
for (let i = 1; i < days.length; i++) {
  const set = new Set();
  for (const code in days[i].close) {
    const pc = days[i - 1].close[code]?.[0];
    if (pc && isLimitUp(days[i].close[code][0], pc, code)) set.add(code);
  }
  luSetByDay[i] = set; marketLU[i] = set.size;
}
// 每日「族群5日漲停熱度」與 top3 熱門族群（用 ≤i 的資料，PIT 安全）
const indHeatByDay = []; // i -> {ind: count5}, top3 set
for (let i = 0; i < days.length; i++) {
  const cnt = {};
  for (let k = Math.max(1, i - 4); k <= i; k++) {
    for (const c of (luSetByDay[k] || [])) { const ind = indMap[c]; if (ind) cnt[ind] = (cnt[ind] || 0) + 1; }
  }
  const top3 = new Set(Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]));
  indHeatByDay.push({ cnt, top3 });
}

for (let i = LOOKBACK; i < days.length - 1; i++) {
  const today = days[i], tomorrow = days[i + 1];
  const inst = instByDate[today.date] || {};
  for (const code in today.close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const [c0, v0] = today.close[code];
    const pc = days[i - 1].close[code]?.[0];
    if (!(c0 > 0) || !(pc > 0)) continue;
    // 流動性濾網：20日均量 ≥100張 且今收 ≥5 元（漲停預測對雞蛋水餃股無意義）
    let vSum = 0, vN = 0, hi20 = 0, luCnt5 = 0;
    for (let k = i - LOOKBACK; k < i; k++) {
      const r = days[k].close[code]; if (!r) continue;
      vSum += r[1] || 0; vN++;
      if (r[0] > hi20) hi20 = r[0];
    }
    const avgV = vN >= 10 ? vSum / vN : 0;
    if (avgV < 100 || c0 < 5) continue;
    // 近5日已漲停次數（含今日）
    for (let k = i - 4; k <= i; k++) {
      const p = days[k - 1]?.close[code]?.[0], c = days[k]?.close[code]?.[0];
      if (p && c && isLimitUp(c, p, code)) luCnt5++;
    }
    const c20 = days[i - LOOKBACK].close[code]?.[0], c5 = days[i - 5].close[code]?.[0];
    const ret20 = c20 > 0 ? (c0 - c20) / c20 * 100 : null;
    const ret5 = c5 > 0 ? (c0 - c5) / c5 * 100 : null;
    const chg0 = (c0 - pc) / pc * 100;
    const volX = avgV > 0 ? (v0 || 0) / avgV : 0;
    const nearHi = hi20 > 0 ? (c0 / hi20 - 1) * 100 : null; // ≥0=創20日新高
    // 法人（≤ 今日）
    const row = inst[code];
    const f0 = row?.[0] ?? 0, t0 = row?.[1] ?? 0, d0 = row?.[2] ?? 0;
    let streak = 0; for (let k = i; k >= 0; k--) { const r = instByDate[days[k].date]?.[code]; if ((r?.[0] || 0) > 0) streak++; else break; }
    let f5 = 0; for (let k = Math.max(0, i - 4); k <= i; k++) f5 += instByDate[days[k].date]?.[code]?.[0] || 0;
    const fShare = v0 > 0 ? f0 / v0 * 100 : 0; // 外資當日佔量%
    const cont = isLimitUp(c0, pc, code);
    // 3個月(≤60交易日)漲停次數（含今日；早期樣本以可得窗計）
    let luCnt60 = 0;
    for (let k = Math.max(1, i - 59); k <= i; k++) if (luSetByDay[k]?.has(code)) luCnt60++;
    // 族群風向：所屬族群 5 日漲停家數 + 是否 top3 熱門族群
    const ind = indMap[code] || null;
    const indLU5 = ind ? (indHeatByDay[i].cnt[ind] || 0) : 0;
    const indHot = ind ? (indHeatByDay[i].top3.has(ind) ? 1 : 0) : 0;
    const pcT = c0; const cT = tomorrow.close[code]?.[0];
    if (!(cT > 0)) continue;
    const y = isLimitUp(cT, pcT, code) ? 1 : 0;
    samples.push({ i, date: today.date, code, y, cont, feats: { ret20, ret5, chg0, volX, nearHi, luCnt5, luCnt60, indLU5, indHot, f0, t0, d0, streak, f5, fShare, mktLU: marketLU[i] } });
  }
}
console.log(`樣本 ${samples.length} 檔日，漲停(明日) ${samples.filter(s => s.y).length}，今日已漲停 ${samples.filter(s => s.cont).length}`);

// ── 因子分桶定義 ──────────────────────────────────────────────────────
const BUCKETS = {
  chg0:   [['<0', v => v < 0], ['0~3', v => v >= 0 && v < 3], ['3~7', v => v >= 3 && v < 7], ['7~9.5', v => v >= 7 && v < 9.5], ['漲停', v => v >= 9.5]],
  ret5:   [['<-3', v => v < -3], ['-3~3', v => v >= -3 && v < 3], ['3~10', v => v >= 3 && v < 10], ['≥10', v => v >= 10]],
  ret20:  [['<0', v => v < 0], ['0~10', v => v >= 0 && v < 10], ['10~25', v => v >= 10 && v < 25], ['≥25', v => v >= 25]],
  volX:   [['<1', v => v < 1], ['1~2', v => v >= 1 && v < 2], ['2~4', v => v >= 2 && v < 4], ['≥4', v => v >= 4]],
  nearHi: [['<-10%', v => v < -10], ['-10~-2', v => v >= -10 && v < -2], ['-2~0', v => v >= -2 && v < 0], ['創新高', v => v >= 0]],
  luCnt5: [['0', v => v === 0], ['1', v => v === 1], ['≥2', v => v >= 2]],
  streak: [['0', v => v === 0], ['1-2', v => v >= 1 && v <= 2], ['≥3', v => v >= 3]],
  fShare: [['賣超', v => v < 0], ['0~5%', v => v >= 0 && v < 5], ['5~15%', v => v >= 5 && v < 15], ['≥15%', v => v >= 15]],
  t0:     [['賣/無', v => v <= 0], ['買超', v => v > 0]],
  mktLU:  [['<10', v => v < 10], ['10~25', v => v >= 10 && v < 25], ['≥25', v => v >= 25]],
  luCnt60: [['0', v => v === 0], ['1-2', v => v >= 1 && v <= 2], ['3-5', v => v >= 3 && v <= 5], ['≥6', v => v >= 6]],
  indLU5:  [['0', v => v === 0], ['1-4', v => v >= 1 && v < 5], ['5-14', v => v >= 5 && v < 15], ['≥15', v => v >= 15]],
  indHot:  [['非熱門', v => v === 0], ['top3族群', v => v === 1]],
};
const NEW_KEYS = new Set(['luCnt60', 'indLU5', 'indHot']);
const bucketOf = (k, v) => { if (v == null) return null; for (const [name, fn] of BUCKETS[k]) if (fn(v)) return name; return null; };

// ── 訓練/驗證切分（walk-forward：後 20 個標籤日為驗證）─────────────────
const dates = [...new Set(samples.map(s => s.date))].sort();
const cutDate = dates[dates.length - 20];
const train = samples.filter(s => s.date < cutDate);
const test = samples.filter(s => s.date >= cutDate);
const base = train.filter(s => s.y).length / train.length;
console.log(`\n訓練 ${train.length}(${dates[0]}~) / 驗證 ${test.length}(${cutDate}~) · 訓練基準漲停率 ${(base * 100).toFixed(2)}%`);

// ── A 榜因子 lift（訓練集）──────────────────────────────────────────────
console.log('\n══ A 明日漲停：因子 lift（訓練集）══');
const weights = {}; // feat -> bucket -> log2 lift
for (const k of Object.keys(BUCKETS)) {
  weights[k] = {};
  const rows = [];
  for (const [name] of BUCKETS[k]) {
    const grp = train.filter(s => bucketOf(k, s.feats[k]) === name);
    if (grp.length < 200) { weights[k][name] = 0; rows.push(`${name}: n=${grp.length}(樣本不足)`); continue; }
    const r = grp.filter(s => s.y).length / grp.length;
    const lift = r / base;
    weights[k][name] = Math.log2(Math.max(lift, 0.1));
    rows.push(`${name}: ${(r * 100).toFixed(2)}% (lift ${lift.toFixed(2)}x, n=${grp.length})`);
  }
  console.log(`  ${k.padEnd(7)} ${rows.join(' | ')}`);
}

// ── 連板 B 榜：今日漲停者，明日再漲停率（訓練集）────────────────────────
console.log('\n══ B 連板持續：今日漲停者分組（訓練集）══');
const contTrain = train.filter(s => s.cont);
const contBase = contTrain.filter(s => s.y).length / Math.max(contTrain.length, 1);
console.log(`  今日漲停樣本 ${contTrain.length}，明日連板基準率 ${(contBase * 100).toFixed(1)}%`);
for (const k of ['luCnt5', 'volX', 'fShare', 'streak', 'ret20', 'mktLU', 't0']) {
  const rows = [];
  for (const [name] of BUCKETS[k]) {
    const grp = contTrain.filter(s => bucketOf(k, s.feats[k]) === name);
    if (grp.length < 30) { rows.push(`${name}: n=${grp.length}`); continue; }
    const r = grp.filter(s => s.y).length / grp.length;
    rows.push(`${name}: ${(r * 100).toFixed(1)}% (n=${grp.length})`);
  }
  console.log(`  ${k.padEnd(7)} ${rows.join(' | ')}`);
}

// ── 驗證：A 榜模型分 = Σ log2(lift)，每日 Top30 命中率（舊模型 vs 加新因子）──
const scoreWith = (s, useNew) => { let w = 0; for (const k in weights) { if (!useNew && NEW_KEYS.has(k)) continue; const b = bucketOf(k, s.feats[k]); if (b) w += weights[k][b] || 0; } return w; };
const byDate = {};
for (const s of test) (byDate[s.date] ||= []).push(s);
let luSum = 0, allSum = 0;
for (const d in byDate) { luSum += byDate[d].filter(s => s.y).length; allSum += byDate[d].length; }
const testBase = luSum / allSum;
console.log(`\n══ A 榜驗證（後 20 日·walk-forward）══`);
console.log(`  驗證期基準漲停率 ${(testBase * 100).toFixed(2)}%（每日全市場約 ${(allSum / 20).toFixed(0)} 檔中 ${(luSum / 20).toFixed(1)} 檔漲停）`);
const topNs = [10, 20, 30];
// 變體：新因子權重縮放(抑制與既有因子的相關重複計分)與子集
const VARIANTS = [
  ['舊模型(8因子)', {}],
  ['+全部新因子(權重1.0)', { luCnt60: 1, indLU5: 1, indHot: 1 }],
  ['+全部新因子(權重0.5)', { luCnt60: 0.5, indLU5: 0.5, indHot: 0.5 }],
  ['+luCnt60(0.5)+indHot(0.5)', { luCnt60: 0.5, indHot: 0.5 }],
  ['+luCnt60(0.5)+indLU5(0.5)', { luCnt60: 0.5, indLU5: 0.5 }],
  ['+indHot(1.0) only', { indHot: 1 }],
  ['+luCnt60(0.3)+indHot(0.3)+indLU5(0.3)', { luCnt60: 0.3, indHot: 0.3, indLU5: 0.3 }],
];
const scoreV = (s, scale) => { let w = 0; for (const k in weights) { const mult = NEW_KEYS.has(k) ? (scale[k] || 0) : 1; if (!mult) continue; const b = bucketOf(k, s.feats[k]); if (b) w += (weights[k][b] || 0) * mult; } return w; };
for (const [tag, scale] of VARIANTS) {
  const hitByN = Object.fromEntries(topNs.map(n => [n, { hit: 0, tot: 0 }]));
  for (const d in byDate) {
    const arr = byDate[d].map(s => ({ s, sc: scoreV(s, scale) })).sort((a, b) => b.sc - a.sc);
    for (const n of topNs) { const top = arr.slice(0, n); hitByN[n].hit += top.filter(x => x.s.y).length; hitByN[n].tot += top.length; }
  }
  const parts = topNs.map(n => { const r = hitByN[n].hit / hitByN[n].tot; return `Top${n} ${(r * 100).toFixed(1)}%(${(r / testBase).toFixed(1)}x)`; });
  console.log(`  ${tag}：${parts.join(' · ')}`);
}
// 個股/族群 3 個月漲停統計（最新截面，供引擎榜單參考）
const last = days.length - 1;
const luKing = {};
for (let k = Math.max(1, last - 59); k <= last; k++) for (const c of (luSetByDay[k] || [])) luKing[c] = (luKing[c] || 0) + 1;
const kings = Object.entries(luKing).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log(`\n══ 3個月漲停王（最新截面 Top10）══\n  ${kings.map(([c, n]) => `${c}×${n}`).join(' | ')}`);
const indCnt = {};
for (const [c, n] of Object.entries(luKing)) { const ind = indMap[c]; if (ind) indCnt[ind] = (indCnt[ind] || 0) + n; }
console.log(`══ 3個月族群漲停排行 Top8 ══\n  ${Object.entries(indCnt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([i, n]) => `${i}×${n}`).join(' | ')}`);
// 連板驗證
const contTest = test.filter(s => s.cont);
const contTestR = contTest.filter(s => s.y).length / Math.max(contTest.length, 1);
const contHi = contTest.filter(s => s.feats.luCnt5 >= 2 && s.feats.volX < 4);
console.log(`\n══ B 榜驗證 ══`);
console.log(`  驗證期今日漲停 ${contTest.length} 檔次，連板率 ${(contTestR * 100).toFixed(1)}%`);
const segs = [
  ['連2板以上(luCnt5≥2)', s => s.feats.luCnt5 >= 2],
  ['首板(luCnt5=1)', s => s.feats.luCnt5 === 1],
  ['外資佔量≥5%', s => s.feats.fShare >= 5],
  ['外資賣超', s => s.feats.fShare < 0],
  ['爆量(volX≥4)', s => s.feats.volX >= 4],
  ['強勢盤(mktLU≥25)', s => s.feats.mktLU >= 25],
];
for (const [name, fn] of segs) {
  const g = contTest.filter(fn);
  if (g.length < 10) { console.log(`  ${name}: n=${g.length} 樣本不足`); continue; }
  console.log(`  ${name}: ${(g.filter(s => s.y).length / g.length * 100).toFixed(1)}% (n=${g.length})`);
}
// ── 消息面因子（newsDaily：鉅亨標題→個股提及/極性，覆蓋近 ~22 交易日）──────
// 誠實方法：新聞只覆蓋驗證段 → 前段(≤-8日)校準 lift、最後 7 日驗證邊際貢獻。
const newsSnap = await db.collection('newsDaily').get();
const newsByDate = {};
for (const d of newsSnap.docs) { const x = d.data(); newsByDate[x.date] = x.mentionsJson ? JSON.parse(x.mentionsJson) : {}; }
for (const s of samples) {
  const day = newsByDate[s.date];
  const m = day?.[s.code];
  s.feats.newsN = day ? (m ? m[0] : 0) : null;      // 當日新聞提及則數
  s.feats.newsPol = day ? (m ? m[1] : 0) : null;    // 極性淨值(正-負)
}
const newsDates = [...new Set(samples.filter(s => s.feats.newsN != null).map(s => s.date))].sort();
console.log(`\n══ 消息面因子（newsDaily 覆蓋 ${newsDates.length} 交易日：${newsDates[0]}~${newsDates[newsDates.length - 1]}）══`);
const valD = new Set(newsDates.slice(-7));
const calS = samples.filter(s => s.feats.newsN != null && !valD.has(s.date));
const calBase = calS.filter(s => s.y).length / calS.length;
const NEWS_BK = {
  newsN:   [['無新聞', v => v === 0], ['1則', v => v === 1], ['≥2則', v => v >= 2]],
  newsPol: [['負面', v => v <= -1], ['中性', v => v === 0], ['正面', v => v >= 1]],
};
const newsW = {};
for (const k in NEWS_BK) {
  newsW[k] = {}; const rows = [];
  for (const [name, fn] of NEWS_BK[k]) {
    const g = calS.filter(s => fn(s.feats[k]));
    if (g.length < 150) { newsW[k][name] = 0; rows.push(`${name}: n=${g.length}(不足)`); continue; }
    const r = g.filter(s => s.y).length / g.length; const lift = r / calBase;
    newsW[k][name] = Math.log2(Math.max(lift, 0.1));
    rows.push(`${name}: ${(r * 100).toFixed(2)}% (lift ${lift.toFixed(2)}x, n=${g.length})`);
  }
  console.log(`  ${k.padEnd(8)} ${rows.join(' | ')}`);
}
const newsBucket = (k, v) => { for (const [name, fn] of NEWS_BK[k]) if (fn(v)) return name; return null; };
// 邊際驗證：最後 7 日，最佳既有模型(阻尼0.3) ± 消息因子(測 0.3/0.5/1.0 阻尼)
const bestScale = { luCnt60: 0.3, indHot: 0.3, indLU5: 0.3 };
const valSamples = samples.filter(s => valD.has(s.date));
const byD2 = {}; for (const s of valSamples) (byD2[s.date] ||= []).push(s);
for (const [tag, nd] of [['基準(v2模型·無消息)', 0], ['+消息(阻尼0.3)', 0.3], ['+消息(阻尼0.5)', 0.5], ['+消息(權重1.0)', 1]]) {
  const hitByN = Object.fromEntries(topNs.map(n => [n, { hit: 0, tot: 0 }]));
  for (const d in byD2) {
    const arr = byD2[d].map(s => {
      let sc = scoreV(s, bestScale);
      if (nd && s.feats.newsN != null) for (const k in NEWS_BK) { const b = newsBucket(k, s.feats[k]); if (b) sc += (newsW[k][b] || 0) * nd; }
      return { s, sc };
    }).sort((a, b) => b.sc - a.sc);
    for (const n of topNs) { const top = arr.slice(0, n); hitByN[n].hit += top.filter(x => x.s.y).length; hitByN[n].tot += top.length; }
  }
  const vBase = valSamples.filter(s => s.y).length / valSamples.length;
  console.log(`  ${tag}：${topNs.map(n => { const r = hitByN[n].hit / hitByN[n].tot; return `Top${n} ${(r * 100).toFixed(1)}%(${(r / vBase).toFixed(1)}x)`; }).join(' · ')}（驗證僅7日·樣本小）`);
}

console.log('\n（確定性統計，非投資建議）');
process.exit(0);
