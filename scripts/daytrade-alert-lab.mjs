#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 當沖即時警示 × 1 分 K 逐根回放（2026-09-23）
// 驗的就是線上那一份：scripts/lib/daytrade-signals.mjs 的 stepAlert（同一份碼）。
//
// 問題：訊號成立那一根收盤進場（多＝買、空＝先賣），
//   ① 「≥2% 空間」兌現率：進場後到收盤前，最大順向幅度是否 ≥2%（MFE）
//   ② 跟著 icon 出場：現象停止那一根收盤出場的淨報酬（扣當沖成本 0.435%）
//   ③ 對照：不理 icon、抱到收盤的淨報酬
// 母體（全部是訊號成立前就已知的條件，不偷看）：
//   做多＝昨日漲≥5%、20 日均量≥1000 張、價>10（仿盤後漲停預測名單）
//   做空＝今日曾漲≥5%（訊號本身就要求，故以日最高≥5% 選股不引入偏誤）、20 日均量≥500 張、價>10
// 資料：chipArchive（昨收、官方收盤）＋ Yahoo 1 分 K（只給最近 30 天，7 天一段抓，本機快取）。
// 切分：前 60% 交易日＝訓練、後 40%＝樣本外。只讀，不寫 Firestore。
// 用法：GOOGLE_APPLICATION_CREDENTIALS=… node scripts/daytrade-alert-lab.mjs [--refetch]
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { DEFAULT_PARAMS, ALERT_PARAMS, DT_COST, metricsAt, stepAlert, twMinute } from './lib/daytrade-signals.mjs';

if (!getApps().length) initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))) });
const db = getFirestore();
const CACHE = process.env.DT_CACHE || '/tmp/dt-1m-cache';
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const f2 = v => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '—');

// ── 1. 日線 ──
const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(60).get();
const days = snap.docs.map(d => d.data()).filter(x => x.closeJson).map(x => ({ date: x.date, m: JSON.parse(x.closeJson) })).reverse();
const snapQ = JSON.parse((await db.collection('marketSnapshot').doc('latest').get()).data().quotesJson);
const mkt = c => (snapQ[c]?.market === 'otc' ? 'TWO' : 'TW');
const now = Date.now();
const winFrom = new Date(now - 29 * 86400000).toISOString().slice(0, 10);
const pairs = []; const codes = new Set();
for (let t = 21; t < days.length; t++) {
  if (days[t].date < winFrom) continue;
  const D = days[t].m, P = days[t - 1].m, PP = days[t - 2].m;
  for (const c in D) {
    if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
    const [cl, , , hi] = D[c]; const pc = P[c]?.[0]; const ppc = PP[c]?.[0];
    if (!(pc > 10 && cl > 0 && hi > 0)) continue;
    let av = 0, k = 0; for (let i = t - 20; i < t; i++) { const v = days[i].m[c]?.[1]; if (v > 0) { av += v; k++; } }
    av = k ? av / k : 0;
    const longU = ppc > 0 && (pc / ppc - 1) * 100 >= 5 && av >= 1000;
    const shortU = (hi / pc - 1) * 100 >= 5 && av >= 500;
    if (!longU && !shortU) continue;
    pairs.push({ date: days[t].date, code: c, pc, close: cl, longU, shortU });
    codes.add(c);
  }
}
const dates = [...new Set(pairs.map(p => p.date))].sort();
const cut = dates[Math.floor(dates.length * 0.6)];
console.log(`母體 (股,日) ${pairs.length}（多 ${pairs.filter(p => p.longU).length}／空 ${pairs.filter(p => p.shortU).length}）｜${codes.size} 檔｜${dates[0]}～${dates.at(-1)}（${dates.length} 日，樣本外自 ${cut}）`);

