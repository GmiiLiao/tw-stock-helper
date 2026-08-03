// ─────────────────────────────────────────────────────────────────────────
// 持股警報：RSI5>85（提醒）／RSI5∧RSI10 皆>85（示警）出場口徑檢定 —— 2026-08-03
//
// 使用者要求：持股 RSI5>85 提醒；RSI5 與 RSI10 同時>85 示警「要出貨下車」。
//
// ⚠先講衝突：本站 2026-07-27 已測過同一想法（rsiTopExit·RSI5>95∧RSI10>90）
//   並**否證了「出貨下車」文案**——真頂點率僅 1.04~1.13x 基準、
//   抱1日 -0.53%（最差）、抱10日 +1.18%（最佳）、風險是雙向而非單向。
//   當時文案改為「高檔波動警戒·移動停利·勿隔日全出」。
//   但 85 比 95/90 低，是**不同母體**，不能直接套用，故本輪獨立重測。
//
// 口徑（持有者視角，與買進口徑不同）：
//   訊號日＝收盤時 RSI 觸發。持有者要決定的是「現在賣 vs 續抱 N 日」。
//   · 毛報酬：今收 → 第 N 日收（賣與不賣的差額，手續費兩種情境都要付，不扣）
//   · 淨報酬：另列扣一次費稅 0.4425%（若賣掉再買回的情境）
//   · 真頂點率：今收 ≥ 未來 N 日所有收盤（N=5/10/20）——這才是「該下車」的定義
//   · 下行/上行風險：5日內曾跌≥5% ／ 10日內曾漲≥5%（雙向都要看）
//   中位數與均數並列（均數易被右尾灌爆·本輪已吃過兩次虧）。
// 主窗 480 日 ＋ 第三獨立窗 OOT。非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';
const COST = 0.4425;

function rsiOf(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const c = days[i].close[code]?.[0]; if (!(c > 0)) continue;
    const s = (st[code] ||= { p: null, u5: 0, d5: 0, u10: 0, d10: 0, n: 0 });
    if (s.p != null) {
      const ch = c - s.p, g = Math.max(ch, 0), l = Math.max(-ch, 0); s.n++;
      if (s.n <= 5) { s.u5 += g / 5; s.d5 += l / 5; } else { s.u5 = (s.u5 * 4 + g) / 5; s.d5 = (s.d5 * 4 + l) / 5; }
      if (s.n <= 10) { s.u10 += g / 10; s.d10 += l / 10; } else { s.u10 = (s.u10 * 9 + g) / 10; s.d10 = (s.d10 * 9 + l) / 10; }
      if (s.n >= 10) out[`${i}_${code}`] = {
        rsi5: s.u5 + s.d5 > 0 ? (s.u5 / (s.u5 + s.d5)) * 100 : 50,
        rsi10: s.u10 + s.d10 > 0 ? (s.u10 / (s.u10 + s.d10)) * 100 : 50 };
    }
    s.p = c;
  }
  return out;
}
/** 前瞻：各持有期收盤、期間最高/最低、是否為未來 N 日最高收盤 */
function fwdOf(days) {
  const out = {};
  for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const cl = [], hi = [], lo = [];
    let ok = true;
    for (let k = 1; k <= 20; k++) {
      const r = days[i + k]?.close?.[code];
      if (!r || r.length < 5) { ok = false; break; }
      cl.push(r[0]); hi.push(r[3]); lo.push(r[4]);
    }
    if (!ok) continue;
    out[`${i}_${code}`] = { fcl: cl, fhi: hi, flo: lo };
  }
  return out;
}
const load = async o => {
  const d = await loadDays(o); const sm = buildSamples(d);
  const rs = rsiOf(d), fw = fwdOf(d);
  for (const s of sm) Object.assign(s, rs[`${s.di}_${s.code}`] || {}, fw[`${s.di}_${s.code}`] || {});
  const u = sm.filter(s => s.rsi5 != null && s.fcl);
  for (const s of u) {
    for (const n of [1, 3, 5, 10, 20]) s[`h${n}`] = +((s.fcl[n - 1] / s.c - 1) * 100).toFixed(3);
    // 真頂點：今收 ≥ 未來 N 日所有收盤
    for (const n of [5, 10, 20]) s[`top${n}`] = s.fcl.slice(0, n).every(x => x <= s.c);
    s.down5 = Math.min(...s.flo.slice(0, 5)) <= s.c * 0.95;    // 5日內曾跌≥5%
    s.up10 = Math.max(...s.fhi.slice(0, 10)) >= s.c * 1.05;    // 10日內曾漲≥5%
  }
  return u;
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };

