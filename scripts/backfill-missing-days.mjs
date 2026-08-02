#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 定向回補「被誤判為休市」的交易日 —— 2026-08-02
//
// 事故：2026-03-10／03-13／03-25／05-20 四天 chipArchive 完全沒有 doc，
//   sync-trading-calendar 的「空洞＝臨時休市」推論把它們列入 tradingCalendar。
//   但獨立查證 MI_5MINS：四天皆有 3,241 列委託統計與 860~1,169 萬股成交量
//   ——**都有開盤**，空洞是我方歸檔失敗。只有 07-10 是真休市（0 列）。
//
// 錯誤會自我強化：一旦被判休市 → isTradingDay() 回 false → 不再嘗試補抓
//   → 空洞永久化。四個假日曆條目污染了所有吃 chipArchive 的回測母體。
//
// 本腳本：對指定日期重抓 上市收盤(MI_INDEX ALLBUT0999)＋上櫃收盤(TPEx)
//   ＋法人(T86)，重建 chipArchive/{date}。
// 用法：node scripts/backfill-missing-days.mjs 2026-03-10 2026-03-13 ...
// ─────────────────────────────────────────────────────────────────────────
import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS ||=
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const _num = v => { const n = parseFloat(String(v ?? '').replace(/[,\s]/g, '')); return isNaN(n) ? 0 : n; };
const rocToYmd = s => { const m = String(s).match(/(\d{2,3})\/(\d{1,2})\/(\d{1,2})/); return m ? `${+m[1] + 1911}${String(+m[2]).padStart(2, '0')}${String(+m[3]).padStart(2, '0')}` : ''; };

async function J(url, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' }, signal: ctl.signal }).finally(() => clearTimeout(tm));
      if (r.status === 307 || r.status === 429 || r.status >= 500) { await sleep(3000 * (a + 1)); continue; }
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await sleep(2500);
  }
  return null;
}

