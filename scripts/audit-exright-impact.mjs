#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 除權息未還原的影響面量測（2026-09-30；唯讀）
//   priceEvents/latest 只收相鄰收盤 ±20% 的結構事件 ⇒ 一般除權息（1~6%）在各消費端都是「假跳空」。
//   本腳本以真實歸檔逐一量測每個消費端：窗內跨除權息的檔日數、平均失真、特徵／榜單／規則的變動。
//   比較兩個口徑：現況＝priceEvents 係數；修正＝官方除權息（exright-history.json）＋priceEvents（mergeFactorItems）。
//   唯讀 Firestore（chipArchive 收盤、priceEvents/latest、aiSwingLab），不打上游、不寫 Firestore。
//   daemon 三個榜（做空候選／dailySeq／波段持有）只重算「價格導出」的部分（其餘輸入沒有逐日歸檔），報告中註明。
//   用法：node scripts/audit-exright-impact.mjs [--days 420] [--cache 快取.json] [--out docs/EXRIGHT-IMPACT-<日>.md]
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPriceFactors, factorsFromItems } from './lib/price-factors.mjs';
import { mergeFactorItems } from './lib/exright-source.mjs';
import { dailyFeatures, learn } from './lib/ai-lab-learn.mjs';
import { horizonOutcome, SWING_HORIZONS } from './lib/ai-swing-lab.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DAYS = +arg('--days', 420);
const CACHE = arg('--cache', null);
const OUT = arg('--out', null);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const YEAR = 245;                 // 近一年交易日（榜單量測窗）
const LEARN_DAYS = 320;           // ai-lab-learn 預設 LEARN_DAYS
const MIN_CODES = 1500;           // 殘缺日門檻（同 ai-lab-learn／v3 驗證器）

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = xs => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return v[Math.floor((v.length - 1) / 2)]; };
const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const pct = (a, b) => (b ? `${(a / b * 100).toFixed(1)}%` : '—');

function initDb() {
  if (!getApps().length) {
    const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    initializeApp(p ? { credential: cert(JSON.parse(readFileSync(p, 'utf8'))) } : {});
  }
  return getFirestore();
}

// ── 1. 資料 ──
async function load() {
  if (CACHE && existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, 'utf8'));
  const db = initDb();
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS).select('date', 'closeJson').get();
  const docs = snap.docs.map(d => d.data()).map(a => ({ date: a.date, m: a.closeJson ? JSON.parse(a.closeJson) : null })).reverse();
  const pe = (await db.collection('priceEvents').doc('latest').get()).data() || {};
  const lab = (await db.collection('aiSwingLab').orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data())
    .map(x => ({ date: x.date, pool: (x.pool || []).map(c => c.code), picks: (x.picks || []).map(p => ({ code: p.code, shares: p.position?.shares ?? 0 })),
      buyFills: x.buyFills || {}, sellFills: Object.fromEntries(Object.entries(x.sellFills || {}).map(([k, v]) => [k, { date: v?.date ?? null, px: v?.px ?? null }])),
      sells: (x.review?.sells || []).map(s => s.key) }));
  const data = { docs, pe: { items: pe.items || [], window: pe.window || null, dataDate: pe.dataDate || null }, lab };
  if (CACHE) writeFileSync(CACHE, JSON.stringify(data));
  return data;
}

// ── 2. 事件與兩個口徑 ──
function prepare(data) {
  const ex = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'exright-history.json'), 'utf8'));
  const good = data.docs.filter(d => d.m && Object.keys(d.m).length >= MIN_CODES);
  const first = good[0].date, last = good[good.length - 1].date;
  const exIn = ex.items.filter(([d]) => d > first && d <= last);                        // 影響窗內價格的官方除權息
  const peItems = (data.pe.items || []).filter(e => e.factor > 0 && e.code && e.date);
  const peKey = new Set(peItems.map(e => `${e.date}:${e.code}`));
  const missing = exIn.filter(([d, c]) => !peKey.has(`${d}:${c}`));                    // 現況沒還原的
  const missBy = {}; for (const [d, c, fac] of missing) (missBy[c] ||= []).push({ date: d, factor: fac });
  const FPE = factorsFromItems(peItems), FALL = factorsFromItems(mergeFactorItems(exIn, peItems));
  return { ex, good, first, last, exIn, peItems, missing, missBy, PE: applyPriceFactors(good, FPE), ALL: applyPriceFactors(good, FALL) };
}
// code 在 (a, b] 之間有沒有「現況沒還原」的除權息（a<E≤b ⇒ 兩端只有一端被乘係數 ⇒ 報酬失真）
const crosses = (missBy, code, a, b) => (missBy[code] || []).some(e => e.date > a && e.date <= b);

