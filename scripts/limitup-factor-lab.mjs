#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 漲停預測：單因子檢定實驗室
//
// 起因（2026-08-28 使用者提問）：現行漲停預測 31 日 hit10Rate 14.2%、
// hit30Rate 11.2%（基準率約 0.9%，即 ~15 倍提升）。問能不能用軋空模型
// 生變體、累積歷史改善、以及在沒有新聞 AI 的情況下還能提升多少。
//
// 「能不能」不靠推理——同一天的軋空實驗才剛證明直覺會錯（最像「軋空前夜」
// 的那組樣本外報酬是負的）。所以先做單因子檢定，看哪些因子**真的**有鑑別力。
//
// 兩個標的分開量（對隔日沖的意義完全不同）：
//   A 隔日**收盤**漲停　→ 鎖死，當沖賣不掉，是「抱過夜」的目標
//   B 隔日**盤中觸及**漲停 → 當沖有機會出，是比較實際的操作目標
//
// 紀律（與 squeeze-gate-lab 同一套）：
//   · 時間序 OOT 切分（訓練 70% / 樣本外 30%），訓練段只看方向
//   · 安慰劑：同樣張數隨機抽樣，作為「隨機也能拿到多少」的量尺
//   · 所有特徵僅用 ≤ t 的資料（PIT 安全）
//
// 用法：node scripts/limitup-factor-lab.mjs [--days=400] [--target=close|touch]
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DAYS = Number(arg('days', 400));
const TARGET = arg('target', 'touch');   // touch = 盤中觸及漲停（當沖可出）

// 檔位表（個股）——漲停價必須落在檔位上，否則比較會失準
const tickOf = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
const limitOf = prev => { const raw = prev * 1.1, tk = tickOf(raw); return Math.floor(raw / tk + 1e-6) * tk; };

async function load() {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS).get();
  return snap.docs.map(d => d.data()).filter(a => a?.closeJson).reverse().map(a => ({
    date: a.date,
    close: JSON.parse(a.closeJson),                          // [close, volLots, open, high, low]
    margin: a.marginJson ? JSON.parse(a.marginJson) : null,  // [融資餘額, 融券餘額]
    inst: a.instJson ? JSON.parse(a.instJson) : null,        // [外資, 投信]（張）
    lend: a.lendingJson ? JSON.parse(a.lendingJson) : null,  // 借券餘額
    dt: a.dayTradeJson ? JSON.parse(a.dayTradeJson) : null,  // 當沖張數
  }));
}

function build(days) {
  const T = days.length;
  const at = (i, f) => { for (let k = i; k >= 0 && k > i - 6; k--) if (days[k][f]) return k; return -1; };
  const avgVol = (t, c) => { let s = 0, k = 0; for (let i = Math.max(0, t - 19); i <= t; i++) { const v = days[i].close[c]?.[1] ?? 0; if (v > 0) { s += v; k++; } } return k ? s / k : 0; };
  const hi20 = (t, c) => { let h = 0; for (let q = 1; q <= 20; q++) { const v = days[t - q]?.close[c]?.[0] ?? 0; if (v > h) h = v; } return h; };

  // 每日市場漲停家數（regime 因子，PIT 安全：只用 ≤t）
  const luCount = [];
  for (let k = 0; k < T; k++) {
    let n = 0;
    if (k > 0) for (const c in days[k].close) { const p = days[k - 1].close[c]?.[0]; const q = days[k].close[c]?.[0]; if (p > 0 && q > 0 && q >= limitOf(p) - 1e-9) n++; }
    luCount.push(n);
  }

  const rows = [];
  for (let t = 26; t < T - 1; t++) {
    const mi = at(t, 'margin'), ii = at(t, 'inst'), li = at(t, 'lend'), di = at(t, 'dt');
    const mPrev = mi >= 0 ? at(mi - 1, 'margin') : -1;
    const lPrev = li >= 0 ? at(li - 1, 'lend') : -1;
    const nxt = days[t + 1];
    for (const c in days[t].close) {
      if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
      const cur = days[t].close[c], p1 = days[t - 1]?.close[c], nx = nxt.close[c];
      if (!cur || !p1 || !nx) continue;
      const close = cur[0], vol = cur[1], high = cur[3], low = cur[4], prev = p1[0];
      if (!(close > 10) || !(prev > 0) || !(vol > 0)) continue;
      const av = avgVol(t, c); if (!(av >= 300)) continue;      // 流動性下限：太冷門的沒有操作意義

      const lim = limitOf(prev);
      const mg = mi >= 0 ? days[mi].margin[c] : null;
      const mgP = mPrev >= 0 ? days[mPrev].margin[c] : null;
      const inst = ii >= 0 ? days[ii].inst[c] : null;
      const lend = li >= 0 ? days[li].lend[c] : null;
      const lendP = lPrev >= 0 ? days[lPrev].lend[c] : null;
      const dtLots = di >= 0 ? days[di].dt[c] : null;

      const h20 = hi20(t, c);
      const nLim = limitOf(close);
      rows.push({
        date: days[t].date, code: c,
        chg: ((close - prev) / prev) * 100,
        isLU: close >= lim - 1e-9,                                  // 當日就是漲停（連板題）
        volX: av > 0 ? vol / av : 0,
        brk20: h20 > 0 && close >= h20,
        pos: high > low ? (close - low) / (high - low) : 0.5,       // 收盤在日內位置
        amp: prev > 0 ? ((high - low) / prev) * 100 : 0,
        ratio: mg && mg[0] > 0 ? (mg[1] / mg[0]) * 100 : 0,          // 券資比
        shrtChg: mg && mgP ? mg[1] - mgP[1] : 0,                     // 融券日增
        instNet: inst ? (inst[0] || 0) + (inst[1] || 0) : 0,         // 法人淨買（張）
        instX: inst && av > 0 ? ((inst[0] || 0) + (inst[1] || 0)) / av * 100 : 0,
        lendChg: lend != null && lendP != null ? lend - lendP : 0,   // 借券日增
        dtRatio: dtLots != null && vol > 0 ? (dtLots / (vol * 1000)) * 100 : null, // 當沖比率
        mktLU: luCount[t],                                           // 當日市場漲停家數（regime）
        close, av,
        // 標的
        yClose: nx[0] >= limitOf(close) - 1e-9,                      // 隔日收盤漲停
        yTouch: (nx[3] ?? 0) >= nLim - 1e-9,                         // 隔日盤中觸及漲停
        yOpenLocked: (nx[2] ?? 0) >= nLim - 1e-9,                    // 隔日開盤即鎖（買不到）
      });
    }
  }
  return rows;
}

