#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 第四輪：0050 成分股宇宙 × 最後一批缺席參數  —— 2026-08-05
//
// 使用者指定：①補上所有還沒加入的參數 ②標的改 0050 成分 50 檔·近 3 年。
//
// **本輪新增 12 族（至此參數空間收攏）**：
//   MACD(OSC翻正負/金叉死叉)、KD(金叉死叉/K>90/K<20連2/高檔鈍化)、
//   季線MA60與乖離60、破20/60日低（先前只有高的一側）、
//   量能結構(量5/量20·OBV5方向·連續量增)、投信連買連賣、券回補、
//   跳空下開、量價背離(價漲量縮)、當沖比>50%
// **仍缺席者與理由（誠實揭露）**：週轉率(chipArchive 無發行股數)、
//   DMI/ADX/CCI/W%R(與 RSI/KD 高度冗餘·加入只會增加多重檢定)、
//   bookDepth(歷史約1個月)、5分K盤中結構(僅60日+·當沖模式資料閘門管轄)。
//
// ⚠**存活者偏誤揭露**：成分名單取自今日 etfInfluence 快照——3 年前的成分
//   與今日不同（0050 汰換率低·偏誤溫和），無歷史成分資料可修正，如實聲明。
// ⚠**0050 宇宙的統計特性**：50 檔高度相關的大型權值股。「觸發日數」欄位
//   比全市場版更關鍵——50 檔一起觸發＝1 個等效事件，不是 50 個樣本。
//
// 口徑：0050 成分 50 檔·近 3 年（chipArchive 822 日全用：主窗 480＋OOT 240）·
//   扣 0.4425%·T日收盤·5日方向。市場級變數（廣度/大盤中位數）仍用全市場算。
// 用法：node scripts/screen-multiparam-0050.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';
import { packSide, evalIds, evalVote } from './screen-multiparam-v3.mjs';