// ── 3. 事件概況 ──
function eventStats(P) {
  const yearFrom = P.good[Math.max(0, P.good.length - YEAR)].date;
  const yr = P.missing.filter(([d]) => d > yearFrom);
  const drop = yr.map(([, , fac]) => (1 - fac) * 100);
  const byMonth = {}; for (const [d] of yr) byMonth[d.slice(0, 7)] = (byMonth[d.slice(0, 7)] || 0) + 1;
  const four = yr.filter(([, c]) => /^\d{4}$/.test(c)).length;
  return { yearFrom, n: yr.length, four, meanDrop: mean(drop), medDrop: median(drop), p90: [...drop].sort((a, b) => a - b)[Math.floor(drop.length * 0.9)] ?? null, byMonth, exInN: P.exIn.length, missN: P.missing.length };
}

// ── 3b. 日期對齊驗證：除權息日開盤 ÷（前一日收盤×factor）應貼近 1；日期錯一天就會偏離（官方表日期格式踩過雷）──
function alignment(P) {
  const idx = new Map(P.good.map((d, i) => [d.date, i]));
  const out = { '-1': [], 0: [], '+1': [], raw: [] };
  for (const [d, c, fac] of P.exIn) {
    const i = idx.get(d); if (i == null || i < 2 || i > P.good.length - 2 || !/^\d{4}$/.test(c) || fac > 0.995) continue;
    for (const [k, s] of [['-1', -1], [0, 0], ['+1', 1]]) { const pv = P.good[i + s - 1].m[c]?.[0], op = P.good[i + s].m[c]?.[2]; if (pv > 0 && op > 0) out[k].push(Math.abs(op / (pv * fac) - 1) * 100); }
    const pv = P.good[i - 1].m[c]?.[0], op = P.good[i].m[c]?.[2]; if (pv > 0 && op > 0) out.raw.push(Math.abs(op / pv - 1) * 100);
  }
  return { n: out[0].length, m0: median(out[0]), mPrev: median(out['-1']), mNext: median(out['+1']), mRaw: median(out.raw) };
}

// ── 4. 消費端 2：ai-lab-learn（波段樣本＝特徵＋5 日淨標籤）──
function learnSamples(days, labDocs) {
  const out = new Map(); const idx = new Map(days.map((d, i) => [d.date, i]));
  const add = (t, code, src) => {
    const k = `${days[t].date}:${code}`; if (out.has(k)) return;
    const F = dailyFeatures(days, t, code); if (!F) return;
    const o = horizonOutcome(days, days[t].date, code, 5); if (!o || o.net == null) return;
    out.set(k, { key: 'swing', date: days[t].date, code, t, f: F.f, raw: F.raw, y: o.net, entryDate: o.entryDate, exitDate: o.exitDate, src });
  };
  for (const d of labDocs) { const t = idx.get(d.date); if (t == null) continue; for (const c of d.pool) add(t, c, 'AI候選池'); }
  for (let t = 60; t < days.length - 5; t += 2) {
    for (const code in days[t].m) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const F = dailyFeatures(days, t, code);
      if (!F || !(F.raw.amtM >= 50) || !(F.raw.gain20 > 0) || !(F.raw.maAbove >= 2)) continue;
      add(t, code, '歷史母體');
    }
  }
  return out;
}