// ── 2. 1 分 K（快取；7 天一段）──
const bars = {};
let fetched = 0;
const chunks = []; for (let e = Math.floor(now / 1000); e > now / 1000 - 29 * 86400; e -= 7 * 86400) chunks.push([Math.max(Math.floor(now / 1000 - 29 * 86400), e - 7 * 86400), e]);
for (const c of codes) {
  const fp = `${CACHE}/${c}.json`;
  if (existsSync(fp) && !process.argv.includes('--refetch')) { bars[c] = JSON.parse(readFileSync(fp, 'utf8')); continue; }
  const all = new Map();
  for (const [a, b] of chunks) {
    for (const suf of [mkt(c), mkt(c) === 'TW' ? 'TWO' : 'TW']) {
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${c}.${suf}?interval=1m&period1=${a}&period2=${b}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }).then(r => r.json());
          const r = j?.chart?.result?.[0];
          if (r?.timestamp?.length) { const q = r.indicators.quote[0]; r.timestamp.forEach((ts, i) => { if (q.close[i] != null) all.set(ts, [ts, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] || 0]); }); ok = true; }
          else ok = !!j?.chart;   // 空結果＝該段無資料（或後綴錯）
        } catch { await sleep(1500); }
      }
      await sleep(220);
      if (all.size) break;
    }
  }
  bars[c] = [...all.values()].sort((x, y) => x[0] - y[0]);
  writeFileSync(fp, JSON.stringify(bars[c]));
  if (++fetched % 50 === 0) console.log(`  · 已抓 ${fetched} 檔`);
}
console.log(`1 分 K：新抓 ${fetched} 檔`);

// 依日切分
const dayBars = {};   // code → date → bars[]
for (const c of codes) {
  const m = {};
  for (const [ts, o, h, l, cl, v] of bars[c] || []) {
    const t = ts * 1000; const d = new Date(t + 8 * 3600000).toISOString().slice(0, 10);
    const hm = twMinute(t); if (hm < 540 || hm > 810) continue;
    (m[d] ||= []).push({ t, o, h, l, c: cl, v });
  }
  dayBars[c] = m;
}

// ── 3. 回放 ──
function replay(side, P) {
  const out = [];
  for (const p of pairs) {
    if (side === 'long' ? !p.longU : !p.shortU) continue;
    const B = dayBars[p.code]?.[p.date]; if (!B || B.length < 60) continue;
    let st = null;
    for (let i = 0; i < B.length; i++) {
      const m = metricsAt(B, i, { prevClose: p.pc }, P);
      const was = st?.phase;
      st = stepAlert(st, side, B, i, m, P);
      if (st.phase === 'on' && was !== 'on') {
        let bc = st.entry; for (let j = i + 1; j < B.length; j++) bc = side === 'long' ? Math.max(bc, B[j].h) : Math.min(bc, B[j].l);
        out.push({ date: p.date, code: p.code, entry: st.entry, since: st.since, minute: m.minute, i, room: st.room, close: p.close, bestClose: bc, rec: null });
      }
      const cur = out.at(-1);
      if (cur && cur.code === p.code && cur.date === p.date && !cur.rec && st.phase === 'stop' && was === 'on') cur.rec = { stopPx: st.stopPx, best: st.best };
    }
    // 收尾：仍在 on 的以最後一根計算 best
    const cur = out.at(-1);
    if (cur && cur.code === p.code && cur.date === p.date && !cur.rec) {
      let best = cur.entry; for (let i = cur.i; i < B.length; i++) best = side === 'long' ? Math.max(best, B[i].h) : Math.min(best, B[i].l);
      cur.rec = { stopPx: p.close, best, open: true };
    }
  }
  for (const o of out) {
    const s = side === 'long' ? 1 : -1;
    o.mfe = s * (o.rec.best / o.entry - 1) * 100;
    o.mfeClose = s * (o.bestClose / o.entry - 1) * 100;   // 到收盤為止的最大順向（「空間」是否兌現）
    o.netStop = s * (o.rec.stopPx / o.entry - 1) * 100 - DT_COST;
    o.netClose = s * (o.close / o.entry - 1) * 100 - DT_COST;
  }
  return out;
}
function summarize(rs) {
  const seg = x => ({ n: x.length, hit2: x.length ? x.filter(r => r.mfeClose >= 2).length / x.length * 100 : NaN, stop: mean(x.map(r => r.netStop)), win: x.length ? x.filter(r => r.netStop > 0).length / x.length * 100 : NaN, close: mean(x.map(r => r.netClose)) });
  return { tr: seg(rs.filter(r => r.date < cut)), te: seg(rs.filter(r => r.date >= cut)) };
}
const line = (label, s) => `${label.padEnd(34)} 訓練 n=${String(s.tr.n).padStart(4)} 達2% ${s.tr.hit2.toFixed(0).padStart(3)}% 跟icon淨 ${f2(s.tr.stop)} 勝${s.tr.win.toFixed(0)}% 抱收 ${f2(s.tr.close)} ｜樣本外 n=${String(s.te.n).padStart(4)} 達2% ${s.te.hit2.toFixed(0).padStart(3)}% 跟icon淨 ${f2(s.te.stop)} 勝${s.te.win.toFixed(0)}% 抱收 ${f2(s.te.close)}`;