const COST = 0.4425;
const MAIN = 480, OOT = 240, WARM = 65;
const MIN_N = 100, HALF_MIN_N = 50, HIT_HALF = 75, HIT_OOT = 75, HIT_ALL = 80;
const CODES = new Set('2330,2454,2308,2317,3711,2383,2881,3037,2408,2303,2882,1303,2345,2891,6949,2327,7769,2382,6669,3017,2412,2885,2059,2887,2360,2344,2886,8046,6505,3653,2357,2884,3231,2880,3008,3443,2301,2890,6446,2395,4958,2883,2892,2368,3665,2603,3189,5880,1216,3045'.split(','));

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
    const D = days[i], P = days[i - 1], P2 = days[i - 2];
    // 市場級變數：一律用**全市場**算（市場狀態不因研究宇宙縮小而改變）
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
      const st = (H[code] ||= { pc: null, cl: [], vl: [], hh: [], ll: [],
        s5: { g: 0, l: 0, n: 0, v: null }, s10: { g: 0, l: 0, n: 0, v: null }, p5: null, p10: null,
        e12: null, e26: null, dea: null, pOsc: null, pDif: null, pDea: null,
        K: 50, Dv: 50, pK: null, pD: null, dn: 0, up: 0, volUp: 0 });
      if (st.pc != null) {
        st.p5 = st.s5.v; st.p10 = st.s10.v;
        rsiStep(st.s5, c - st.pc, 5); rsiStep(st.s10, c - st.pc, 10);
        st.dn = c < st.pc ? st.dn + 1 : 0; st.up = c > st.pc ? st.up + 1 : 0;
        const pv = st.vl[st.vl.length - 1];
        st.volUp = pv != null && v > pv ? st.volUp + 1 : 0;             // 連續量增天數
      }
      // MACD（EMA 流式）
      st.pDif = st.e12 != null && st.e26 != null ? st.e12 - st.e26 : null;
      st.pDea = st.dea;
      st.e12 = st.e12 == null ? c : st.e12 + 2 / 13 * (c - st.e12);
      st.e26 = st.e26 == null ? c : st.e26 + 2 / 27 * (c - st.e26);
      const dif = st.e12 - st.e26;
      st.dea = st.dea == null ? dif : st.dea + 2 / 10 * (dif - st.dea);
      const osc = dif - st.dea;
      // KD(9)
      st.pK = st.K; st.pD = st.Dv;
      const hh9 = [...st.hh.slice(-8), h], ll9 = [...st.ll.slice(-8), l];
      const hi9 = Math.max(...hh9), lo9 = Math.min(...ll9);
      const rsv = hi9 > lo9 ? (c - lo9) / (hi9 - lo9) * 100 : 50;
      st.K = st.K * 2 / 3 + rsv / 3; st.Dv = st.Dv * 2 / 3 + st.K / 3;

      const pc = st.pc, cl = st.cl, vl = st.vl;
      st.pc = c;
      const inUniverse = CODES.has(code);
      if (i >= WARM && pc > 0 && st.s5.v != null && st.p5 != null && cl.length >= 60) {
        const chg = (c - pc) / pc * 100;
        if (v >= 300 && chg <= 8.5) {
          if (st.s10.v < 20 && st.p10 < 20) bLoAll++;
          if (st.s10.v > 80 && st.p10 > 80) bHiAll++;
          if (inUniverse) {
            let hi20 = 0, hi60 = 0, lo20 = Infinity, lo60 = Infinity, av20 = 0, av5 = 0;
            for (let k = 1; k <= 60; k++) {
              const x = cl[cl.length - k];
              if (k <= 5) av5 += vl[vl.length - k] || 0;
              if (k <= 20) { if (x > hi20) hi20 = x; if (x < lo20) lo20 = x; av20 += vl[vl.length - k] || 0; }
              if (x > hi60) hi60 = x; if (x < lo60) lo60 = x;
            }
            av20 /= 20; av5 /= 5;
            const ma5 = (cl.slice(-4).reduce((s2, x) => s2 + x, 0) + c) / 5;
            const ma10 = (cl.slice(-9).reduce((s2, x) => s2 + x, 0) + c) / 10;
            const ma20 = (cl.slice(-19).reduce((s2, x) => s2 + x, 0) + c) / 20;
            const ma60 = (cl.slice(-59).reduce((s2, x) => s2 + x, 0) + c) / 60;
            const c5 = cl[cl.length - 5];
            // OBV5：近5日 上漲日量合 − 下跌日量合
            let obv5 = 0;
            for (let k = 1; k <= 5; k++) {
              const a = cl[cl.length - k] ?? c, b = cl[cl.length - k - 1];
              if (a != null && b != null) obv5 += (a > b ? 1 : a < b ? -1 : 0) * (vl[vl.length - k] || 0);
            }
            const it1 = P?.inst?.[code];
            const f1 = it1 ? (it1[0] || 0) : null, t1 = it1 ? (it1[1] || 0) : null;
            const tot1 = it1 ? (it1[0] || 0) + (it1[1] || 0) + (it1[2] || 0) : null;
            let fBuy = 0, fSell = 0, tBuy = 0, tSell = 0;
            for (let k = 1; k <= 10; k++) { const f = days[i - k]?.inst?.[code]?.[0]; if (f > 0) fBuy++; else break; }
            for (let k = 1; k <= 10; k++) { const f = days[i - k]?.inst?.[code]?.[0]; if (f < 0) fSell++; else break; }
            for (let k = 1; k <= 10; k++) { const t = days[i - k]?.inst?.[code]?.[1]; if (t > 0) tBuy++; else break; }
            for (let k = 1; k <= 10; k++) { const t = days[i - k]?.inst?.[code]?.[1]; if (t < 0) tSell++; else break; }
            const mg1 = P?.mg?.[code], mg2 = P2?.mg?.[code];
            const mgChg = mg1 && mg2 ? (mg1[0] || 0) - (mg2[0] || 0) : null;
            const shChg = mg1 && mg2 ? (mg1[1] || 0) - (mg2[1] || 0) : null;
            const vPrev = P?.close?.[code]?.[1] || 0;
            const lnLv = P?.ln?.[code] != null && av20 > 0 ? P.ln[code] / av20 : null;
            const dtR = D.dt?.[code] != null && v > 0 ? D.dt[code] / v * 100 : null;
            const amp = h > l ? (h - l) / pc * 100 : 0;
            const rets = [];
            for (let k = 1; k < 21; k++) { const a = cl[cl.length - k] ?? c, b = cl[cl.length - k - 1]; if (a > 0 && b > 0) rets.push((a - b) / b * 100); }
            const m = avg(rets);
            const vol20 = rets.length >= 15 ? Math.sqrt(avg(rets.map(x => (x - m) ** 2))) : null;
            const f = n => { const d0 = days[i + n]?.close?.[code]; return d0 && d0[0] > 0 ? (d0[0] - c) / c * 100 - COST : null; };
            todays.push({
              di: i, code, r5: st.s5.v, r10: st.s10.v, p5: st.p5, p10: st.p10, chg, mkt,
              pos: h > l ? (c - l) / (h - l) : 0.5, amp,
              upSh: h > l ? (h - Math.max(o, c)) / (h - l) : 0, loSh: h > l ? (Math.min(o, c) - l) / (h - l) : 0,
              gapUp: o > pc * 1.01, gapDn: o < pc * 0.99,
              volX: av20 > 0 ? v / av20 : null, v520: av20 > 0 ? av5 / av20 : null, volUp: st.volUp,
              obvPos: obv5 > 0,
              ret5: c5 > 0 ? (c - c5) / c5 * 100 : null,
              p20: hi20 > 0 ? c / hi20 : null, p60: hi60 > 0 ? c / hi60 : null,
              brkLo20: lo20 < Infinity && c < lo20, brkLo60: lo60 < Infinity && c < lo60,
              ma5rel: (c / ma5 - 1) * 100, ma20rel: (c / ma20 - 1) * 100, ma60rel: (c / ma60 - 1) * 100,
              aboveMA60: c > ma60,
              bull: c > ma5 && ma5 > ma10 && ma10 > ma20, bear: c < ma5 && ma5 < ma10 && ma10 < ma20,
              dn: st.dn, up: st.up, rs: mkt != null ? chg - mkt : null, vol20,
              osc, oscUpX: st.pOsc != null && st.pOsc <= 0 && osc > 0, oscDnX: st.pOsc != null && st.pOsc >= 0 && osc < 0,
              macdGX: st.pDif != null && st.pDea != null && st.pDif <= st.pDea && dif > st.dea,
              macdDX: st.pDif != null && st.pDea != null && st.pDif >= st.pDea && dif < st.dea,
              K: st.K, Dv: st.Dv, kdGX: st.pK != null && st.pK <= st.pD && st.K > st.Dv,
              kdDX: st.pK != null && st.pK >= st.pD && st.K < st.Dv,
              kLo2: st.K < 20 && st.pK != null && st.pK < 20, kHi2: st.K > 80 && st.pK != null && st.pK > 80,
              f1lots: f1, t1lots: t1, tot1, fBuy, fSell, tBuy, tSell, mgChg,
              shCover: shChg != null && vPrev > 0 ? shChg <= -0.005 * vPrev : null,   // 券大減=回補
              shSurge: shChg != null && vPrev > 0 ? shChg >= 0.005 * vPrev : null,
              lnLv, dtR,
              f5: f(5),
            });
          }
        }
      }
      st.pOsc = osc;
      cl.push(c); vl.push(v || 0); st.hh.push(h > 0 ? h : c); st.ll.push(l > 0 ? l : c);
      if (cl.length > 65) { cl.shift(); vl.shift(); st.hh.shift(); st.ll.shift(); }
    }
    for (const s of todays) { s.bLo = bLoAll; s.bHi = bHiAll; }
    S.push(...todays);
  }
  const mid = Math.floor(days.length / 2);
  for (const s of S) s.half = s.di < mid ? 0 : 1;
  return S;
}

