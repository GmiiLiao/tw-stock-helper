#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 個股版：連 2 日 RSI 極端 → 反轉  —— 2026-08-05（使用者：技巧搬到個股測）
//
// **與指數版的三個本質差異（不是照抄）**：
//   ① 個股**可以真的買**⇒ 必須扣來回費稅 0.4425%；指數版不扣是因為買不到。
//   ② 必須限**可交易宇宙**：4碼普通股·量≥300張·進場日漲幅≤8.5%（漲停買不到）。
//   ③ 有 983 個交易日 × 約 1,000 檔 ⇒ 樣本足夠做本站標準判準
//      （兩半窗同號 ＋ 第三獨立窗 OOT），指數版只有 2,429 根日線做不到。
//
// 目標窗口：1/3/5/10/20 日全測。
//   （2026-08-05 教訓：先前四輪只測 20 日，把「隔天就彈」的短窗訊號稀釋掉了。
//     使用者用實際線圖對帳才發現。目標窗口要配合要預測的事件長度。）
//
// 進場：T 日收盤（RSI 收盤即知）。**不含隔日確認**——指數版四輪＋全參數
//   空間窮舉都證明確認是負貢獻，個股版另外單獨列出確認變體供對照。
//
// 用法：node scripts/screen-stock-rsi-reversal.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';

const COST = 0.4425;
const MAIN = 480, OOT = 240, WARM = 30;
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
const r3 = x => (x == null ? null : +x.toFixed(3));
const wr = a => (a.length ? +(a.filter(v => v > 0).length / a.length * 100).toFixed(1) : null);
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

/** Wilder RSI 的逐步推進（與 Yahoo 顯示值對帳一致，見 screen-index-reversal） */
function rsiStep(st, diff, p) {
  if (st.n < p) {
    st.g += diff > 0 ? diff : 0; st.l += diff < 0 ? -diff : 0; st.n++;
    if (st.n === p) { st.g /= p; st.l /= p; st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l); }
    return st.v;
  }
  st.g = (st.g * (p - 1) + (diff > 0 ? diff : 0)) / p;
  st.l = (st.l * (p - 1) + (diff < 0 ? -diff : 0)) / p;
  st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l);
  return st.v;
}

/** 逐日推進整個宇宙的 RSI，產出樣本 */
function build(days) {
  const S = [];
  const H = {};   // code → { pc, r5:{}, r10:{}, prevR5, prevR10, cur5, cur10 }
  for (let i = 0; i < days.length; i++) {
    const D = days[i], N = days[i + 1];
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const row = D.close[code]; if (!row || row.length < 5) continue;
      const c = row[0], v = row[1];
      if (!(c > 0)) continue;
      const st = (H[code] ||= { pc: null, s5: { g: 0, l: 0, n: 0, v: null }, s10: { g: 0, l: 0, n: 0, v: null }, p5: null, p10: null });
      if (st.pc != null) {
        st.p5 = st.s5.v; st.p10 = st.s10.v;               // 前一日（T-1）的 RSI
        rsiStep(st.s5, c - st.pc, 5);
        rsiStep(st.s10, c - st.pc, 10);
      }
      const pc = st.pc;
      st.pc = c;
      if (i < WARM || pc == null || st.s5.v == null || st.s10.v == null || st.p5 == null) continue;
      const chg = (c - pc) / pc * 100;
      if (!(v >= 300) || chg > 8.5) continue;             // 可交易宇宙
      const nx = N?.close?.[code];
      const f = n => {
        const d = days[i + n]?.close?.[code];
        return d && d[0] > 0 ? (d[0] - c) / c * 100 - COST : null;
      };
      S.push({
        di: i, code, c, chg,
        r5: st.s5.v, r10: st.s10.v, p5: st.p5, p10: st.p10,
        nextUp: nx && nx[0] > 0 ? nx[0] > c : null,        // 隔日是否上漲（確認變體用）
        f1: f(1), f3: f(3), f5: f(5), f10: f(10), f20: f(20),
      });
    }
  }
  const mid = Math.floor(days.length / 2);
  for (const s of S) s.half = s.di < mid ? 0 : 1;
  return S;
}

const HZ = ['f1', 'f3', 'f5', 'f10', 'f20'];
const HZL = ['1日', '3日', '5日', '10日', '20日'];

function evalCond(S, cond) {
  const sel = S.filter(cond);
  if (!sel.length) return null;
  const out = { n: sel.length };
  for (const h of HZ) {
    const a = sel.map(s => s[h]).filter(v => v != null);
    out[h] = avg(a); out[h + 'w'] = wr(a);
    for (const hf of [0, 1]) {
      const b = sel.filter(s => s.half === hf).map(s => s[h]).filter(v => v != null);
      out[`${h}_${hf}`] = avg(b);
    }
  }
  return out;
}

