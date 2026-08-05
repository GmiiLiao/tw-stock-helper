#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 頭部反轉：連 2 日 RSI 超買 → 下跌開始？  —— 2026-08-05（個股＋指數）
//
// 使用者提供的頭部樣本（Yahoo 截圖，RSI 已對帳一致）：
//   6/02 RSI5 82.19 / RSI10 77.22  ┐連2日超買
//   6/03 RSI5 86.92 / RSI10 80.42  ┘→ 6/04 -781.7（-1.68%）
//   6/22 RSI5 82.18 / RSI10 71.89   → 6/23 -640.86（-1.34%）
//   （6/18 RSI5 73.65，所以第二例其實**不是**連2日 >80，已如實標註）
//
// **本檔內建今天剛學到的判準**（stockRsiReversal 的教訓）：
//   bt-core 的「兩半窗同號＋OOT 同向」對**事件驅動型**訊號沒有保護力——
//   超賣側 20/20 全過關，拆開卻是關稅崩盤兩天賺完全部。
//   ⇒ 所以這裡除了兩半窗＋OOT，**強制輸出單日/單事件集中度**：
//      剔掉最大的 1/3/5/10 個觸發日之後還剩多少。
//      以及依「當日全市場同時觸發檔數」分組（相關性結構檢查）。
//
// 成立條件（賣出/避開訊號）：forward 報酬**低於**同期可交易宇宙基準，
//   且兩半窗同號、OOT 同向、剔除集中日後仍成立。
//
// 個股口徑：可交易宇宙（4碼·量≥300張·進場日漲幅≤8.5%）、已扣 0.4425%。
//   ⚠賣出訊號的實務用途是「出場/避開」，不是放空（台股放空成本與限制另計），
//     所以這裡的報酬解讀是「若續抱會怎樣」，不是「放空能賺多少」。
// 用法：node scripts/screen-rsi-top-reversal.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';

const COST = 0.4425;
const MAIN = 480, OOT = 240, WARM = 30;
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
const r3 = x => (x == null ? null : +x.toFixed(3));
const wr = a => (a.length ? +(a.filter(v => v > 0).length / a.length * 100).toFixed(1) : null);
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

function step(st, d, p) {
  if (st.n < p) {
    st.g += d > 0 ? d : 0; st.l += d < 0 ? -d : 0; st.n++;
    if (st.n === p) { st.g /= p; st.l /= p; st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l); }
    return;
  }
  st.g = (st.g * (p - 1) + (d > 0 ? d : 0)) / p;
  st.l = (st.l * (p - 1) + (d < 0 ? -d : 0)) / p;
  st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l);
}

/** 逐日推進宇宙 RSI，產出樣本（含當日觸發廣度所需的日期鍵） */
function build(days) {
  const S = [];
  const H = {};
  for (let i = 0; i < days.length; i++) {
    const D = days[i];
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const row = D.close[code]; if (!row || row.length < 5) continue;
      const c = row[0], v = row[1]; if (!(c > 0)) continue;
      const st = (H[code] ||= { pc: null, s5: { g: 0, l: 0, n: 0, v: null }, s10: { g: 0, l: 0, n: 0, v: null }, p5: null, p10: null });
      if (st.pc != null) { st.p5 = st.s5.v; st.p10 = st.s10.v; step(st.s5, c - st.pc, 5); step(st.s10, c - st.pc, 10); }
      const pc = st.pc; st.pc = c;
      if (i < WARM || pc == null || st.s5.v == null || st.p5 == null) continue;
      const chg = (c - pc) / pc * 100;
      if (!(v >= 300) || chg > 8.5) continue;
      const f = n => { const d = days[i + n]?.close?.[code]; return d && d[0] > 0 ? (d[0] - c) / c * 100 - COST : null; };
      S.push({ di: i, date: D.date, code, r5: st.s5.v, r10: st.s10.v, p5: st.p5, p10: st.p10,
        f1: f(1), f3: f(3), f5: f(5), f10: f(10), f20: f(20) });
    }
  }
  const mid = Math.floor(days.length / 2);
  for (const s of S) s.half = s.di < mid ? 0 : 1;
  return S;
}

const HZ = ['f1', 'f3', 'f5', 'f10', 'f20'], HZL = ['1日', '3日', '5日', '10日', '20日'];

const summarize = (sel, base) => {
  const o = { n: sel.length };
  for (const h of HZ) {
    const a = sel.map(s => s[h]).filter(v => v != null);
    o[h] = avg(a); o[h + 'd'] = avg(a) - base[h];
    for (const hf of [0, 1]) {
      const b = sel.filter(s => s.half === hf).map(s => s[h]).filter(v => v != null);
      o[`${h}_${hf}`] = b.length ? avg(b) - base[`${h}_${hf}`] : null;
    }
  }
  o.w5 = wr(sel.map(s => s.f5).filter(v => v != null));
  return o;
};
const mkBase = S => {
  const b = {};
  for (const h of HZ) {
    b[h] = avg(S.map(s => s[h]).filter(v => v != null));
    for (const hf of [0, 1]) b[`${h}_${hf}`] = avg(S.filter(s => s.half === hf).map(s => s[h]).filter(v => v != null));
  }
  return b;
};

