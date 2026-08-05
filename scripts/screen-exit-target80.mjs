#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 第八輪：出場訊號的 80% —— 換「目標定義」這支最後的合法槓桿  —— 2026-08-05
//
// 七輪結論：「5日後收盤方向」目標下，下跌側平常日誠實前緣 71.2%/OOT 61.1%。
// 剩下唯一沒動過的合法變因是**目標本身**：
//   下跌側是**出場/避開訊號**。持有者真正的問題不是「5天後收盤會不會比較低」，
//   而是「接下來5天內會不會出現值得先跑的下跌」。同一訊號、換操作正確的目標，
//   命中率地板本來就不同——**但基準也會跟著變高，所以必須並列基準與超額**，
//   否則就是換個題目騙自己。
//
// 目標定義（皆 PIT 安全）：
//   T1 五日後收盤下跌（原目標·扣費稅·與前七輪可比）
//   T2 5日內最低收盤 ≤ -2%（毛·曾有 -2% 的收盤出場點）
//   T3 5日內最低點(low) ≤ -3%（毛·盤中曾觸 -3%）
//   T4 五日後收盤 ≤ -3%（毛·實質下跌而非小黑）
//
// 同時：在 T1 上對前緣組合加第 4 參數（能否直推 80%）。
// 口徑：全市場·平常日（同第六輪定義）·觸發日≥30·兩半窗＋OOT。
// 用法：node scripts/screen-exit-target80.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';

const COST = 0.4425;
const MAIN = 480, OOT = 240, WARM = 30;
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

function rsiStep(st, d, p) {
  if (st.n < p) { st.g += d > 0 ? d : 0; st.l += d < 0 ? -d : 0; st.n++;
    if (st.n === p) { st.g /= p; st.l /= p; st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l); } return; }
  st.g = (st.g * (p - 1) + (d > 0 ? d : 0)) / p; st.l = (st.l * (p - 1) + (d < 0 ? -d : 0)) / p;
  st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l);
}

export function build(days) {
  const S = [], H = {};
  for (let i = 0; i < days.length; i++) {
    const D = days[i], P = days[i - 1];
    let mkt = null;
    if (P) {
      const g = [];
      for (const c in D.close) {
        if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
        const a = D.close[c]?.[0], b = P.close?.[c]?.[0];
        if (a > 0 && b > 0) g.push((a - b) / b * 100);
      }
      g.sort((a, b) => a - b); mkt = g.length ? g[g.length >> 1] : null;
    }
    const todays = []; let bLo = 0, bHi = 0;
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const row = D.close[code]; if (!row || row.length < 5) continue;
      const [c, v, o, h, l] = row; if (!(c > 0)) continue;
      const st = (H[code] ||= { pc: null, cl: [], vl: [], s5: { g: 0, l: 0, n: 0, v: null }, s10: { g: 0, l: 0, n: 0, v: null }, p5: null, p10: null, up: 0, b1: null, b2: null });
      const b1 = st.b1, b2 = st.b2;
      if (st.pc != null) {
        st.p5 = st.s5.v; st.p10 = st.s10.v;
        rsiStep(st.s5, c - st.pc, 5); rsiStep(st.s10, c - st.pc, 10);
        st.up = c > st.pc ? st.up + 1 : 0;
      }
      const pc = st.pc, cl = st.cl, vl = st.vl;
      st.pc = c;
      if (i >= WARM && pc > 0 && st.s5.v != null && st.p5 != null && cl.length >= 20) {
        const chg = (c - pc) / pc * 100;
        if (v >= 300 && chg <= 8.5) {
          if (st.s10.v < 20 && st.p10 < 20) bLo++;
          if (st.s10.v > 80 && st.p10 > 80) bHi++;
          let hi20 = 0, av20 = 0;
          for (let k = 1; k <= 20; k++) { const x = cl[cl.length - k]; if (x > hi20) hi20 = x; av20 += vl[vl.length - k] || 0; }
          av20 /= 20;
          const c5 = cl[cl.length - 5];
          const it1 = P?.inst?.[code];
          const f1 = it1 ? (it1[0] || 0) : null, t1 = it1 ? (it1[1] || 0) : null;
          let fSell = 0;
          for (let k = 1; k <= 10; k++) { const f = days[i - k]?.inst?.[code]?.[0]; if (f < 0) fSell++; else break; }
          const mg1 = P?.mg?.[code];
          const sr = mg1 && (mg1[0] || 0) > 0 ? (mg1[1] || 0) / mg1[0] : null;
          const lnLv = P?.ln?.[code] != null && av20 > 0 ? P.ln[code] / av20 : null;
          const white = c > o, body = Math.abs(c - o) / pc * 100;
          let w3 = false;
          if (b1 && b2) w3 = white && b1.c > b1.o && b2.c > b2.o && c > b1.c && b1.c > b2.c && body >= 1;
          // 目標值
          let f5 = null, minC = null, minL = null;
          const d5 = days[i + 5]?.close?.[code];
          if (d5 && d5[0] > 0) f5 = (d5[0] - c) / c * 100 - COST;
          let mc = Infinity, ml = Infinity, complete = true;
          for (let k = 1; k <= 5; k++) {
            const dk = days[i + k]?.close?.[code];
            if (!dk || !(dk[0] > 0)) { complete = false; break; }
            if (dk[0] < mc) mc = dk[0];
            const lo = dk[4] > 0 ? dk[4] : dk[0];
            if (lo < ml) ml = lo;
          }
          if (complete) { minC = (mc - c) / c * 100; minL = (ml - c) / c * 100; }
          todays.push({
            di: i, mkt, r5: st.s5.v, p5: st.p5,
            pos: h > l ? (c - l) / (h - l) : 0.5,
            upSh: h > l ? (h - Math.max(o, c)) / (h - l) : 0, amp: (h - l) / pc * 100,
            volX: av20 > 0 ? v / av20 : null, price: c,
            p20: hi20 > 0 ? c / hi20 : null,
            ret5: c5 > 0 ? (c - c5) / c5 * 100 : null,
            up: st.up, fSell, sr, lnLv, w3,
            fMag: f1 != null && av20 > 0 ? f1 / av20 : null,
            tSell: t1 != null && t1 < 0,
            f5, minC, minL,
          });
        }
      }
      st.b2 = st.b1; st.b1 = { o, c };
      cl.push(c); vl.push(v || 0);
      if (cl.length > 25) { cl.shift(); vl.shift(); }
    }
    for (const s of todays) { s.bLo = bLo; s.bHi = bHi; }
    S.push(...todays);
  }
  const mid = Math.floor(days.length / 2);
  for (const s of S) s.half = s.di < mid ? 0 : 1;
  return S;
}

