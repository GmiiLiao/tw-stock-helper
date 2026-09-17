#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// 權值稽核 D1／D2 驗證器（2026-09-18）——用 v2 的尺量站上的權值
//
// 尺（與 squeeze-train v2 同一把）：
//   · 口徑：隔日沖（今收買→明開賣），扣費稅 COST；可交易宇宙 chg ≤ 8.5%
//   · 日層級超額：每日「該組平均淨報酬 − 當日可交易宇宙平均淨報酬」，對日序列取平均
//   · 95% CI：按日區塊自助法（block 5、1,000 次，決定性種子）
//   · 切點固定 2026-06-10；訓練段內三段皆須贏基準；市況分層＝漲家數比三分位
//   · 通過＝超額 CI 下界>0 且 淨報酬 CI 下界>0 且 三段皆贏 且 多頭/空頭兩層皆不為負（訓練段），樣本外同尺不分段
//
// 量什麼：
//   D1 五大因子：每一階梯（動能／成交值／收盤位置／價位穩定度／形態）各桶的超額；以及「每日前 20 名」的排序鍵表現
//   D2 法人加權：instWeight 各成分（外資買／外資賣／連買≥3／三方同買／外資≥5000 張／投信買）逐項；×1.5 的整體鍵
//
// 用法：node scripts/screen-weights-v2.mjs [--days 480]
// ─────────────────────────────────────────────────────────────────────
import { loadDays, COST } from './lib/bt-core.mjs';

const args = process.argv.slice(2);
const DAYS = +(args[args.indexOf('--days') + 1] || 480);
const OOS_FROM = process.env.OOS_FROM || '2026-06-10';
const WARM = 62, MIN_DAYS = 40, BOOT = 1000, BLOCK = 5;
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
function prng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function boot(daily, seed = 7) {
  const n = daily.length; if (n < 8) return { mean: n ? +mean(daily).toFixed(3) : null, lo: null, hi: null };
  const rnd = prng(seed); const ms = [];
  for (let k = 0; k < BOOT; k++) { let s = 0, c = 0; while (c < n) { const st = Math.floor(rnd() * n); for (let j = 0; j < BLOCK && c < n; j++, c++) s += daily[(st + j) % n]; } ms.push(s / n); }
  ms.sort((a, b) => a - b);
  return { mean: +mean(daily).toFixed(3), lo: +ms[Math.floor(BOOT * 0.025)].toFixed(3), hi: +ms[Math.floor(BOOT * 0.975) - 1].toFixed(3) };
}

// ── 樣本（可交易宇宙）──
const days = await loadDays({ days: DAYS, lookback: WARM });
const samples = []; const H = {}; const upRatio = {};
for (let i = 0; i < days.length; i++) {
  const D = days[i], P = days[i - 1], N = days[i + 1], I1 = days[i - 1]?.inst || {};   // 法人 t-1（PIT）
  let up = 0, tot = 0;
  for (const code in D.close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const row = D.close[code]; if (!row || row.length < 5) continue;
    const [c, v, o, h, l] = row;
    const st = (H[code] ||= { c: [], f: [] });
    const pc = st.c[st.c.length - 1];
    if (pc > 0 && c > 0) { tot++; if (c > pc) up++; }
    const n = N?.close?.[code];
    if (i >= WARM && pc > 0 && c > 0 && v >= 300 && h > l && n && n.length >= 5 && n[2] > 0) {
      const chg = (c - pc) / pc * 100;
      if (chg <= 8.5) {
        const ins = I1[code] || null;
        let fStreak = 0; for (let k = st.f.length - 1; k >= 0 && st.f[k] > 0; k--) fStreak++;
        samples.push({ date: D.date, code, chg, c, v, o, pc, pos: (c - l) / (h - l), value: c * v * 1000,
          f: ins?.[0] ?? null, t: ins?.[1] ?? null, d: ins?.[2] ?? null, fStreak,
          net: (n[2] - c) / c * 100 - COST });
      }
    }
    st.c.push(c > 0 ? c : (st.c[st.c.length - 1] || 0)); if (st.c.length > WARM) st.c.shift();
    st.f.push(I1[code]?.[0] ?? 0); if (st.f.length > 12) st.f.shift();
  }
  if (tot >= 500) upRatio[D.date] = up / tot;
}
const dates = [...new Set(samples.map(s => s.date))].sort();
const ratios = dates.map(d => upRatio[d]).filter(v => v != null);
const rgLo = pct(ratios, 1 / 3), rgHi = pct(ratios, 2 / 3);
const rgOf = d => (upRatio[d] == null ? 'neutral' : upRatio[d] >= rgHi ? 'bull' : upRatio[d] <= rgLo ? 'bear' : 'neutral');
const baseByDay = {}; { const acc = {}; for (const s of samples) (acc[s.date] ||= []).push(s.net); for (const d in acc) baseByDay[d] = mean(acc[d]); }
const trainDates = dates.filter(d => d < OOS_FROM), ootDates = dates.filter(d => d >= OOS_FROM);
const segCut = [trainDates[Math.floor(trainDates.length / 3)], trainDates[Math.floor(trainDates.length * 2 / 3)]];
const segOf = d => (d < segCut[0] ? 0 : d < segCut[1] ? 1 : 2);
console.log(`樣本 ${samples.length.toLocaleString()} 筆｜${dates[0]}～${dates[dates.length - 1]}｜訓練 ${trainDates.length} 日／樣本外 ${ootDates.length} 日｜市況三分位 ≤${rgLo?.toFixed(3)} 空頭／≥${rgHi?.toFixed(3)} 多頭`);