const run = (S, tag) => {
  const base = mkBase(S);
  console.log(`\n${'═'.repeat(122)}\n${tag}｜可交易樣本 ${S.length.toLocaleString()}`);
  console.log(`基準（可交易宇宙等權·扣 ${COST}%）：` + HZ.map((h, j) => `${HZL[j]} ${r3(base[h])}%`).join('  '));
  console.log('成立＝各期報酬**低於**基準（訊號是「別追/該出場」）');
  console.log('═'.repeat(122));
  console.log(pad('條件（連2日超買·T日收盤）', 30) + padL('次數', 8)
    + HZL.map(l => padL(l + 'Δ', 9)).join('') + padL('5日勝', 8) + '  5日兩半窗Δ');
  console.log('─'.repeat(122));
  const out = [];
  for (const x of [70, 75, 80, 85]) for (const y of [65, 70, 75, 80]) {
    const cond = s => s.r5 > x && s.r10 > y && s.p5 > x && s.p10 > y;
    const sel = S.filter(cond);
    if (sel.length < 300) continue;
    const r = summarize(sel, base);
    const d = [r.f5_0, r.f5_1];
    const ok = d[0] != null && d[1] != null && Math.sign(d[0]) === Math.sign(d[1]) && Math.min(Math.abs(d[0]), Math.abs(d[1])) >= 0.05;
    out.push({ x, y, r, d, ok, sel });
    console.log(pad(`RSI5>${x} ∧ RSI10>${y}`, 30) + padL(r.n.toLocaleString(), 8)
      + HZ.map(h => padL(r3(r[h + 'd']), 9)).join('') + padL(`${r.w5}%`, 8)
      + `  [${r3(d[0])}/${r3(d[1])}]${ok ? '✓' : ''}`);
  }
  return { base, out };
};

/** 集中度：剔掉最大的 k 個觸發日後還剩多少（今天學到的必要檢查） */
const concentration = (sel, label) => {
  const byDay = {};
  for (const s of sel) if (s.f5 != null) (byDay[s.date] ||= []).push(s.f5);
  const days = Object.entries(byDay).map(([d, a]) => ({ d, n: a.length, m: avg(a) }));
  const total = days.flatMap(x => Array(x.n).fill(x.m));
  const byImpact = [...days].sort((a, b) => a.m * a.n - b.m * b.n);   // 對「下跌」最有貢獻者排前
  console.log(`\n  【集中度】${label}｜觸發 ${days.length} 日·樣本 ${total.length.toLocaleString()}·5日均 ${r3(avg(total))}%`);
  for (const k of [1, 3, 5, 10]) {
    const ex = new Set(byImpact.slice(0, k).map(x => x.d));
    const rest = days.filter(x => !ex.has(x.d)).flatMap(x => Array(x.n).fill(x.m));
    console.log(`    剔除貢獻最大的 ${String(k).padStart(2)} 個觸發日 → 其餘 5日均 ${r3(avg(rest))}%（剩 ${rest.length.toLocaleString()} 筆）`);
  }
  const BANDS = [[1, 3, '極少 1~3 檔'], [4, 10, '少 4~10'], [11, 30, '中 11~30'], [31, 100, '多 31~100'], [101, 9999, '極多 >100']];
  console.log('    依當日全市場同時觸發檔數分組：');
  for (const [lo, hi, lab] of BANDS) {
    const g = days.filter(x => x.n >= lo && x.n <= hi);
    const a = g.flatMap(x => Array(x.n).fill(x.m));
    if (!a.length) continue;
    console.log(`      ${pad(lab, 14)}${padL(g.length + ' 日', 8)}${padL(a.length.toLocaleString() + ' 筆', 10)}  5日均 ${r3(avg(a))}%`);
  }
};

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 40 });
  console.log(`chipArchive ${all.length} 日（${all[0].date} → ${all[all.length - 1].date}）`);
  const M = run(build(all.slice(-(MAIN + WARM))), `【個股·主窗 ${MAIN} 日】`);
  const O = run(build(all.slice(0, OOT + WARM)), `【個股·第三獨立窗 OOT ${OOT} 日】`);

  console.log(`\n${'═'.repeat(122)}\n【交叉判定】主窗兩半窗同號(5日) ＋ OOT 同向 ＋ 皆為負（＝訊號有效）\n${'═'.repeat(122)}`);
  console.log(pad('條件', 28) + padL('主窗5日Δ', 11) + padL('主窗兩半', 20) + padL('OOT5日Δ', 11) + padL('主窗n', 9) + padL('OOTn', 9) + '  判定');
  console.log('─'.repeat(112));
  const pass = [];
  for (const m of M.out) {
    const o = O.out.find(z => z.x === m.x && z.y === m.y);
    if (!o) continue;
    const ok = m.ok && m.r.f5d < 0 && o.r.f5d < 0;
    console.log(pad(`RSI5>${m.x} ∧ RSI10>${m.y}`, 28) + padL(r3(m.r.f5d), 11)
      + padL(`[${r3(m.d[0])}/${r3(m.d[1])}]`, 20) + padL(r3(o.r.f5d), 11)
      + padL(m.r.n.toLocaleString(), 9) + padL(o.r.n.toLocaleString(), 9) + '  ' + (ok ? '✅' : '❌'));
    if (ok) pass.push(m);
  }
  if (!pass.length) console.log('\n  ✖ 沒有任何門檻組合通過。');
  else {
    console.log(`\n  ✅ ${pass.length} 組通過；對最強者做集中度檢查（今天學到的必要步驟）：`);
    pass.sort((a, b) => a.r.f5d - b.r.f5d);
    for (const p of pass.slice(0, 3)) concentration(p.sel, `RSI5>${p.x} ∧ RSI10>${p.y}（主窗）`);
  }
  console.log('\n  · 賣出訊號的用途是「出場/避開」，不是放空（台股放空成本與限制另計）。');
  console.log('  · 報酬解讀＝「若於訊號日收盤買進並持有會怎樣」，負值代表該避開。非投資建議。');
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