export const POOL = [
  ['RSI5連2日>80', 'rsi', s => s.r5 > 80 && s.p5 > 80],
  ['RSI5連2日>85', 'rsi', s => s.r5 > 85 && s.p5 > 85],
  ['長上影', 'kup', s => s.upSh > 0.5 && s.amp >= 3],
  ['股價<20', 'px', s => s.price < 20],
  ['股價<50', 'px', s => s.price < 50],
  ['量比>5', 'volx', s => s.volX != null && s.volX > 5],
  ['量比>3', 'volx', s => s.volX != null && s.volX > 3],
  ['三白兵', 'w3', s => s.w3],
  ['破20日高', 'brk', s => s.p20 != null && s.p20 >= 1],
  ['收位>0.9', 'pos', s => s.pos > 0.9],
  ['外資連賣≥3', 'for', s => s.fSell >= 3],
  ['外資賣力道>3%均量', 'for', s => s.fMag != null && s.fMag < -0.03],
  ['借券/均量>1', 'ln', s => s.lnLv != null && s.lnLv > 1],
  ['券資比>0.2', 'sr', s => s.sr != null && s.sr > 0.2],
  ['連漲≥3', 'up', s => s.up >= 3],
  ['5日漲>15%', 'ret5', s => s.ret5 != null && s.ret5 > 15],
  ['投信昨賣超', 'tru', s => s.tSell],
];
export const TGT = {
  T1: { key: 'f5', hit: v => v < 0, name: '5日後收盤下跌(原目標·淨)' },
  T2: { key: 'minC', hit: v => v <= -2, name: '5日內最低收盤≤-2%(毛)' },
  T3: { key: 'minL', hit: v => v <= -3, name: '5日內曾觸-3%低點(毛)' },
  T4: { key: 'f5', hit: v => v <= -3 + COST, name: '5日後收盤≤-3%(毛)' },
};
export const isOrdinary = s => s.mkt != null && Math.abs(s.mkt) < 2 && s.bLo <= 30 && s.bHi <= 30;

