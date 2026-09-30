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
import { scanDesk, DESK_PARAMS, DESK_VERSION } from './lib/daytrade-setups.mjs';

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
const ROOM = process.argv.includes('--room');
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
    // --room（2026-09-30）：做多選股來源比較——流動性母體全部納入，事後依「觸發當下已漲幅」分組
    const roomU = ROOM && av >= 1000;
    const shortU = (hi / pc - 1) * 100 >= 5 && av >= 500;
    if (!longU && !shortU && !roomU) continue;
    const Pr = P[c] || [];
    pairs.push({ date: days[t].date, code: c, pc, close: cl, longU, shortU, roomU, prevUp: ppc > 0 ? (pc / ppc - 1) * 100 : null, prevHigh: Pr[3] || null, prevLow: Pr[4] || null });
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
          const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${c}.${suf}?interval=1m&period1=${a}&period2=${b}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }).then(r => { if (r.status === 429) throw Object.assign(new Error('429'), { rl: true }); return r.json(); });
          const r = j?.chart?.result?.[0];
          if (r?.timestamp?.length) { const q = r.indicators.quote[0]; r.timestamp.forEach((ts, i) => { if (q.close[i] != null) all.set(ts, [ts, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] || 0]); }); ok = true; }
          else ok = !!j?.chart;   // 空結果＝該段無資料（或後綴錯）
        } catch (e) {
          // Yahoo 限流：立刻中止整個回放（與 daemon 同一 IP——不可拖累線上 K 線/國際盤抓取）
          if (e?.rl) { console.log(`✖ Yahoo 限流（429）：已抓 ${fetched} 檔後中止，保護 daemon 的 Yahoo 額度（已抓的有快取，可稍後續跑）`); process.exit(3); }
          await sleep(1500);
        }
      }
      await sleep(+(process.env.DT_PACE || 220));
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

// ── 5. 開盤型態（--gap，2026-09-23 使用者問「開高走低／開低走高」）──
// 母體＝做多母體（昨漲≥5%、均量≥1000 張），是**開盤前就已知**的名單，不以當日走勢選股。
// 開低走高：開盤 ≤ 昨收−1%，11:00 前第一根收盤翻紅（>昨收）＝買進。
// 開高走低：開盤 ≥ 昨收+2%，11:00 前第一根收盤跌破開盤−2%＝先賣。另測「跌破 VWAP」版。
// 出場：抱到收盤；或反向穿越前 3 根高低（與警示 🏁 同規則）。淨已扣 0.435%。
if (process.argv.includes('--gap')) {
  const setups = [
    ['開低走高·翻紅', 'long', (B, i, m, p) => B[0].o <= p.pc * 0.99 && m.c > p.pc],
    ['開低走高·站上VWAP且翻紅', 'long', (B, i, m, p) => B[0].o <= p.pc * 0.99 && m.c > p.pc && m.vwap != null && m.c > m.vwap],
    ['開低≥3%走高·翻紅', 'long', (B, i, m, p) => B[0].o <= p.pc * 0.97 && m.c > p.pc],
    ['開高走低·跌破開盤−2%', 'short', (B, i, m, p) => B[0].o >= p.pc * 1.02 && m.c < B[0].o * 0.98],
    ['開高走低·跌破VWAP', 'short', (B, i, m, p) => B[0].o >= p.pc * 1.02 && m.vwap != null && m.c < m.vwap && m.c < B[0].o],
    ['開高≥5%走低·翻黑', 'short', (B, i, m, p) => B[0].o >= p.pc * 1.05 && m.c < p.pc],
  ];
  console.log('\n══ 開盤型態（母體：昨漲≥5%，開盤前已知；11:00 前第一次成立；淨已扣成本）══');
  console.log('型態'.padEnd(24) + '段    n   達+2%   抱收盤  3根出場  勝率(抱收)');
  for (const [label, side, test] of setups) {
    const T = [];
    for (const p of pairs) {
      if (!p.longU) continue;
      const B = dayBars[p.code]?.[p.date]; if (!B || B.length < 60) continue;
      for (let i = 1; i < B.length; i++) {
        const m = metricsAt(B, i, { prevClose: p.pc });
        if (m.minute >= 660) break;
        if (!test(B, i, m, p)) continue;
        const sg = side === 'long' ? 1 : -1, e = m.c; let best = e, ex = null;
        for (let j = i + 1; j < B.length; j++) {
          best = side === 'long' ? Math.max(best, B[j].h) : Math.min(best, B[j].l);
          if (ex == null && j >= 3) { const lo = Math.min(B[j - 1].l, B[j - 2].l, B[j - 3].l), hi = Math.max(B[j - 1].h, B[j - 2].h, B[j - 3].h); if (side === 'long' ? B[j].c < lo : B[j].c > hi) ex = sg * (B[j].c / e - 1) * 100 - DT_COST; }
        }
        const close = sg * (p.close / e - 1) * 100 - DT_COST;
        T.push({ oos: p.date >= cut, hit: sg * (best / e - 1) * 100 >= 2, close, bar3: ex ?? close });
        break;
      }
    }
    for (const seg of [false, true]) {
      const x = T.filter(t => t.oos === seg); if (!x.length) continue;
      console.log(`${(seg ? '' : label).padEnd(24)}${seg ? '外' : '訓'} ${String(x.length).padStart(5)} ${(x.filter(t => t.hit).length / x.length * 100).toFixed(0).padStart(5)}% ${f2(mean(x.map(t => t.close))).padStart(7)} ${f2(mean(x.map(t => t.bar3))).padStart(7)} ${(x.filter(t => t.close > 0).length / x.length * 100).toFixed(0).padStart(6)}%`);
    }
  }
}

