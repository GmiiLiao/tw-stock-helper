// ─────────────────────────────────────────────────────────────────────────
// RSI(5/10) 對漲停預測模型的「增量價值」walk-forward 檢定（2026-07-27）
// 方法：復刻現行 limitUpForecast 的分桶 lift×log2 加權模型（LU_LIFT 定版權重），
// 前半窗訓練 RSI 分桶 lift → 後半窗（模型未見過）比較每日 Top10/Top30 命中率。
// 宇宙：可交易（chg≤8.5·排除今日已漲停＝A榜口徑）。命中＝隔日收盤漲停。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples } from './lib/bt-core.mjs';

const days = await loadDays({ days: 720 });
const samples = buildSamples(days);

// ── RSI + ret20 + luCnt5 補齊 ──
const tickOf = p => p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
const isLU = (c, pc) => { if (!(pc > 0)) return false; const raw = pc * 1.1, t = tickOf(raw); return c >= Math.floor(raw / t + 1e-9) * t - 1e-6; };
const luSets = [null];
for (let i = 1; i < days.length; i++) { const s = new Set();
  for (const c in days[i].close) { const p = days[i - 1].close?.[c]?.[0]; if (p && isLU(days[i].close[c][0], p)) s.add(c); } luSets.push(s); }

const hist = {};
for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
  if (!/^\d{4}$/.test(code)) continue;
  const c = days[i].close[code]?.[0]; if (c > 0) (hist[code] ||= []).push([i, c]);
}
const bykey = {};
for (const code in hist) { const a = hist[code]; if (a.length < 25) continue;
  let u5 = 0, d5 = 0, u10 = 0, d10 = 0, p10 = 50;
  for (let k = 1; k < a.length; k++) {
    const ch = a[k][1] - a[k - 1][1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (k <= 5) { u5 += g / 5; d5 += l / 5; } else { u5 = (u5 * 4 + g) / 5; d5 = (d5 * 4 + l) / 5; }
    if (k <= 10) { u10 += g / 10; d10 += l / 10; } else { u10 = (u10 * 9 + g) / 10; d10 = (d10 * 9 + l) / 10; }
    const r5 = u5 + d5 > 0 ? u5 / (u5 + d5) * 100 : 50, r10 = u10 + d10 > 0 ? u10 / (u10 + d10) * 100 : 50;
    if (k >= 20) bykey[a[k][0] + '_' + code] = { r5, r10, p10, ret20: a[k - 20] ? (a[k][1] - a[k - 20][1]) / a[k - 20][1] * 100 : null };
    p10 = r10;
  }
}
for (const s of samples) {
  const x = bykey[s.di + '_' + s.code]; if (x) Object.assign(s, x);
  let lu5 = 0; for (let k = s.di - 4; k <= s.di; k++) if (luSets[k]?.has(s.code)) lu5++;
  s.luCnt5 = lu5;
  const it = days[s.di - 1]?.inst?.[s.code];   // 法人 t-1（PIT）
  s.fShare = it && s.v > 0 ? (it[0] || 0) / s.v * 100 : 0;
  s.t0 = it ? (it[1] || 0) : 0;
  s.nearHi = s.hi20 > 0 ? (s.c / s.hi20 - 1) * 100 : null;
  s.LU = s.rNC >= 9.3;   // 隔日漲停（命中）
}
const uni = samples.filter(s => s.tradable && s.r5 != null && s.ret20 != null && s.nearHi != null);
const mid = Math.floor(days.length / 2);
const train = uni.filter(s => s.di < mid), test = uni.filter(s => s.di >= mid);
const rate = a => a.length ? a.filter(x => x.LU).length / a.length * 100 : 0;
console.log(`訓練 ${train.length.toLocaleString()}（漲停率 ${rate(train).toFixed(2)}%）／驗證 ${test.length.toLocaleString()}（${rate(test).toFixed(2)}%）\n`);

// ── 現行模型 LU_LIFT（daemon 定版·不得手改）──
const LU_LIFT = {
  chg0:   [['<0', v => v < 0, 0.68], ['0~3', v => v < 3, 0.59], ['3~7', v => v < 7, 1.66], ['7~9.5', () => true, 2.62]],
  ret5:   [['<-3', v => v < -3, 0.77], ['平淡', v => v < 3, 0.46], ['+3~10', v => v < 10, 1.16], ['≥10', () => true, 3.29]],
  ret20:  [['跌', v => v < 0, 0.47], ['0~10', v => v < 10, 0.64], ['10~25', v => v < 25, 1.54], ['≥25', () => true, 3.13]],
  volX:   [['量縮', v => v < 1, 0.75], ['量平', v => v < 2, 1.05], ['2-4x', v => v < 4, 2.03], ['≥4x', () => true, 2.68]],
  nearHi: [['>10%', v => v < -10, 1.01], ['2~10%', v => v < -2, 0.63], ['貼近', v => v < 0, 0.73], ['創新高', () => true, 2.48]],
  luCnt5: [['無板', v => v === 0, 0.63], ['1板', v => v === 1, 2.81], ['≥2板', () => true, 4.76]],
  fShare: [['賣超', v => v < 0, 0.90], ['小買', v => v < 5, 1.35], ['5-15%', v => v < 15, 1.32], ['重倉', () => true, 0.86]],
  t0:     [['未買', v => v <= 0, 0.91], ['買超', () => true, 1.76]],
};
const liftOf = (tbl, v) => { for (const [, pred, lift] of tbl) if (pred(v)) return lift; return 1; };
const baseScore = s => Math.log2(liftOf(LU_LIFT.chg0, s.chg)) + Math.log2(liftOf(LU_LIFT.ret5, s.ret5))
  + Math.log2(liftOf(LU_LIFT.ret20, s.ret20)) + Math.log2(liftOf(LU_LIFT.volX, s.volX))
  + Math.log2(liftOf(LU_LIFT.nearHi, s.nearHi)) + Math.log2(liftOf(LU_LIFT.luCnt5, s.luCnt5))
  + Math.log2(liftOf(LU_LIFT.fShare, s.fShare)) + Math.log2(liftOf(LU_LIFT.t0, s.t0));

// ── RSI 分桶 lift：只用訓練窗（不得偷看驗證窗）──
const R5B = [['<20', s => s.r5 < 20], ['20~50', s => s.r5 < 50], ['50~70', s => s.r5 < 70], ['70~85', s => s.r5 < 85], ['85~95', s => s.r5 < 95], ['≥95', () => true]];
const R10B = [['<30', s => s.r10 < 30], ['30~60', s => s.r10 < 60], ['60~80', s => s.r10 < 80], ['80~90', s => s.r10 < 90], ['≥90', () => true]];
const bucketLifts = (bkts) => {
  const base = rate(train) / 100;
  return bkts.map(([label, pred], i) => {
    const sel = train.filter(s => bkts.findIndex(([, p]) => p(s)) === i);
    const r = sel.length >= 200 ? (rate(sel) / 100) / base : 1;
    return [label, pred, +r.toFixed(2), sel.length];
  });
};
const L5 = bucketLifts(R5B), L10 = bucketLifts(R10B);
console.log('訓練窗學到的 RSI lift：');
console.log('  RSI5 ', L5.map(x => `${x[0]}:${x[2]}x(n${x[3]})`).join(' '));
console.log('  RSI10', L10.map(x => `${x[0]}:${x[2]}x(n${x[3]})`).join(' '));
const rsiScore = (s, damp) => {
  const i5 = R5B.findIndex(([, p]) => p(s)), i10 = R10B.findIndex(([, p]) => p(s));
  return damp * (Math.log2(L5[i5][2]) + Math.log2(L10[i10][2]));
};

// ── 驗證窗每日 Top-N 命中率 ──
const byDay = {};
for (const s of test) (byDay[s.di] ||= []).push(s);
const evalTopN = (scorer, N) => {
  let hit = 0, tot = 0, days2 = 0;
  for (const di in byDay) {
    const arr = byDay[di]; if (arr.length < 100) continue;
    const top = [...arr].sort((a, b) => scorer(b) - scorer(a)).slice(0, N);
    hit += top.filter(s => s.LU).length; tot += top.length; days2++;
  }
  return { pct: +(hit / tot * 100).toFixed(2), days: days2, hit, tot };
};
const baseRate = rate(test);
console.log(`\n驗證窗基準漲停率 ${baseRate.toFixed(2)}%（每日 Top-N 排序命中率）`);
const rows = [
  ['現行因子（8項·定版）', s => baseScore(s)],
  ['＋RSI（阻尼0.3·同新因子慣例）', s => baseScore(s) + rsiScore(s, 0.3)],
  ['＋RSI（阻尼0.6）', s => baseScore(s) + rsiScore(s, 0.6)],
  ['＋RSI（全權重1.0）', s => baseScore(s) + rsiScore(s, 1.0)],
  ['純 RSI（對照）', s => rsiScore(s, 1.0)],
];
for (const [label, sc] of rows) {
  const t10 = evalTopN(sc, 10), t30 = evalTopN(sc, 30);
  console.log(`  ${label.padEnd(26)} Top10 ${String(t10.pct).padStart(5)}%(${(t10.pct/baseRate).toFixed(1)}x·${t10.hit}/${t10.tot})  Top30 ${String(t30.pct).padStart(5)}%(${(t30.pct/baseRate).toFixed(1)}x)`);
}
process.exit(0);