const G = [
  ['全宇宙基準', () => true],
  ['RSI5>85（提醒級）', s => s.rsi5 > 85],
  ['RSI5>85 ∧ RSI10>85（示警級）', s => s.rsi5 > 85 && s.rsi10 > 85],
  ['RSI5>85 ∧ RSI10≤85（對照·只單5）', s => s.rsi5 > 85 && s.rsi10 <= 85],
  ['RSI5>95 ∧ RSI10>90（舊檢定門檻）', s => s.rsi5 > 95 && s.rsi10 > 90],
];
console.log('══ ① 續抱 N 日的毛報酬（持有者視角：賣與不賣的差額，手續費兩情境都要付故不扣）\n');
console.log(`  ${'組別'.padEnd(30)} ${'窗'.padEnd(4)} ${'抱1日'.padStart(16)} ${'抱3日'.padStart(16)} ${'抱5日'.padStart(16)} ${'抱10日'.padStart(16)} ${'抱20日'.padStart(16)}   n`);
for (const [nm, f] of G) for (const [wn, w] of Object.entries(W)) {
  const g = w.filter(f);
  if (g.length < 200) { console.log(`  ${nm.padEnd(30)} ${wn.padEnd(4)} 樣本不足 ${g.length}`); continue; }
  const cells = [1, 3, 5, 10, 20].map(n => `${String(r3(avg(g.map(s => s[`h${n}`])))).padStart(7)}/${String(med(g.map(s => s[`h${n}`]))).padStart(7)}`);
  console.log(`  ${nm.padEnd(30)} ${wn.padEnd(4)} ${cells.join(' ')}   ${g.length.toLocaleString()}`);
}
console.log('  （每格＝均數/中位數 %）\n');

