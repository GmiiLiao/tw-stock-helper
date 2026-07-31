#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 波段種子風險驗證（歷史資料·上產品前必過）：
//   ① 持有期掃描（3/5/8/10日）②年度分段（獨立四段）③每日組合模擬
//   ④ 最大回撤/連虧/左尾（P5/P1/最差筆）⑤簡易停損變體（日收盤價路徑近似）
// 策略：空頭日(寬度<50%)×5日跌<-5%×深回檔(<0.8×60日高)×量≥500張，等權。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, COST } from './lib/bt-core.mjs';
const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 700);
const days = await loadDays({ days: DAYS });
const samples = buildSamples(days);
const avg = a => a.length ? a.reduce((t, v) => t + v, 0) / a.length : null;
const r2 = x => x == null ? null : +x.toFixed(2);
const SIG = s => s.tradable && s.bull === false && s.ret5 != null && s.ret5 < -5 && s.posture60 != null && s.posture60 < 0.8 && s.v >= 500;
// 收盤價序列（路徑近似用）
const closeAt = (di, code) => days[di]?.close?.[code]?.[0] ?? null;

// ① 持有期掃描
console.log('── ① 持有期掃描（訊號同上·毛報酬-費稅）──');
for (const H of [3, 5, 8, 10]) {
  const rets = [];
  for (const s of samples) { if (!SIG(s)) continue; const x = closeAt(s.di + H, s.code); if (x > 0) rets.push((x - s.c) / s.c * 100 - COST); }
  if (rets.length < 500) continue;
  console.log(`  ${H}日持有：淨均${r2(avg(rets))}%·淨勝${r2(rets.filter(v => v > 0).length / rets.length * 100)}%·n=${rets.length.toLocaleString()}`);
}

// ②③④ 以 5 日為主做分段＋組合模擬
const sel = samples.filter(SIG).filter(s => s.net5 != null);
console.log('\n── ② 年度分段（獨立四段·5日持有）──');
const segs = {};
for (const s of sel) { const seg = s.date.slice(0, 4) + (s.date.slice(5, 7) <= '06' ? 'H1' : 'H2'); (segs[seg] ||= []).push(s.net5); }
for (const k of Object.keys(segs).sort()) console.log(`  ${k}: 淨均${r2(avg(segs[k]))}%·淨勝${r2(segs[k].filter(v => v > 0).length / segs[k].length * 100)}%·n=${segs[k].length.toLocaleString()}`);

console.log('\n── ③④ 每日組合模擬（每訊號日取深跌最重前10檔等權·資金分5批輪動）──');
const byDay = {};
for (const s of sel) (byDay[s.di] ||= []).push(s);
const cohort = [];   // 每訊號日一批：日均報酬攤5日
for (const di of Object.keys(byDay).map(Number).sort((a, b) => a - b)) {
  const top = byDay[di].sort((a, b) => a.ret5 - b.ret5).slice(0, 10);
  cohort.push({ di, ret: avg(top.map(s => s.net5)) });
}
const rets = cohort.map(c => c.ret);
const sorted = [...rets].sort((a, b) => a - b);
console.log(`  批次數 ${rets.length}·批均${r2(avg(rets))}%·批勝率${r2(rets.filter(v => v > 0).length / rets.length * 100)}%`);
console.log(`  左尾：P5 ${r2(sorted[Math.floor(rets.length * 0.05)])}%·P1 ${r2(sorted[Math.floor(rets.length * 0.01)])}%·最差批 ${r2(sorted[0])}%`);
// 權益曲線（每批投入 1/5 資金·報酬/5 累加）＋最大回撤＋連虧
let eq = 100, peak = 100, mdd = 0, streak = 0, worstStreak = 0;
for (const c of cohort) {
  eq *= 1 + c.ret / 100 / 5;
  if (eq > peak) peak = eq;
  mdd = Math.min(mdd, (eq / peak - 1) * 100);
  if (c.ret < 0) { streak++; worstStreak = Math.max(worstStreak, streak); } else streak = 0;
}
console.log(`  權益（1/5資金輪動）：終值 ${r2(eq)}（起100）·最大回撤 ${r2(mdd)}%·最長連虧 ${worstStreak} 批`);

// ⑤ 停損變體（日收盤路徑近似：持有中任一收盤跌破進場價-8% → 次日收盤出場）
console.log('\n── ⑤ 停損變體（收盤價-8%破線次日出·路徑近似）──');
const sl = [];
for (const s of sel) {
  let exited = false;
  for (let k = 1; k <= 5; k++) {
    const x = closeAt(s.di + k, s.code); if (!(x > 0)) break;
    if (!exited && (x - s.c) / s.c * 100 <= -8) {
      const nx = closeAt(s.di + Math.min(k + 1, 5), s.code) ?? x;
      sl.push((nx - s.c) / s.c * 100 - COST); exited = true; break;
    }
  }
  if (!exited) sl.push(s.net5);
}
console.log(`  含-8%停損：淨均${r2(avg(sl))}%·淨勝${r2(sl.filter(v => v > 0).length / sl.length * 100)}%·觸損率${r2((sl.length - sel.filter(s => { let hit = false; for (let k = 1; k <= 5; k++) { const x = closeAt(s.di + k, s.code); if (x > 0 && (x - s.c) / s.c * 100 <= -8) { hit = true; break; } } return !hit; }).length) / sl.length * 100)}%`);
console.log('\n※ 路徑以日收盤近似（無日內）；訊號集中崩跌段·左尾風險真實存在。非投資建議。');
process.exit(0);
