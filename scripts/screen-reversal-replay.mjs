#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 反轉訊號歷史重放：六條凍結規則能不能「標出上漲與下跌訊號日」 —— 2026-08-05
//
// 使用者問題：再次驗證，能找出上漲與下跌訊息日?
// 做法：拿 daemon computeReversalSignals 的六條凍結規則（一字不改），
//       對過去 760 個交易日逐日重放，列出每個訊號日與其後 5 日實際結果。
//
// ⚠ 定位：這是「規則能否正確標日」的重放驗證，不是新的認證回測——
//    規則本來就是在這段資料上選出來的，數字會偏樂觀；
//    對外可宣稱的成績仍以 picksScoreboard 前瞻累積為準。
// 目標口徑：上漲訊號看後 5 日淨報酬（扣0.4425%）與勝率；
//           下跌訊號看 T1(5日收盤下跌·淨) 與 T3(5日內曾觸-3%低點·毛)。
// 用法：node scripts/screen-reversal-replay.mjs
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import { loadDays } from './lib/bt-core.mjs';

const COST = 0.4425, MAIN = 480, OOT = 240, WARM = 65;
const W = JSON.parse(fs.readFileSync('scripts/data/overheat-weighted-v1.json', 'utf8'));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

function rsiStep(st, d, p) {
  if (st.n < p) { st.g += d > 0 ? d : 0; st.l += d < 0 ? -d : 0; st.n++;
    if (st.n === p) { st.g /= p; st.l /= p; st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l); } return; }
  st.g = (st.g * (p - 1) + (d > 0 ? d : 0)) / p; st.l = (st.l * (p - 1) + (d < 0 ? -d : 0)) / p;
  st.v = st.l === 0 ? 100 : 100 - 100 / (1 + st.g / st.l);
}

// 加權指數距 20 日高（panicDip 第 5 條件）——單次 Yahoo 5y 日線，映射到歸檔日期
async function fetchTwiiDD20() {
  const map = {};
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=5y', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const res = (await r.json())?.chart?.result?.[0];
    const ts = res?.timestamp || [], cl = res?.indicators?.quote?.[0]?.close || [];
    const seq = [];
    for (let i = 0; i < ts.length; i++) if (cl[i] > 0) seq.push({ d: new Date((ts[i] + 8 * 3600) * 1000).toISOString().slice(0, 10), c: cl[i] });
    for (let i = 20; i < seq.length; i++) {
      let hi = 0; for (let k = 1; k <= 20; k++) hi = Math.max(hi, seq[i - k].c);
      map[seq[i].d] = +((seq[i].c / hi - 1) * 100).toFixed(2);
    }
  } catch { /* 取不到＝fail-closed，panicDip 各日不觸發並註記 */ }
  return map;
}

