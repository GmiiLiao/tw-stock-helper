#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// 即時轉空 × 盤中做空 回放實驗室（2026-09-23 使用者：「用在盤中做空單，提高預測精準度」）
//
// 問題定義（做空的人真正在乎的）：型態在盤中第 T 根 5 分 K **剛成立**的那一刻賣出（現股當沖先賣），
//   收盤回補；淨報酬＝(進場價−收盤價)/進場價 − 當沖成本 0.435%（買賣手續費 0.1425%×2＋當沖證交稅 0.15%，未含折讓）。
//   另測停損：進場後最高價觸及 進場×(1+停損%) 即以停損價回補。
// 資料：chipArchive（昨收、20 日均量、官方收盤、前 5 日漲幅）＋ Yahoo 5 分 K（range=60d，本機快取，逐檔 350ms）。
// 切分：前 60% 交易日＝訓練、後 40%＝樣本外；濾網只在訓練段挑，樣本外只驗。
// 唯讀：不寫 Firestore。用法：GOOGLE_APPLICATION_CREDENTIALS=… node scripts/fade-intraday-lab.mjs [--refetch]
// ─────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

if (!getApps().length) initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))) });
const db = getFirestore();
const CACHE = process.env.FADE_CACHE || '/tmp/fade-5m-cache';
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
const COST = 0.435;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const f2 = v => (Number.isFinite(v) ? v.toFixed(2) : '—');

// ── 1. 日線 ──
const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(95).get();
const days = snap.docs.map(d => d.data()).filter(x => x.closeJson).map(x => ({ date: x.date, m: JSON.parse(x.closeJson) })).reverse();
const idxOf = Object.fromEntries(days.map((d, i) => [d.date, i]));
const snapQ = JSON.parse((await db.collection('marketSnapshot').doc('latest').get()).data().quotesJson);
const mkt = c => (snapQ[c]?.market === 'otc' ? 'TWO' : 'TW');

// 候選：Yahoo 5 分 K 視窗內（最後 58 個交易日）、當日最高漲幅≥4%、價>10、日量≥500 張
const winStart = Math.max(21, days.length - 58);
const pairs = []; const codes = new Set();
for (let t = winStart; t < days.length; t++) {
  const D = days[t].m, P = days[t - 1].m;
  for (const c in D) {
    if (!/^\d{4}$/.test(c) || c.startsWith('00')) continue;
    const [cl, vol, , hi] = D[c]; const pc = P[c]?.[0];
    if (!(pc > 10 && hi > 0 && cl > 0) || vol < 500) continue;
    if ((hi / pc - 1) * 100 < 4) continue;
    let av = 0, k = 0; for (let i = t - 20; i < t; i++) { const v = days[i].m[c]?.[1]; if (v > 0) { av += v; k++; } }
    const c5 = days[t - 5]?.m[c]?.[0];
    pairs.push({ t, date: days[t].date, code: c, pc, close: cl, avg20: k ? av / k : 0, prevChg: days[t - 2]?.m[c]?.[0] > 0 ? (pc / days[t - 2].m[c][0] - 1) * 100 : null, ret5: c5 > 0 ? (pc / c5 - 1) * 100 : null });
    codes.add(c);
  }
}
console.log(`候選 (股,日) ${pairs.length}｜${codes.size} 檔｜期間 ${days[winStart].date}～${days[days.length - 1].date}`);

