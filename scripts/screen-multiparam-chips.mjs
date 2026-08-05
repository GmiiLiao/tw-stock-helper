#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 全參數族多組合搜尋（含法人/資券/借券/當沖/K線）—— 2026-08-05
//
// 使用者指正：上一輪只掃了價量類參數。這次把 chipArchive 裡所有可用參數
// 全部納入，1~4 個參數的組合，找「聯動」並檢驗能否達到 80% 命中率。
//
// 參數族（每族多個切法）：
//   價量：RSI5/RSI10 連2日、廣度、大盤中位數、連跌、5日漲跌幅、MA乖離、
//         收位、量比、20日位階
//   法人：外資昨日買/賣超、外資連買/連賣天數、投信昨日、5日(外資+投信)佔均量比
//   資券：融資昨增/減、券資比、資餘/均量（回補天數）、昨券大增(軋空setup)
//   借券：借券餘/均量
//   當沖：當沖佔比
//   K線：長紅、長黑、長上影、跳空上開
//
// ⚠**PIT 鐵律**：籌碼類（法人/資券/借券）一律取 **t-1**——T86 約 15:00 才
//   公布，收盤進場時只知道昨天的。價量/K線/當沖比為當日收盤即知。
//   （與 bt-core buildSamples「chip 類=t-1、價量=當日收盤」同口徑）
//
// ⚠資料覆蓋誠實揭露：借券歷史約 185 日覆蓋、上櫃資券為部分回填——
//   相關條件在缺資料時視為「不觸發」，且 OOT 窗（最舊 240 日）的籌碼
//   覆蓋率低於主窗，OOT 樣本不足時如實顯示而非硬給數字。
//
// 通過門檻（與上一輪相同的硬防線）：
//   n≥100（主窗與 OOT 各自）· 主窗合併命中≥80% ·
//   **主窗兩個半窗各自≥75% 且各自 n≥50** · OOT≥75%
//   ——「兩半窗各自」是單一事件（如 2025-04 關稅崩盤）的照妖鏡。
//
// 口徑：個股·可交易宇宙（4碼·量≥300張·進場日漲幅≤8.5%）·扣 0.4425%·
//   T 日收盤進場·目標＝5 日方向。
// 用法：node scripts/screen-multiparam-chips.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';

const COST = 0.4425;
const MAIN = 480, OOT = 240, WARM = 30;
const MIN_N = 100, HALF_MIN_N = 50, HIT_MAIN_HALF = 75, HIT_OOT = 75, HIT_ALL = 80;

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
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