// ── 條件池：既有全家族 ＋ 本輪 12 新族 ──
const P_UP = [
  ['RSI10連2日<25', 'rsi10', s => s.r10 < 25 && s.p10 < 25],
  ['RSI10連2日<30', 'rsi10', s => s.r10 < 30 && s.p10 < 30],
  ['RSI5連2日<20', 'rsi5', s => s.r5 < 20 && s.p5 < 20],
  ['廣度>30檔', 'blo', s => s.bLo > 30],
  ['大盤跌>1%', 'mkt', s => s.mkt != null && s.mkt < -1],
  ['大盤跌>2%', 'mkt', s => s.mkt != null && s.mkt < -2],
  ['連跌≥3日', 'dn', s => s.dn >= 3],
  ['5日跌>7%', 'ret5', s => s.ret5 != null && s.ret5 < -7],
  ['5日跌>12%', 'ret5', s => s.ret5 != null && s.ret5 < -12],
  ['低於MA20>7%', 'ma20', s => s.ma20rel < -7],
  ['收位<0.3', 'pos', s => s.pos < 0.3],
  ['收位>0.7', 'pos', s => s.pos > 0.7],
  ['量比>1.5', 'volx', s => s.volX != null && s.volX > 1.5],
  ['量比>3', 'volx', s => s.volX != null && s.volX > 3],
  ['外資昨買超', 'for', s => s.f1lots != null && s.f1lots > 0],
  ['外資連賣≥3', 'for', s => s.fSell >= 3],
  ['三法人昨買超', 'toti', s => s.tot1 != null && s.tot1 > 0],
  ['借券/均量>1', 'ln', s => s.lnLv != null && s.lnLv > 1],
  ['高波動vol20>3%', 'v20', s => s.vol20 != null && s.vol20 > 3],
  ['空頭排列', 'align', s => s.bear],
  ['RS弱<-2%', 'rs', s => s.rs != null && s.rs < -2],
  ['錘子線', 'klo', s => s.loSh > 0.5 && s.amp >= 2.5],
  ['60日位階<0.8', 'p60', s => s.p60 != null && s.p60 < 0.8],
  ['振幅>5%', 'amp', s => s.amp > 5],
  // ── 本輪新族 ──
  ['MACD OSC翻正', 'macd', s => s.oscUpX],
  ['MACD金叉', 'macd', s => s.macdGX],
  ['KD金叉', 'kd', s => s.kdGX],
  ['K<20連2日', 'kd', s => s.kLo2],
  ['破20日低', 'brkl', s => s.brkLo20],
  ['破60日低', 'brkl', s => s.brkLo60],
  ['乖離季線<-12%', 'ma60', s => s.ma60rel < -12],
  ['低於季線', 'ma60x', s => !s.aboveMA60],
  ['量5/20>1.3(升溫)', 'v520', s => s.v520 != null && s.v520 > 1.3],
  ['量5/20<0.7(退潮)', 'v520', s => s.v520 != null && s.v520 < 0.7],
  ['OBV5為正', 'obv', s => s.obvPos],
  ['連續量增≥3日', 'vup', s => s.volUp >= 3],
  ['投信連買≥3', 'tru', s => s.tBuy >= 3],
  ['券回補(昨券大減)', 'shc', s => s.shCover === true],
  ['跳空下開>1%', 'kgd', s => s.gapDn],
  ['當沖比>50%', 'dt', s => s.dtR != null && s.dtR > 50],
];
const P_DN = [
  ['RSI10連2日>75', 'rsi10', s => s.r10 > 75 && s.p10 > 75],
  ['RSI5連2日>80', 'rsi5', s => s.r5 > 80 && s.p5 > 80],
  ['廣度(超買)>30檔', 'bhi', s => s.bHi > 30],
  ['大盤漲>1%', 'mkt', s => s.mkt != null && s.mkt > 1],
  ['5日漲>10%', 'ret5', s => s.ret5 != null && s.ret5 > 10],
  ['5日漲>15%', 'ret5', s => s.ret5 != null && s.ret5 > 15],
  ['高於MA20>10%', 'ma20', s => s.ma20rel > 10],
  ['高於MA5>4%', 'ma5', s => s.ma5rel > 4],
  ['收位>0.9', 'pos', s => s.pos > 0.9],
  ['量比>3', 'volx', s => s.volX != null && s.volX > 3],
  ['量比>5(爆量)', 'volx', s => s.volX != null && s.volX > 5],
  ['破20日高', 'brk', s => s.p20 != null && s.p20 >= 1],
  ['外資昨賣超', 'for', s => s.f1lots != null && s.f1lots < 0],
  ['外資連賣≥3', 'for', s => s.fSell >= 3],
  ['三法人昨賣超', 'toti', s => s.tot1 != null && s.tot1 < 0],
  ['融資昨增', 'mgc', s => s.mgChg != null && s.mgChg > 0],
  ['借券/均量>1', 'ln', s => s.lnLv != null && s.lnLv > 1],
  ['多頭排列', 'align', s => s.bull],
  ['RS強>2%', 'rs', s => s.rs != null && s.rs > 2],
  ['連漲≥3日', 'uprun', s => s.up >= 3],
  ['長上影', 'kup', s => s.upSh > 0.5 && s.amp >= 2.5],
  ['60日位階>0.98', 'p60', s => s.p60 != null && s.p60 > 0.98],
  ['量增價漲(漲2%↑量比2↑)', 'pv', s => s.chg >= 2 && s.volX != null && s.volX > 2],
  ['振幅>5%', 'amp', s => s.amp > 5],
  // ── 本輪新族 ──
  ['MACD OSC翻負', 'macd', s => s.oscDnX],
  ['MACD死叉', 'macd', s => s.macdDX],
  ['KD死叉', 'kd', s => s.kdDX],
  ['K>90極度超買', 'kd', s => s.K > 90],
  ['K>80連2日', 'kd2', s => s.kHi2],
  ['乖離季線>+15%', 'ma60', s => s.ma60rel > 15],
  ['量5/20>1.5', 'v520', s => s.v520 != null && s.v520 > 1.5],
  ['量價背離(5日漲>5%量5/20<0.8)', 'div', s => s.ret5 != null && s.ret5 > 5 && s.v520 != null && s.v520 < 0.8],
  ['OBV5為負', 'obv', s => !s.obvPos],
  ['投信連賣≥3', 'tru', s => s.tSell >= 3],
  ['券大增', 'shs', s => s.shSurge === true],
  ['跳空上開>1%', 'kgu', s => s.gapUp],
  ['當沖比>50%', 'dt', s => s.dtR != null && s.dtR > 50],
];

