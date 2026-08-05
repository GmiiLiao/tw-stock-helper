#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 第七輪：最終缺席參數（K線組合形態/ADX/CCI/W%R/妖股計數等）—— 2026-08-05
//
// 本輪新增（真正未測過的）：
//   ①二三日K線組合：多方吞噬/空方吞噬/晨星/夜星/三白兵/三黑鴉/母子線
//   ②趨勢強度 ADX14（先前用「冗餘」帶過——該量測不該宣稱）
//   ③CCI20、W%R14（同上：實測與 RSI 的增量，用資料關掉冗餘問題）
//   ④相對ATR14（與 vol20 的差異：ATR 含跳空）
//   ⑤20日漲停次數（妖股/炒作計數）  ⑥股價/成交值水平
//   ⑦外資/投信買賣佔均量幅度（連買天數之外的「力道」維度）
//   ⑧券資比5日變化  ⑨MA糾結度  ⑩距20日高天數
// 已測過而不重複：週轉率(2026-07-27 SOP檢定·1%飽和·僅排除價值)、布林上軌(否證)。
//
// 評估重點（承第六輪）：
//   A) 下跌側**平常日**（結構存在處）：新參數能否把 68.5%/OOT 59.1% 推高？
//   B) 上漲側平常日：新參數是否翻案「無結構」的結論？
//   C) 冗餘實測：CCI/W%R/ADX 疊在 RSI 上的增量。
// 門檻同前（硬防線）。平常日定義同第六輪。
// 用法：node scripts/screen-multiparam-v7.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';
import { packSide, evalIds } from './screen-multiparam-v3.mjs';

const COST = 0.4425;
const MAIN = 480, OOT = 240, WARM = 65;
const MIN_N = 100, HALF_MIN_N = 50, HIT_HALF = 75, HIT_OOT = 75, HIT_ALL = 80;
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

function rsiStep(st, d, p) {
  if (st.n < p) { st.g += d > 0 ? d : 0; st.l += d < 0 ? -d : 0; st.n++;
    if (st.n === p) { st.g /= p; st.l /= p; st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l); } return; }
  st.g = (st.g * (p - 1) + (d > 0 ? d : 0)) / p; st.l = (st.l * (p - 1) + (d < 0 ? -d : 0)) / p;
  st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l);
}