// ── 2. 5 分 K（快取） ──
const bars = {};
let fetched = 0;
for (const c of codes) {
  const fp = `${CACHE}/${c}.json`;
  if (existsSync(fp) && !process.argv.includes('--refetch')) { bars[c] = JSON.parse(readFileSync(fp, 'utf8')); continue; }
  let got = null;
  for (const suf of [mkt(c), mkt(c) === 'TW' ? 'TWO' : 'TW']) {
    try {
      const j = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${c}.${suf}?interval=5m&range=60d`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }).then(r => r.json());
      const r = j?.chart?.result?.[0];
      if (r?.timestamp?.length) { const q = r.indicators.quote[0]; got = r.timestamp.map((ts, i) => [ts, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]]); break; }
    } catch { /* 換下一個後綴 */ }
    await sleep(350);
  }
  bars[c] = got || [];
  writeFileSync(fp, JSON.stringify(bars[c]));
  fetched++; await sleep(350);
  if (fetched % 100 === 0) console.log(`  · 已抓 ${fetched} 檔`);
}
console.log(`5 分 K：新抓 ${fetched} 檔，其餘讀快取`);

// ── 3. 逐根回放 ──
const tw = ts => { const d = new Date((ts + 8 * 3600) * 1000); return { date: d.toISOString().slice(0, 10), hm: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
const PAT = [
  ['沖高回落＋爆量', m => m.hiUp >= 5 && m.give >= 4 && m.pace >= 2],
  ['漲停打開回落', m => m.hiUp >= 9.4 && m.give >= 3],
  ['沖高回落', m => m.hiUp >= 5 && m.give >= 4],
  ['翻黑＋爆量', m => m.hiUp >= 3 && m.chg < 0 && m.pace >= 2],
  ['開高走低', m => m.openUp >= 2 && m.openFall >= 2],
  ['翻黑', m => m.hiUp >= 3 && m.chg < 0],
];
const trades = [];   // 每 (股,日,型態) 第一次成立
for (const p of pairs) {
  const b = (bars[p.code] || []).map(r => ({ ...tw(r[0]), o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] || 0 })).filter(r => r.date === p.date && r.hm >= 540 && r.hm < 810);
  if (b.length < 20) continue;
  let open = null, hi = 0, cumV = 0, last = null, vwN = 0, vwD = 0;
  const done = new Set();
  for (let k = 0; k < b.length; k++) {
    const r = b[k];
    if (r.c != null) last = r.c;
    if (open == null && r.o != null) open = r.o;
    if (r.h != null && r.h > hi) hi = r.h;
    cumV += r.v; if (r.c != null) { vwN += r.c * r.v; vwD += r.v; }
    if (last == null || open == null || r.hm < 545 || r.hm > 780) continue;   // 09:05 後才判、13:00 後不再進場
    const frac = Math.min(1, (r.hm + 5 - 540) / 270);
    const m = { hiUp: (hi / p.pc - 1) * 100, give: (hi - last) / p.pc * 100, chg: (last / p.pc - 1) * 100, openUp: (open / p.pc - 1) * 100, openFall: (open - last) / open * 100,
      pace: p.avg20 > 0 ? (cumV / 1000) / p.avg20 / frac : 0, belowVwap: vwD > 0 ? last < vwN / vwD : false };
    for (const [name, fn] of PAT) {
      if (done.has(name) || !fn(m)) continue;
      done.add(name);
      const entry = last; let maxAfter = entry;
      for (let j = k + 1; j < b.length; j++) if (b[j].h != null && b[j].h > maxAfter) maxAfter = b[j].h;
      const exit = p.close;   // 官方收盤回補
      const stopOut = s => (maxAfter >= entry * (1 + s / 100) ? -s - COST : (entry - exit) / entry * 100 - COST);
      trades.push({ ...p, pat: name, hm: r.hm, m, net: (entry - exit) / entry * 100 - COST, gross: (entry - exit) / entry * 100, s15: stopOut(1.5), s2: stopOut(2), s3: stopOut(3), mae: (maxAfter / entry - 1) * 100 });
    }
  }
}
const allDates = [...new Set(trades.map(x => x.date))].sort();
const cut = allDates[Math.floor(allDates.length * 0.6)];
const tr = trades.filter(x => x.date < cut), oo = trades.filter(x => x.date >= cut);
console.log(`\n回放交易 ${trades.length} 筆｜訓練 ${tr.length}（<${cut}）／樣本外 ${oo.length}｜成本 ${COST}%`);
const row = (name, g) => g.length ? `${name} | n=${g.length} | 勝率(淨>0) ${(g.filter(x => x.net > 0).length / g.length * 100).toFixed(1)}% | 淨均 ${f2(mean(g.map(x => x.net)))}% | 毛均 ${f2(mean(g.map(x => x.gross)))}% | 停損2% 淨均 ${f2(mean(g.map(x => x.s2)))}% | 停損3% ${f2(mean(g.map(x => x.s3)))}% | MAE 中位 ${f2(g.map(x => x.mae).sort((a, b) => a - b)[Math.floor(g.length / 2)])}%` : `${name} | n=0`;

console.log('\n表 1｜各型態（進場＝成立當根收，回補＝官方收盤）');
for (const [name] of PAT) { console.log(row(`[訓練] ${name}`, tr.filter(x => x.pat === name))); console.log(row(`[樣本外] ${name}`, oo.filter(x => x.pat === name))); }

// ── 4. 濾網（只在訓練段挑） ──
const FILTERS = [
  ['進場 09:05–10:00', x => x.hm < 600], ['進場 10:00–11:00', x => x.hm >= 600 && x.hm < 660], ['進場 11:00–12:00', x => x.hm >= 660 && x.hm < 720], ['進場 12:00–13:00', x => x.hm >= 720],
  ['已翻黑(現價<昨收)', x => x.m.chg < 0], ['仍在平盤上', x => x.m.chg >= 0],
  ['跌破VWAP', x => x.m.belowVwap], ['在VWAP上', x => !x.m.belowVwap],
  ['跌破開盤', x => x.m.openFall > 0], ['回吐≥6', x => x.m.give >= 6], ['回吐 4–6', x => x.m.give >= 4 && x.m.give < 6],
  ['量能節奏≥3x', x => x.m.pace >= 3], ['量能節奏<2x', x => x.m.pace < 2],
  ['曾觸漲停', x => x.m.hiUp >= 9.4], ['最高 5–9%', x => x.m.hiUp >= 5 && x.m.hiUp < 9.4],
  ['昨日已大漲≥5%', x => x.prevChg != null && x.prevChg >= 5], ['昨日未大漲', x => x.prevChg != null && x.prevChg < 5],
  ['前5日漲≥15%(已漲多)', x => x.ret5 != null && x.ret5 >= 15], ['前5日漲<5%', x => x.ret5 != null && x.ret5 < 5],
];
console.log('\n表 2｜濾網效果（全型態合併、每(股,日)取最早成立的一筆）');
const firstOf = g => { const seen = new Map(); for (const x of g.sort((a, b) => a.hm - b.hm)) { const k = x.code + x.date; if (!seen.has(k)) seen.set(k, x); } return [...seen.values()]; };
const trF = firstOf([...tr]), ooF = firstOf([...oo]);
console.log(row('[訓練] 全部', trF)); console.log(row('[樣本外] 全部', ooF));
const scored = [];
for (const [name, fn] of FILTERS) {
  const a = trF.filter(fn), b = ooF.filter(fn);
  console.log(`${name} ｜訓練 n=${a.length} 淨均 ${f2(mean(a.map(x => x.net)))}% 勝率 ${a.length ? (a.filter(x => x.net > 0).length / a.length * 100).toFixed(1) : '—'}% ｜樣本外 n=${b.length} 淨均 ${f2(mean(b.map(x => x.net)))}% 勝率 ${b.length ? (b.filter(x => x.net > 0).length / b.length * 100).toFixed(1) : '—'}%`);
  if (a.length >= 60) scored.push([name, fn, mean(a.map(x => x.net))]);
}
// ── 5. 兩兩組合（訓練挑前 8，樣本外驗） ──
console.log('\n表 3｜兩濾網組合：訓練段淨均前 8（n≥60），樣本外驗證');
const combos = [];
for (let i = 0; i < FILTERS.length; i++) for (let j = i + 1; j < FILTERS.length; j++) {
  const fn = x => FILTERS[i][1](x) && FILTERS[j][1](x); const a = trF.filter(fn);
  if (a.length >= 60) combos.push([`${FILTERS[i][0]} ＋ ${FILTERS[j][0]}`, fn, mean(a.map(x => x.net)), a.length]);
}
combos.sort((a, b) => b[2] - a[2]);
for (const [name, fn, m, n] of combos.slice(0, 8)) { const b = ooF.filter(fn); console.log(`${name} ｜訓練 n=${n} 淨均 ${f2(m)}% ｜樣本外 n=${b.length} 淨均 ${f2(mean(b.map(x => x.net)))}% 勝率 ${b.length ? (b.filter(x => x.net > 0).length / b.length * 100).toFixed(1) : '—'}% 停損2% ${f2(mean(b.map(x => x.s2)))}%`); }
writeFileSync(`${CACHE}/trades.json`, JSON.stringify(trades));
process.exit(0);