function evalSel(sel, { oot = false, seg = true } = {}) {
  const set = samples.filter(s => (oot ? s.date >= OOS_FROM : s.date < OOS_FROM) && sel(s));
  const byDay = {}; for (const s of set) (byDay[s.date] ||= []).push(s.net);
  const ds = Object.keys(byDay).sort();
  if (set.length < 80 || ds.length < MIN_DAYS) return { n: set.length, days: ds.length, why: '樣本/交易日不足' };
  const ex = ds.map(d => mean(byDay[d]) - baseByDay[d]), netD = ds.map(d => mean(byDay[d]));
  const b = boot(ex), bn = boot(netD, 11);
  const segs = seg ? [0, 1, 2].map(k => { const a = ds.filter(d => segOf(d) === k).map(d => mean(byDay[d]) - baseByDay[d]); return a.length >= 8 ? +mean(a).toFixed(3) : null; }) : null;
  const rg = {}; for (const k of ['bull', 'bear']) { const a = ds.filter(d => rgOf(d) === k).map(d => mean(byDay[d]) - baseByDay[d]); rg[k] = a.length >= 8 ? +mean(a).toFixed(3) : null; }
  const state = b.lo == null ? 'ns' : b.lo > 0 ? 'valid' : b.hi < 0 ? 'invalid' : 'ns';
  const segOk = !segs || segs.every(v => v != null && v > 0);
  const netOk = bn.lo != null && bn.lo > 0;
  const rgOk = ['bull', 'bear'].every(k => rg[k] == null || rg[k] >= 0);
  const pass = state === 'valid' && segOk && netOk && rgOk;
  return { n: set.length, days: ds.length, excess: b.mean, ci: [b.lo, b.hi], net: bn.mean, netCi: [bn.lo, bn.hi], segs, rg, state, pass,
    why: pass ? 'ok' : state === 'invalid' ? '顯著輸基準' : state === 'ns' ? 'CI 跨 0' : !segOk ? '三段未皆贏' : !netOk ? '淨報酬未過' : '市況一層為負' };
}
const fmt = r => (r.excess == null ? `n=${r.n} ${r.why}` : `n=${r.n}/${r.days}日 超額 ${r.excess >= 0 ? '+' : ''}${r.excess}pp CI[${r.ci}] 淨 ${r.net}% CI[${r.netCi}] 段${JSON.stringify(r.segs)} 多${r.rg.bull}/空${r.rg.bear} → ${r.pass ? '✅' : '✗ ' + r.why}`);
const both = (label, sel) => { console.log(`  ${label}`); console.log(`    訓練 ${fmt(evalSel(sel))}`); console.log(`    樣本外 ${fmt(evalSel(sel, { oot: true, seg: false }))}`); };