/** 建樣本：價量 + 籌碼(t-1) + K線 一次算齊 */
function build(days) {
  const S = [];
  const H = {};
  for (let i = 0; i < days.length; i++) {
    const D = days[i], P = days[i - 1], P2 = days[i - 2];
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
      const [c, v, o, h, l] = row; if (!(c > 0)) continue;
      const st = (H[code] ||= { pc: null, cl: [], vl: [], s5: { g: 0, l: 0, n: 0, v: null }, s10: { g: 0, l: 0, n: 0, v: null }, p5: null, p10: null, dn: 0 });
      if (st.pc != null) {
        st.p5 = st.s5.v; st.p10 = st.s10.v;
        step(st.s5, c - st.pc, 5); step(st.s10, c - st.pc, 10);
        st.dn = c < st.pc ? st.dn + 1 : 0;
      }
      const pc = st.pc, cl = st.cl, vl = st.vl;
      st.pc = c;
      const ready = i >= WARM && pc > 0 && st.s5.v != null && st.p5 != null && cl.length >= 20;
      if (ready) {
        const chg = (c - pc) / pc * 100;
        if (v >= 300 && chg <= 8.5) {
          let hi20 = 0, av20 = 0;
          for (let k = 1; k <= 20; k++) { const x = cl[cl.length - k]; if (x > hi20) hi20 = x; av20 += vl[vl.length - k] || 0; }
          av20 /= 20;
          const ma5 = (cl.slice(-4).reduce((s2, x) => s2 + x, 0) + c) / 5;
          const ma20 = (cl.slice(-19).reduce((s2, x) => s2 + x, 0) + c) / 20;
          const c5 = cl[cl.length - 5];
          // ── 籌碼（一律 t-1·PIT 安全）──
          const it1 = P?.inst?.[code];
          const f1 = it1 ? (it1[0] || 0) : null;          // 外資昨日淨買(張)
          const t1 = it1 ? (it1[1] || 0) : null;          // 投信昨日淨買
          let fBuy = 0, fSell = 0;
          for (let k = 1; k <= 10; k++) { const f = days[i - k]?.inst?.[code]?.[0]; if (f > 0) fBuy++; else break; }
          for (let k = 1; k <= 10; k++) { const f = days[i - k]?.inst?.[code]?.[0]; if (f < 0) fSell++; else break; }
          let inst5 = 0, has5 = false;
          for (let k = 1; k <= 5; k++) { const it = days[i - k]?.inst?.[code]; if (it) { inst5 += (it[0] || 0) + (it[1] || 0); has5 = true; } }
          const inst5R = has5 && av20 > 0 ? inst5 / av20 : null;
          const mg1 = P?.mg?.[code], mg2 = P2?.mg?.[code];
          const mgChg = mg1 && mg2 ? (mg1[0] || 0) - (mg2[0] || 0) : null;   // 融資昨增減
          const shChg = mg1 && mg2 ? (mg1[1] || 0) - (mg2[1] || 0) : null;   // 融券昨增減
          const vPrev = P?.close?.[code]?.[1] || 0;
          const sqz = shChg != null && vPrev > 0 ? shChg >= 0.005 * vPrev : null;  // 昨券增≥昨量0.5%
          const sr = mg1 && (mg1[0] || 0) > 0 ? (mg1[1] || 0) / mg1[0] : null;     // 券資比
          const mgLv = mg1 && av20 > 0 ? (mg1[0] || 0) / av20 : null;              // 資餘/均量
          const lnLv = P?.ln?.[code] != null && av20 > 0 ? P.ln[code] / av20 : null;
          const dtR = D.dt?.[code] != null && v > 0 ? D.dt[code] / v * 100 : null; // 當沖比(當日收盤即知)
          // ── K 線（當日）──
          const amp = h > l ? (h - l) / pc * 100 : 0;
          const pos = h > l ? (c - l) / (h - l) : 0.5;
          const upSh = h > l ? (h - Math.max(o, c)) / (h - l) : 0;
          const f = n => { const d = days[i + n]?.close?.[code]; return d && d[0] > 0 ? (d[0] - c) / c * 100 - COST : null; };
          todays.push({
            di: i, r5: st.s5.v, r10: st.s10.v, p5: st.p5, p10: st.p10,
            chg, mkt, pos, amp, upSh, gapUp: o > pc * 1.01,
            volX: av20 > 0 ? v / av20 : null,
            ret5: c5 > 0 ? (c - c5) / c5 * 100 : null,
            posture: hi20 > 0 ? c / hi20 : null,
            ma5rel: (c / ma5 - 1) * 100, ma20rel: (c / ma20 - 1) * 100, dn: st.dn,
            f1lots: f1, t1lots: t1, fBuy, fSell, inst5R, mgChg, sqz, sr, mgLv, lnLv, dtR,
            f5: f(5),
          });
        }
      }
      cl.push(c); vl.push(v || 0);
      if (cl.length > 40) { cl.shift(); vl.shift(); }
    }
    const bLo = todays.filter(s => s.r10 < 20 && s.p10 < 20).length;
    const bHi = todays.filter(s => s.r10 > 80 && s.p10 > 80).length;
    for (const s of todays) { s.bLo = bLo; s.bHi = bHi; }
    S.push(...todays);
  }
  const mid = Math.floor(days.length / 2);
  for (const s of S) s.half = s.di < mid ? 0 : 1;
  return S;
}

