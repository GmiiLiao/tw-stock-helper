#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 多參數組合搜尋：找命中率 ≥80% 的上漲/下跌判別  —— 2026-08-05
//
// 使用者要求：測各項參數與 2 種以上參數的組合，找出能精準強化上漲/下跌判別者，
//   **命中率需達 80% 以上才能下結論**。
//
// ⚠**先說清楚這個門檻有多高**：5 日方向命中率的基準約 45~50%；本站至今
//   所有通過檢定的訊號最高約 62%。要達 80% 只有兩條路——
//     (a) 極罕見的條件（n 很小 ⇒ 統計上沒有意義）
//     (b) 過度擬合（掃夠多組合必然找得到）
//   所以本腳本的防線是**硬性的**，不是建議值：
//     · n ≥ 100（主窗與 OOT 各自）
//     · 主窗**兩個半窗各自**命中率 ≥75%（不是合併後 ≥80%）
//     · 第三獨立窗 OOT 命中率 ≥75%
//     · 全部條件同時滿足才列為通過
//   並且輸出**掃了幾組**，讓多重檢定風險可被評估。
//
// ⚠**使用者前提的實測狀態**（如實標註，不影響照做）：
//   「連2日」在指數三版檢定中增量為 -0.15 ~ -0.34pp（無貢獻）；
//   真正有解釋力的是**市場廣度**（當日全市場同時觸發檔數）——
//   1~30 檔時 5 日淨在 0 附近或為負，>100 檔時 +12.28%。
//   故本次把「廣度」也列入參數空間，與 RSI 等並列由資料裁決。
//
// 口徑：個股·可交易宇宙（4碼·量≥300張·進場日漲幅≤8.5%）·扣 0.4425%·
//   T 日收盤進場（所有特徵收盤即知，PIT 安全）。
// 用法：node scripts/screen-multiparam-hit80.mjs [--hz f5]
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';

const COST = 0.4425;
const MAIN = 480, OOT = 240, WARM = 30;
const HZ = (() => { const i = process.argv.indexOf('--hz'); return i >= 0 ? process.argv[i + 1] : 'f5'; })();
const MIN_N = 100, HIT_MAIN_HALF = 75, HIT_OOT = 75, HIT_ALL = 80;

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
const hit = (a, dir) => (a.length ? +(a.filter(v => (dir > 0 ? v > 0 : v < 0)).length / a.length * 100).toFixed(1) : null);
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

/** 建樣本：一次算齊所有候選參數（全部收盤即知） */
function build(days) {
  const S = [];
  const H = {};
  for (let i = 0; i < days.length; i++) {
    const D = days[i], P = days[i - 1];
    // 當日大盤中位數漲幅
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
    const todays = [];
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const row = D.close[code]; if (!row || row.length < 5) continue;
      const [c, v, , h, l] = row; if (!(c > 0)) continue;
      const st = (H[code] ||= { pc: null, cl: [], vl: [], s5: { g: 0, l: 0, n: 0, v: null }, s10: { g: 0, l: 0, n: 0, v: null }, p5: null, p10: null, dn: 0 });
      if (st.pc != null) {
        st.p5 = st.s5.v; st.p10 = st.s10.v;
        step(st.s5, c - st.pc, 5); step(st.s10, c - st.pc, 10);
        st.dn = c < st.pc ? st.dn + 1 : 0;                    // 連跌天數
      }
      const pc = st.pc, cl = st.cl, vl = st.vl;
      st.pc = c;
      const ready = i >= WARM && pc > 0 && st.s5.v != null && st.p5 != null && cl.length >= 20;
      if (ready) {
        const chg = (c - pc) / pc * 100;
        if (v >= 300 && chg <= 8.5) {
          let hi20 = 0, lo20 = Infinity, av20 = 0;
          for (let k = 1; k <= 20; k++) { const x = cl[cl.length - k]; if (x > hi20) hi20 = x; if (x < lo20) lo20 = x; av20 += vl[vl.length - k] || 0; }
          av20 /= 20;
          const ma5 = (cl.slice(-4).reduce((s2, x) => s2 + x, 0) + c) / 5;
          const ma20 = (cl.slice(-19).reduce((s2, x) => s2 + x, 0) + c) / 20;
          const c5 = cl[cl.length - 5];
          const f = n => { const d = days[i + n]?.close?.[code]; return d && d[0] > 0 ? (d[0] - c) / c * 100 - COST : null; };
          todays.push({
            di: i, date: D.date, code,
            r5: st.s5.v, r10: st.s10.v, p5: st.p5, p10: st.p10,
            chg, mkt, pos: h > l ? (c - l) / (h - l) : 0.5,
            volX: av20 > 0 ? v / av20 : null,
            ret5: c5 > 0 ? (c - c5) / c5 * 100 : null,
            posture: hi20 > 0 ? c / hi20 : null,
            fromLo: lo20 > 0 && lo20 < Infinity ? c / lo20 : null,
            ma5rel: (c / ma5 - 1) * 100, ma20rel: (c / ma20 - 1) * 100,
            dn: st.dn,
            f1: f(1), f3: f(3), f5: f(5), f10: f(10), f20: f(20),
          });
        }
      }
      cl.push(c); vl.push(v || 0);
      if (cl.length > 40) { cl.shift(); vl.shift(); }
    }
    // 廣度：當日全市場「連2日 RSI10<20」與「連2日 RSI10>80」的檔數
    const bLo = todays.filter(s => s.r10 < 20 && s.p10 < 20).length;
    const bHi = todays.filter(s => s.r10 > 80 && s.p10 > 80).length;
    for (const s of todays) { s.bLo = bLo; s.bHi = bHi; }
    S.push(...todays);
  }
  const mid = Math.floor(days.length / 2);
  for (const s of S) s.half = s.di < mid ? 0 : 1;
  return S;
}