const GRID = [];
for (const volK of [1.5, 2, 3]) for (const lookback of [5, 10]) for (const exitBars of [2, 3]) for (const ex of ['bars', 'vwap', 'both'])
  GRID.push({ ...DEFAULT_PARAMS, volK, lookback, exitBars, longExit: ex, shortExit: ex });
const results = { long: [], short: [] };
for (const side of ['long', 'short']) {
  console.log(`\n══ ${side === 'long' ? '做多轉強 ▲' : '做空轉弱 ▼'}（進場＝成立那根收盤；淨＝扣 ${DT_COST}%）══`);
  console.log(line('預設參數', summarize(replay(side, DEFAULT_PARAMS))));
  for (const P of GRID) {
    const s = summarize(replay(side, P));
    results[side].push({ P, s });
  }
  // 只用訓練段挑：訓練 n≥40 下「跟 icon 淨」最高的前 5 組，再看樣本外
  const top = results[side].filter(r => r.s.tr.n >= 40).sort((a, b) => b.s.tr.stop - a.s.tr.stop).slice(0, 5);
  for (const r of top) console.log(line(`volK${r.P.volK} N${r.P.lookback} 停${r.P.exitBars}/${side === 'long' ? r.P.longExit : r.P.shortExit}`, r.s));
  // 線上採用參數：全段／10 點前／10 點後（ALERT_EVIDENCE 的來源）
  const base = replay(side, ALERT_PARAMS);
  for (const [lab, fn] of [['採用·全部', () => true], ['採用·10點前', r => r.minute < 600], ['採用·10點後', r => r.minute >= 600]]) console.log(line(lab, summarize(base.filter(fn))));
}