// ── 因子（全部 PIT 安全）────────────────────────────────────────────
const FACTORS = [
  ['當日漲停（連板）', s => s.isLU],
  ['當日漲 7~10%', s => s.chg >= 7 && !s.isLU],
  ['當日漲 5~7%', s => s.chg >= 5 && s.chg < 7],
  ['當日漲 3~5%', s => s.chg >= 3 && s.chg < 5],
  ['當日漲 0~3%', s => s.chg >= 0 && s.chg < 3],
  ['當日下跌', s => s.chg < 0],
  ['量增 2~5x', s => s.volX >= 2 && s.volX < 5],
  ['量增 ≥5x', s => s.volX >= 5],
  ['量增 1.5~2x', s => s.volX >= 1.5 && s.volX < 2],
  ['破20日高', s => s.brk20],
  ['收盤位置 ≥0.9', s => s.pos >= 0.9],
  ['振幅 ≥7%', s => s.amp >= 7],
  ['券資比 ≥10%', s => s.ratio >= 10],
  ['券資比 ≥20%', s => s.ratio >= 20],
  ['融券日增 >0', s => s.shrtChg > 0],
  ['融券日增 ≥均量0.5%', s => s.shrtChg >= s.av * 0.005],
  ['法人淨買/均量 ≥5%', s => s.instX >= 5],
  ['法人淨買/均量 ≥15%', s => s.instX >= 15],
  ['法人賣超', s => s.instNet < 0],
  ['借券日增 >0', s => s.lendChg > 0],
  ['當沖比率 ≥40%', s => s.dtRatio != null && s.dtRatio >= 40],
  ['當沖比率 <15%', s => s.dtRatio != null && s.dtRatio < 15],
  ['市場漲停 ≥30 家（熱）', s => s.mktLU >= 30],
  ['市場漲停 <10 家（冷）', s => s.mktLU < 10],
  ['價 10~50 元', s => s.close >= 10 && s.close < 50],
  ['價 ≥200 元', s => s.close >= 200],
];

const days = await load();
const rows = build(days);
const dates = [...new Set(rows.map(r => r.date))].sort();
const cut = dates[Math.floor(dates.length * 0.7)];
const train = rows.filter(r => r.date < cut);
const oot = rows.filter(r => r.date >= cut);

const hit = TARGET === 'close' ? (r => r.yClose) : (r => r.yTouch);
const label = TARGET === 'close' ? '隔日收盤漲停' : '隔日盤中觸及漲停';

const rate = seg => seg.length ? seg.filter(hit).length / seg.length * 100 : 0;
const baseTr = rate(train), baseOo = rate(oot);

