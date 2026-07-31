// ─────────────────────────────────────────────────────────────────────────
// 犀利媽「短線只設 5 日線」法回測（2026-07-24·bt-core 准入關卡）
// 方法論（影片標題+公開方法）：短線唯一指標=5日線——站上做多/跌破出場、
// 乖離過大=過熱不追、回測5日線=買點、遠低於5日線=超跌反彈。
// 檢定（可交易宇宙·兩半窗·regime·雙口徑+5日持有）：
//  A. 乖離5日線分桶 → 隔日/5日報酬
//  B. 回測5日線買點：多頭結構(c>MA20)×觸5日線不破×非大漲日
//  C. 跌破5日線（賣訊驗證）  D. 過熱定義比較：乖離5 vs 現行ret5
//  E. 話題結合代理：熱門族群(5日板數前3) × 5日線買點
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, report } from './lib/bt-core.mjs';

const days = await loadDays({ days: 720 });
const samples = buildSamples(days);

// 補 MA5/MA20/昨日乖離/族群熱（PIT：全部 t 日收盤可得）
const hist = {}; // code → closes[]
const bias5At = {}, ma5At = {}, ma20At = {}, prevBias5 = {};
for (let i = 0; i < days.length; i++) {
  for (const code in days[i].close) {
    if (!/^\d{4}$/.test(code)) continue;
    const c = days[i].close[code]?.[0]; if (!(c > 0)) continue;
    (hist[code] ||= []).push([i, c]);
  }
}
const bykey = {};
for (const code in hist) {
  const arr = hist[code];
  for (let k = 0; k < arr.length; k++) {
    const [di, c] = arr[k];
    if (k >= 4) {
      const m5 = (arr[k][1] + arr[k-1][1] + arr[k-2][1] + arr[k-3][1] + arr[k-4][1]) / 5;
      bykey[di + '_' + code] = { m5, bias5: (c - m5) / m5 * 100 };
      if (k >= 19) {
        let s = 0; for (let j = 0; j < 20; j++) s += arr[k-j][1];
        bykey[di + '_' + code].m20 = s / 20;
      }
      if (k >= 5) {
        const pm5 = (arr[k-1][1] + arr[k-2][1] + arr[k-3][1] + arr[k-4][1] + arr[k-5][1]) / 5;
        bykey[di + '_' + code].pAbove = arr[k-1][1] > pm5;   // 昨日是否站上昨日5日線
      }
    }
  }
}
for (const s of samples) {
  const x = bykey[s.di + '_' + s.code];
  if (x) { s.m5 = x.m5; s.bias5 = x.bias5; s.m20 = x.m20; s.pAbove = x.pAbove; }
}
const uni = samples.filter(s => s.tradable && s.bias5 != null && s.m20 != null);
console.log(`樣本 ${uni.length.toLocaleString()}（可交易×MA齊備）`);

// A. 乖離分桶
report(uni, { title: 'A 乖離5日線分桶（隔日）', groups: [
  { label: '超跌<-5%', cond: s => s.bias5 < -5 },
  { label: '-5~-2%', cond: s => s.bias5 >= -5 && s.bias5 < -2 },
  { label: '貼線±2%', cond: s => s.bias5 >= -2 && s.bias5 <= 2 },
  { label: '+2~+5%', cond: s => s.bias5 > 2 && s.bias5 <= 5 },
  { label: '過熱>+5%', cond: s => s.bias5 > 5 },
  { label: '過熱>+8%', cond: s => s.bias5 > 8 },
]});
// 5日持有口徑（犀利媽是短波段不是嚴格隔日）
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
console.log('\n── A2 乖離分桶×5日持有淨均%（fwd重疊·顯著性打折）──');
for (const [label, cond] of [['超跌<-5%', s => s.bias5 < -5], ['-5~-2%', s => s.bias5 >= -5 && s.bias5 < -2], ['貼線±2%', s => Math.abs(s.bias5) <= 2], ['+2~+5%', s => s.bias5 > 2 && s.bias5 <= 5], ['過熱>+5%', s => s.bias5 > 5]]) {
  const sel = uni.filter(s => s.net5 != null).filter(cond);
  const h = [0,1].map(hf => avg(sel.filter(x => x.half === hf).map(x => x.net5)));
  console.log(`  ${label.padEnd(10)} n=${sel.length.toLocaleString().padStart(8)}  5日淨均 ${h[0]?.toFixed(2)}%/${h[1]?.toFixed(2)}%`);
}

// B. 回測5日線買點（多頭結構×觸線不破×非大漲日）
report(uni, { title: 'B 回測5日線買點', groups: [
  { label: '觸線守穩(基本)', cond: s => s.c > s.m20 && s.l <= s.m5 * 1.005 && s.c >= s.m5 && s.chg > -2 && s.chg < 3 },
  { label: '觸線守穩×昨在線上', cond: s => s.c > s.m20 && s.l <= s.m5 * 1.005 && s.c >= s.m5 && s.chg > -2 && s.chg < 3 && s.pAbove === true },
  { label: '觸線守穩×量縮<0.8', cond: s => s.c > s.m20 && s.l <= s.m5 * 1.005 && s.c >= s.m5 && s.chg > -2 && s.chg < 3 && s.volX < 0.8 },
]});
console.log('\n── B2 買點×5日持有 ──');
for (const [label, cond] of [['觸線守穩', s => s.c > s.m20 && s.l <= s.m5 * 1.005 && s.c >= s.m5 && s.chg > -2 && s.chg < 3], ['觸線守穩×昨在線上', s => s.c > s.m20 && s.l <= s.m5 * 1.005 && s.c >= s.m5 && s.chg > -2 && s.chg < 3 && s.pAbove === true]]) {
  const sel = uni.filter(s => s.net5 != null).filter(cond);
  const h = [0,1].map(hf => avg(sel.filter(x => x.half === hf).map(x => x.net5)));
  const win = sel.filter(x => x.net5 > 0).length / (sel.length || 1) * 100;
  console.log(`  ${label.padEnd(16)} n=${sel.length.toLocaleString().padStart(7)}  5日淨均 ${h[0]?.toFixed(2)}%/${h[1]?.toFixed(2)}%  淨勝${win.toFixed(1)}%`);
}

// C. 跌破5日線＝賣訊？（昨在線上今收破線 → 隔日/5日）
report(uni, { title: 'C 跌破5日線(賣訊驗證)', groups: [
  { label: '今跌破5日線', cond: s => s.pAbove === true && s.c < s.m5 },
  { label: '跌破×多頭結構', cond: s => s.pAbove === true && s.c < s.m5 && s.c > s.m20 },
]});
const selC = uni.filter(s => s.net5 != null && s.pAbove === true && s.c < s.m5);
const hC = [0,1].map(hf => avg(selC.filter(x => x.half === hf).map(x => x.net5)));
console.log(`  跌破5日線×5日持有淨均 ${hC[0]?.toFixed(2)}%/${hC[1]?.toFixed(2)}%（若顯著負=賣訊成立）`);
process.exit(0);