// ── 6. 當沖工作台 setup（--desk）：scanDesk 逐日回放（與 daemon 同一函式）──
// 母體（兩側相同、開盤前已知）：昨漲≥5%、20 日均量≥1000 張。R＝每股風險 d；淨 R 已扣成本（${DESK_PARAMS.costPct}%）。
if (process.argv.includes('--desk')) {
  console.log(`\n══ 當沖工作台 ${DESK_VERSION}（ORB／突破回踩／開低反轉·出場計畫 1R 保本、2R 追蹤、3R 出場）══`);
  for (const side of ['long', 'short']) {
    const T = [], V = [], FB = []; let setupsSeen = 0;
    for (const p of pairs) {
      if (!p.longU) continue;
      const B = dayBars[p.code]?.[p.date]; if (!B || B.length < 60) continue;
      const res = scanDesk(B, side, { prevClose: p.pc, prevHigh: p.prevHigh, prevLow: p.prevLow });
      setupsSeen++;
      for (const t of res.trades) if (t.exit) T.push({ ...t, oos: p.date >= cut, date: p.date });
      for (const v of res.vetoed) V.push({ ...v, oos: p.date >= cut });
      for (const fb of res.falseBreaks) FB.push({ ...fb, oos: p.date >= cut });
    }
    const types = [...new Set(T.map(t => t.type))];
    console.log(`\n${side === 'long' ? '做多' : '做空（鏡像）'}：掃描 ${setupsSeen} 個(股,日)｜觸發 ${T.length}｜否決 ${V.length}｜假突破 ${FB.length}`);
    console.log('型態'.padEnd(12) + '段    n  勝率  平均淨R  中位淨R  達1R  達2R  連敗  出場原因前三');
    const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
    for (const ty of ['全部', ...types]) for (const seg of [false, true]) {
      const x = T.filter(t => t.oos === seg && (ty === '全部' || t.type === ty)).sort((a, b) => a.t - b.t); if (!x.length) continue;
      let streak = 0, maxS = 0; for (const t of x) { streak = t.netR < 0 ? streak + 1 : 0; maxS = Math.max(maxS, streak); }
      const reasons = {}; for (const t of x) reasons[t.exit.reason] = (reasons[t.exit.reason] || 0) + 1;
      const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}${v}`).join('、');
      console.log(`${(seg ? '' : ty).padEnd(12)}${seg ? '外' : '訓'} ${String(x.length).padStart(5)} ${(x.filter(t => t.netR > 0).length / x.length * 100).toFixed(0).padStart(4)}% ${f2(mean(x.map(t => t.netR))).padStart(7)} ${f2(med(x.map(t => t.netR))).padStart(7)} ${(x.filter(t => t.hit[0]).length / x.length * 100).toFixed(0).padStart(4)}% ${(x.filter(t => t.hit[1]).length / x.length * 100).toFixed(0).padStart(4)}% ${String(maxS).padStart(4)}  ${top}`);
    }
    const vr = {}; for (const v of V) for (const w of v.veto) { const k = w.replace(/[\d.]+/g, '#'); vr[k] = (vr[k] || 0) + 1; }
    console.log('  否決原因：' + Object.entries(vr).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`).join('；'));
  }
}
if (ROOM) {
  console.log(`\n══ 做多選股來源比較（--room）：流動性母體（20 日均量≥1000 張）全部跑 ${DESK_VERSION} 做多規則，依「觸發當下已漲幅」分組；淨 R 已扣成本 ══`);
  const T = [];
  for (const p of pairs) {
    if (!p.roomU) continue;
    const B = dayBars[p.code]?.[p.date]; if (!B || B.length < 60) continue;
    const res = scanDesk(B, 'long', { prevClose: p.pc, prevHigh: p.prevHigh, prevLow: p.prevLow });
    for (const t of res.trades) if (t.exit) T.push({ ...t, oos: p.date >= cut, entryChgPct: (t.entry / p.pc - 1) * 100, gap: (B[0].o / p.pc - 1) * 100, prevUp: p.prevUp });
  }
  const row = (lab, x) => { if (!x.length) return console.log(`${lab.padEnd(22)}     0`); const w = x.filter(t => t.netR > 0).length; const r = x.map(t => t.netR).sort((a, b) => a - b);
    console.log(`${lab.padEnd(22)}${String(x.length).padStart(6)} ${(w / x.length * 100).toFixed(0).padStart(5)}% ${f2(mean(r)).padStart(8)}R ${f2(r[Math.floor(r.length / 2)]).padStart(8)}R`); };
  const groups = [['觸發時已漲 <0%', t => t.entryChgPct < 0], ['觸發時已漲 0~2%', t => t.entryChgPct >= 0 && t.entryChgPct < 2], ['觸發時已漲 2~4%', t => t.entryChgPct >= 2 && t.entryChgPct < 4],
    ['觸發時已漲 4~7%', t => t.entryChgPct >= 4 && t.entryChgPct < 7], ['觸發時已漲 ≥7%', t => t.entryChgPct >= 7],
    ['【建議】已漲 0~4%', t => t.entryChgPct >= 0 && t.entryChgPct < 4], ['【現行近似】已漲 ≥4%', t => t.entryChgPct >= 4], ['【原回放母體】昨漲≥5%', t => t.prevUp >= 5], ['全部', () => true]];
  for (const seg of [false, true]) {
    console.log(`\n${seg ? '樣本外（後 40% 日期）' : '訓練（前 60% 日期）'}`.padEnd(22) + '     n   勝率    平均淨R   中位淨R');
    for (const [lab, fn] of groups) row(lab, T.filter(t => t.oos === seg && fn(t)));
  }
  console.log(`\n型態（全期，已漲 0~4%）：${[...new Set(T.map(t => t.type))].map(ty => { const x = T.filter(t => t.type === ty && t.entryChgPct >= 0 && t.entryChgPct < 4); return `${ty} n=${x.length} 平均 ${f2(mean(x.map(t => t.netR)))}R`; }).join('｜')}`);
}
writeFileSync(`${CACHE}/_results.json`, JSON.stringify({ cut, dates, results }, null, 1));
console.log('\n非投資建議。');
process.exit(0);
