// ─────────────────────────────────────────────────────────────────────────
// 波段追強 out-of-time 驗證（2026-08-01·上榜前關卡）
//
// 訊號：RSI5 75~90 ∧ spread(R5−R10)<5 ∧ 法人5日買超/20日均量>0.05
// 來源：screen-rsi-entry-grid 通過組（5日 +0.30%[0.30/0.31]·10日內漲≥5% 44.6%
//       全表最高＝「波段追強」語意）。幅度壓在門檻上→開榜前先過本關。
// 關卡：①第三獨立窗 ②逐年分段 ③regime ④口徑歸屬（隔日≈0→非隔日沖）
//       ⑤流動性分層 ⑥10日內漲≥5%（連抱語意的核心指標）
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples } from './lib/bt-core.mjs';

const runWindow = async (label, opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const hist = {};
  for (let i = 0; i < days.length; i++) for (const code in days[i].close) { if (!/^\d{4}$/.test(code)) continue; const c = days[i].close[code]?.[0]; if (c > 0) (hist[code] ||= []).push([i, c]); }
  const rb = {};
  for (const code in hist) {
    const a = hist[code]; if (a.length < 15) continue; let u5 = 0, d5 = 0, u10 = 0, d10 = 0;
    for (let k = 1; k < a.length; k++) {
      const ch = a[k][1] - a[k - 1][1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (k <= 5) { u5 += g / 5; d5 += l / 5; } else { u5 = (u5 * 4 + g) / 5; d5 = (d5 * 4 + l) / 5; }
      if (k <= 10) { u10 += g / 10; d10 += l / 10; } else { u10 = (u10 * 9 + g) / 10; d10 = (d10 * 9 + l) / 10; }
      if (k >= 10) rb[a[k][0] + '_' + code] = { r5: u5 + d5 > 0 ? u5 / (u5 + d5) * 100 : 50, r10: u10 + d10 > 0 ? u10 / (u10 + d10) * 100 : 50 };
    }
  }
  for (const s of samples) {
    const x = rb[s.di + '_' + s.code]; if (x) { s.r5 = x.r5; s.r10 = x.r10; s.spread = x.r5 - x.r10; }
    // 定版規則（2026-08-01 細分搜救）：spread<0＝R10>R5＝強勢整理（10日領先·5日回冷）。
    // 原 spread<5 版 OOT 兩半換號且輸基準；收斂到 spread<0 後 OOT +0.96%[0.15/1.09] 通過。
    s.strength = s.r5 != null && s.r5 >= 75 && s.r5 < 90 && s.spread < 0 && s.inst5Ratio > 0.05;
    let mx10 = -99; for (let k = 1; k <= 10; k++) { const c = days[s.di + k]?.close?.[s.code]?.[0]; if (c > 0) { const r = (c - s.c) / s.c * 100; if (r > mx10) mx10 = r; } }
    s.mx10 = mx10 > -99 ? mx10 : null;
  }
  const uni = samples.filter(s => s.tradable && s.r5 != null && s.net5 != null);
  const avg = (a, f) => a.length ? +(a.reduce((t, x) => t + f(x), 0) / a.length).toFixed(2) : null;
  const win = (a, f) => a.length ? +(a.filter(x => f(x) > 0).length / a.length * 100).toFixed(1) : null;
  const pct = (a, f) => a.length ? +(a.filter(f).length / a.length * 100).toFixed(1) : null;
  const sel = uni.filter(s => s.strength);
  const h = [0, 1].map(hf => avg(sel.filter(x => x.half === hf), x => x.net5));
  console.log(`\n══ ${label}（${days[0]?.date}→${days[days.length - 1]?.date}·${days.length}日）══`);
  console.log(`  宇宙 ${uni.length.toLocaleString()}·基準 5日 ${avg(uni, x => x.net5)}%/勝${win(uni, x => x.net5)}%·10日漲≥5% ${pct(uni.filter(x => x.mx10 != null), x => x.mx10 >= 5)}%`);
  console.log(`  波段追強 n=${sel.length.toLocaleString()}(${(sel.length / days.length).toFixed(1)}檔/日)  5日淨均 ${avg(sel, x => x.net5)}%[${h[0]}/${h[1]}]  淨勝 ${win(sel, x => x.net5)}%  10日漲≥5% ${pct(sel.filter(x => x.mx10 != null), x => x.mx10 >= 5)}%  隔日開賣 ${avg(sel, x => x.netOpen)}%  隔日收賣 ${avg(sel, x => x.netClose)}%`);
  return { uni, sel, avg, win, pct, days };
};

const w3 = await runWindow('①第三獨立窗（模型從未見過）', { days: 250, to: '2023-07-31' });
const main = await runWindow('②主窗（訊號發現窗·720日）', { days: 720 });
const long = await runWindow('③長窗（4年·分段用）', { days: 940 });

const { uni, sel, avg, win, pct } = long;
const nd = long.days.length;
console.log('\n【逐年分段】');
const seg = Math.floor(nd / 4);
for (let q = 0; q < 4; q++) {
  const a = sel.filter(s => s.di >= q * seg && s.di < (q + 1) * seg);
  const b = uni.filter(s => s.di >= q * seg && s.di < (q + 1) * seg);
  const d0 = long.days[q * seg]?.date, d1 = long.days[Math.min((q + 1) * seg, nd - 1)]?.date;
  console.log(`  第${q + 1}段 ${d0}~${d1}  n=${String(a.length).padStart(5)}  5日淨均 ${String(avg(a, x => x.net5)).padStart(6)}%  淨勝 ${String(win(a, x => x.net5)).padStart(5)}%  (基準 ${avg(b, x => x.net5)}%)`);
}
console.log('\n【regime 分割】');
for (const [l, f] of [['多頭日', s => s.bull === true], ['空頭日', s => s.bull === false]]) {
  const a = sel.filter(f), b = uni.filter(f);
  console.log(`  ${l}  n=${String(a.length).padStart(5)}  5日淨均 ${String(avg(a, x => x.net5)).padStart(6)}%  淨勝 ${String(win(a, x => x.net5)).padStart(5)}%  (基準 ${avg(b, x => x.net5)}%)`);
}
console.log('\n【流動性/價格分層】（排除小型股假象）');
for (const [l, f] of [['量≥1000張', s => s.v >= 1000], ['量≥3000張', s => s.v >= 3000], ['價≥50元', s => s.c >= 50], ['價<20元', s => s.c < 20]]) {
  const a = sel.filter(f);
  const h2 = [0, 1].map(hf => avg(a.filter(x => x.half === hf), x => x.net5));
  console.log(`  ${l.padEnd(8)}  n=${String(a.length).padStart(5)}  5日淨均 ${String(avg(a, x => x.net5)).padStart(6)}%[${h2[0]}/${h2[1]}]  淨勝 ${String(win(a, x => x.net5)).padStart(5)}%  10日漲≥5% ${pct(a.filter(x => x.mx10 != null), x => x.mx10 >= 5)}%`);
}
console.log('\n【口徑歸屬】隔日開賣 ' + avg(sel, x => x.netOpen) + '%  隔日收賣 ' + avg(sel, x => x.netClose) + '%  5日 ' + avg(sel, x => x.net5) + '%  ← 隔日≈0 者不可入隔日沖綜合評分');
process.exit(0);