// ── 候選條件（fam＝同族不互相組合，避免「廣度>30 ∧ 廣度>100」這種假組合）──
const P_UP = [
  ['RSI10連2日<20', 'rsi10', s => s.r10 < 20 && s.p10 < 20],
  ['RSI10連2日<25', 'rsi10', s => s.r10 < 25 && s.p10 < 25],
  ['RSI5連2日<15', 'rsi5', s => s.r5 < 15 && s.p5 < 15],
  ['RSI5連2日<20', 'rsi5', s => s.r5 < 20 && s.p5 < 20],
  ['廣度>30檔', 'blo', s => s.bLo > 30],
  ['廣度>100檔', 'blo', s => s.bLo > 100],
  ['大盤跌>1%', 'mkt', s => s.mkt != null && s.mkt < -1],
  ['大盤跌>2%', 'mkt', s => s.mkt != null && s.mkt < -2],
  ['連跌≥3日', 'dn', s => s.dn >= 3],
  ['5日跌>10%', 'ret5', s => s.ret5 != null && s.ret5 < -10],
  ['5日跌>15%', 'ret5', s => s.ret5 != null && s.ret5 < -15],
  ['低於MA20>10%', 'ma20', s => s.ma20rel < -10],
  ['收位<0.3', 'pos', s => s.pos < 0.3],
  ['收位>0.7', 'pos', s => s.pos > 0.7],
  ['量比>1.5', 'volx', s => s.volX != null && s.volX > 1.5],
  ['量比<0.7', 'volx', s => s.volX != null && s.volX < 0.7],
  ['外資昨買超', 'for', s => s.f1lots != null && s.f1lots > 0],
  ['外資連買≥3', 'for', s => s.fBuy >= 3],
  ['外資連賣≥3', 'for', s => s.fSell >= 3],
  ['投信昨買超', 'tru', s => s.t1lots != null && s.t1lots > 0],
  ['5日法人買佔均量>10%', 'i5', s => s.inst5R != null && s.inst5R > 0.1],
  ['5日法人賣佔均量>10%', 'i5', s => s.inst5R != null && s.inst5R < -0.1],
  ['融資昨增', 'mgc', s => s.mgChg != null && s.mgChg > 0],
  ['融資昨減', 'mgc', s => s.mgChg != null && s.mgChg < 0],
  ['券資比>0.2', 'sr', s => s.sr != null && s.sr > 0.2],
  ['資餘/均量>3', 'mglv', s => s.mgLv != null && s.mgLv > 3],
  ['借券/均量>1', 'ln', s => s.lnLv != null && s.lnLv > 1],
  ['昨券大增(軋空setup)', 'sqz', s => s.sqz === true],
  ['當沖比>30%', 'dt', s => s.dtR != null && s.dtR > 30],
  ['長紅K(漲3%↑收位0.8↑)', 'kred', s => s.chg >= 3 && s.pos >= 0.8],
  ['長黑K(跌3%↑收位0.2↓)', 'kblk', s => s.chg <= -3 && s.pos <= 0.2],
  ['長上影(>50%振幅·振幅3%↑)', 'kush', s => s.upSh > 0.5 && s.amp >= 3],
  ['跳空上開>1%', 'kgap', s => s.gapUp],
];
const P_DN = [
  ['RSI10連2日>75', 'rsi10', s => s.r10 > 75 && s.p10 > 75],
  ['RSI10連2日>80', 'rsi10', s => s.r10 > 80 && s.p10 > 80],
  ['RSI5連2日>80', 'rsi5', s => s.r5 > 80 && s.p5 > 80],
  ['RSI5連2日>85', 'rsi5', s => s.r5 > 85 && s.p5 > 85],
  ['廣度(超買)>10檔', 'bhi', s => s.bHi > 10],
  ['廣度(超買)>30檔', 'bhi', s => s.bHi > 30],
  ['大盤漲>1%', 'mkt', s => s.mkt != null && s.mkt > 1],
  ['大盤漲>2%', 'mkt', s => s.mkt != null && s.mkt > 2],
  ['5日漲>15%', 'ret5', s => s.ret5 != null && s.ret5 > 15],
  ['5日漲>20%', 'ret5', s => s.ret5 != null && s.ret5 > 20],
  ['高於MA20>15%', 'ma20', s => s.ma20rel > 15],
  ['高於MA5>5%', 'ma5', s => s.ma5rel > 5],
  ['收位>0.9', 'pos', s => s.pos > 0.9],
  ['收位<0.3', 'pos', s => s.pos < 0.3],
  ['量比>2', 'volx', s => s.volX != null && s.volX > 2],
  ['量比>3', 'volx', s => s.volX != null && s.volX > 3],
  ['破20日高', 'brk', s => s.posture != null && s.posture >= 1],
  ['外資昨賣超', 'for', s => s.f1lots != null && s.f1lots < 0],
  ['外資連賣≥3', 'for', s => s.fSell >= 3],
  ['外資昨買超', 'for', s => s.f1lots != null && s.f1lots > 0],
  ['投信昨賣超', 'tru', s => s.t1lots != null && s.t1lots < 0],
  ['5日法人賣佔均量>10%', 'i5', s => s.inst5R != null && s.inst5R < -0.1],
  ['融資昨增', 'mgc', s => s.mgChg != null && s.mgChg > 0],
  ['散戶接棒(融資增∧外資賣)', 'ret', s => s.mgChg != null && s.mgChg > 0 && s.f1lots != null && s.f1lots < 0],
  ['券資比>0.2', 'sr', s => s.sr != null && s.sr > 0.2],
  ['資餘/均量>3', 'mglv', s => s.mgLv != null && s.mgLv > 3],
  ['借券/均量>1', 'ln', s => s.lnLv != null && s.lnLv > 1],
  ['昨券大增', 'sqz', s => s.sqz === true],
  ['當沖比>40%', 'dt', s => s.dtR != null && s.dtR > 40],
  ['長上影(>50%振幅·振幅3%↑)', 'kush', s => s.upSh > 0.5 && s.amp >= 3],
  ['長黑K', 'kblk', s => s.chg <= -3 && s.pos <= 0.2],
  ['長紅K', 'kred', s => s.chg >= 3 && s.pos >= 0.8],
  ['跳空上開>1%', 'kgap', s => s.gapUp],
];