function build(days) {
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
    const todays = []; let bLoAll = 0, bHiAll = 0;
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const row = D.close[code]; if (!row || row.length < 5) continue;
      const [c, v, o, h, l] = row; if (!(c > 0)) continue;
      const st = (H[code] ||= { pc: null, cl: [], vl: [], tp: [], hh: [], ll: [], chgs: [],
        s5: { g: 0, l: 0, n: 0, v: null }, s10: { g: 0, l: 0, n: 0, v: null }, p5: null, p10: null,
        b1: null, b2: null,                          // 前一日/前二日 K 棒 {o,h,l,c}
        atr: null, pdm: null, ndm: null, adx: null, dxN: 0 });
      const pc = st.pc, b1 = st.b1, b2 = st.b2;
      if (pc != null) {
        st.p5 = st.s5.v; st.p10 = st.s10.v;
        rsiStep(st.s5, c - pc, 5); rsiStep(st.s10, c - pc, 10);
        // ATR / DMI / ADX（Wilder 14 流式）
        const tr = Math.max(h - l, Math.abs(h - (b1?.c ?? pc)), Math.abs(l - (b1?.c ?? pc)));
        st.atr = st.atr == null ? tr : (st.atr * 13 + tr) / 14;
        if (b1) {
          const up = h - b1.h, dn = b1.l - l;
          const pDM = up > dn && up > 0 ? up : 0, nDM = dn > up && dn > 0 ? dn : 0;
          st.pdm = st.pdm == null ? pDM : (st.pdm * 13 + pDM) / 14;
          st.ndm = st.ndm == null ? nDM : (st.ndm * 13 + nDM) / 14;
          if (st.atr > 0) {
            const pdi = st.pdm / st.atr * 100, ndi = st.ndm / st.atr * 100;
            const dx = pdi + ndi > 0 ? Math.abs(pdi - ndi) / (pdi + ndi) * 100 : 0;
            st.adx = st.adx == null ? dx : (st.adx * 13 + dx) / 14;
          }
        }
      }
      st.pc = c;
      const cl = st.cl, vl = st.vl, tp = st.tp;
      if (i >= WARM && pc > 0 && st.s5.v != null && st.p5 != null && cl.length >= 20) {
        const chg = (c - pc) / pc * 100;
        if (v >= 300 && chg <= 8.5) {
          if (st.s10.v < 20 && st.p10 < 20) bLoAll++;
          if (st.s10.v > 80 && st.p10 > 80) bHiAll++;
          let hi20 = 0, av20 = 0, hiIdx = 0;
          for (let k = 1; k <= 20; k++) {
            const x = cl[cl.length - k];
            if (x > hi20) { hi20 = x; hiIdx = k; }
            av20 += vl[vl.length - k] || 0;
          }
          av20 /= 20;
          const ma5 = (cl.slice(-4).reduce((s2, x) => s2 + x, 0) + c) / 5;
          const ma10 = (cl.slice(-9).reduce((s2, x) => s2 + x, 0) + c) / 10;
          const ma20 = (cl.slice(-19).reduce((s2, x) => s2 + x, 0) + c) / 20;
          const c5 = cl[cl.length - 5];
          // CCI20 / W%R14
          const tps = [...tp.slice(-19), (h + l + c) / 3];
          const tpm = avg(tps);
          const md = avg(tps.map(x => Math.abs(x - tpm)));
          const cci = md > 0 ? ((h + l + c) / 3 - tpm) / (0.015 * md) : 0;
          const hi14 = Math.max(...st.hh.slice(-13), h), lo14 = Math.min(...st.ll.slice(-13), l);
          const wpos = hi14 > lo14 ? (c - lo14) / (hi14 - lo14) * 100 : 50;
          // 20日漲停次數（近似：日漲 ≥9.4%）
          const lu20 = st.chgs.slice(-20).filter(x => x >= 9.4).length;
          // K 線組合（需 b1/b2）
          const body = Math.abs(c - o) / pc * 100;
          const white = c > o, black = c < o;
          let bullEng = false, bearEng = false, mStar = false, eStar = false, w3 = false, b3 = false;
          if (b1) {
            const pw = b1.c > b1.o, pb = b1.c < b1.o;
            bullEng = pb && white && o <= b1.c && c >= b1.o && body >= 1;
            bearEng = pw && black && o >= b1.c && c <= b1.o && body >= 1;
            if (b2) {
              const b2body = Math.abs(b2.c - b2.o) / b2.o * 100;
              const b1body = Math.abs(b1.c - b1.o) / b1.o * 100;
              mStar = b2.c < b2.o && b2body >= 2 && b1body < 0.6 && white && c > (b2.o + b2.c) / 2;
              eStar = b2.c > b2.o && b2body >= 2 && b1body < 0.6 && black && c < (b2.o + b2.c) / 2;
              w3 = white && pw && b2.c > b2.o && c > b1.c && b1.c > b2.c && body >= 1;
              b3 = black && pb && b2.c < b2.o && c < b1.c && b1.c < b2.c && body >= 1;
            }
          }
          const it1 = P?.inst?.[code];
          const f1 = it1 ? (it1[0] || 0) : null, t1 = it1 ? (it1[1] || 0) : null;
          let fSell = 0;
          for (let k = 1; k <= 10; k++) { const f = days[i - k]?.inst?.[code]?.[0]; if (f < 0) fSell++; else break; }
          const mg1 = P?.mg?.[code], mg6 = days[i - 6]?.mg?.[code];
          const sr1 = mg1 && (mg1[0] || 0) > 0 ? (mg1[1] || 0) / mg1[0] : null;
          const sr6 = mg6 && (mg6[0] || 0) > 0 ? (mg6[1] || 0) / mg6[0] : null;
          const lnLv = P?.ln?.[code] != null && av20 > 0 ? P.ln[code] / av20 : null;
          const f = n => { const d0 = days[i + n]?.close?.[code]; return d0 && d0[0] > 0 ? (d0[0] - c) / c * 100 - COST : null; };
          todays.push({
            di: i, code, r5: st.s5.v, r10: st.s10.v, p5: st.p5, p10: st.p10, chg, mkt,
            pos: h > l ? (c - l) / (h - l) : 0.5,
            volX: av20 > 0 ? v / av20 : null,
            ret5: c5 > 0 ? (c - c5) / c5 * 100 : null,
            p20: hi20 > 0 ? c / hi20 : null, ma20rel: (c / ma20 - 1) * 100,
            upSh: h > l ? (h - Math.max(o, c)) / (h - l) : 0, amp: (h - l) / pc * 100,
            fSell, f1lots: f1, lnLv,
            // ── 本輪新參數 ──
            adx: st.adx, cci, wpos, relAtr: st.atr != null ? st.atr / c * 100 : null,
            lu20, price: c, value: c * v * 1000,
            fMag: f1 != null && av20 > 0 ? f1 / av20 : null,      // 外資力道(佔均量)
            tMag: t1 != null && av20 > 0 ? t1 / av20 : null,      // 投信力道
            srUp5: sr1 != null && sr6 != null ? sr1 - sr6 : null, // 券資比5日變化
            tangle: (Math.max(ma5, ma10, ma20) - Math.min(ma5, ma10, ma20)) / c * 100,
            dHi20: hiIdx,                                          // 距20日高幾天前
            bullEng, bearEng, mStar, eStar, w3, b3,
            f5: f(5),
          });
        }
      }
      st.b2 = st.b1; st.b1 = { o, h, l, c };
      cl.push(c); vl.push(v || 0); tp.push((h + l + c) / 3);
      st.hh.push(h > 0 ? h : c); st.ll.push(l > 0 ? l : c); st.chgs.push(pc > 0 ? (c - pc) / pc * 100 : 0);
      if (cl.length > 30) { cl.shift(); vl.shift(); tp.shift(); st.hh.shift(); st.ll.shift(); st.chgs.shift(); }
    }
    for (const s of todays) { s.bLo = bLoAll; s.bHi = bHiAll; }
    S.push(...todays);
  }
  const mid = Math.floor(days.length / 2);
  for (const s of S) s.half = s.di < mid ? 0 : 1;
  return S;
}