function consumerLearn(P, data, ST) {
  // 複製 ai-lab-learn 的讀取：最近 LEARN_DAYS+10 份歸檔 → 去殘缺日
  const docs = data.docs.slice(-(LEARN_DAYS + 10)).filter(d => d.m && Object.keys(d.m).length >= MIN_CODES);
  const from = docs[0].date;
  const cut = arr => arr.filter(d => d.date >= from);
  const dPE = cut(P.PE), dALL = cut(P.ALL);
  const sPE = learnSamples(dPE, data.lab), sALL = learnSamples(dALL, data.lab);
  const common = [...sPE.keys()].filter(k => sALL.has(k));
  // 跨除權息以事件日判定（a<E≤b）；其餘的微小差異是 applyPriceFactors 四捨五入到 0.01 元的雜訊（事件在樣本之後、兩端同乘）
  const diffs = [], noise = [], byMonth = {}; let flipsAny = 0, flipsNoise = 0, lookCross = 0; const flips = {};
  const structBy = {}; for (const x of ST.unexplained) (structBy[x.code] ||= []).push(x.date);
  let structHit = 0;
  for (const k of common) {
    const a = sPE.get(k), b = sALL.get(k);
    const dy = b.y - a.y; const m = a.date.slice(0, 7);
    byMonth[m] ||= { n: 0, cross: 0 }; byMonth[m].n++;
    if (crosses(P.missBy, a.code, a.entryDate, a.exitDate)) { diffs.push(dy); byMonth[m].cross++; } else noise.push(Math.abs(dy));
    const look0 = dPE[a.t - 60].date;
    const inLook = crosses(P.missBy, a.code, look0, a.date); if (inLook) lookCross++;
    let any = false;
    for (const fk of new Set([...Object.keys(a.f), ...Object.keys(b.f)])) if (a.f[fk] !== b.f[fk]) { if (inLook) flips[fk] = (flips[fk] || 0) + 1; any = true; }
    if (any) { if (inLook) flipsAny++; else flipsNoise++; }
    if ((structBy[a.code] || []).some(d => d > look0 && d <= a.exitDate)) structHit++;
  }
  const yPE = common.map(k => sPE.get(k).y), yALL = common.map(k => sALL.get(k).y);
  const LPE = learn([...sPE.values()]).swing, LALL = learn([...sALL.values()]).swing;
  const v = L => new Map((L?.rules || []).filter(r => r.status === 'validated').map(r => [r.id, r]));
  const vPE = v(LPE), vALL = v(LALL);
  return {
    window: [dPE[0].date, dPE[dPE.length - 1].date], nPE: sPE.size, nALL: sALL.size, common: common.length,
    onlyPE: sPE.size - common.length, onlyALL: sALL.size - common.length,
    cross: diffs.length, meanDiff: mean(diffs), medDiff: median(diffs), bias: mean(yALL) - mean(yPE), meanPE: mean(yPE), meanALL: mean(yALL),
    noiseMax: noise.length ? Math.max(...noise) : 0, noiseMean: mean(noise), lookCross, flipsNoise, structHit,
    flipsAny, flips, byMonth,
    base: { PE: LPE?.base, ALL: LALL?.base },
    rulesLost: [...vPE.values()].filter(r => !vALL.has(r.id)), rulesGained: [...vALL.values()].filter(r => !vPE.has(r.id)),
    rulesKept: [...vPE.values()].filter(r => vALL.has(r.id)).map(r => ({ r, s: vALL.get(r.id) })),
  };
}

// ── 5. 消費端 3a：做空候選（21 日窗；價格導出三項：當日跌＞2%、空頭排列、破 20 日低）──
function shortFlags(days, t, code) {
  const win = days.slice(t - 20, t + 1);
  const ser = win.map(d => d.m[code]).filter(r => Array.isArray(r) && r[0] > 0);
  if (ser.length < 21) return null;
  const avgAmt = ser.slice(-20).reduce((s, x) => s + x[0] * (x[1] || 0) * 1000, 0) / 20;
  if (avgAmt < 50_000_000) return null;
  const closes = ser.map(x => x[0]); const price = closes[20], prev = closes[19];
  const chg = (price - prev) / prev * 100;
  const ma = n => closes.slice(-n).reduce((s, x) => s + x, 0) / n;
  const low20 = Math.min(...closes.slice(-21, -1));
  const F = { chg: chg < -2, bear: ma(5) < ma(20) && price < ma(20), brk: price < low20 };
  return { ...F, pts: (F.chg ? 2 : 0) + (F.bear ? 4 : 0) + (F.brk ? 3 : 0) };
}
function consumerShort(P) {
  const L = P.good.length; const r = { days: 0, elig: 0, cross: 0, flip: { chg: 0, bear: 0, brk: 0 }, fakeOn: { chg: 0, bear: 0, brk: 0 }, fakePts: 0, anyFlip: 0 };
  for (let t = L - YEAR; t < L; t++) {
    r.days++;
    const w0 = P.good[t - 20].date, dt = P.good[t].date;
    for (const code in P.good[t].m) {
      const a = shortFlags(P.PE, t, code); if (!a) continue;
      r.elig++;
      if (!crosses(P.missBy, code, w0, dt)) continue;
      r.cross++;
      const b = shortFlags(P.ALL, t, code); if (!b) continue;
      let any = false;
      for (const k of ['chg', 'bear', 'brk']) if (a[k] !== b[k]) { r.flip[k]++; any = true; if (a[k] && !b[k]) r.fakeOn[k]++; }
      if (any) r.anyFlip++;
      r.fakePts += a.pts - b.pts;
    }
  }
  return r;
}