// ── 候選條件（每個都是「單一參數的一個切法」）──────────────────────
const P_UP = [   // 判別「上漲」用的候選條件
  ['RSI10連2日<20', s => s.r10 < 20 && s.p10 < 20],
  ['RSI10連2日<25', s => s.r10 < 25 && s.p10 < 25],
  ['RSI10連2日<30', s => s.r10 < 30 && s.p10 < 30],
  ['RSI5連2日<15', s => s.r5 < 15 && s.p5 < 15],
  ['RSI5連2日<20', s => s.r5 < 20 && s.p5 < 20],
  ['廣度>100檔', s => s.bLo > 100],
  ['廣度>30檔', s => s.bLo > 30],
  ['廣度>10檔', s => s.bLo > 10],
  ['大盤跌>1%', s => s.mkt != null && s.mkt < -1],
  ['大盤跌>2%', s => s.mkt != null && s.mkt < -2],
  ['連跌≥3日', s => s.dn >= 3],
  ['連跌≥5日', s => s.dn >= 5],
  ['量比>1.5', s => s.volX != null && s.volX > 1.5],
  ['量比<0.7', s => s.volX != null && s.volX < 0.7],
  ['收位>0.7', s => s.pos > 0.7],
  ['收位<0.3', s => s.pos < 0.3],
  ['距20日高<0.85', s => s.posture != null && s.posture < 0.85],
  ['距20日低<1.03', s => s.fromLo != null && s.fromLo < 1.03],
  ['5日跌>10%', s => s.ret5 != null && s.ret5 < -10],
  ['5日跌>15%', s => s.ret5 != null && s.ret5 < -15],
  ['低於MA20 >10%', s => s.ma20rel < -10],
  ['低於MA5 >5%', s => s.ma5rel < -5],
];
const P_DN = [   // 判別「下跌」用的候選條件
  ['RSI10連2日>80', s => s.r10 > 80 && s.p10 > 80],
  ['RSI10連2日>75', s => s.r10 > 75 && s.p10 > 75],
  ['RSI10連2日>70', s => s.r10 > 70 && s.p10 > 70],
  ['RSI5連2日>85', s => s.r5 > 85 && s.p5 > 85],
  ['RSI5連2日>80', s => s.r5 > 80 && s.p5 > 80],
  ['廣度(超買)>100檔', s => s.bHi > 100],
  ['廣度(超買)>30檔', s => s.bHi > 30],
  ['廣度(超買)>10檔', s => s.bHi > 10],
  ['大盤漲>1%', s => s.mkt != null && s.mkt > 1],
  ['大盤漲>2%', s => s.mkt != null && s.mkt > 2],
  ['量比>2', s => s.volX != null && s.volX > 2],
  ['量比>3', s => s.volX != null && s.volX > 3],
  ['收位<0.3', s => s.pos < 0.3],
  ['收位>0.9', s => s.pos > 0.9],
  ['破20日高', s => s.posture != null && s.posture >= 1],
  ['5日漲>15%', s => s.ret5 != null && s.ret5 > 15],
  ['5日漲>20%', s => s.ret5 != null && s.ret5 > 20],
  ['高於MA20 >15%', s => s.ma20rel > 15],
  ['高於MA5 >5%', s => s.ma5rel > 5],
];