const P_UP = [
  // 既有核心（供組合）
  ['RSI10連2日<25', 'rsi10', s => s.r10 < 25 && s.p10 < 25],
  ['5日跌>15%', 'ret5', s => s.ret5 != null && s.ret5 < -15],
  ['收位>0.7', 'pos', s => s.pos > 0.7],
  ['低於MA20>10%', 'ma20', s => s.ma20rel < -10],
  ['量比>1.5', 'volx', s => s.volX != null && s.volX > 1.5],
  ['外資連賣≥3', 'for', s => s.fSell >= 3],
  ['借券/均量>1', 'ln', s => s.lnLv != null && s.lnLv > 1],
  // 本輪新參數
  ['多方吞噬', 'eng', s => s.bullEng],
  ['晨星', 'star', s => s.mStar],
  ['三黑鴉(棄守)', 'k3', s => s.b3],
  ['ADX>30(強趨勢)', 'adx', s => s.adx != null && s.adx > 30],
  ['ADX<15(盤整)', 'adx', s => s.adx != null && s.adx < 15],
  ['CCI<-100', 'cci', s => s.cci < -100],
  ['W%R超賣(wpos<15)', 'wr', s => s.wpos < 15],
  ['相對ATR>5%', 'atr', s => s.relAtr != null && s.relAtr > 5],
  ['20日漲停≥2次(妖股)', 'lu', s => s.lu20 >= 2],
  ['20日無漲停', 'lu', s => s.lu20 === 0],
  ['股價<20', 'px', s => s.price < 20],
  ['股價>100', 'px', s => s.price > 100],
  ['成交值>10億', 'val', s => s.value > 1e9],
  ['外資昨買力道>3%均量', 'fmag', s => s.fMag != null && s.fMag > 0.03],
  ['外資昨賣力道>3%均量', 'fmag', s => s.fMag != null && s.fMag < -0.03],
  ['投信昨買力道>1%均量', 'tmag', s => s.tMag != null && s.tMag > 0.01],
  ['券資比5日上升>0.05', 'sr5', s => s.srUp5 != null && s.srUp5 > 0.05],
  ['MA糾結<1.5%', 'tgl', s => s.tangle < 1.5],
  ['距20日高≥15天', 'dhi', s => s.dHi20 >= 15],
];
const P_DN = [
  ['RSI5連2日>80', 'rsi5', s => s.r5 > 80 && s.p5 > 80],
  ['收位>0.9', 'pos', s => s.pos > 0.9],
  ['量比>5(爆量)', 'volx', s => s.volX != null && s.volX > 5],
  ['破20日高', 'brk', s => s.p20 != null && s.p20 >= 1],
  ['外資連賣≥3', 'for', s => s.fSell >= 3],
  ['借券/均量>1', 'ln', s => s.lnLv != null && s.lnLv > 1],
  ['5日漲>15%', 'ret5', s => s.ret5 != null && s.ret5 > 15],
  ['長上影', 'kup', s => s.upSh > 0.5 && s.amp >= 3],
  // 本輪新參數
  ['空方吞噬', 'eng', s => s.bearEng],
  ['夜星', 'star', s => s.eStar],
  ['三白兵(連三紅)', 'k3', s => s.w3],
  ['ADX>30(強趨勢)', 'adx', s => s.adx != null && s.adx > 30],
  ['CCI>150', 'cci', s => s.cci > 150],
  ['W%R超買(wpos>90)', 'wr', s => s.wpos > 90],
  ['相對ATR>5%', 'atr', s => s.relAtr != null && s.relAtr > 5],
  ['20日漲停≥2次(妖股)', 'lu', s => s.lu20 >= 2],
  ['20日漲停≥4次', 'lu', s => s.lu20 >= 4],
  ['股價<20', 'px', s => s.price < 20],
  ['成交值>10億', 'val', s => s.value > 1e9],
  ['外資昨賣力道>3%均量', 'fmag', s => s.fMag != null && s.fMag < -0.03],
  ['投信昨賣力道>1%均量', 'tmag', s => s.tMag != null && s.tMag < -0.01],
  ['券資比5日下降>0.05', 'sr5', s => s.srUp5 != null && s.srUp5 < -0.05],
  ['MA糾結<1.5%', 'tgl', s => s.tangle < 1.5],
  ['距20日高=當日(創高)', 'dhi', s => s.dHi20 <= 1],
];

