#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 推薦榜排序鍵的三方對決 —— 2026-08-05
//
// 上一輪把五大因子的反向項修掉，排序恢復單調——但那只證明「不再顛倒」，
// 沒有證明「有 edge」。本站另有一套**每一項都經過兩半窗＋第三獨立窗檢定**
// 的隔日沖訊號（composite-score.ts 的加減分）。問題是：
//   把 AI 推薦的排序鍵換成那些已驗證訊號，會比修正後的五大因子更好嗎？
//
// 不猜，直接對決三個排序鍵（同一份樣本、同一個口徑）：
//   Ⓐ 修正後五大因子（動能/量能/收盤位置/股價層級/形態）
//   Ⓑ 已驗證訊號疊加（composite-score 中「可用單日+歷史重建」的項目）
//   Ⓒ Ⓐ＋Ⓑ
//
// 口徑：隔日沖（今收買→明開賣·扣 0.4425%），可交易宇宙（chg≤8.5）。
//   判準沿用 bt-core：兩半窗同號且 |Δ|≥0.05 才算穩定；再過第三獨立窗。
//   **重點看的是「Top 20 檔/日」這個實際榜單大小的表現**，不是全體分桶——
//   因為產品真正推出去的就是每天前 20 名。
//
// 用法：node scripts/screen-recommend-rank.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, COST } from './lib/bt-core.mjs';

const MAIN = 480, OOT = 240, WARM = 62;
const r3 = x => (x == null ? null : +x.toFixed(3));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const wr = a => (a.length ? +(a.filter(v => v > 0).length / a.length * 100).toFixed(1) : null);

/** 自建樣本：bt-core 的 buildSamples 沒吐 vol20/K9/mktChg，這裡一次補齊 */
export function build(days) {
  const out = [];
  const H = {};                       // code → closes/vols/highs/lows
  for (let i = 0; i < days.length; i++) {
    const D = days[i], P = days[i - 1], N = days[i + 1];
    // 當日大盤漲跌%＝可交易宇宙的中位數漲幅（跟風懲罰的第二關代理，收盤即知）
    let mktChg = null;
    if (P) {
      const gs = [];
      for (const c in D.close) {
        if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
        const a = D.close[c]?.[0], b = P.close?.[c]?.[0];
        if (a > 0 && b > 0) gs.push((a - b) / b * 100);
      }
      gs.sort((a, b) => a - b);
      mktChg = gs.length ? gs[gs.length >> 1] : null;
    }
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const row = D.close[code]; if (!row || row.length < 5) continue;
      const [c, v, o, h, l] = row;
      const st = (H[code] ||= { c: [], v: [], h: [], l: [] });
      const pc = st.c[st.c.length - 1];
      const n = N?.close?.[code];
      if (i >= WARM && pc > 0 && c > 0 && v >= 300 && h > l && n && n.length >= 5 && n[0] > 0 && n[2] > 0) {
        const chg = (c - pc) / pc * 100;
        if (chg <= 8.5) {                                     // 可交易宇宙
          const cl = st.c, hh = st.h, ll = st.l;
          let hi20 = 0;
          for (let k = 1; k <= Math.min(20, cl.length); k++) if (cl[cl.length - k] > hi20) hi20 = cl[cl.length - k];
          // 20 日已實現波動（日報酬標準差%）
          const rets = [];
          for (let k = 1; k < Math.min(21, cl.length); k++) {
            const a = cl[cl.length - k], b = cl[cl.length - k - 1];
            if (a > 0 && b > 0) rets.push((a - b) / b * 100);
          }
          const m = avg(rets);
          const vol20 = rets.length >= 15 ? Math.sqrt(avg(rets.map(x => (x - m) ** 2))) : null;
          // KD(9) 的 K：以 9 日 RSV 的簡化平滑（與站上同法）
          let k9 = null;
          if (cl.length >= 9) {
            let K = 50;
            for (let t = Math.max(0, cl.length - 30); t < cl.length; t++) {
              const hs = hh.slice(Math.max(0, t - 8), t + 1), ls = ll.slice(Math.max(0, t - 8), t + 1);
              if (hs.length < 9) continue;
              const hi = Math.max(...hs), lo = Math.min(...ls);
              const rsv = hi > lo ? (cl[t] - lo) / (hi - lo) * 100 : 50;
              K = K * 2 / 3 + rsv / 3;
            }
            k9 = K;
          }
          const ma5 = cl.length >= 5 ? avg(cl.slice(-5)) : null;
          const c5 = cl[cl.length - 5];
          out.push({
            di: i, code, chg, c, v, o, h, l, pc, mktChg,
            pos: (c - l) / (h - l),
            value: c * v * 1000,
            hi20, brk20: hi20 > 0 && c > hi20,
            ret5: c5 > 0 ? (c - c5) / c5 * 100 : null,
            vol20, k9, belowMA5: ma5 != null ? c < ma5 : null,
            netOpen: (n[2] - c) / c * 100 - COST,
          });
        }
      }
      st.c.push(c > 0 ? c : (st.c[st.c.length - 1] || 0)); st.v.push(v || 0);
      st.h.push(h > 0 ? h : c); st.l.push(l > 0 ? l : c);
      if (st.c.length > WARM) { st.c.shift(); st.v.shift(); st.h.shift(); st.l.shift(); }
    }
  }
  const mid = Math.floor(days.length / 2);
  for (const s of out) s.half = s.di < mid ? 0 : 1;
  return out;
}