// ── 4. 情境拆解（--explore）：同一觸發點，依「成立當下已知」的情境切分，量到收盤為止的空間與多種出場 ──
// 目的：找出「預估 ≥2% 空間」真的兌現的子集合；觸發不設空間門檻（minRoom=0），空間本身也當情境檢驗。
if (process.argv.includes('--explore')) {
  const P0 = { ...DEFAULT_PARAMS, minRoom: 0 };
  const exits = {
    close: () => null,
    bar3: (side, B, i, m) => side === 'long' ? m.c < Math.min(B[i - 1].l, B[i - 2].l, B[i - 3].l) : m.c > Math.max(B[i - 1].h, B[i - 2].h, B[i - 3].h),
    vwap: (side, B, i, m) => m.vwap != null && (side === 'long' ? m.c < m.vwap : m.c > m.vwap),
    trail15: (side, B, i, m, e) => side === 'long' ? m.c < e.best * 0.985 : m.c > e.best * 1.015,
    tp2sl15: (side, B, i, m, e) => { const r = side === 'long' ? m.c / e.entry - 1 : 1 - m.c / e.entry; return r >= 0.02 || r <= -0.015; },
  };
  for (const side of ['long', 'short']) {
    const T = [];
    for (const p of pairs) {
      if (side === 'long' ? !p.longU : !p.shortU) continue;
      const B = dayBars[p.code]?.[p.date]; if (!B || B.length < 60) continue;
      let cool = -1;
      const open = B[0].o;
      for (let i = 3; i < B.length; i++) {
        if (i < cool) continue;
        const m = metricsAt(B, i, { prevClose: p.pc }, P0);
        const trig = side === 'long' ? (m.minute >= P0.startMin && m.minute <= P0.endMin && m.brkUp && (m.volX ?? 0) >= 2 && m.vwap != null && m.c > m.vwap)
          : (m.minute >= P0.startMin && m.minute <= P0.endMin && m.hiUp >= 5 && m.brkDn && (m.volX ?? 0) >= 2);
        if (!trig) continue;
        cool = i + 10;
        const sgn = side === 'long' ? 1 : -1; const entry = m.c;
        let best = entry; let mfe = 0, mae = 0;
        const out = {};
        for (const k in exits) out[k] = null;
        const eState = { entry, best };
        for (let j = i + 1; j < B.length; j++) {
          const mj = metricsAt(B, j, { prevClose: p.pc }, P0);
          best = side === 'long' ? Math.max(best, B[j].h) : Math.min(best, B[j].l); eState.best = best;
          mfe = Math.max(mfe, sgn * ((side === 'long' ? B[j].h : B[j].l) / entry - 1) * 100);
          mae = Math.min(mae, sgn * ((side === 'long' ? B[j].l : B[j].h) / entry - 1) * 100);
          for (const k in exits) if (out[k] == null && k !== 'close' && exits[k](side, B, j, mj, eState)) out[k] = sgn * (mj.c / entry - 1) * 100 - DT_COST;
        }
        const netClose = sgn * (p.close / entry - 1) * 100 - DT_COST;
        for (const k in out) if (out[k] == null) out[k] = netClose;
        T.push({ date: p.date, oos: p.date >= cut, minute: m.minute, chg: m.chg, hiUp: m.hiUp, give: m.give, vwapDev: m.vwapDev, volX: m.volX, room: side === 'long' ? m.roomUp : m.roomDn,
          gap: (open / p.pc - 1) * 100, mfe, mae, out });
      }
    }
    const ctx = side === 'long' ? [
      ['全部', t => true],
      ['10:00 前', t => t.minute < 600], ['10:00 後', t => t.minute >= 600],
      ['漲幅 0~3%', t => t.chg < 3], ['漲幅 3~6%', t => t.chg >= 3 && t.chg < 6], ['漲幅 ≥6%', t => t.chg >= 6],
      ['VWAP 乖離 ≤1%', t => t.vwapDev <= 1], ['VWAP 乖離 >2%', t => t.vwapDev > 2],
      ['量比 ≥4x', t => t.volX >= 4],
      ['空間 ≥2%', t => t.room >= 2], ['空間 ≥4%', t => t.room >= 4], ['空間 <2%（貼漲停）', t => t.room < 2],
      ['開高 ≥2%', t => t.gap >= 2], ['開平/低 <1%', t => t.gap < 1],
      ['10點前∧乖離≤1%', t => t.minute < 600 && t.vwapDev <= 1],
      ['漲幅≥6%∧空間≥2%', t => t.chg >= 6 && t.room >= 2],
    ] : [
      ['全部', t => true],
      ['10:00 前', t => t.minute < 600], ['10:00 後', t => t.minute >= 600],
      ['漲停打開（曾≥9.4∧回吐≥3）', t => t.hiUp >= 9.4 && t.give >= 3],
      ['曾≥9.4∧仍在VWAP上', t => t.hiUp >= 9.4 && t.vwapDev > 0],
      ['仍在 VWAP 上', t => t.vwapDev > 0], ['已在 VWAP 下', t => t.vwapDev <= 0],
      ['現價仍漲 ≥5%', t => t.chg >= 5], ['已翻黑', t => t.chg < 0],
      ['回吐 ≥4', t => t.give >= 4], ['量比 ≥4x', t => t.volX >= 4],
      ['空間 ≥2%', t => t.room >= 2], ['空間 <2%', t => t.room < 2],
      ['10點前∧仍在VWAP上', t => t.minute < 600 && t.vwapDev > 0],
    ];
    console.log(`\n══ 情境拆解 ${side === 'long' ? '做多 ▲' : '做空 ▼'}（觸發 ${T.length}；收盤前最大順向≥2%＝兌現；淨已扣 ${DT_COST}%）══`);
    console.log('情境'.padEnd(22) + '段    n    兌現2%  MFE中位  MAE中位 | 抱收盤   3根停   VWAP停  回落1.5%  +2/−1.5');
    const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
    for (const [label, fn] of ctx) for (const seg of [false, true]) {
      const x = T.filter(t => t.oos === seg && fn(t)); if (x.length < 15) continue;
      const h = x.filter(t => t.mfe >= 2).length / x.length * 100;
      const cols = ['close', 'bar3', 'vwap', 'trail15', 'tp2sl15'].map(k => f2(mean(x.map(t => t.out[k]))).padStart(7));
      console.log(`${(seg ? '' : label).padEnd(22)}${seg ? '外' : '訓'} ${String(x.length).padStart(5)} ${h.toFixed(0).padStart(6)}% ${f2(med(x.map(t => t.mfe))).padStart(7)} ${f2(med(x.map(t => t.mae))).padStart(7)} | ${cols.join(' ')}`);
    }
    writeFileSync(`${CACHE}/_explore_${side}.json`, JSON.stringify(T));
  }
}
writeFileSync(`${CACHE}/_results.json`, JSON.stringify({ cut, dates, results }, null, 1));
console.log('\n非投資建議。');
process.exit(0);
