#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 漲停預測：候選模型 vs 線上模型 正面對決
//
// 為什麼要這支：limitup-factor-lab 顯示「連板 × 券資比」樣本外命中 29.94%，
// 而線上 31 日 hit10Rate 是 14.2%。但兩者**不是 like-for-like**——宇宙不同、
// 期間不同。不做同期間同宇宙的對決就宣稱改善，就是拿不同尺量兩個東西。
//
// 做法：
//   · 線上那一側**用實際紀錄**（limitUpForecast/review-* 的 hits+failed
//     ＝當日 top-30 真實預測），不重寫評分器——重寫必然有偏差。
//   · 候選那一側用同樣的日子、同樣的標的定義（隔日**收盤**漲停）重放。
//   · ⚠ 權重只用**訓練段（< 2026-03-18）**推導；測試日是 2026-07~08，
//     完全樣本外。用含測試日的資料挑權重＝拿答案配題目。
//
// 用法：node scripts/limitup-headtohead.mjs [--top=30]
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const TOP = Number(arg('top', 30));

const tickOf = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
const limitOf = prev => { const raw = prev * 1.1, tk = tickOf(raw); return Math.floor(raw / tk + 1e-6) * tk; };

// ── 候選模型的評分（權重取自訓練段實測倍數，四捨五入到 0.5，不做細調）──
// 刻意保持**可讀、少參數**：參數越多越容易在 31 天的測試集上騙到自己。
const score = s => {
  let v = 0;
  if (s.isLU) v += 3;                                   // 連板 5.6x — 最強單因子
  if (s.ratio >= 20) v += 2.5; else if (s.ratio >= 10) v += 2;   // 券資比 1.9x
  if (s.shrtChg >= s.av * 0.005) v += 1.5;              // 融券日增≥均量0.5% 2.15x
  if (s.volX >= 5) v += 1.5; else if (s.volX >= 2) v += 1;       // 量增 2.5x / 2.2x
  if (s.brk20) v += 1;                                  // 破20日高 2.45x
  if (s.pos >= 0.9) v += 1;                             // 收盤位置 2.25x
  if (s.amp >= 7) v += 0.5;                             // 振幅 2.3x（與量增高度重疊，減半）
  if (s.instX >= 5) v += 0.5;                           // 法人淨買 1.1x
  if (s.instNet < 0) v -= 0.5;                          // 法人賣超 0.90x（反向）
  if (s.dtRatio != null && s.dtRatio < 15) v -= 0.5;    // 低當沖比 0.79x（反向）
  if (s.lendChg > 0) v -= 0.25;                         // 借券日增 0.92x（反向·弱）
  return v;
};

// ── 載入線上實績 ───────────────────────────────────────────────────────
const revSnap = await db.collection('limitUpForecast').get();
const reviews = revSnap.docs.filter(d => d.id.startsWith('review-')).map(d => d.data())
  .filter(r => r.predDate && Array.isArray(r.hits) && Array.isArray(r.failed))
  .sort((a, b) => a.predDate.localeCompare(b.predDate));
if (!reviews.length) { console.log('沒有線上實績可比'); process.exit(1); }

const predDates = reviews.map(r => r.predDate);
console.log(`\n線上實績：${reviews.length} 個預測日（${predDates[0]} ~ ${predDates[predDates.length - 1]}）`);

// ── 載入 chipArchive（要涵蓋預測日的前 26 日起算，與預測日的隔日）────────
const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(400).get();
const days = snap.docs.map(d => d.data()).filter(a => a?.closeJson).reverse().map(a => ({
  date: a.date,
  close: JSON.parse(a.closeJson),
  margin: a.marginJson ? JSON.parse(a.marginJson) : null,
  inst: a.instJson ? JSON.parse(a.instJson) : null,
  lend: a.lendingJson ? JSON.parse(a.lendingJson) : null,
  dt: a.dayTradeJson ? JSON.parse(a.dayTradeJson) : null,
}));
const idxOf = Object.fromEntries(days.map((d, i) => [d.date, i]));

const at = (i, f) => { for (let k = i; k >= 0 && k > i - 6; k--) if (days[k][f]) return k; return -1; };
const avgVol = (t, c) => { let s = 0, k = 0; for (let i = Math.max(0, t - 19); i <= t; i++) { const v = days[i].close[c]?.[1] ?? 0; if (v > 0) { s += v; k++; } } return k ? s / k : 0; };
const hi20 = (t, c) => { let h = 0; for (let q = 1; q <= 20; q++) { const v = days[t - q]?.close[c]?.[0] ?? 0; if (v > h) h = v; } return h; };