// ── Ⓐ 修正後五大因子（與 scoring-server.ts 同步）──
export function fiveFixed(s) {
  const { chg, value: val, pos, c: p } = s;
  const m = chg > 8.5 ? 0 : chg >= 3 ? 16 : chg > 0 ? 10 : chg === 0 ? 8 : chg > -2 ? 8 : 6;
  let v = val > 5e9 ? 20 : val > 1e9 ? 17 : val > 5e8 ? 14 : val > 1e8 ? 10 : val > 5e7 ? 6 : 2;
  if (chg > 1 && val > 5e8) v = Math.min(v + 3, 20);
  let t = pos >= 0.85 ? 8 : pos >= 0.70 ? 12 : pos >= 0.50 ? 14 : pos >= 0.30 ? 15 : 16;
  if (s.o > s.pc * 1.005 && chg > 1) t = Math.min(t + 1, 20);
  const st = p >= 500 ? 18 : p >= 100 ? 16 : p >= 30 ? 14 : p >= 10 ? 10 : 6;
  const va = chg >= 9.9 ? 4 : (chg >= 7 && chg < 9.9) ? 8 : chg <= -9.9 ? 0 : (chg > 0 && chg < 5) ? 15 : 12;
  return m + v + t + st + va;
}

// ── Ⓑ 已驗證訊號疊加（composite-score.ts 中可由單日+歷史重建者）──
//   每一項都附本站兩半窗＋OOT 的檢定出處；未通過檢定的一律不放進來。
export function validated(s) {
  let a = 0;
  const strongTail = s.pos >= 0.8 && Math.abs(s.chg) > 1;
  if (s.brk20 && s.pos >= 0.7) a += 2;                                   // 🏔破高×強尾（+2·兩窗穩定正）
  else if (strongTail) a -= 2;                                            // 💪強尾單獨（−2·舊版誤給+2）
  if (s.mktChg != null && s.mktChg >= 1 && s.chg >= 3 && s.chg - s.mktChg < 1) a -= 2;  // 🐑跟風（−2）
  if (s.ret5 != null && s.ret5 >= 20) a -= 2;                             // 🔥5日過熱（−2）
  if (s.k9 != null && s.k9 > 90) a -= 2;                                  // 📉K>90 極度超買（−2）
  else if (s.k9 != null && s.k9 > 80 && s.belowMA5) a -= 2;               // 📉K80~90×破5MA（−2）
  if (s.vol20 != null && s.vol20 < 1.5) a -= 2;                           // 😴低波動（−2）
  return a;
}