/** 打包成 typed arrays 以便大量組合掃描 */
function packSide(S, pool) {
  const N = S.length;
  const sign = new Int8Array(N), half = new Uint8Array(N), ret = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const v = S[k].f5;
    sign[k] = v == null ? 0 : v > 0 ? 1 : -1;
    half[k] = S[k].half; ret[k] = v == null ? 0 : v;
  }
  const masks = pool.map(([, , fn]) => {
    const m = new Uint8Array(N);
    for (let k = 0; k < N; k++) m[k] = fn(S[k]) ? 1 : 0;
    return m;
  });
  return { N, sign, half, ret, masks };
}

function evalIds(pk, ids, dir) {
  const { N, sign, half, ret, masks } = pk;
  const a = masks[ids[0]], b = ids[1] != null ? masks[ids[1]] : null,
    c = ids[2] != null ? masks[ids[2]] : null, d = ids[3] != null ? masks[ids[3]] : null;
  let n = 0, w = 0, sum = 0, n0 = 0, w0 = 0, n1 = 0, w1 = 0;
  for (let k = 0; k < N; k++) {
    if (!a[k] || (b && !b[k]) || (c && !c[k]) || (d && !d[k])) continue;
    const s = sign[k]; if (!s) continue;
    const win = dir > 0 ? s > 0 : s < 0;
    n++; if (win) w++; sum += ret[k];
    if (half[k] === 0) { n0++; if (win) w0++; } else { n1++; if (win) w1++; }
  }
  if (!n) return null;
  return { n, hit: +(w / n * 100).toFixed(1), n0, n1,
    h0: n0 ? +(w0 / n0 * 100).toFixed(1) : null, h1: n1 ? +(w1 / n1 * 100).toFixed(1) : null,
    ret: sum / n };
}

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 40 });
  const SM = build(all.slice(-(MAIN + WARM)));
  const SO = build(all.slice(0, OOT + WARM));
  console.log('═'.repeat(120));
  console.log(`全參數族組合搜尋（含法人/資券/借券/當沖/K線）｜主窗樣本 ${SM.length.toLocaleString()}／OOT ${SO.length.toLocaleString()}`);
  console.log(`門檻：n≥${MIN_N}（兩窗各自）· 主窗合併≥${HIT_ALL}% · 兩半窗各自≥${HIT_MAIN_HALF}%（各 n≥${HALF_MIN_N}）· OOT≥${HIT_OOT}%`);
  console.log('籌碼類一律 t-1（PIT）；借券覆蓋約 185 日、上櫃資券部分回填——缺資料＝不觸發');
  console.log('═'.repeat(120));

  for (const [sideName, pool, dir] of [['上漲判別', P_UP, 1], ['下跌判別', P_DN, -1]]) {
    const pkM = packSide(SM, pool), pkO = packSide(SO, pool);
    const baseM = evalIds({ ...pkM, masks: [new Uint8Array(pkM.N).fill(1)] }, [0], dir);
    const baseO = evalIds({ ...pkO, masks: [new Uint8Array(pkO.N).fill(1)] }, [0], dir);
    console.log(`\n${'━'.repeat(120)}\n【${sideName}】基準命中：主窗 ${baseM.hit}%／OOT ${baseO.hit}%\n${'━'.repeat(120)}`);

    // 1~3 參數全組合（同族跳過）
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
    // 4 參數：從「兩半窗皆 n≥50」的前 60 名延伸（貪婪·如實標註）
    const seeds = res.filter(r => r.ids.length === 3 && Math.min(r.m.n0, r.m.n1) >= HALF_MIN_N)
      .sort((a, b) => b.m.hit - a.m.hit).slice(0, 60);
    let four = 0;
    for (const sd of seeds) {
      for (let k = 0; k < np; k++) {
        if (sd.ids.includes(k)) continue;
        if (sd.ids.some(id => pool[id][1] === pool[k][1])) continue;
        const ids = [...sd.ids, k];
        const m = evalIds(pkM, ids, dir);
        four++;
        if (m && m.n >= MIN_N) res.push({ ids, m });
      }
    }
    console.log(`  掃描：1~3 參數 ${combos.length.toLocaleString()} 組（全組合）＋ 4 參數 ${four.toLocaleString()} 組（前60名貪婪延伸）`
      + `｜樣本足夠 ${res.length.toLocaleString()} 組`);

    const label = ids => ids.map(i => pool[i][0]).join(' ∧ ');

    // 通過全部門檻者（含 OOT）
    const pass = [];
    for (const r of res) {
      const { m } = r;
      if (m.hit < HIT_ALL || m.n0 < HALF_MIN_N || m.n1 < HALF_MIN_N || m.h0 < HIT_MAIN_HALF || m.h1 < HIT_MAIN_HALF) continue;
      const o = evalIds(pkO, r.ids, dir);
      if (!o || o.n < MIN_N || o.hit < HIT_OOT) { r.oFail = o; continue; }
      pass.push({ ...r, o });
    }

    // 兩半窗皆穩者 top（不論 80%），附 OOT
    const stable = res.filter(r => Math.min(r.m.n0, r.m.n1) >= HALF_MIN_N)
      .sort((a, b) => b.m.hit - a.m.hit).slice(0, 10);
    console.log('\n  ★兩半窗皆有樣本（非單一事件）·主窗命中前 10，附 OOT：');
    console.log('  ' + pad('條件組合', 66) + padL('n', 7) + padL('主窗', 7) + padL('兩半窗', 13) + padL('OOT', 8) + padL('OOTn', 7) + padL('5日均報', 9));
    console.log('  ' + '─'.repeat(117));
    for (const r of stable) {
      const o = evalIds(pkO, r.ids, dir);
      console.log('  ' + pad(label(r.ids), 66) + padL(r.m.n.toLocaleString(), 7) + padL(`${r.m.hit}%`, 7)
        + padL(`${r.m.h0}/${r.m.h1}`, 13)
        + padL(o && o.n >= 50 ? `${o.hit}%` : '不足', 8) + padL(o ? o.n.toLocaleString() : '-', 7)
        + padL(`${r2(r.m.ret)}%`, 9));
    }

    // 聯動（synergy）：配對命中 − 兩個單獨的最大值（皆需兩半窗有樣本）
    const singles = new Map();
    for (const r of res) if (r.ids.length === 1) singles.set(r.ids[0], r.m);
    const syn = [];
    for (const r of res) {
      if (r.ids.length !== 2 || Math.min(r.m.n0, r.m.n1) < HALF_MIN_N) continue;
      const a = singles.get(r.ids[0]), b = singles.get(r.ids[1]);
      if (!a || !b) continue;
      syn.push({ r, gain: +(r.m.hit - Math.max(a.hit, b.hit)).toFixed(1) });
    }
    syn.sort((x, y) => y.gain - x.gain);
    console.log('\n  🔗參數聯動 top 8（配對命中 − 單獨最佳，兩半窗皆有樣本）：');
    for (const s of syn.slice(0, 8)) {
      console.log(`    ${pad(label(s.r.ids), 60)} 聯動 +${s.gain}pp → 配對 ${s.r.m.hit}%·n=${s.r.m.n.toLocaleString()}`);
    }

    console.log(`\n  ✅ 通過全部門檻（含 OOT≥${HIT_OOT}%·n≥${MIN_N}）：${pass.length} 組`);
    for (const p of pass.slice(0, 12)) {
      console.log(`    ${pad(label(p.ids), 62)} 主窗 ${p.m.hit}%[${p.m.h0}/${p.m.h1}]·n=${p.m.n}`
        + `  OOT ${p.o.hit}%·n=${p.o.n}  均報 ${r2(p.m.ret)}%`);
    }
    if (!pass.length) console.log('    （無）');
  }

  console.log(`\n${'═'.repeat(120)}\n判讀提醒：掃描逾萬組合，未過「兩半窗各自＋OOT」者一律視為多重檢定產物。非投資建議。\n${'═'.repeat(120)}`);
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