const main = async () => {
  const all = await loadDays({ days: MAIN + OOT + 70 });
  const SM = build(all.slice(-(MAIN + WARM)));
  const SO = build(all.slice(0, OOT + WARM));
  console.log('═'.repeat(120));
  console.log(`第四輪：0050 成分 50 檔宇宙｜主窗樣本 ${SM.length.toLocaleString()}／OOT ${SO.length.toLocaleString()}`);
  console.log('⚠成分名單為今日快照（存活者偏誤·0050 汰換率低故溫和）｜市場級變數仍用全市場算');
  console.log(`門檻：n≥${MIN_N} 兩窗各自 · 兩半窗各自≥${HIT_HALF}%(各n≥${HALF_MIN_N}) · OOT≥${HIT_OOT}%`);
  console.log('═'.repeat(120));

  for (const [sideName, pool, dir] of [['上漲判別', P_UP, 1], ['下跌判別', P_DN, -1]]) {
    const pkM = packSide(SM, pool), pkO = packSide(SO, pool);
    const baseM = evalIds({ ...pkM, masks: [new Uint8Array(pkM.N).fill(1)] }, [0], dir);
    const baseO = evalIds({ ...pkO, masks: [new Uint8Array(pkO.N).fill(1)] }, [0], dir);
    console.log(`\n${'━'.repeat(120)}\n【${sideName}】基準：主窗 ${baseM.hit}%／OOT ${baseO.hit}%\n${'━'.repeat(120)}`);
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
    console.log(`  掃描 ${combos.length.toLocaleString()} 組（1~3參數）｜樣本足夠 ${res.length.toLocaleString()} 組`);
    const label = ids => ids.map(i => pool[i][0]).join(' ∧ ');

    // 單參數：本輪新族的表現一覽（回答「新參數有沒有用」）
    const NEW_FAMS = new Set(['macd', 'kd', 'kd2', 'brkl', 'ma60', 'ma60x', 'v520', 'obv', 'vup', 'tru', 'shc', 'shs', 'kgd', 'kgu', 'dt', 'div']);
    console.log('\n  🆕本輪新參數（單獨）表現：');
    for (const r of res.filter(r0 => r0.ids.length === 1 && NEW_FAMS.has(pool[r0.ids[0]][1]))) {
      const o = evalIds(pkO, r.ids, dir);
      const dM = r.m.hit - baseM.hit;
      console.log(`    ${pad(label(r.ids), 34)} 主窗 ${r.m.hit}%（${dM >= 0 ? '+' : ''}${r2(dM)}pp）·n=${r.m.n.toLocaleString()}·${r.m.days}天`
        + `｜OOT ${o && o.n >= 50 ? `${o.hit}%` : '不足'}`);
    }

    const pass = [];
    for (const r of res) {
      const { m } = r;
      if (m.hit < HIT_ALL || m.n0 < HALF_MIN_N || m.n1 < HALF_MIN_N || m.h0 < HIT_HALF || m.h1 < HIT_HALF) continue;
      const o = evalIds(pkO, r.ids, dir);
      if (!o || o.n < MIN_N || o.hit < HIT_OOT) continue;
      pass.push({ ...r, o });
    }
    const stable = res.filter(r => Math.min(r.m.n0, r.m.n1) >= HALF_MIN_N && r.m.days >= 30)
      .sort((a, b) => b.m.hit - a.m.hit).slice(0, 8);
    console.log(`\n  ★觸發日≥30天·主窗命中前 8（附 OOT）：`);
    for (const r of stable) {
      const o = evalIds(pkO, r.ids, dir);
      console.log(`    ${pad(label(r.ids), 62)} ${r.m.hit}%[${r.m.h0}/${r.m.h1}]·n=${r.m.n.toLocaleString()}·${r.m.days}天`
        + `｜OOT ${o && o.n >= 50 ? `${o.hit}%·n=${o.n}` : '不足'}｜均報 ${r2(r.m.ret)}%`);
    }
    console.log(`\n  ✅ 通過全部門檻：${pass.length} 組`);
    for (const p2 of pass.slice(0, 10)) {
      console.log(`    ${pad(label(p2.ids), 60)} 主窗 ${p2.m.hit}%[${p2.m.h0}/${p2.m.h1}]·n=${p2.m.n}·${p2.m.days}天`
        + `  OOT ${p2.o.hit}%·n=${p2.o.n}  均報 ${r2(p2.m.ret)}%`);
    }
    if (!pass.length) console.log('    （無）');
  }
  console.log(`\n${'═'.repeat(120)}\n0050 宇宙：50 檔高度相關·觸發日數比 n 更關鍵。非投資建議。\n${'═'.repeat(120)}`);
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