const evalCombo = (S, conds, dir) => {
  const sel = S.filter(s => conds.every(c => c[1](s)) && s[HZ] != null);
  if (sel.length < MIN_N) return null;
  const all = sel.map(s => s[HZ]);
  const h0 = sel.filter(s => s.half === 0).map(s => s[HZ]);
  const h1 = sel.filter(s => s.half === 1).map(s => s[HZ]);
  return { n: sel.length, hitAll: hit(all, dir), h0: h0.length >= 20 ? hit(h0, dir) : null,
    h1: h1.length >= 20 ? hit(h1, dir) : null, n0: h0.length, n1: h1.length, ret: avg(all) };
};

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 40 });
  const M = build(all.slice(-(MAIN + WARM)));
  const O = build(all.slice(0, OOT + WARM));
  console.log('═'.repeat(118));
  console.log(`多參數組合搜尋｜目標窗口 ${HZ}｜主窗樣本 ${M.length.toLocaleString()}／OOT ${O.length.toLocaleString()}`);
  console.log(`通過門檻：n≥${MIN_N}（主窗與OOT各自）· 主窗合併命中≥${HIT_ALL}% · 主窗兩半窗各自≥${HIT_MAIN_HALF}% · OOT≥${HIT_OOT}%`);
  console.log('═'.repeat(118));

  for (const [sideName, pool, dir] of [['上漲判別', P_UP, 1], ['下跌判別', P_DN, -1]]) {
    const baseM = hit(M.map(s => s[HZ]).filter(v => v != null), dir);
    const baseO = hit(O.map(s => s[HZ]).filter(v => v != null), dir);
    console.log(`\n${'━'.repeat(118)}\n【${sideName}】基準命中率：主窗 ${baseM}%／OOT ${baseO}%（＝可交易宇宙隨機一檔的方向正確率）\n${'━'.repeat(118)}`);
    let tested = 0; const pass = []; const best = [];
    // 1~3 個參數的所有組合
    const combos = [];
    for (let i = 0; i < pool.length; i++) {
      combos.push([pool[i]]);
      for (let j = i + 1; j < pool.length; j++) {
        combos.push([pool[i], pool[j]]);
        for (let k = j + 1; k < pool.length; k++) combos.push([pool[i], pool[j], pool[k]]);
      }
    }
    for (const c of combos) {
      tested++;
      const m = evalCombo(M, c, dir);
      if (!m) continue;
      best.push({ c, m });
      if (m.hitAll < HIT_ALL || m.h0 == null || m.h1 == null || m.h0 < HIT_MAIN_HALF || m.h1 < HIT_MAIN_HALF) continue;
      const o = evalCombo(O, c, dir);
      if (!o || o.hitAll < HIT_OOT) continue;
      pass.push({ c, m, o });
    }
    console.log(`  掃描 ${tested.toLocaleString()} 個組合（1~3 個參數），樣本足夠者 ${best.length.toLocaleString()} 組`);
    console.log(`\n  主窗命中率最高的 12 組（不論是否通過全部門檻）：`);
    console.log('  ' + pad('條件組合', 62) + padL('n', 8) + padL('主窗命中', 10) + padL('兩半窗', 16) + padL(`${HZ}均報`, 10));
    console.log('  ' + '─'.repeat(106));
    best.sort((a, b) => b.m.hitAll - a.m.hitAll);
    for (const b of best.slice(0, 12)) {
      console.log('  ' + pad(b.c.map(x => x[0]).join(' ∧ '), 62) + padL(b.m.n.toLocaleString(), 8)
        + padL(`${b.m.hitAll}%`, 10) + padL(`${b.m.h0 ?? '-'}/${b.m.h1 ?? '-'}`, 16) + padL(`${r2(b.m.ret)}%`, 10));
    }
    // 兩半窗都有足夠樣本者：這才是「非單一事件」的候選，即使沒到 80% 也要列
    console.log('\n  ★兩半窗都有足夠樣本（＝非單一事件）且命中率最高的 8 組，含 OOT：');
    console.log('  ' + pad('條件組合', 58) + padL('n', 7) + padL('主窗', 8) + padL('兩半窗', 14)
      + padL('OOT', 8) + padL('OOTn', 8) + padL(`${HZ}均報`, 10));
    console.log('  ' + '─'.repeat(105));
    const stable = best.filter(b => b.m.h0 != null && b.m.h1 != null && Math.min(b.m.n0, b.m.n1) >= 100)
      .sort((a, b) => b.m.hitAll - a.m.hitAll).slice(0, 8);
    for (const b of stable) {
      const o = evalCombo(O, b.c, dir);
      console.log('  ' + pad(b.c.map(x => x[0]).join(' ∧ '), 58) + padL(b.m.n.toLocaleString(), 7)
        + padL(`${b.m.hitAll}%`, 8) + padL(`${b.m.h0}/${b.m.h1}`, 14)
        + padL(o ? `${o.hitAll}%` : '樣本不足', 8) + padL(o ? o.n.toLocaleString() : '-', 8)
        + padL(`${r2(b.m.ret)}%`, 10));
    }

    console.log(`\n  ✅ 通過全部門檻者：${pass.length} 組`);
    for (const p of pass.slice(0, 15)) {
      console.log(`    ${pad(p.c.map(x => x[0]).join(' ∧ '), 58)} 主窗 ${p.m.hitAll}%[${p.m.h0}/${p.m.h1}]·n=${p.m.n}`
        + `  OOT ${p.o.hitAll}%·n=${p.o.n}  ${HZ}均報 ${r2(p.m.ret)}%`);
    }
    if (!pass.length) console.log('    （無）');
  }

  console.log(`\n${'═'.repeat(118)}\n判讀\n${'═'.repeat(118)}`);
  console.log('  · 掃描數千組合後挑出的高命中率，**極可能是多重檢定的產物**。');
  console.log('    這正是門檻要求「兩個半窗各自 ≥75% ＋ OOT ≥75%」而非只看合併值的原因。');
  console.log('  · 命中率高 ≠ 賺錢：要同時看均報（例如 90% 機率賺 0.1%、10% 機率賠 5% 仍是負期望）。');
  console.log('  · 已扣 0.4425% 來回費稅，限可交易宇宙。非投資建議。');
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