console.log(`\n漲停預測·單因子檢定｜標的＝**${label}**`);
console.log(`樣本 ${rows.length} 筆 / ${dates.length} 交易日（${dates[0]} ~ ${dates[dates.length - 1]}）`);
console.log(`切分：訓練段 < ${cut}（${train.length}）｜樣本外 ≥ ${cut}（${oot.length}）`);
console.log(`基準率：訓練段 ${baseTr.toFixed(2)}%｜樣本外 ${baseOo.toFixed(2)}%`);
console.log(`（另記：隔日開盤即鎖漲停＝買不到，樣本外佔 ${(oot.filter(r => r.yOpenLocked).length / oot.length * 100).toFixed(2)}%）\n`);

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('因子', 24) + pad('訓練 n', 9) + pad('命中率', 9) + pad('樣本外 n', 10) + pad('命中率', 9) + pad('倍數', 8) + '方向一致');
console.log('─'.repeat(96));
const res = [];
for (const [name, f] of FACTORS) {
  const tr = train.filter(f), oo = oot.filter(f);
  if (tr.length < 80 || oo.length < 30) continue;
  const rt = rate(tr), ro = rate(oo);
  const lift = baseOo > 0 ? ro / baseOo : 0;
  const same = (rt > baseTr) === (ro > baseOo);
  res.push({ name, nTr: tr.length, rt, nOo: oo.length, ro, lift, same });
}
res.sort((a, b) => b.lift - a.lift);
for (const r of res) {
  console.log(pad(r.name, 24) + pad(r.nTr, 9) + pad(r.rt.toFixed(2) + '%', 9) + pad(r.nOo, 10) + pad(r.ro.toFixed(2) + '%', 9) + pad(r.lift.toFixed(2) + 'x', 8) + (r.same ? '✓' : '✗ 兩段方向相反'));
}
console.log(`\n⚠ 倍數＝樣本外命中率 ÷ 樣本外基準率（${baseOo.toFixed(2)}%）。方向不一致的因子一律不採用——`);
console.log('   那是「訓練段挑出來、樣本外不成立」的典型過擬合長相。');

// ── 組合檢定 ───────────────────────────────────────────────────────────
// 單因子最強的是「連板」（5.63x）。問題是：組合能不能更高、而且每天還有得挑？
// 只報**樣本外**，並附「每日檔數」——命中率再高、一年只出現三次就沒有操作價值。
const F = Object.fromEntries(FACTORS);
const COMBOS = [
  ['連板', s => F['當日漲停（連板）'](s)],
  ['連板 × 量增≥2x', s => F['當日漲停（連板）'](s) && s.volX >= 2],
  ['連板 × 收盤位置≥0.9', s => F['當日漲停（連板）'](s) && s.pos >= 0.9],
  ['連板 × 券資比≥10%', s => F['當日漲停（連板）'](s) && s.ratio >= 10],
  ['連板 × 融券日增≥均量0.5%', s => F['當日漲停（連板）'](s) && s.shrtChg >= s.av * 0.005],
  ['連板 × 法人淨買≥5%均量', s => F['當日漲停（連板）'](s) && s.instX >= 5],
  ['連板 × 非法人賣超 × 量增≥2x', s => F['當日漲停（連板）'](s) && s.instNet >= 0 && s.volX >= 2],
  ['破20日高 × 量增≥2x × 收盤≥0.9', s => s.brk20 && s.volX >= 2 && s.pos >= 0.9],
  ['破20日高 × 漲5~10% × 收盤≥0.9', s => s.brk20 && s.chg >= 5 && !s.isLU && s.pos >= 0.9],
  ['漲7~10% × 量增≥2x × 收盤≥0.9', s => s.chg >= 7 && !s.isLU && s.volX >= 2 && s.pos >= 0.9],
  ['軋空型：券資比≥10% × 融券日增≥均量0.5% × 漲≥5%', s => s.ratio >= 10 && s.shrtChg >= s.av * 0.005 && s.chg >= 5],
  ['連板 或（破20日高 × 量增≥2x × 收盤≥0.9）', s => F['當日漲停（連板）'](s) || (s.brk20 && s.volX >= 2 && s.pos >= 0.9)],
];
const ootDays = new Set(oot.map(r => r.date)).size;
console.log(`\n\n組合檢定（只報樣本外｜基準 ${baseOo.toFixed(2)}%｜樣本外 ${ootDays} 個交易日）`);
console.log(pad('組合', 46) + pad('n', 8) + pad('命中率', 10) + pad('倍數', 8) + pad('每日檔數', 10) + '訓練段命中率');
console.log('─'.repeat(104));
const combo = [];
for (const [name, f] of COMBOS) {
  const oo = oot.filter(f), tr = train.filter(f);
  if (oo.length < 20) { console.log(pad(name, 46) + `樣本外僅 ${oo.length} 筆，不足以判讀`); continue; }
  const ro = rate(oo), rt = rate(tr);
  combo.push({ name, n: oo.length, ro, lift: ro / baseOo, perDay: oo.length / ootDays, rt });
  console.log(pad(name, 46) + pad(oo.length, 8) + pad(ro.toFixed(2) + '%', 10) + pad((ro / baseOo).toFixed(2) + 'x', 8) + pad((oo.length / ootDays).toFixed(1), 10) + rt.toFixed(2) + '%');
}
console.log('\n⚠ 命中率高但每日檔數 <1 的組合沒有操作價值——一年只出現幾次的規則無法構成一個榜單。');
process.exit(0);