const isOrdinary = s => s.mkt != null && Math.abs(s.mkt) < 2 && s.bLo <= 30 && s.bHi <= 30;

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 70 });
  const SM0 = build(all.slice(-(MAIN + WARM)));
  const SO0 = build(all.slice(0, OOT + WARM));
  const SM = SM0.filter(isOrdinary), SO = SO0.filter(isOrdinary);
  console.log('═'.repeat(120));
  console.log(`第七輪：最終缺席參數｜平常日主窗 ${SM.length.toLocaleString()}／OOT ${SO.length.toLocaleString()}（全樣本 ${SM0.length.toLocaleString()}／${SO0.length.toLocaleString()}）`);
  console.log('═'.repeat(120));

  for (const [sideName, pool, dir, target] of [['上漲判別', P_UP, 1, '翻案「平常日無結構」？'], ['下跌判別', P_DN, -1, '能否推高 68.5%/OOT 59.1%？']]) {
    const pkM = packSide(SM, pool), pkO = packSide(SO, pool);
    const pkMall = packSide(SM0, pool);
    const baseM = evalIds({ ...pkM, masks: [new Uint8Array(pkM.N).fill(1)] }, [0], dir);
    const baseO = evalIds({ ...pkO, masks: [new Uint8Array(pkO.N).fill(1)] }, [0], dir);
    console.log(`\n${'━'.repeat(120)}\n【${sideName}·平常日】基準 主窗 ${baseM.hit}%／OOT ${baseO.hit}%｜本側問題：${target}\n${'━'.repeat(120)}`);

    // 新參數單獨（平常日 + 全樣本對照）
    const NEW = new Set(['eng', 'star', 'k3', 'adx', 'cci', 'wr', 'atr', 'lu', 'px', 'val', 'fmag', 'tmag', 'sr5', 'tgl', 'dhi']);
    console.log('  🆕新參數單獨（平常日）：');
    for (let i = 0; i < pool.length; i++) {
      if (!NEW.has(pool[i][1])) continue;
      const m = evalIds(pkM, [i], dir);
      if (!m || m.n < MIN_N) { console.log(`    ${pad(pool[i][0], 30)} 樣本不足`); continue; }
      const o = evalIds(pkO, [i], dir);
      const ma = evalIds(pkMall, [i], dir);
      console.log(`    ${pad(pool[i][0], 30)} ${m.hit}%（${m.hit - baseM.hit >= 0 ? '+' : ''}${r2(m.hit - baseM.hit)}pp）·n=${m.n.toLocaleString()}·${m.days}天`
        + `｜OOT ${o && o.n >= 50 ? o.hit + '%' : '不足'}｜全樣本 ${ma ? ma.hit + '%' : '—'}`);
    }

    // 冗餘實測：CCI/W%R/ADX 疊在 RSI 上
    const rsiIdx = pool.findIndex(p => p[1] === 'rsi10' || p[1] === 'rsi5');
    console.log('\n  🔬冗餘實測（疊在 RSI 條件上的增量·平常日）：');
    const rsiOnly = evalIds(pkM, [rsiIdx], dir);
    if (rsiOnly) console.log(`    ${pad(pool[rsiIdx][0] + '（單獨）', 44)} ${rsiOnly.hit}%·n=${rsiOnly.n.toLocaleString()}`);
    for (const fam of ['cci', 'wr', 'adx']) {
      const j = pool.findIndex(p => p[1] === fam);
      if (j < 0) continue;
      const both = evalIds(pkM, [rsiIdx, j], dir);
      if (!both || both.n < MIN_N) { console.log(`    ${pad('+ ' + pool[j][0], 44)} 樣本不足`); continue; }
      console.log(`    ${pad('+ ' + pool[j][0], 44)} ${both.hit}%·n=${both.n.toLocaleString()}（增量 ${both.hit - rsiOnly.hit >= 0 ? '+' : ''}${r2(both.hit - rsiOnly.hit)}pp）`);
    }

    // 全組合搜尋（平常日）
    const combos = [];
    const np = pool.length;
    for (let i = 0; i < np; i++) {
      combos.push([i]);
      for (let j = i + 1; j < np; j++) {
        if (pool[i][1] === pool[j][1]) continue;
        combos.push([i, j]);
        for (let k = j + 1; k < np; k++) {
          if (pool[k][1] === pool[i][1] || pool[k][1] === pool[j][1]) continue;
          combos.push([i, j, k]);
        }
      }
    }
    const res = [];
    for (const ids of combos) {
      const m = evalIds(pkM, ids, dir);
      if (m && m.n >= MIN_N) res.push({ ids, m });
    }
    const label = ids => ids.map(i => pool[i][0]).join(' ∧ ');
    const stable = res.filter(r => Math.min(r.m.n0, r.m.n1) >= HALF_MIN_N && r.m.days >= 30)
      .sort((a, b) => b.m.hit - a.m.hit).slice(0, 8);
    console.log(`\n  ★平常日·觸發≥30天·前 8（掃 ${combos.length.toLocaleString()} 組）：`);
    for (const r of stable) {
      const o = evalIds(pkO, r.ids, dir);
      console.log(`    ${pad(label(r.ids), 60)} ${r.m.hit}%[${r.m.h0}/${r.m.h1}]·n=${r.m.n.toLocaleString()}·${r.m.days}天`
        + `｜OOT ${o && o.n >= 50 ? `${o.hit}%·n=${o.n}` : '不足'}｜均報 ${r2(r.m.ret)}%`);
    }
    const pass = res.filter(r => {
      const { m } = r;
      if (m.hit < HIT_ALL || m.n0 < HALF_MIN_N || m.n1 < HALF_MIN_N || m.h0 < HIT_HALF || m.h1 < HIT_HALF) return false;
      const o = evalIds(pkO, r.ids, dir);
      return o && o.n >= MIN_N && o.hit >= HIT_OOT;
    });
    console.log(`\n  ✅ 通過全部門檻：${pass.length} 組`);
    for (const p2 of pass.slice(0, 8)) console.log(`    ${label(p2.ids)}`);
    if (!pass.length) console.log('    （無）');
  }
  console.log(`\n${'═'.repeat(120)}\n非投資建議。\n${'═'.repeat(120)}`);
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