console.log('══ ② 真頂點率：今日收盤是否為未來 N 日的最高收盤（＝「該下車」的定義）\n');
console.log(`  ${'組別'.padEnd(30)} ${'窗'.padEnd(4)} ${'頂5日'.padStart(8)} ${'頂10日'.padStart(8)} ${'頂20日'.padStart(8)}  ｜ 相對基準倍數`);
for (const [nm, f] of G) for (const [wn, w] of Object.entries(W)) {
  const g = w.filter(f); if (g.length < 200) continue;
  const b = [5, 10, 20].map(n => pct(w, s => s[`top${n}`]));
  const v = [5, 10, 20].map(n => pct(g, s => s[`top${n}`]));
  console.log(`  ${nm.padEnd(30)} ${wn.padEnd(4)} ${v.map(x => String(x).padStart(8)).join(' ')}  ｜ ${v.map((x, i) => (x / b[i]).toFixed(2) + 'x').join(' ')}`);
}
console.log('');
console.log('══ ③ 風險是單向還是雙向：5日內曾跌≥5% vs 10日內曾漲≥5%\n');
console.log(`  ${'組別'.padEnd(30)} ${'窗'.padEnd(4)} ${'5日曾跌≥5%'.padStart(12)} ${'(基準)'.padStart(9)} ${'10日曾漲≥5%'.padStart(13)} ${'(基準)'.padStart(9)}`);
for (const [nm, f] of G) for (const [wn, w] of Object.entries(W)) {
  const g = w.filter(f); if (g.length < 200) continue;
  console.log(`  ${nm.padEnd(30)} ${wn.padEnd(4)} ${String(pct(g, s => s.down5)).padStart(12)} ${String(pct(w, s => s.down5)).padStart(9)} ${String(pct(g, s => s.up10)).padStart(13)} ${String(pct(w, s => s.up10)).padStart(9)}`);
}
console.log('');
console.log('══ ④ 示警級 vs 提醒級：加上 RSI10>85 到底有沒有增量？（主窗/OOT 並列）\n');
for (const [wn, w] of Object.entries(W)) {
  const single = w.filter(s => s.rsi5 > 85 && s.rsi10 <= 85), dual = w.filter(s => s.rsi5 > 85 && s.rsi10 > 85);
  if (single.length < 200 || dual.length < 200) { console.log(`  【${wn}】樣本不足`); continue; }
  console.log(`  【${wn}】只單5(n=${single.length.toLocaleString()}) → 雙高(n=${dual.length.toLocaleString()})`);
  for (const [lab, f] of [['抱1日均', s => avg(s.map(x => x.h1))], ['抱5日均', s => avg(s.map(x => x.h5))], ['抱10日均', s => avg(s.map(x => x.h10))],
    ['頂10日率', s => pct(s, x => x.top10)], ['5日跌≥5%率', s => pct(s, x => x.down5)], ['10日漲≥5%率', s => pct(s, x => x.up10)]]) {
    const a = f(single), b = f(dual);
    console.log(`    ${lab.padEnd(12)} ${String(r3(a)).padStart(8)} → ${String(r3(b)).padStart(8)}  Δ${String(r3(b - a)).padStart(7)}`);
  }
}
// ── ⑤ 買方口徑：「勿買在高點」成不成立？──────────────────────────
// ⚠與①~④的持有者口徑**完全不同的問題**：
//   持有者已經買了、不必再付進場成本，右尾對他有利 → 抱著平均是賺的；
//   買方要付費稅 0.4425%、且在延伸價位進場 → 損益結構完全不同。
//   故此段改用**可交易宇宙**（排除 chg>8.5% 漲停買不到）＋**扣費稅**。
console.log('══ ⑤ 買方口徑：可交易宇宙(chg≤8.5%)＋扣費稅 0.4425%——「勿買在高點」成不成立\n');
console.log(`  ${'組別'.padEnd(30)} ${'窗'.padEnd(4)} ${'買後1日'.padStart(16)} ${'買後5日'.padStart(16)} ${'買後10日'.padStart(16)}  ｜ vs 基準(5日均/中位)   n`);
for (const [nm, f] of G) for (const [wn, w] of Object.entries(W)) {
  const uni = w.filter(s2 => s2.tradable);
  const g = uni.filter(f);
  if (g.length < 200) { console.log(`  ${nm.padEnd(30)} ${wn.padEnd(4)} 樣本不足 ${g.length}`); continue; }
  const net = (arr, n) => arr.map(x => x[`h${n}`] - COST);
  const cells = [1, 5, 10].map(n => `${String(r3(avg(net(g, n)))).padStart(7)}/${String(med(net(g, n))).padStart(7)}`);
  const bM = avg(net(uni, 5)), bMd = med(net(uni, 5));
  const dM = r3(avg(net(g, 5)) - bM), dMd = r3(med(net(g, 5)) - bMd);
  console.log(`  ${nm.padEnd(30)} ${wn.padEnd(4)} ${cells.join(' ')}  ｜ Δ${String(dM).padStart(7)}/${String(dMd).padStart(7)} ${dM < 0 && dMd < 0 ? '✓較差' : '✗未較差'}   ${g.length.toLocaleString()}`);
}
console.log('  （每格＝均數/中位數 %·已扣費稅）\n');

console.log('\n判準（是否支持「出貨下車」）：真頂點率須顯著高於基準（≥1.3x）∧ 續抱報酬須為負且中位數同號 ∧ 兩窗一致。');
console.log('若「抱越久越好」則文案不可寫成賣訊，只能寫成風險揭露。非投資建議。');
process.exit(0);
