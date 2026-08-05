#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 第三輪全參數搜尋：補齊缺席參數族 ＋ N-of-M 投票制  —— 2026-08-05
//
// 使用者問「還有哪些參數沒加上？價量？量比？」——盤點結果：
//   已有：量比(4切法)、收位、RSI、廣度、大盤、連跌、5日幅、MA乖離、20日位階、
//         法人t-1、資券、借券、當沖、長紅黑/上影/跳空
//   **本輪新增 10 族**：①波動率 vol20 ②均線排列(多頭/空頭 c-ma5-ma10-ma20)
//   ③相對強弱 RS(個股-大盤) ④下影線/錘子線 ⑤連紅連黑序列 ⑥60日位階
//   ⑦量價配合(量增價跌/量縮價穩) ⑧自營商 t-1 ⑨三法人合計 t-1 ⑩振幅
//   並新增組合結構：**N-of-M 投票**（滿足 M 個條件中的 ≥N 個）——
//   AND 會把樣本切到碎，投票制是使用者「多種複數參數」的另一種形狀。
//
// 門檻不變（硬防線）：n≥100 兩窗各自 · 主窗合併≥80%（本輪使用者目標 90% 另列）·
//   兩半窗各自≥75%（各 n≥50）· OOT≥75%。
// 另設「90% 檢查線」：任何主窗 ≥90% 者，一律附兩半窗與觸發日數檢查。
//
// 口徑：個股·可交易宇宙·扣 0.4425%·T日收盤·5日方向。籌碼 t-1。
// 用法：node scripts/screen-multiparam-v3.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';

const COST = 0.4425;
const MAIN = 480, OOT = 240, WARM = 65;
const MIN_N = 100, HALF_MIN_N = 50, HIT_HALF = 75, HIT_OOT = 75, HIT_ALL = 80;
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

function step(st, d, p) {
  if (st.n < p) { st.g += d > 0 ? d : 0; st.l += d < 0 ? -d : 0; st.n++;
    if (st.n === p) { st.g /= p; st.l /= p; st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l); } return; }
  st.g = (st.g * (p - 1) + (d > 0 ? d : 0)) / p; st.l = (st.l * (p - 1) + (d < 0 ? -d : 0)) / p;
  st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l);
}