/** 上市全市場收盤（含 OHLC）：MI_INDEX type=ALLBUT0999 */
async function fetchTseClose(ymd8) {
  const j = await J(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd8}&type=ALLBUT0999&response=json`);
  if (!j || j.stat !== 'OK') return { rows: [], why: j?.stat || 'no data' };
  // 回音驗證：標題民國日期須等於請求日
  // 回音驗證：新版 rwd 回 `date` 欄位（YYYYMMDD），舊版只有民國標題，兩種都比對
  if (j.date && String(j.date) !== ymd8) return { rows: [], why: `日期回音不符(${j.date})` };
  const m = (j.title || '').match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (m) {
    const got = `${+m[1] + 1911}${String(+m[2]).padStart(2, '0')}${String(+m[3]).padStart(2, '0')}`;
    if (got !== ymd8) return { rows: [], why: `日期回音不符(${got})` };
  }
  // rwd 新版格式：所有表包在 `tables` 陣列裡（舊版是 fieldsN/dataN，兩種都收）。
  // 個股表＝欄位含「收盤價」且列數最多的那張（實測 table8「每日收盤行情(全部)」1,344 檔）。
  const tables = [];
  for (const t of (Array.isArray(j.tables) ? j.tables : [])) {
    if (Array.isArray(t.fields) && Array.isArray(t.data) && t.fields.some(x => /收盤價/.test(x))) tables.push({ f: t.fields, d: t.data, title: t.title || '' });
  }
  for (let i = 1; i <= 12; i++) {
    const f = j[`fields${i}`], d = j[`data${i}`];
    if (Array.isArray(f) && Array.isArray(d) && f.some(x => /收盤價/.test(x))) tables.push({ f, d, title: '' });
  }
  if (Array.isArray(j.fields) && Array.isArray(j.data) && j.fields.some(x => /收盤價/.test(x))) tables.push({ f: j.fields, d: j.data, title: j.title || '' });
  const T = tables.sort((a, b) => b.d.length - a.d.length)[0];
  if (!T) return { rows: [], why: '找不到個股表' };
  const idx = n => T.f.findIndex(x => x.includes(n));
  const iC = idx('證券代號'), iV = idx('成交股數'), iO = idx('開盤價'), iH = idx('最高價'), iL = idx('最低價'), iP = idx('收盤價');
  const rows = [];
  for (const r of T.d) {
    const code = String(r[iC] ?? '').trim();
    if (!/^\d{4}$/.test(code)) continue;
    const c = _num(r[iP]);
    if (c > 0) rows.push({ code, close: c, vol: _num(r[iV]), open: _num(r[iO]), high: _num(r[iH]), low: _num(r[iL]) });
  }
  return { rows };
}

/** 上櫃全市場收盤 */
async function fetchTpexClose(ymd8) {
  const roc = `${+ymd8.slice(0, 4) - 1911}/${ymd8.slice(4, 6)}/${ymd8.slice(6, 8)}`;
  const j = await J(`https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=${encodeURIComponent(roc)}&o=json`);
  const arr = j?.aaData || [];
  if (j?.reportDate && j.reportDate !== roc) return { rows: [], why: `TPEx 日期回音不符(${j.reportDate})` };
  const rows = [];
  for (const r of arr) {
    const code = String(r[0] ?? '').trim();
    if (!/^\d{4}$/.test(code)) continue;
    const c = _num(r[2]);
    if (c > 0) rows.push({ code, close: c, vol: _num(r[8]), open: _num(r[4]), high: _num(r[5]), low: _num(r[6]) });
  }
  return { rows };
}

/** 三大法人（上市 T86）→ {code:[外資,投信,自營]} 張 */
async function fetchInst(ymd8) {
  const j = await J(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${ymd8}&selectType=ALL`);
  if (!j || j.stat !== 'OK') return {};
  const m = (j.title || '').match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (m) {
    const got = `${+m[1] + 1911}${String(+m[2]).padStart(2, '0')}${String(+m[3]).padStart(2, '0')}`;
    if (got !== ymd8) return {};
  }
  const out = {};
  for (const r of (j.data || [])) {
    const code = String(r[0] ?? '').trim();
    if (!/^\d{4}$/.test(code)) continue;
    // 欄位：外資買賣超(4)、投信買賣超(10)、自營商買賣超(11 或合計欄)，以股計 → 轉張
    const f = _num(r[4]) + _num(r[7]);   // 外資(不含自營)+外資自營
    const t = _num(r[10]);
    const d = _num(r[11]) || 0;
    out[code] = [Math.round(f / 1000), Math.round(t / 1000), Math.round(d / 1000)];
  }
  return out;
}

const main = async () => {
  const dates = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!dates.length) { console.log('用法：node scripts/backfill-missing-days.mjs 2026-03-10 [更多日期…]'); process.exit(1); }
  console.log(`▶ 定向回補 ${dates.length} 個交易日\n`);
  for (const iso of dates) {
    const ymd8 = iso.replace(/-/g, '');
    const tse = await fetchTseClose(ymd8); await sleep(1500);
    const tpex = await fetchTpexClose(ymd8); await sleep(1500);
    const inst = await fetchInst(ymd8); await sleep(1500);
    const all = [...tse.rows, ...tpex.rows];
    if (all.length < 500) {
      console.log(`  ${iso} ✖ 收盤資料不足（上市 ${tse.rows.length}${tse.why ? '/' + tse.why : ''}、上櫃 ${tpex.rows.length}${tpex.why ? '/' + tpex.why : ''}）— 跳過，不寫入殘缺資料`);
      continue;
    }
    const close = {};
    for (const r of all) close[r.code] = [r.close, Math.round(r.vol / 1000), r.open, r.high, r.low];
    const doc = {
      date: iso,
      closeJson: JSON.stringify(close),
      n: Object.keys(close).length,
      ...(Object.keys(inst).length ? { instJson: JSON.stringify(inst) } : {}),
      backfilledAt: Date.now(),
      backfillNote: '2026-08-02 定向回補：此日曾因歸檔失敗無 doc，並被交易日曆誤判為臨時休市',
    };
    await db.collection('chipArchive').doc(iso).set(doc, { merge: true });
    console.log(`  ${iso} ✓ 上市 ${tse.rows.length}＋上櫃 ${tpex.rows.length} = ${doc.n} 檔｜法人 ${Object.keys(inst).length} 檔`);
  }
  process.exit(0);
};
main();