const main = async () => {
  const days = await loadDays({ days: MAIN + OOT + 40 });
  const dd20 = await fetchTwiiDD20();
  const H = {};
  // byDay[date] = { mkt, bLo, sig: {rule: [samples]} }
  const byDay = [];
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
    const todays = []; let bLo = 0;
    for (const code in D.close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const row = D.close[code]; if (!row || row.length < 5) continue;
      const [c, v, o, h, l] = row; if (!(c > 0)) continue;
      const st = (H[code] ||= { pc: null, cl: [], vl: [], s5: { g: 0, l: 0, n: 0, v: null }, s10: { g: 0, l: 0, n: 0, v: null }, p5: null, p10: null, b1: null, b2: null });
      const b1 = st.b1, b2 = st.b2;
      if (st.pc != null) {
        st.p5 = st.s5.v; st.p10 = st.s10.v;
        rsiStep(st.s5, c - st.pc, 5); rsiStep(st.s10, c - st.pc, 10);
      }
      const pc = st.pc, cl = st.cl, vl = st.vl;
      st.pc = c;
      if (i >= WARM && pc > 0 && st.s5.v != null && st.p5 != null && cl.length >= 61) {
        const chg = (c - pc) / pc * 100;
        if (v >= 300 && chg <= 8.5) {
          if (st.s10.v < 20 && st.p10 < 20) bLo++;
          let hi20 = 0, hi60 = 0, av20 = 0, ma20 = 0;
          for (let k = 1; k <= 60; k++) {
            const x = cl[cl.length - k]; if (x == null) break;
            if (k <= 20) { if (x > hi20) hi20 = x; av20 += vl[vl.length - k] || 0; ma20 += x; }
            if (x > hi60) hi60 = x;
          }
          av20 /= 20; ma20 /= 20;
          const c5 = cl[cl.length - 5];
          const it1 = P?.inst?.[code];
          let fSell = 0;
          for (let k = 1; k <= 10; k++) { const f = days[i - k]?.inst?.[code]?.[0]; if (f < 0) fSell++; else break; }
          const mg1 = P?.mg?.[code];
          const white = c > o, body = pc > 0 ? Math.abs(c - o) / pc * 100 : 0;
          const w3 = !!(b1 && b2 && white && b1.c > b1.o && b2.c > b2.o && c > b1.c && b1.c > b2.c && body >= 1);
          let f5 = null, minL = null;
          const d5 = days[i + 5]?.close?.[code];
          if (d5 && d5[0] > 0) f5 = (d5[0] - c) / c * 100 - COST;
          let ml = Infinity, complete = true;
          for (let k = 1; k <= 5; k++) {
            const dk = days[i + k]?.close?.[code];
            if (!dk || !(dk[0] > 0)) { complete = false; break; }
            const lo = dk[4] > 0 ? dk[4] : dk[0];
            if (lo < ml) ml = lo;
          }
          if (complete) minL = (ml - c) / c * 100;
          todays.push({ code, price: c,
            r5: st.s5.v, r10: st.s10.v, p5: st.p5, p10: st.p10,
            ret5: c5 > 0 ? (c - c5) / c5 * 100 : null,
            pos: h > l ? (c - l) / (h - l) : 0.5,
            upSh: h > l ? (h - Math.max(o, c)) / (h - l) : 0, amp: (h - l) / pc * 100,
            volX: av20 > 0 ? v / av20 : null,
            p20: hi20 > 0 ? c / hi20 : null, p60: hi60 > 0 ? c / hi60 : null,
            ma20rel: ma20 > 0 ? (c / ma20 - 1) * 100 : null,
            fSell, fMag: it1 != null && av20 > 0 ? (it1[0] || 0) / av20 : null,
            tSell: it1 != null && (it1[1] || 0) < 0,
            tot1: it1 ? (it1[0] || 0) + (it1[1] || 0) + (it1[2] || 0) : null,
            lnLv: P?.ln?.[code] != null && av20 > 0 ? P.ln[code] / av20 : null,
            sr: mg1 && (mg1[0] || 0) > 0 ? (mg1[1] || 0) / mg1[0] : null,
            upN: (() => { let u = 0; for (let k = cl.length; k > 0; k--) { const a = k === cl.length ? c : cl[k], b = cl[k - 1]; if (a > b) u++; else break; } return u; })(),
            w3, f5, minL });
        }
      }
      st.b2 = st.b1; st.b1 = { o, c };
      cl.push(c); vl.push(v || 0);
      if (cl.length > 65) { cl.shift(); vl.shift(); }
    }
    byDay.push({ date: D.date, mkt, bLo, dd: dd20[D.date] ?? null, S: todays });
  }

  // ── 六條凍結規則（與 daemon 一字不改）──
  const wz = W.weights;
  const RULES = {
    '🩹panicDip(上漲)': { dir: 'up', fn: (s, d) => s.r10 < 25 && s.p10 < 25 && s.ret5 != null && s.ret5 < -15 && d.bLo > 30 && d.mkt != null && d.mkt < -2 && d.dd != null && d.dd <= -10 },
    '🗳️voteDip(上漲)': { dir: 'up', fn: (s, d) => {
      let v = 0;
      if (d.bLo > 30) v++;
      if (s.ret5 != null && s.ret5 < -15) v++;
      if (s.r10 < 20 && s.p10 < 20) v++;
      if (d.mkt != null && d.mkt < -2) v++;
      if (s.r10 < 25 && s.p10 < 25) v++;
      if (s.r5 < 15 && s.p5 < 15) v++;
      if (s.ret5 != null && s.ret5 < -10) v++;
      if (d.mkt != null && d.mkt < -1) v++;
      if (s.ma20rel != null && s.ma20rel < -10) v++;
      if (s.p60 != null && s.p60 < 0.7) v++;
      return v >= 7; } },
    '🚪overheatV1(下跌)': { dir: 'dn', fn: s => s.r5 > 80 && s.p5 > 80 && s.pos > 0.9 && s.fSell >= 3 && s.lnLv != null && s.lnLv > 1 },
    '📉overheatV2(下跌)': { dir: 'dn', fn: s => s.pos > 0.9 && s.volX != null && s.volX > 5 && s.p20 != null && s.p20 >= 1 && s.tot1 != null && s.tot1 < 0 },
    '🎈overheatV3(下跌)': { dir: 'dn', fn: s => s.r5 > 80 && s.p5 > 80 && s.upSh > 0.5 && s.amp >= 3 && s.price < 20 && s.volX != null && s.volX > 3 },
    '⚖️wExit(下跌)': { dir: 'dn', fn: s => {
      let z = W.bias;
      if (s.r5 > 80 && s.p5 > 80) z += wz['RSI5連2日>80'];
      if (s.r5 > 85 && s.p5 > 85) z += wz['RSI5連2日>85'];
      if (s.upSh > 0.5 && s.amp >= 3) z += wz['長上影'];
      if (s.price < 20) z += wz['股價<20'];
      if (s.price < 50) z += wz['股價<50'];
      if (s.volX != null && s.volX > 5) z += wz['量比>5'];
      if (s.volX != null && s.volX > 3) z += wz['量比>3'];
      if (s.w3) z += wz['三白兵'];
      if (s.p20 != null && s.p20 >= 1) z += wz['破20日高'];
      if (s.pos > 0.9) z += wz['收位>0.9'];
      if (s.fSell >= 3) z += wz['外資連賣≥3'];
      if (s.fMag != null && s.fMag < -0.03) z += wz['外資賣力道>3%均量'];
      if (s.lnLv != null && s.lnLv > 1) z += wz['借券/均量>1'];
      if (s.sr != null && s.sr > 0.2) z += wz['券資比>0.2'];
      if (s.upN >= 3) z += wz['連漲≥3'];
      if (s.ret5 != null && s.ret5 > 15) z += wz['5日漲>15%'];
      if (s.tSell) z += wz['投信昨賣超'];
      return z >= W.cut; } },
  };

  const evalDays = byDay.filter(d => d.S.length);
  console.log('═'.repeat(118));
  console.log(`反轉訊號歷史重放（六條凍結規則·一字不改）｜${evalDays[0]?.date} ~ ${evalDays[evalDays.length - 1]?.date}·${evalDays.length} 個可評日`);
  console.log(`twiiDD20 覆蓋 ${Object.keys(dd20).length} 日（缺日＝panicDip fail-closed 不觸發·與 daemon 相同）`);
  console.log('═'.repeat(118));

  for (const [nm, rule] of Object.entries(RULES)) {
    const sigDays = [];
    for (const d of evalDays) {
      const hit = d.S.filter(s => rule.fn(s, d));
      if (hit.length) sigDays.push({ date: d.date, mkt: d.mkt, hit });
    }
    const all = sigDays.flatMap(x => x.hit);
    const withF = all.filter(s => s.f5 != null);
    const withL = all.filter(s => s.minL != null);
    console.log(`\n${'─'.repeat(118)}`);
    if (rule.dir === 'up') {
      const win = withF.filter(s => s.f5 > 0).length;
      console.log(`${nm}｜訊號日 ${sigDays.length} 天·${all.length} 檔次｜後5日淨均 ${r2(avg(withF.map(s => s.f5)))}%·勝率 ${withF.length ? r2(win / withF.length * 100) : '-'}%`);
      console.log('  逐訊號日（上漲訊號稀少·全列）：');
      for (const x of sigDays) {
        const f = x.hit.filter(s => s.f5 != null);
        const w = f.filter(s => s.f5 > 0).length;
        console.log(`    ${x.date} 大盤${padL(r2(x.mkt) + '%', 7)}·${padL(x.hit.length, 4)}檔 → 後5日淨均 ${padL(r2(avg(f.map(s => s.f5))) + '%', 8)}·勝 ${f.length ? r2(w / f.length * 100) : '-'}%${f.length < x.hit.length ? '（部分 forward 未完整）' : ''}`);
      }
      if (!sigDays.length) console.log('    （760 日內零觸發——正確行為：這是多年一遇的事件級規則）');
    } else {
      const t1 = withF.filter(s => s.f5 < 0).length;
      const t3 = withL.filter(s => s.minL <= -3).length;
      console.log(`${nm}｜訊號日 ${sigDays.length} 天·${all.length} 檔次｜T1(5日收跌·淨) ${withF.length ? r2(t1 / withF.length * 100) : '-'}%·T3(曾觸-3%低) ${withL.length ? r2(t3 / withL.length * 100) : '-'}%·後5日淨均 ${r2(avg(withF.map(s => s.f5)))}%`);
      console.log('  最近 10 個訊號日：');
      for (const x of sigDays.slice(-10)) {
        const f = x.hit.filter(s => s.f5 != null), l3 = x.hit.filter(s => s.minL != null);
        const a = f.filter(s => s.f5 < 0).length, b = l3.filter(s => s.minL <= -3).length;
        console.log(`    ${x.date} ${padL(x.hit.length, 3)}檔 → T1 ${f.length ? padL(r2(a / f.length * 100) + '%', 6) : '  未到'}·T3 ${l3.length ? padL(r2(b / l3.length * 100) + '%', 6) : '  未到'}·後5日淨均 ${f.length ? r2(avg(f.map(s => s.f5))) + '%' : '未到'}`);
      }
    }
  }
  console.log(`\n${'═'.repeat(118)}`);
  console.log('⚠ 重放≠認證：規則是在這段資料上選的，數字偏樂觀；對外成績以 picksScoreboard 前瞻累積為準。非投資建議。');
  console.log('═'.repeat(118));
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