// ── 6. 消費端 3b：dailySeq（近 10 日漲跌序列＋5/20/60 日線位置；70 日窗）──
function seqOf(days, t, code) {
  const win70 = days.slice(Math.max(0, t - 69), t + 1);
  const cl = win70.map(d => d.m[code]?.[0]).filter(v => v > 0); if (cl.length < 2) return null;
  const c = cl[cl.length - 1];
  const ma = n => (cl.length >= n ? (c > cl.slice(-n).reduce((s, v) => s + v, 0) / n ? 1 : 0) : -1);
  const win = days.slice(t - 10, t + 1); const seq = [];
  for (let i = 1; i < win.length; i++) { const p = win[i - 1].m[code]?.[0], q = win[i].m[code]?.[0]; if (p > 0 && q > 0) seq.push(+(((q / p) - 1) * 100).toFixed(1)); }
  return { ma: [ma(5), ma(20), ma(60)], seq };
}
function consumerDailySeq(P) {
  const L = P.good.length; const r = { days: 0, codes: 0, seqFake: 0, seqFakeAbs: [], maFlip: [0, 0, 0], maAny: 0 };
  for (let t = L - YEAR; t < L; t++) {
    r.days++;
    const w0 = P.good[Math.max(0, t - 69)].date, dt = P.good[t].date;
    for (const code in P.good[t].m) {
      if (!/^\d{4,6}$/.test(code)) continue;
      r.codes++;
      if (!crosses(P.missBy, code, w0, dt)) continue;
      const a = seqOf(P.PE, t, code), b = seqOf(P.ALL, t, code); if (!a || !b) continue;
      const dif = a.seq.map((v, i) => b.seq[i] - v).filter(x => Math.abs(x) >= 0.1);
      if (dif.length) { r.seqFake++; r.seqFakeAbs.push(...dif.map(Math.abs)); }
      let any = false; a.ma.forEach((v, i) => { if (v !== b.ma[i]) { r.maFlip[i]++; any = true; } });
      if (any) r.maAny++;
    }
  }
  return r;
}

// ── 7. 消費端 3c：波段持有（5/10/20/60 日漲幅榜、每張淨額榜、整合榜；前 25）──
const HOLD_N = [5, 10, 20, 60], HOLD_TOP = 25;
function holdBoards(days, t, universe) {
  const boards = {};
  for (const N of HOLD_N) {
    const win = days.slice(t - N, t + 1); const rows = [];
    for (const code of universe) {
      const cl = win.map(d => d.m[code]?.[0]); if (cl.some(v => !(v > 0))) continue;
      const gain = (cl[N] / cl[0] - 1) * 100; if (!(gain > 0)) continue;
      rows.push({ code, gain, amt: (cl[N] - cl[0]) * 1000 });
    }
    rows.sort((a, b) => b.gain - a.gain);
    boards[N] = { gain: rows.slice(0, HOLD_TOP).map(x => x.code), amt: rows.filter(x => x.amt > 0).sort((a, b) => b.amt - a.amt).slice(0, HOLD_TOP).map(x => x.code), g: new Map(rows.map(x => [x.code, x.gain])) };
  }
  const combo = {};
  for (const N of HOLD_N) boards[N].gain.forEach((code, i) => { const c = (combo[code] ||= { code, boards: 0, score: 0 }); c.boards++; c.score += HOLD_TOP - i; });
  boards.combo = Object.values(combo).sort((a, b) => b.boards - a.boards || b.score - a.score).slice(0, HOLD_TOP).map(x => x.code);
  return boards;
}
function consumerSwingHold(P) {
  const L = P.good.length;
  const r = { days: 0, uni: 0, win: Object.fromEntries(HOLD_N.map(N => [N, { cross: 0, diffs: [], chGain: 0, chAmt: 0 }])), chCombo: 0, daysComboCh: 0 };
  for (let t = L - YEAR; t < L; t++) {
    r.days++;
    const amtDays = P.good.slice(t - 19, t + 1);
    const universe = Object.keys(P.good[t].m).filter(c => {
      if (!/^\d{4}$/.test(c)) return false;
      let s = 0, n = 0; for (const d of amtDays) { const x = d.m[c]; if (x && x[0] > 0) { s += x[0] * (x[1] || 0) * 1000; n++; } }
      return n && s / n >= 50_000_000;
    });
    r.uni += universe.length;
    const A = holdBoards(P.PE, t, universe), B = holdBoards(P.ALL, t, universe);
    for (const N of HOLD_N) {
      const w0 = P.good[t - N].date, dt = P.good[t].date;
      for (const code of universe) if (crosses(P.missBy, code, w0, dt)) {
        r.win[N].cross++;
        const ca = P.PE[t].m[code]?.[0], c0a = P.PE[t - N].m[code]?.[0], cb = P.ALL[t].m[code]?.[0], c0b = P.ALL[t - N].m[code]?.[0];
        if (ca > 0 && c0a > 0 && cb > 0 && c0b > 0) r.win[N].diffs.push(((cb / c0b) - (ca / c0a)) * 100);
      }
      const sA = new Set(A[N].gain), sAm = new Set(A[N].amt);
      r.win[N].chGain += B[N].gain.filter(c => !sA.has(c)).length;
      r.win[N].chAmt += B[N].amt.filter(c => !sAm.has(c)).length;
    }
    const sC = new Set(A.combo); const ch = B.combo.filter(c => !sC.has(c)).length;
    r.chCombo += ch; if (ch) r.daysComboCh++;
  }
  return r;
}