// ── D1 五大因子階梯 ──
console.log('\n══ D1 五大因子（各桶 vs 可交易宇宙）══');
console.log('Factor 1 動能');
for (const [lab, sel] of [['>7~8.5', s => s.chg > 7], ['3~7', s => s.chg >= 3 && s.chg <= 7], ['0~3', s => s.chg > 0 && s.chg < 3], ['平盤', s => s.chg === 0], ['-2~0', s => s.chg < 0 && s.chg > -2], ['<-2', s => s.chg <= -2]]) both(lab, sel);
console.log('Factor 2 成交值');
for (const [lab, sel] of [['>50億', s => s.value > 5e9], ['10~50億', s => s.value > 1e9 && s.value <= 5e9], ['5~10億', s => s.value > 5e8 && s.value <= 1e9], ['1~5億', s => s.value > 1e8 && s.value <= 5e8], ['<1億', s => s.value <= 1e8]]) both(lab, sel);
console.log('Factor 3 收盤位置');
for (const [lab, sel] of [['≥0.85', s => s.pos >= 0.85], ['0.7~0.85', s => s.pos >= 0.7 && s.pos < 0.85], ['0.5~0.7', s => s.pos >= 0.5 && s.pos < 0.7], ['0.3~0.5', s => s.pos >= 0.3 && s.pos < 0.5], ['<0.3', s => s.pos < 0.3]]) both(lab, sel);
console.log('Factor 4 價位（穩定度）');
for (const [lab, sel] of [['≥500', s => s.c >= 500], ['100~500', s => s.c >= 100 && s.c < 500], ['30~100', s => s.c >= 30 && s.c < 100], ['10~30', s => s.c >= 10 && s.c < 30], ['<10', s => s.c < 10]]) both(lab, sel);
console.log('Factor 5 形態');
for (const [lab, sel] of [['溫和漲 0~5', s => s.chg > 0 && s.chg < 5], ['近漲停 7~8.5', s => s.chg >= 7], ['其他', s => !(s.chg > 0 && s.chg < 5) && s.chg < 7]]) both(lab, sel);

// ── D2 法人加權成分（t-1 PIT）──
console.log('\n══ D2 instWeight 成分（法人 t-1）══');
for (const [lab, sel] of [
  ['外資買超>0', s => s.f > 0], ['外資賣超<0', s => s.f < 0], ['外資連買≥3', s => s.fStreak >= 3], ['外資連買≥6', s => s.fStreak >= 6],
  ['三方同買', s => s.f > 0 && s.t > 0 && s.d > 0], ['外資≥5000張', s => s.f >= 5000], ['投信買超>0', s => s.t > 0], ['投信買且外資買', s => s.t > 0 && s.f > 0],
]) both(lab, sel);

// ── 排序鍵：每日前 20 名 ──
console.log('\n══ 排序鍵 每日前 20 名 vs 宇宙（訓練／樣本外）══');
const five = s => { const m = s.chg > 7 ? 10 : s.chg > 0 ? 10 : s.chg === 0 ? 8 : s.chg > -2 ? 8 : 6; let v = s.value > 5e9 ? 20 : s.value > 1e9 ? 17 : s.value > 5e8 ? 14 : s.value > 1e8 ? 10 : s.value > 5e7 ? 6 : 2; if (s.chg > 1 && s.value > 5e8) v = Math.min(v + 3, 20); let t = s.pos >= 0.85 ? 8 : s.pos >= 0.7 ? 12 : s.pos >= 0.5 ? 14 : s.pos >= 0.3 ? 15 : 16; if (s.o > s.pc * 1.005 && s.chg > 1) t = Math.min(t + 1, 20); const st = s.c >= 500 ? 18 : s.c >= 100 ? 16 : s.c >= 30 ? 14 : s.c >= 10 ? 10 : 6; const va = (s.chg >= 7) ? 8 : (s.chg > 0 && s.chg < 5) ? 15 : 12; return m + v + t + st + va; };
const instW = s => (s.f > 0 ? 3 : s.f < 0 ? -6 : 0) + Math.min(s.fStreak, 6) + (s.f > 0 && s.t > 0 && s.d > 0 ? 3 : 0) + (s.f >= 5000 ? 2 : 0) + (s.t > 0 ? 1 : 0);
const topK = (key, K = 20) => { const byDay = {}; for (const s of samples) (byDay[s.date] ||= []).push(s); const pick = new Set(); for (const d in byDay) byDay[d].sort((a, b) => key(b) - key(a)).slice(0, K).forEach(s => pick.add(s)); return s => pick.has(s); };
for (const [lab, key] of [['五大因子(現行)', five], ['五大因子(Factor4 歸零)', s => five(s) - (s.c >= 500 ? 18 : s.c >= 100 ? 16 : s.c >= 30 ? 14 : s.c >= 10 ? 10 : 6)], ['五大 + 法人×1.5', s => five(s) + instW(s) * 1.5], ['五大 + 法人×0.5', s => five(s) + instW(s) * 0.5], ['只用法人加權', instW], ['隨機（基準）', () => Math.random()]]) both(lab, topK(key));