function candidatesOn(t) {
  const mi = at(t, 'margin'), ii = at(t, 'inst'), li = at(t, 'lend'), di = at(t, 'dt');
  const mPrev = mi >= 0 ? at(mi - 1, 'margin') : -1;
  const lPrev = li >= 0 ? at(li - 1, 'lend') : -1;
  const out = [];
  for (const c in days[t].close) {
    if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
    const cur = days[t].close[c], p1 = days[t - 1]?.close[c];
    if (!cur || !p1) continue;
    const close = cur[0], vol = cur[1], high = cur[3], low = cur[4], prev = p1[0];
    if (!(close > 10) || !(prev > 0) || !(vol > 0)) continue;
    const av = avgVol(t, c); if (!(av >= 300)) continue;
    const mg = mi >= 0 ? days[mi].margin[c] : null;
    const mgP = mPrev >= 0 ? days[mPrev].margin[c] : null;
    const inst = ii >= 0 ? days[ii].inst[c] : null;
    const lend = li >= 0 ? days[li].lend[c] : null;
    const lendP = lPrev >= 0 ? days[lPrev].lend[c] : null;
    const dtLots = di >= 0 ? days[di].dt[c] : null;
    const h20 = hi20(t, c);
    const s = {
      code: c, close, av,
      isLU: close >= limitOf(prev) - 1e-9,
      volX: av > 0 ? vol / av : 0,
      brk20: h20 > 0 && close >= h20,
      pos: high > low ? (close - low) / (high - low) : 0.5,
      amp: prev > 0 ? ((high - low) / prev) * 100 : 0,
      ratio: mg && mg[0] > 0 ? (mg[1] / mg[0]) * 100 : 0,
      shrtChg: mg && mgP ? mg[1] - mgP[1] : 0,
      instNet: inst ? (inst[0] || 0) + (inst[1] || 0) : 0,
      instX: inst && av > 0 ? ((inst[0] || 0) + (inst[1] || 0)) / av * 100 : 0,
      lendChg: lend != null && lendP != null ? lend - lendP : 0,
      dtRatio: dtLots != null && vol > 0 ? (dtLots / (vol * 1000)) * 100 : null,
    };
    s.sc = score(s);
    out.push(s);
  }
  return out.sort((a, b) => b.sc - a.sc);
}

// ── 對決 ───────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n對決｜標的＝隔日**收盤**漲停（與線上 actualLU 同定義）｜各取 top ${TOP}\n`);
console.log(pad('預測日', 12) + pad('當日實際漲停', 14) + pad('線上命中', 12) + pad('候選命中', 12) + '差');
console.log('─'.repeat(64));

let pOn = 0, pAll = 0, cOn = 0, cAll = 0, dayWin = 0, dayLose = 0, usable = 0;
const perDay = [];
for (const r of reviews) {
  const t = idxOf[r.predDate];
  if (t == null || t < 26 || t + 1 >= days.length) continue;
  const nxt = days[t + 1];
  const isHit = code => {
    const cur = days[t].close[code], nx = nxt.close[code];
    return !!(cur && nx && nx[0] >= limitOf(cur[0]) - 1e-9);
  };
  const prodTop = [...r.hits, ...r.failed].slice(0, TOP).map(x => x.code);
  const prodHit = prodTop.filter(isHit).length;
  const mine = candidatesOn(t).slice(0, TOP);
  const myHit = mine.filter(x => isHit(x.code)).length;

  usable++; pOn += prodHit; pAll += prodTop.length; cOn += myHit; cAll += mine.length;
  perDay.push({ date: r.predDate, lu: r.actualLU ?? 0, p: prodHit, c: myHit, n: TOP });
  if (myHit > prodHit) dayWin++; else if (myHit < prodHit) dayLose++;
  const d = myHit - prodHit;
  console.log(pad(r.predDate, 12) + pad(r.actualLU ?? '—', 14) + pad(`${prodHit}/${prodTop.length}`, 12) + pad(`${myHit}/${mine.length}`, 12) + (d > 0 ? `+${d}` : d));
}

const pr = pAll ? pOn / pAll * 100 : 0, cr = cAll ? cOn / cAll * 100 : 0;
console.log('─'.repeat(64));
console.log(`\n可比日數 ${usable}`);
console.log(`  線上模型：命中 ${pOn}/${pAll} ＝ ${pr.toFixed(2)}%`);
console.log(`  候選模型：命中 ${cOn}/${cAll} ＝ ${cr.toFixed(2)}%`);
console.log(`  差距：${(cr - pr) >= 0 ? '+' : ''}${(cr - pr).toFixed(2)}pp`);
console.log(`  逐日勝負：候選贏 ${dayWin} 天、輸 ${dayLose} 天、平 ${usable - dayWin - dayLose} 天`);
// ── 分市況檢定 ─────────────────────────────────────────────────────────
// 總體平手不代表兩個模型一樣：逐日表看得出分歧集中在漲停家數極端的日子。
// 若某一側在特定市況明顯較好，regime 切換的集成模型就是真的改善。
const REG = [
  ['冷（實際漲停 <10 家）', d => d.lu < 10],
  ['普通（10~29 家）', d => d.lu >= 10 && d.lu < 30],
  ['熱（≥30 家）', d => d.lu >= 30],
];
console.log('\n\n分市況（依當日實際漲停家數）');
console.log(pad('市況', 22) + pad('日數', 7) + pad('線上', 14) + pad('候選', 14) + '差');
console.log('─'.repeat(66));
for (const [name, f] of REG) {
  const g = perDay.filter(f);
  if (!g.length) { console.log(pad(name, 22) + '0'); continue; }
  const p2 = g.reduce((a, b) => a + b.p, 0), c2 = g.reduce((a, b) => a + b.c, 0);
  const n2 = g.reduce((a, b) => a + b.n, 0);
  const pr2 = p2 / n2 * 100, cr2 = c2 / n2 * 100;
  console.log(pad(name, 22) + pad(g.length, 7) + pad(`${p2}/${n2} ${pr2.toFixed(1)}%`, 14) + pad(`${c2}/${n2} ${cr2.toFixed(1)}%`, 14) + `${cr2 - pr2 >= 0 ? '+' : ''}${(cr2 - pr2).toFixed(1)}pp`);
}
console.log(`\n⚠ 權重取自訓練段（< 2026-03-18）的實測倍數，測試日全在 2026-07 之後——樣本外。`);
console.log('   逐日勝負若接近五五波，總體差距就可能只是幾天的極端值造成的，不足以換模型。');
process.exit(0);