const run = (S, tag) => {
  const base = {};
  for (const h of HZ) {
    base[h] = avg(S.map(s => s[h]).filter(v => v != null));
    for (const hf of [0, 1]) base[`${h}_${hf}`] = avg(S.filter(s => s.half === hf).map(s => s[h]).filter(v => v != null));
  }
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`${tag}｜可交易樣本 ${S.length.toLocaleString()} 筆`);
  console.log(`基準（可交易宇宙等權·已扣 ${COST}%）：` + HZ.map((h, j) => `${HZL[j]} ${r3(base[h])}%`).join('  '));
  console.log('═'.repeat(120));
  console.log(pad('條件（連2日·T日收盤進場·不等確認）', 34) + padL('次數', 8)
    + HZL.map(l => padL(l, 9)).join('') + padL('1日勝', 8) + padL('5日勝', 8) + '  5日兩半窗Δ');
  console.log('─'.repeat(120));
  const rows = [];
  for (const x of [15, 20, 25, 30]) for (const y of [20, 25, 30, 35, 40]) {
    const cond = s => s.r5 < x && s.r10 < y && s.p5 < x && s.p10 < y;
    const r = evalCond(S, cond);
    if (!r || r.n < 300) continue;
    const d5 = [r.f5_0 - base.f5_0, r.f5_1 - base.f5_1];
    const ok = Math.sign(d5[0]) === Math.sign(d5[1]) && Math.min(Math.abs(d5[0]), Math.abs(d5[1])) >= 0.05;
    rows.push({ x, y, r, d5, ok });
    console.log(pad(`RSI5<${x} ∧ RSI10<${y}`, 34) + padL(r.n.toLocaleString(), 8)
      + HZ.map(h => padL(r3(r[h]), 9)).join('') + padL(`${r.f1w}%`, 8) + padL(`${r.f5w}%`, 8)
      + `  [${r3(d5[0])}/${r3(d5[1])}]${ok ? '✓' : ''}`);
  }
  return { base, rows };
};

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 40 });
  console.log(`chipArchive 載入 ${all.length} 個交易日（${all[0].date} → ${all[all.length - 1].date}）`);

  const mainS = build(all.slice(-(MAIN + WARM)));
  const M = run(mainS, `【主窗 ${MAIN} 日·兩半窗內建】`);

  const ootS = build(all.slice(0, OOT + WARM));
  const O = run(ootS, `【第三獨立窗 OOT ${OOT} 日】`);

  // ── 交叉判定：主窗兩半窗同號 ＋ OOT 同向 ──
  console.log(`\n${'═'.repeat(120)}\n【交叉判定】主窗兩半窗同號(5日) ＋ OOT 同向 才算過關\n${'═'.repeat(120)}`);
  console.log(pad('條件', 26) + padL('主窗5日Δ', 11) + padL('主窗兩半', 20) + padL('OOT 5日Δ', 11) + padL('主窗n', 9) + padL('OOTn', 9) + '  判定');
  console.log('─'.repeat(110));
  const pass = [];
  for (const r of M.rows) {
    const o = O.rows.find(z => z.x === r.x && z.y === r.y);
    if (!o) continue;
    const dM = r.r.f5 - M.base.f5, dO = o.r.f5 - O.base.f5;
    const ok = r.ok && Math.sign(dM) === Math.sign(dO) && dM > 0 && dO > 0;
    console.log(pad(`RSI5<${r.x} ∧ RSI10<${r.y}`, 26) + padL(r3(dM), 11)
      + padL(`[${r3(r.d5[0])}/${r3(r.d5[1])}]`, 20) + padL(r3(dO), 11)
      + padL(r.r.n.toLocaleString(), 9) + padL(o.r.n.toLocaleString(), 9) + '  ' + (ok ? '✅' : '❌'));
    if (ok) pass.push({ ...r, dM, dO, oN: o.r.n });
  }

  console.log(`\n${'═'.repeat(120)}\n結論\n${'═'.repeat(120)}`);
  if (!pass.length) {
    console.log('  ✖ 沒有任何門檻組合同時通過「主窗兩半窗同號 ＋ OOT 同向為正」。');
  } else {
    console.log(`  ✅ ${pass.length} 組通過，依主窗 5 日超額排序：`);
    pass.sort((a, b) => b.dM - a.dM);
    for (const p of pass) {
      console.log(`    RSI5<${p.x} ∧ RSI10<${p.y}`.padEnd(28)
        + `主窗 5日淨 ${r3(p.r.f5)}%（Δ${r3(p.dM)}）·勝${p.r.f5w}%·n=${p.r.n.toLocaleString()}`
        + `  ｜OOT Δ${r3(p.dO)}·n=${p.oN.toLocaleString()}`);
    }
  }
  console.log('\n  · 已扣來回費稅 0.4425%，限可交易宇宙（量≥300張·進場日漲幅≤8.5%）。');
  console.log('  · 個股與指數的最大差別：個股買得到，所以這裡的數字是可執行報酬。非投資建議。');
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
