#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 第三獨立窗複驗（2022-07~2023-07·模型從未見過的 out-of-time 年）
// 複驗對象：①七加減分中 EOD 可算者 ②tier 基底（inst 可算者·A 級無自營資料略過）
// ③撿尾盤定版濾網雙口徑 ④出場規則 A vs C1 ⑤波段種子（空頭日深跌×深回檔）
// 判準：方向與 2024-2026 主窗一致=通過；反向=權重需降級。非投資建議。
// 用法：node scripts/verify-window3.mjs [--to=2023-07-16] [--days=250]
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, COST } from './lib/bt-core.mjs';

const TO = process.argv.find(a => a.startsWith('--to='))?.split('=')[1] || '2023-07-16';
const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 250);
const days = await loadDays({ days: DAYS, to: TO });
console.log(`第三窗 ${days[0]?.date} → ${days[days.length - 1]?.date}（${days.length} 日）`);
const samples = buildSamples(days);
const uni = samples.filter(s => s.tradable);
const avg = a => a.length ? a.reduce((t, v) => t + v, 0) / a.length : null;
const r3 = x => x == null ? '—' : +x.toFixed(3);
const st = a => a.length < 200 ? null : ({ n: a.length, win: +(a.filter(s => s.netClose > 0).length / a.length * 100).toFixed(1), net: r3(avg(a.map(s => s.netClose))), open: r3(avg(a.map(s => s.netOpen))) });
const base = st(uni);
console.log(`樣本 ${uni.length.toLocaleString()}（可交易）·基準 勝${base.win}%·收賣${base.net}%·開賣${base.open}%\n`);
// 每日市場均漲幅（跟風）
const mkt = {}; { const acc = {}; for (const s of uni) (acc[s.di] ||= []).push(s.chg); for (const di in acc) mkt[di] = avg(acc[di]); }
for (const s of uni) s.rs = s.chg - (mkt[s.di] ?? 0);

console.log('── ① 加減分因子（主窗方向→第三窗實測 Δ vs 基準）──');
const row = (label, expect, cond) => {
  const g = uni.filter(cond); const x = st(g);
  if (!x) { console.log(`  ${label.padEnd(20)} 樣本不足(${g.length})`); return; }
  const dC = +(x.net - base.net).toFixed(3), dO = +(x.open - base.open).toFixed(3);
  const dir = expect === '+' ? (dC > 0 || dO > 0) : (dC < 0 && dO <= 0.05);
  console.log(`  ${label.padEnd(20)} 收Δ${dC} 開Δ${dO}·勝${x.win}%·n=${x.n.toLocaleString()} ${dir ? '✅同向' : '⚠反向/弱'}`);
};
row('破高×強尾（主窗+）', '+', s => s.brk20 && s.pos >= 0.7);
row('強尾單獨（主窗−）', '-', s => s.pos >= 0.8 && Math.abs(s.chg) > 1 && !(s.brk20 && s.pos >= 0.7));
row('過熱ret5≥20（主窗−）', '-', s => s.ret5 != null && s.ret5 >= 20);
row('跟風RS<1∧chg≥3（主窗−）', '-', s => mkt[s.di] >= 1 && s.chg >= 3 && s.rs < 1);
row('弱尾盤（主窗0）', '-', s => s.pos <= 0.2 && Math.abs(s.chg) > 1);
row('大漲未鎖7~8.5（主窗−）', '-', s => s.chg >= 7);

console.log('\n── ② 撿尾盤定版濾網（破20日高×強尾×3~7）──');
const fin = uni.filter(s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7);
const fx = st(fin);
if (fx) console.log(`  收賣${fx.net}%（vs基準 ${(fx.net - base.net).toFixed(3)}）·開賣${fx.open}%（vs ${(fx.open - base.open).toFixed(3)}）·n=${fx.n}（主窗：開賣淨正+0.055）`);

console.log('\n── ③ 出場規則（濾網池·主窗定版=A一律開盤賣）──');
if (fin.length >= 200) {
  const A = avg(fin.map(s => s.rNO - COST)), B = avg(fin.map(s => s.rNC - COST));
  const C1 = avg(fin.map(s => (s.rNO >= 0 ? s.rNC : s.rNO) - COST));
  console.log(`  A開盤賣 ${r3(A)}% ｜ B收盤賣 ${r3(B)}% ｜ C1開高抱 ${r3(C1)}%（主窗 A>C1>B）${A > C1 && A > B ? ' ✅A仍最優' : ' ⚠順序變了'}`);
}

console.log('\n── ④ 波段種子（空頭日×深跌×深回檔·5日持有）──');
const sw = samples.filter(s => s.tradable && s.net5 != null && s.bull === false && s.ret5 != null && s.ret5 < -5 && s.posture60 != null && s.posture60 < 0.8 && s.v >= 500);
if (sw.length >= 200) {
  const swAll = samples.filter(s => s.tradable && s.net5 != null && s.bull === false);
  console.log(`  淨均${r3(avg(sw.map(s => s.net5)))}%·淨勝${+(sw.filter(s => s.net5 > 0).length / sw.length * 100).toFixed(1)}%·n=${sw.length.toLocaleString()}（空頭日基準 ${r3(avg(swAll.map(s => s.net5)))}%）（主窗+1.27/+2.19）`);
} else console.log(`  樣本不足(${sw.length})`);
console.log('\n非投資建議；本輸出決定權重是否降級。');
process.exit(0);