// ── 每日取前 N 名，算相對可交易宇宙的超額 ──
function topN(samples, key, N = 20) {
  const byDay = {};
  for (const s of samples) (byDay[s.di] ||= []).push(s);
  const picked = [], baseAll = [];
  for (const di in byDay) {
    const arr = byDay[di];
    baseAll.push(...arr.map(s => s.netOpen));
    picked.push(...[...arr].sort((x, y) => key(y) - key(x)).slice(0, N));
  }
  return { picked, baseAll };
}

function evalKey(samples, key, label, N) {
  const halves = [0, 1].map(hf => {
    const sub = samples.filter(s => s.half === hf);
    const { picked, baseAll } = topN(sub, key, N);
    return { d: avg(picked.map(s => s.netOpen)) - avg(baseAll), win: wr(picked.map(s => s.netOpen)), n: picked.length };
  });
  const { picked, baseAll } = topN(samples, key, N);
  const ok = Math.sign(halves[0].d) === Math.sign(halves[1].d) && Math.min(Math.abs(halves[0].d), Math.abs(halves[1].d)) >= 0.05;
  return {
    label, dHalf: halves.map(h => r3(h.d)), win: wr(picked.map(s => s.netOpen)),
    net: r3(avg(picked.map(s => s.netOpen))), base: r3(avg(baseAll)),
    delta: r3(avg(picked.map(s => s.netOpen)) - avg(baseAll)), n: picked.length, ok,
  };
}

const run = (samples, tag, N) => {
  console.log(`\n${'═'.repeat(84)}\n${tag}｜可交易樣本 ${samples.length.toLocaleString()}｜每日取前 ${N} 名\n${'═'.repeat(84)}`);
  const keys = [
    ['Ⓐ 修正後五大因子', fiveFixed],
    ['Ⓑ 已驗證訊號疊加', validated],
    ['Ⓒ Ⓐ＋Ⓑ×3（疊加加權）', s => fiveFixed(s) + validated(s) * 3],
    ['Ⓓ Ⓐ＋Ⓑ×6', s => fiveFixed(s) + validated(s) * 6],
    ['（對照）隨機／全宇宙', () => 0],
  ];
  const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);
  console.log(pad('排序鍵', 24) + padL('兩半窗Δ', 20) + padL('全窗Δ', 9) + padL('淨均', 9) + padL('淨勝', 8) + padL('n', 8) + '  判定');
  console.log('─'.repeat(84));
  for (const [label, key] of keys) {
    const r = evalKey(samples, key, label, N);
    console.log(pad(label, 24) + padL(`[${r.dHalf[0]}/${r.dHalf[1]}]`, 20) + padL(`${r.delta}`, 9)
      + padL(`${r.net}%`, 9) + padL(`${r.win}%`, 8) + padL(r.n.toLocaleString(), 8) + '  ' + (r.ok ? '✅兩窗同號' : '❌'));
  }
  console.log(`  （基準＝同期可交易宇宙等權淨均 ${r3(avg(samples.map(s => s.netOpen)))}%）`);
};

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 5 });
  const mainS = build(all.slice(-(MAIN + WARM)));
  const ootS = build(all.slice(0, OOT + WARM));
  for (const N of [20, 50]) {
    run(mainS, `【主窗 ${MAIN} 日】`, N);
    run(ootS, `【第三獨立窗 OOT ${OOT} 日】`, N);
  }
  process.exit(0);
};
// 只有直接執行才跑；被 import（screen-recommend-gate.mjs 共用 build/fiveFixed/
// validated）時不得自動執行，否則會多跑一整輪回測並蓋掉呼叫端的輸出。
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