// ── 8. 消費端 1：AI 波段（研究結算 h 日＋帳戶實際部位的應得股利）──
function consumerSwingLab(P, data, learnWin) {
  // 研究結算口徑（D+1 開盤買、第 h 日收盤賣）：以經驗庫歷史母體的取樣日／檔（現況口徑）量各持有期跨除權息的比例與平均失真
  const docs = data.docs.slice(-(LEARN_DAYS + 10)).filter(d => d.m && Object.keys(d.m).length >= MIN_CODES);
  const from = docs[0].date;
  const dPE = P.PE.filter(d => d.date >= from), dALL = P.ALL.filter(d => d.date >= from);
  const hz = {};
  for (const h of SWING_HORIZONS) {
    const diffs = []; let n = 0, all = 0;
    for (let t = 60; t < dPE.length - h; t += 2) {
      for (const code in dPE[t].m) {
        if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
        const F = dailyFeatures(dPE, t, code);
        if (!F || !(F.raw.amtM >= 50) || !(F.raw.gain20 > 0) || !(F.raw.maAbove >= 2)) continue;
        const a = horizonOutcome(dPE, dPE[t].date, code, h), b = horizonOutcome(dALL, dALL[t].date, code, h);
        if (!a || !b) continue;
        n++; all += b.net - a.net;
        if (crosses(P.missBy, code, a.entryDate, a.exitDate)) diffs.push(b.net - a.net);
      }
    }
    hz[h] = { n, cross: diffs.length, meanDiff: mean(diffs), bias: n ? all / n : null };
  }
  // 帳戶實際部位：買進成交日 < 除權息日 ≤ 賣出成交日（未賣＝最新歸檔日）⇒ 真實交易會領到的股利（以前一日收盤×(1−factor) 估每股價值）
  const lastDate = P.good[P.good.length - 1].date;
  const lots = [];
  for (const d of data.lab) for (const p of d.picks) {
    const bf = d.buyFills?.[p.code]; if (!bf?.px || bf.failed) continue;
    const key = `${d.date}_${p.code}`;
    const sf = Object.values(data.lab).map(x => x.sellFills?.[key]).find(Boolean);
    const end = sf?.date || lastDate;
    const evs = (P.missBy[p.code] || []).filter(e => e.date > bf.date && e.date <= end);
    const shares = bf.shares ?? p.shares;
    const val = evs.reduce((s, e) => { const i = P.good.findIndex(g => g.date === e.date); const prev = i > 0 ? P.good[i - 1].m[p.code]?.[0] : null; return s + (prev > 0 ? prev * (1 - e.factor) * shares : 0); }, 0);
    lots.push({ key, code: p.code, buyDate: bf.date, end, shares, events: evs.map(e => e.date), divTwd: Math.round(val) });
  }
  return { hz, lots, learnWin };
}

