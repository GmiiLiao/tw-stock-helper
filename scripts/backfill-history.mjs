#!/usr/bin/env node
// ============================================================
// One-time (throttled) backfill of ~3 years of daily bars into the
// Firestore "stockHistory" collection — the cloud tier of the second brain.
//
// Usage:
//   1) Authenticate once (local):  gcloud auth application-default login
//   2) node --env-file=.env.local scripts/backfill-history.mjs [--limit N] [--codes 2330,2317] [--delay 400]
//
// Notes:
// - Uses the Admin SDK with Application Default Credentials, so it bypasses
//   Firestore security rules (no need to open public writes). On a machine
//   without ADC, set GOOGLE_APPLICATION_CREDENTIALS to a service-account key.
// - Pulls each stock's 3y history from Yahoo Finance in a single request,
//   then writes one doc per code. Re-runnable (overwrites/merges by date).
// ============================================================

import { readFileSync } from 'node:fs';
import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ── tiny .env.local loader (fallback when --env-file isn't used) ──
function loadEnv() {
  if (process.env.NEXT_PUBLIC_FIREBASE_API_KEY) return;
  try {
    const txt = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
}
loadEnv();

// ── args ──
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const LIMIT = parseInt(getArg('--limit', '0'), 10) || 0;
const DELAY = parseInt(getArg('--delay', '400'), 10) || 400;
const ONLY_CODES = (getArg('--codes', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const YEARS = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── firebase admin (ADC) ──
const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

if (!PROJECT_ID) {
  console.error('✖ Missing project id. Run with: node --env-file=.env.local scripts/backfill-history.mjs');
  process.exit(1);
}

let app;
try {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  app = svc
    ? initializeApp({ credential: cert(JSON.parse(svc)), projectId: PROJECT_ID })
    : initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
} catch (e) {
  console.error('✖ Admin init failed. Run `gcloud auth application-default login` first, or set');
  console.error('  GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT. Detail:', e.message);
  process.exit(1);
}
const db = getFirestore(app);

// ── helpers ──
const isRegular = code => /^\d{4}$/.test(code) && !['00', '01'].some(p => code.startsWith(p));

async function fetchYahoo(symbol, p1, p2) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${p1}&period2=${p2}&includePrePost=false`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://finance.yahoo.com/' } });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.chart?.result?.[0] ?? null;
  } catch { return null; }
}

function toBars(result) {
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const { open = [], high = [], low = [], close = [], volume = [] } = q;
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (open[i] == null || high[i] == null || low[i] == null || close[i] == null) continue;
    const tw = new Date(new Date(ts[i] * 1000).toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const d = `${tw.getFullYear()}-${String(tw.getMonth() + 1).padStart(2, '0')}-${String(tw.getDate()).padStart(2, '0')}`;
    bars.push({ d, o: +open[i].toFixed(2), h: +high[i].toFixed(2), l: +low[i].toFixed(2), c: +close[i].toFixed(2), v: Math.round(volume[i] ?? 0) });
  }
  return bars;
}

async function getStockList() {
  if (ONLY_CODES.length) return ONLY_CODES.map(code => ({ code, name: '' }));
  const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const arr = await res.json();
  return arr.filter(x => isRegular(x.Code)).map(x => ({ code: x.Code, name: x.Name }));
}

// ── main ──
(async () => {
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - Math.ceil(YEARS * 365.25) * 86400;

  let list = await getStockList();
  if (LIMIT > 0) list = list.slice(0, LIMIT);
  console.log(`▶ Backfilling ${list.length} stocks (${YEARS}y daily, ~${DELAY}ms/stock)…`);

  let ok = 0, empty = 0, fail = 0;
  for (let i = 0; i < list.length; i++) {
    const { code, name } = list[i];
    try {
      let r = await fetchYahoo(`${code}.TW`, p1, p2);
      let market = 'tse';
      let bars = r ? toBars(r) : [];
      if (bars.length === 0) {
        r = await fetchYahoo(`${code}.TWO`, p1, p2);
        bars = r ? toBars(r) : [];
        market = 'otc';
      }
      if (bars.length === 0) { empty++; }
      else {
        await db.collection('stockHistory').doc(code).set({
          code, name, market,
          bars,
          firstDate: bars[0].d,
          lastDate: bars[bars.length - 1].d,
          updatedAt: Date.now(),
        });
        ok++;
      }
    } catch (e) {
      fail++;
      console.warn(`  ✖ ${code} ${name}: ${e.message}`);
    }
    if ((i + 1) % 50 === 0) console.log(`  …${i + 1}/${list.length} (ok=${ok} empty=${empty} fail=${fail})`);
    await sleep(DELAY);
  }
  console.log(`✓ Done. ok=${ok} empty=${empty} fail=${fail}`);
  process.exit(0);
})();