export function build(days) {
  const S = [], H = {};
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
      const st = (H[code] ||= { pc: null, cl: [], vl: [], s5: { g: 0, l: 0, n: 0, v: null }, s10: { g: 0, l: 0, n: 0, v: null }, p5: null, p10: null, dn: 0, up: 0 });
      if (st.pc != null) {
        st.p5 = st.s5.v; st.p10 = st.s10.v;
        step(st.s5, c - st.pc, 5); step(st.s10, c - st.pc, 10);
        st.dn = c < st.pc ? st.dn + 1 : 0;
        st.up = c > st.pc ? st.up + 1 : 0;
      }
      const pc = st.pc, cl = st.cl, vl = st.vl;
      st.pc = c;
      if (i >= WARM && pc > 0 && st.s5.v != null && st.p5 != null && cl.length >= 60) {
        const chg = (c - pc) / pc * 100;
        if (v >= 300 && chg <= 8.5) {
          let hi20 = 0, hi60 = 0, av20 = 0;
          for (let k = 1; k <= 60; k++) { const x = cl[cl.length - k]; if (k <= 20) { if (x > hi20) hi20 = x; av20 += vl[vl.length - k] || 0; } if (x > hi60) hi60 = x; }
          av20 /= 20;
          const ma5 = (cl.slice(-4).reduce((s2, x) => s2 + x, 0) + c) / 5;
          const ma10 = (cl.slice(-9).reduce((s2, x) => s2 + x, 0) + c) / 10;
          const ma20 = (cl.slice(-19).reduce((s2, x) => s2 + x, 0) + c) / 20;
          const c5 = cl[cl.length - 5];
          // 波動率 vol20（日報酬標準差%）
          const rets = [];
          for (let k = 1; k < 21; k++) { const a = cl[cl.length - k] ?? c, b = cl[cl.length - k - 1]; if (a > 0 && b > 0) rets.push((a - b) / b * 100); }
          const m = avg(rets);
          const vol20 = rets.length >= 15 ? Math.sqrt(avg(rets.map(x => (x - m) ** 2))) : null;
          // 籌碼 t-1
          const it1 = P?.inst?.[code];
          const f1 = it1 ? (it1[0] || 0) : null, t1 = it1 ? (it1[1] || 0) : null, d1 = it1 ? (it1[2] || 0) : null;
          const tot1 = it1 ? (it1[0] || 0) + (it1[1] || 0) + (it1[2] || 0) : null;
          let fBuy = 0, fSell = 0;
          for (let k = 1; k <= 10; k++) { const f = days[i - k]?.inst?.[code]?.[0]; if (f > 0) fBuy++; else break; }
          for (let k = 1; k <= 10; k++) { const f = days[i - k]?.inst?.[code]?.[0]; if (f < 0) fSell++; else break; }
          const mg1 = P?.mg?.[code], mg2 = P2?.mg?.[code];
          const mgChg = mg1 && mg2 ? (mg1[0] || 0) - (mg2[0] || 0) : null;
          const sr = mg1 && (mg1[0] || 0) > 0 ? (mg1[1] || 0) / mg1[0] : null;
          const lnLv = P?.ln?.[code] != null && av20 > 0 ? P.ln[code] / av20 : null;
          const amp = h > l ? (h - l) / pc * 100 : 0;
          const pos = h > l ? (c - l) / (h - l) : 0.5;
          const f = n => { const d0 = days[i + n]?.close?.[code]; return d0 && d0[0] > 0 ? (d0[0] - c) / c * 100 - COST : null; };
          todays.push({
            di: i, r5: st.s5.v, r10: st.s10.v, p5: st.p5, p10: st.p10, chg, mkt,
            pos, amp, upSh: h > l ? (h - Math.max(o, c)) / (h - l) : 0, loSh: h > l ? (Math.min(o, c) - l) / (h - l) : 0,
            gapUp: o > pc * 1.01, volX: av20 > 0 ? v / av20 : null,
            ret5: c5 > 0 ? (c - c5) / c5 * 100 : null,
            p20: hi20 > 0 ? c / hi20 : null, p60: hi60 > 0 ? c / hi60 : null,
            ma5rel: (c / ma5 - 1) * 100, ma20rel: (c / ma20 - 1) * 100,
            bull: c > ma5 && ma5 > ma10 && ma10 > ma20, bear: c < ma5 && ma5 < ma10 && ma10 < ma20,
            dn: st.dn, up: st.up, rs: mkt != null ? chg - mkt : null, vol20,
            f1lots: f1, t1lots: t1, d1lots: d1, tot1, fBuy, fSell, mgChg, sr, lnLv,
            f5: f(5),
          });
        }
      }
      cl.push(c); vl.push(v || 0);
      if (cl.length > 65) { cl.shift(); vl.shift(); }
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

export const P_UP = [
  ['RSI10連2日<20', 'rsi10', s => s.r10 < 20 && s.p10 < 20],
  ['RSI10連2日<25', 'rsi10', s => s.r10 < 25 && s.p10 < 25],
  ['RSI5連2日<15', 'rsi5', s => s.r5 < 15 && s.p5 < 15],
  ['廣度>30檔', 'blo', s => s.bLo > 30],
  ['大盤跌>1%', 'mkt', s => s.mkt != null && s.mkt < -1],
  ['大盤跌>2%', 'mkt', s => s.mkt != null && s.mkt < -2],
  ['連跌≥3日', 'dn', s => s.dn >= 3],
  ['連跌≥5日', 'dn', s => s.dn >= 5],
  ['5日跌>10%', 'ret5', s => s.ret5 != null && s.ret5 < -10],
  ['5日跌>15%', 'ret5', s => s.ret5 != null && s.ret5 < -15],
  ['低於MA20>10%', 'ma20', s => s.ma20rel < -10],
  ['收位<0.3', 'pos', s => s.pos < 0.3],
  ['收位>0.7', 'pos', s => s.pos > 0.7],
  ['量比>1.5', 'volx', s => s.volX != null && s.volX > 1.5],
  ['量比>5(爆量)', 'volx', s => s.volX != null && s.volX > 5],
  ['量比<0.5(量縮)', 'volx', s => s.volX != null && s.volX < 0.5],
  ['外資昨買超', 'for', s => s.f1lots != null && s.f1lots > 0],
  ['外資連賣≥3', 'for', s => s.fSell >= 3],
  ['三法人合計昨買超', 'toti', s => s.tot1 != null && s.tot1 > 0],
  ['三法人合計昨賣超', 'toti', s => s.tot1 != null && s.tot1 < 0],
  ['自營商昨買超', 'dlr', s => s.d1lots != null && s.d1lots > 0],
  ['融資昨減', 'mgc', s => s.mgChg != null && s.mgChg < 0],
  ['券資比>0.2', 'sr', s => s.sr != null && s.sr > 0.2],
  ['借券/均量>1', 'ln', s => s.lnLv != null && s.lnLv > 1],
  // ── 新增族 ──
  ['高波動vol20>4%', 'v20', s => s.vol20 != null && s.vol20 > 4],
  ['低波動vol20<1.5%', 'v20', s => s.vol20 != null && s.vol20 < 1.5],
  ['空頭排列(c<5<10<20)', 'align', s => s.bear],
  ['多頭排列(c>5>10>20)', 'align', s => s.bull],
  ['RS弱(個股-大盤<-3%)', 'rs', s => s.rs != null && s.rs < -3],
  ['RS強(個股-大盤>3%)', 'rs', s => s.rs != null && s.rs > 3],
  ['錘子線(下影>50%·振幅3%↑)', 'klo', s => s.loSh > 0.5 && s.amp >= 3],
  ['長上影(>50%·振幅3%↑)', 'kup', s => s.upSh > 0.5 && s.amp >= 3],
  ['60日位階<0.7', 'p60', s => s.p60 != null && s.p60 < 0.7],
  ['量增價跌(跌2%↑×量比2↑)', 'pv', s => s.chg <= -2 && s.volX != null && s.volX > 2],
  ['量縮價穩(|漲跌|<1×量比<0.6)', 'pv', s => Math.abs(s.chg) < 1 && s.volX != null && s.volX < 0.6],
  ['振幅>7%', 'amp', s => s.amp > 7],
];
export const P_DN = [
  ['RSI10連2日>75', 'rsi10', s => s.r10 > 75 && s.p10 > 75],
  ['RSI5連2日>80', 'rsi5', s => s.r5 > 80 && s.p5 > 80],
  ['RSI5連2日>85', 'rsi5', s => s.r5 > 85 && s.p5 > 85],
  ['廣度(超買)>30檔', 'bhi', s => s.bHi > 30],
  ['大盤漲>1%', 'mkt', s => s.mkt != null && s.mkt > 1],
  ['大盤漲>2%', 'mkt', s => s.mkt != null && s.mkt > 2],
  ['5日漲>15%', 'ret5', s => s.ret5 != null && s.ret5 > 15],
  ['5日漲>20%', 'ret5', s => s.ret5 != null && s.ret5 > 20],
  ['高於MA20>15%', 'ma20', s => s.ma20rel > 15],
  ['高於MA5>5%', 'ma5', s => s.ma5rel > 5],
  ['收位>0.9', 'pos', s => s.pos > 0.9],
  ['量比>3', 'volx', s => s.volX != null && s.volX > 3],
  ['量比>5(爆量)', 'volx', s => s.volX != null && s.volX > 5],
  ['破20日高', 'brk', s => s.p20 != null && s.p20 >= 1],
  ['外資昨賣超', 'for', s => s.f1lots != null && s.f1lots < 0],
  ['外資連賣≥3', 'for', s => s.fSell >= 3],
  ['投信昨賣超', 'tru', s => s.t1lots != null && s.t1lots < 0],
  ['三法人合計昨賣超', 'toti', s => s.tot1 != null && s.tot1 < 0],
  ['自營商昨賣超', 'dlr', s => s.d1lots != null && s.d1lots < 0],
  ['融資昨增', 'mgc', s => s.mgChg != null && s.mgChg > 0],
  ['券資比>0.2', 'sr', s => s.sr != null && s.sr > 0.2],
  ['借券/均量>1', 'ln', s => s.lnLv != null && s.lnLv > 1],
  // ── 新增族 ──
  ['高波動vol20>4%', 'v20', s => s.vol20 != null && s.vol20 > 4],
  ['多頭排列(c>5>10>20)', 'align', s => s.bull],
  ['RS強(個股-大盤>3%)', 'rs', s => s.rs != null && s.rs > 3],
  ['連漲≥3日', 'uprun', s => s.up >= 3],
  ['連漲≥5日', 'uprun', s => s.up >= 5],
  ['長上影(>50%·振幅3%↑)', 'kup', s => s.upSh > 0.5 && s.amp >= 3],
  ['60日位階>0.98(60日高附近)', 'p60', s => s.p60 != null && s.p60 > 0.98],
  ['量增價漲(漲3%↑×量比3↑)', 'pv', s => s.chg >= 3 && s.volX != null && s.volX > 3],
  ['振幅>7%', 'amp', s => s.amp > 7],
];

export function packSide(S, pool) {
  const N = S.length;
  const sign = new Int8Array(N), half = new Uint8Array(N), ret = new Float32Array(N), di = new Int32Array(N);
  for (let k = 0; k < N; k++) {
    const v = S[k].f5;
    sign[k] = v == null ? 0 : v > 0 ? 1 : -1;
    half[k] = S[k].half; ret[k] = v == null ? 0 : v; di[k] = S[k].di;
  }
  const masks = pool.map(([, , fn]) => { const m = new Uint8Array(N); for (let k = 0; k < N; k++) m[k] = fn(S[k]) ? 1 : 0; return m; });
  return { N, sign, half, ret, di, masks };
}
export function evalIds(pk, ids, dir) {
  const { N, sign, half, ret, di, masks } = pk;
  const a = masks[ids[0]], b = ids[1] != null ? masks[ids[1]] : null,
    c = ids[2] != null ? masks[ids[2]] : null, d = ids[3] != null ? masks[ids[3]] : null;
  let n = 0, w = 0, sum = 0, n0 = 0, w0 = 0, n1 = 0, w1 = 0;
  const daySet = new Set();
  for (let k = 0; k < N; k++) {
    if (!a[k] || (b && !b[k]) || (c && !c[k]) || (d && !d[k])) continue;
    const s = sign[k]; if (!s) continue;
    const win = dir > 0 ? s > 0 : s < 0;
    n++; if (win) w++; sum += ret[k]; daySet.add(di[k]);
    if (half[k] === 0) { n0++; if (win) w0++; } else { n1++; if (win) w1++; }
  }
  if (!n) return null;
  return { n, hit: +(w / n * 100).toFixed(1), n0, n1, days: daySet.size,
    h0: n0 ? +(w0 / n0 * 100).toFixed(1) : null, h1: n1 ? +(w1 / n1 * 100).toFixed(1) : null, ret: sum / n };
}
/** N-of-M 投票：滿足 pool 子集中 ≥need 個 */
export function evalVote(pk, ids, need, dir) {
  const { N, sign, half, ret, di, masks } = pk;
  let n = 0, w = 0, sum = 0, n0 = 0, w0 = 0, n1 = 0, w1 = 0;
  const daySet = new Set();
  for (let k = 0; k < N; k++) {
    let cnt = 0;
    for (const id of ids) if (masks[id][k]) cnt++;
    if (cnt < need) continue;
    const s = sign[k]; if (!s) continue;
    const win = dir > 0 ? s > 0 : s < 0;
    n++; if (win) w++; sum += ret[k]; daySet.add(di[k]);
    if (half[k] === 0) { n0++; if (win) w0++; } else { n1++; if (win) w1++; }
  }
  if (!n) return null;
  return { n, hit: +(w / n * 100).toFixed(1), n0, n1, days: daySet.size,
    h0: n0 ? +(w0 / n0 * 100).toFixed(1) : null, h1: n1 ? +(w1 / n1 * 100).toFixed(1) : null, ret: sum / n };
}

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 70 });
  const SM = build(all.slice(-(MAIN + WARM)));
  const SO = build(all.slice(0, OOT + WARM));
  console.log('═'.repeat(122));
  console.log(`第三輪全參數搜尋（補 10 族＋投票制）｜主窗 ${SM.length.toLocaleString()}／OOT ${SO.length.toLocaleString()}`);
  console.log(`門檻：n≥${MIN_N} 兩窗各自 · 兩半窗各自≥${HIT_HALF}%(各n≥${HALF_MIN_N}) · OOT≥${HIT_OOT}%｜90% 檢查線另列`);
  console.log('═'.repeat(122));

  for (const [sideName, pool, dir] of [['上漲判別', P_UP, 1], ['下跌判別', P_DN, -1]]) {
    const pkM = packSide(SM, pool), pkO = packSide(SO, pool);
    const allMask = new Uint8Array(pkM.N).fill(1);
    const baseM = evalIds({ ...pkM, masks: [allMask] }, [0], dir);
    const baseO = evalIds({ ...pkO, masks: [new Uint8Array(pkO.N).fill(1)] }, [0], dir);
    console.log(`\n${'━'.repeat(122)}\n【${sideName}】基準：主窗 ${baseM.hit}%／OOT ${baseO.hit}%\n${'━'.repeat(122)}`);

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
    const seeds = res.filter(r => r.ids.length === 3 && Math.min(r.m.n0, r.m.n1) >= HALF_MIN_N)
      .sort((a, b) => b.m.hit - a.m.hit).slice(0, 80);
    for (const sd of seeds) {
      for (let k = 0; k < np; k++) {
        if (sd.ids.includes(k) || sd.ids.some(id => pool[id][1] === pool[k][1])) continue;
        const ids = [...sd.ids, k];
        const m = evalIds(pkM, ids, dir);
        if (m && m.n >= MIN_N) res.push({ ids, m });
      }
    }
    console.log(`  掃描 ${combos.length.toLocaleString()} 組（1~3參數全組合）＋4參數貪婪延伸｜樣本足夠 ${res.length.toLocaleString()} 組`);
    const label = ids => ids.map(i => pool[i][0]).join(' ∧ ');

    // 通過門檻 + 90% 線
    const pass = [], over90 = [];
    for (const r of res) {
      const { m } = r;
      const stableHalves = m.n0 >= HALF_MIN_N && m.n1 >= HALF_MIN_N && m.h0 >= HIT_HALF && m.h1 >= HIT_HALF;
      if (m.hit >= 90 && stableHalves) over90.push(r);
      if (m.hit < HIT_ALL || !stableHalves) continue;
      const o = evalIds(pkO, r.ids, dir);
      if (!o || o.n < MIN_N || o.hit < HIT_OOT) { r.o = o; continue; }
      pass.push({ ...r, o });
    }

    console.log(`\n  🎯90% 檢查線：主窗≥90% 且兩半窗皆過者 ${over90.length} 組——逐一附觸發日數與 OOT：`);
    over90.sort((a, b) => b.m.hit - a.m.hit);
    for (const r of over90.slice(0, 8)) {
      const o = evalIds(pkO, r.ids, dir);
      console.log(`    ${pad(label(r.ids), 72)}`);
      console.log(`      主窗 ${r.m.hit}%[${r.m.h0}/${r.m.h1}]·n=${r.m.n.toLocaleString()}·**觸發日 ${r.m.days} 天**`
        + `｜OOT ${o ? `${o.hit}%·n=${o.n}·${o.days}天` : '零觸發'}｜均報 ${r2(r.m.ret)}%`);
    }
    if (!over90.length) console.log('    （無）');

    const stable = res.filter(r => Math.min(r.m.n0, r.m.n1) >= HALF_MIN_N && r.m.days >= 30)
      .sort((a, b) => b.m.hit - a.m.hit).slice(0, 8);
    console.log(`\n  ★觸發日≥30 天（非事件集中）·主窗命中前 8，附 OOT：`);
    for (const r of stable) {
      const o = evalIds(pkO, r.ids, dir);
      console.log(`    ${pad(label(r.ids), 68)} ${r.m.hit}%[${r.m.h0}/${r.m.h1}]·n=${r.m.n.toLocaleString()}·${r.m.days}天`
        + `｜OOT ${o && o.n >= 50 ? `${o.hit}%·n=${o.n}` : '不足'}｜均報 ${r2(r.m.ret)}%`);
    }

    // N-of-M 投票：取主窗單參數命中前 10 為委員
    const singles = res.filter(r => r.ids.length === 1).sort((a, b) => b.m.hit - a.m.hit);
    const committee = singles.slice(0, 10).map(r => r.ids[0]);
    console.log(`\n  🗳️ N-of-M 投票制（委員＝單參數命中前10：${committee.map(i => pool[i][0]).join('、')}）`);
    for (const need of [4, 5, 6, 7, 8]) {
      const m = evalVote(pkM, committee, need, dir);
      if (!m || m.n < 50) { console.log(`    ≥${need} 票：樣本不足`); continue; }
      const o = evalVote(pkO, committee, need, dir);
      console.log(`    ≥${need} 票  主窗 ${m.hit}%[${m.h0 ?? '-'}/${m.h1 ?? '-'}]·n=${m.n.toLocaleString()}·${m.days}天`
        + `｜OOT ${o && o.n >= 30 ? `${o.hit}%·n=${o.n}` : '不足'}｜均報 ${r2(m.ret)}%`);
    }

    console.log(`\n  ✅ 通過全部門檻（含 OOT）：${pass.length} 組`);
    for (const p2 of pass.slice(0, 10)) {
      console.log(`    ${pad(label(p2.ids), 66)} 主窗 ${p2.m.hit}%[${p2.m.h0}/${p2.m.h1}]·n=${p2.m.n}·${p2.m.days}天`
        + `  OOT ${p2.o.hit}%·n=${p2.o.n}  均報 ${r2(p2.m.ret)}%`);
    }
    if (!pass.length) console.log('    （無）');
  }
  console.log(`\n${'═'.repeat(122)}\n觸發日數是關鍵欄位：n 大而天數少＝事件集中＝假解析度。非投資建議。\n${'═'.repeat(122)}`);
  process.exit(0);
};
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