// ── 9. priceEvents 視窗外的結構事件（±20% 且官方除權息解釋不了）──
function structural(P, data) {
  const ex = new Set(P.exIn.map(([d, c]) => `${d}:${c}`)), pe = new Set(P.peItems.map(e => `${e.date}:${e.code}`));
  const winFrom = data.pe.window?.from || null;
  const last = {}; const out = { n: 0, inPe: 0, byEx: 0, unexplained: [], olderThanPe: 0 };
  for (const d of P.good) for (const c in d.m) {
    const q = d.m[c]?.[0]; if (!(q > 0)) continue;
    const L = last[c];
    if (L && /^\d{4}$/.test(c)) {
      const r = q / L; if (r > 1.2 || r < 0.8) {
        out.n++; const k = `${d.date}:${c}`;
        if (pe.has(k)) out.inPe++; else if (ex.has(k)) out.byEx++; else { out.unexplained.push({ date: d.date, code: c, ratio: +r.toFixed(3) }); if (winFrom && d.date < winFrom) out.olderThanPe++; }
      }
    }
    last[c] = q;
  }
  return { ...out, peWindow: data.pe.window };
}

// ── 10. 報告 ──
function report(P, E, LR, SH, DS, HD, SL, ST, AL) {
  const L = [];
  const perYear = (x, days) => Math.round(x / days * YEAR);
  L.push(`# 除權息未還原的影響面量測（資料日 ${P.last}）`, '',
    '> 產生：`node scripts/audit-exright-impact.mjs`（唯讀）。現況＝priceEvents/latest 係數；修正＝官方除權息（exright-history.json）＋priceEvents（同檔同日以官方為準）。',
    `> 歸檔 ${P.good.length} 日（${P.first} ~ ${P.last}，<${MIN_CODES} 檔殘缺日剔除）；近一年＝最近 ${YEAR} 個交易日（${E.yearFrom} 之後）。`, '');
  L.push('## 事件', '',
    `- 近一年官方除權息 **${E.n} 件**現況未還原（4 位數代號 ${E.four} 件，其餘為 ETF／REIT 等）；除權息日跌幅（1−factor）平均 ${f(E.meanDrop)}%、中位 ${f(E.medDrop)}%、P90 ${f(E.p90)}%。`,
    `- 月分布（${E.yearFrom} 之後，首月不完整）：${Object.entries(E.byMonth).sort().map(([m, n]) => `${m.slice(2)} ${n}`).join('、')}`,
    `- priceEvents/latest 窗內事件 ${P.peItems.length} 件（有係數者），與官方除權息同檔同日 ${E.exInN - E.missN} 件（已還原，不重複乘）。`,
    `- 日期對齊驗證（4 位數代號、跌幅 ≥0.5% 的 ${AL.n} 件）：除權息日開盤 ÷（前一日收盤×factor）偏離中位數 **${f(AL.m0)}%**（一般隔夜波動）；未還原 ${f(AL.mRaw)}%；日期前移一天 ${f(AL.mPrev)}%、後移一天 ${f(AL.mNext)}% ⇒ 官方日期與係數對得上歸檔（上市／上櫃皆含）。`, '');

  L.push('## 影響總表', '',
    '| 消費端 | 窗口／口徑 | 跨除權息的樣本（近一年） | 平均失真 | 對輸出的影響 |', '|---|---|---|---|---|');
  L.push(`| ② 經驗庫 ai-lab-learn（波段樣本） | 特徵 60 日回看＋5 日淨標籤（D+1 開→第 5 日收） | 標籤 ${LR.cross} / ${LR.common}（${pct(LR.cross, LR.common)}）；特徵回看窗 ${LR.lookCross}（${pct(LR.lookCross, LR.common)}），其中分段翻轉 ${LR.flipsAny} | 標籤少算 ${f(LR.meanDiff)}pp（中位 ${f(LR.medDiff)}）；全樣本平均 ${f(LR.bias)}pp | 已驗證規則：失去 ${LR.rulesLost.length}、新增 ${LR.rulesGained.length}、保留 ${LR.rulesKept.length}（t 值小幅移動） |`);
  L.push(`| ③a 做空候選 shortCandidates | 21 日收盤（當日跌>2%／空頭排列／破 20 日低） | ${perYear(SH.cross, SH.days)} 檔日 / ${perYear(SH.elig, SH.days)} 流動性合格檔日（${pct(SH.cross, SH.elig)}） | 假訊號：當日跌 ${SH.fakeOn.chg}、空頭排列 ${SH.fakeOn.bear}、破低 ${SH.fakeOn.brk}（檔日） | 價格分合計多給 ${SH.fakePts} 分；有任一旗標翻轉 ${SH.anyFlip} 檔日（${pct(SH.anyFlip, SH.cross)} 的跨事件檔日） |`);
  const sAbs = mean(DS.seqFakeAbs);
  L.push(`| ③b dailySeq（自選列 10 日縮圖＋三線位置） | 10 日逐日漲跌、5/20/60 日線 | ${perYear(DS.seqFake, DS.days)} 檔日顯示假跌幅（平均每日 ${f(DS.seqFake / DS.days, 1)} 檔） | 假跌幅平均 ${f(sAbs)}% | 均線旗標翻轉 ${DS.maAny} 檔日（5 日 ${DS.maFlip[0]}／20 日 ${DS.maFlip[1]}／60 日 ${DS.maFlip[2]}） |`);
  for (const N of HOLD_N) {
    const w = HD.win[N];
    L.push(`| ③c 波段持有 swingHold ${N} 日 | 收盤→收盤漲幅、流動性宇宙 | ${perYear(w.cross, HD.days)} 檔日（宇宙的 ${pct(w.cross, HD.uni)}） | 漲幅少算 ${f(mean(w.diffs))}pp（中位 ${f(median(w.diffs))}） | 前 25 名每日平均換 ${f(w.chGain / HD.days)} 檔（淨額榜 ${f(w.chAmt / HD.days)}） |`);
  }
  L.push(`| ③c 波段持有 整合榜 | 四窗聯集 | — | — | 前 25 名每日平均換 ${f(HD.chCombo / HD.days)} 檔；${HD.daysComboCh}/${HD.days} 日有變動 |`);
  for (const h of SWING_HORIZONS) {
    const x = SL.hz[h];
    L.push(`| ① AI 波段·研究結算 ${h} 日 | D+1 開→第 ${h} 日收 | ${x.cross} / ${x.n}（${pct(x.cross, x.n)}） | 跨者少算 ${f(x.meanDiff)}pp；全體平均 ${f(x.bias)}pp | 研究數字與整池基準同向偏低（寫一次不改） |`);
  }
  L.push('');

  L.push('## ② 經驗庫細節', '',
    `- 訓練窗 ${LR.window[0]} ~ ${LR.window[1]}；樣本 現況 ${LR.nPE}／修正 ${LR.nALL}（共同 ${LR.common}；只在現況 ${LR.onlyPE}、只在修正 ${LR.onlyALL}——歷史母體的篩選條件本身用到 20 日漲幅與均線）。`,
    `- 5 日淨報酬平均（兩口徑的共同樣本；含篩選進出後的全樣本以 \`ai-lab-learn.mjs --dry\` 為準）：現況 ${f(LR.meanPE)}% → 修正 ${f(LR.meanALL)}%。`,
    `- 特徵分段翻轉（回看窗內有除權息的樣本）：${Object.entries(LR.flips).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('、') || '無'}；回看窗外只因四捨五入翻轉 ${LR.flipsNoise} 筆。`,
    `- 四捨五入雜訊（事件在樣本之後、兩端同乘係數，applyPriceFactors 取到 0.01 元）：標籤差異平均 ${f(LR.noiseMean, 4)}pp、最大 ${f(LR.noiseMax, 3)}pp。`,
    `- priceEvents 視窗外、官方除權息也解釋不了的 ±20% 結構事件落在特徵回看窗或標籤窗內的樣本：${LR.structHit} 筆（兩個口徑都沒還原）。`,
    `- 月別（標籤跨除權息比例）：${Object.entries(LR.byMonth).sort().map(([m, x]) => `${m.slice(2)} ${pct(x.cross, x.n)}`).join('、')}`, '');
  const rl = r => `${r.kind === 'risk' ? '⚠' : '✓'} ${r.label}（n=${r.n}、t=${r.t}、訓練 ${r.train.diff}／驗證 ${r.holdout.diff}）`;
  L.push('**失去驗證的規則（現況有、修正後無）**', '', ...(LR.rulesLost.length ? LR.rulesLost.map(r => `- ${rl(r)}`) : ['- 無']), '',
    '**新增驗證的規則（修正後才有）**', '', ...(LR.rulesGained.length ? LR.rulesGained.map(r => `- ${rl(r)}`) : ['- 無']), '',
    '**兩者皆驗證（t 值變化）**', '', ...(LR.rulesKept.length ? LR.rulesKept.map(({ r, s }) => `- ${r.kind === 'risk' ? '⚠' : '✓'} ${r.label}：t ${r.t} → ${s.t}、平均 ${r.mean} → ${s.mean}`) : ['- 無']), '');

  L.push('## ① AI 波段帳戶：實際部位的應得股利', '',
    SL.lots.length ? '| 部位 | 買進成交 | 至 | 股數 | 期間除權息 | 估計股利價值（元） |' : '- 目前沒有已成交部位。',
    ...(SL.lots.length ? ['|---|---|---|---|---|---|', ...SL.lots.map(l => `| ${l.key} | ${l.buyDate} | ${l.end} | ${l.shares} | ${l.events.join('、') || '—'} | ${l.divTwd || 0} |`)] : []), '');

  L.push('## priceEvents 視窗外的結構事件（兩個口徑都沒還原）', '',
    `- 歸檔窗內相鄰收盤 ±20%（4 位數代號）共 ${ST.n} 件：priceEvents 已收 ${ST.inPe}、官方除權息可解釋 ${ST.byEx}、無法解釋 ${ST.unexplained.length}（其中早於 priceEvents 視窗 ${ST.peWindow?.from || '—'} 的 ${ST.olderThanPe} 件）。`,
    `- priceEvents 視窗：${ST.peWindow ? `${ST.peWindow.from} ~ ${ST.peWindow.to}（${ST.peWindow.days} 日）` : '—'}；經驗庫訓練窗 ${LR.window[0]} 起 ⇒ 視窗外的減資／面額變更在經驗庫是未還原的。`,
    ...ST.unexplained.slice(0, 40).map(x => `  - ${x.date} ${x.code} ×${x.ratio}`), '');
  L.push('## 其他 priceEvents 讀者（本次不改，列出供追蹤）', '',
    '- `scripts/squeeze-train.mjs`：只拿 priceEvents 做「事件日 ±30 日樣本剔除」，不乘係數；一般除權息不在剔除範圍 ⇒ 除息股的 chg／ret5／brk20 同樣有假跌幅（樣本是漲停股，量級未量）。',
    '- `scoring-v3-validate.mjs`／`scoring-v3-shadow.mjs`：已合併官方除權息（前者讀 exright-history.json、後者每日自行查詢）。',
    '- `/api/ai/price-events`、稽核契約 `priceEvents`：只顯示／檢查事件表本身，不受影響。priceEvents/latest 的語意（±20%、90 個交易日窗）本次不動。', '');
  L.push('## 方法與限制', '',
    '- 「跨除權息」＝報酬區間 (a, b] 內有現況未還原的官方除權息日 E（a<E≤b ⇒ 只有起點被乘係數）。平均失真＝修正口徑減現況口徑（百分點，正值＝現況少算）。',
    '- 做空候選只重算三個價格旗標（處置／當沖資格／軋空／資券／法人／新聞等輸入沒有逐日歸檔）；波段持有只重算漲幅與前 25 名（名稱、均線小提示未比）。',
    '- 近一年檔日數＝逐日重算最近 245 個交易日的合計；「每日平均換 X 檔」＝修正後前 25 名中不在現況前 25 名的檔數。',
    '- 研究結算的 h 日樣本取自經驗庫歷史母體（每 2 日取樣、同一篩選），不是 AI 實際選股（實際記錄自 2026-09-24 起，尚無到期樣本足以統計）。', '',
    '非投資建議。');
  return L.join('\n');
}

const data = await load();
const P = prepare(data);
const E = eventStats(P);
const ST = structural(P, data);
const LR = consumerLearn(P, data, ST);
const SH = consumerShort(P);
const DS = consumerDailySeq(P);
const HD = consumerSwingHold(P);
const SL = consumerSwingLab(P, data, LR.window);
const md = report(P, E, LR, SH, DS, HD, SL, ST, alignment(P));
if (OUT) { writeFileSync(join(ROOT, OUT), md + '\n'); console.log(`✓ 報告 → ${OUT}`); } else console.log(md);
process.exit(0);