export function evalT(S, masks, ids, tgt) {
  let n = 0, w = 0, n0 = 0, w0 = 0, n1 = 0, w1 = 0;
  const daySet = new Set();
  for (let k = 0; k < S.length; k++) {
    let ok = true;
    for (const id of ids) if (!masks[id][k]) { ok = false; break; }
    if (!ok) continue;
    const v = S[k][tgt.key]; if (v == null) continue;
    const win = tgt.hit(v);
    n++; if (win) w++; daySet.add(S[k].di);
    if (S[k].half === 0) { n0++; if (win) w0++; } else { n1++; if (win) w1++; }
  }
  if (!n) return null;
  return { n, days: daySet.size, hit: +(w / n * 100).toFixed(1),
    h0: n0 >= 30 ? +(w0 / n0 * 100).toFixed(1) : null, h1: n1 >= 30 ? +(w1 / n1 * 100).toFixed(1) : null, n0, n1 };
}

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 40 });
  const SM = build(all.slice(-(MAIN + WARM))).filter(isOrdinary);
  const SO = build(all.slice(0, OOT + WARM)).filter(isOrdinary);
  const mk = S => POOL.map(([, , fn]) => { const m = new Uint8Array(S.length); for (let k = 0; k < S.length; k++) m[k] = fn(S[k]) ? 1 : 0; return m; });
  const mM = mk(SM), mO = mk(SO);
  console.log('═'.repeat(118));
  console.log(`第八輪：出場訊號×目標定義｜平常日主窗 ${SM.length.toLocaleString()}／OOT ${SO.length.toLocaleString()}`);
  console.log('═'.repeat(118));

  // 各目標的基準（平常日全樣本）
  console.log('\n【各目標的基準命中率（＝隨便一檔也會中的機率·必看）】');
  for (const [tk, tgt] of Object.entries(TGT)) {
    const bM = evalT(SM, mM, [], tgt), bO = evalT(SO, mO, [], tgt);
    console.log(`  ${tk} ${pad(tgt.name, 30)} 主窗基準 ${bM.hit}%／OOT ${bO.hit}%`);
  }

  // A) T1 上衝 80%：前緣組合 + 第 4 參數
  console.log(`\n${'━'.repeat(118)}\nA) 原目標 T1 加第 4 參數——能否直推 80%？（門檻：兩半窗皆 n≥30·觸發≥30天·OOT n≥50）\n${'━'.repeat(118)}`);
  const combos = [];
  const np = POOL.length;
  for (let i = 0; i < np; i++) for (let j = i + 1; j < np; j++) {
    if (POOL[i][1] === POOL[j][1]) continue;
    for (let k = j + 1; k < np; k++) {
      if (POOL[k][1] === POOL[i][1] || POOL[k][1] === POOL[j][1]) continue;
      combos.push([i, j, k]);
      for (let q = k + 1; q < np; q++) {
        if (POOL[q][1] === POOL[i][1] || POOL[q][1] === POOL[j][1] || POOL[q][1] === POOL[k][1]) continue;
        combos.push([i, j, k, q]);
      }
    }
  }
  const label = ids => ids.map(i => POOL[i][0]).join(' ∧ ');
  const good = [];
  for (const ids of combos) {
    const m = evalT(SM, mM, ids, TGT.T1);
    if (!m || m.n < 100 || m.days < 30 || m.h0 == null || m.h1 == null) continue;
    good.push({ ids, m });
  }
  good.sort((a, b) => b.m.hit - a.m.hit);
  console.log(`  掃 ${combos.length.toLocaleString()} 組（3~4 參數）·合格 ${good.length.toLocaleString()} 組·前 8：`);
  for (const g of good.slice(0, 8)) {
    const o = evalT(SO, mO, g.ids, TGT.T1);
    console.log(`    ${pad(label(g.ids), 64)} ${g.m.hit}%[${g.m.h0}/${g.m.h1}]·n=${g.m.n}·${g.m.days}天`
      + `｜OOT ${o && o.n >= 50 ? `${o.hit}%·n=${o.n}` : '不足'}`);
  }

  // B) 前緣組合 × 四種目標
  console.log(`\n${'━'.repeat(118)}\nB) 前緣組合 × 操作目標（80% 若出現，看它離基準多遠才算數）\n${'━'.repeat(118)}`);
  const FRONT = [
    ['RSI5連2日>80', '長上影', '股價<20'],
    ['量比>5', '三白兵', '股價<20'],
    ['收位>0.9', '量比>5', '破20日高'],
    ['RSI5連2日>80', '收位>0.9', '外資連賣≥3'],
  ].map(names => names.map(nm => POOL.findIndex(p => p[0] === nm)));
  for (const ids of FRONT) {
    console.log(`  ▍${label(ids)}`);
    for (const [tk, tgt] of Object.entries(TGT)) {
      const m = evalT(SM, mM, ids, tgt);
      const o = evalT(SO, mO, ids, tgt);
      const bM = evalT(SM, mM, [], tgt);
      if (!m) { console.log(`    ${tk} 樣本不足`); continue; }
      console.log(`    ${tk} ${pad(tgt.name, 28)} 主窗 ${padL(m.hit + '%', 7)}[${m.h0 ?? '-'}/${m.h1 ?? '-'}]（基準 ${bM.hit}%·超額 ${r2(m.hit - bM.hit)}pp）`
        + `｜OOT ${o && o.n >= 50 ? `${o.hit}%` : '不足'}`);
    }
  }
  console.log(`\n${'═'.repeat(118)}\n判讀：換目標後命中率若變高但超額沒變大，只是題目變簡單，不是訊號變準。非投資建議。\n${'═'.repeat(118)}`);
  process.exit(0);
};
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
