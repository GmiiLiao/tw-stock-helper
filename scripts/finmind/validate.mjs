#!/usr/bin/env node
// ── FinMind 抽樣驗證：與官方鏡像（second-brain/official）／chipArchive 備份比對 ─────────────────
// 使用者 2026-10-08：「可下載的資料先下載2023-2026的部份，先驗證，其它的再找空閒時間下載」
//   ⇒ 每個資料集先 --sample 小樣本下載 → 本程式比對 → _validation.json status=pass，backfill 才允許大量下載。
// 比對方法（validator）：
//   kbar         分 K 彙總成日 K，開高低收與 chipArchive 完全相同（量只報告：2026-10-08 實測 FinMind 量約官方 92–94%）
//   tick         最後一筆成交價＝收盤（量只報告）
//   broker       分點每檔買進／賣出合計 vs 官方成交股數（分點不含鉅額 ⇒ 對 MI_INDEX −5%～+0.5%；對 chipArchive ±2%）
//   price-limit  上市比 TWT84U 當日、上櫃比前一交易日 dailyQuotes 的次日漲跌停
//   dividend     TWT49U＋exDailyQ 每一檔都在、前收與參考價相同
//   market-value 上櫃以收盤×發行股數（2% 內）
//   price-limit／market-value 的閘門只看 4 碼普通股；ETF（00 開頭）與其他（REITs、ETN）另列 byCategory
//     （2026-10-08 以目錄員樣本實測：FinMind 的 ETF 漲跌停用錯檔位，上市 ETF 只對 9/83；4 碼股 1,120/1,137）
//   structural   官方沒有對應資料：列數、必要欄位、每列日期＝請求日
// 用法：node scripts/finmind/validate.mjs --dataset <name> [--dates d1,d2] [--route stock] [--root <dir>]
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOURCE_LABEL, getSpec } from './datasets.mjs';
import { datasetDir, forEachRow, groupPaths, readJson, writeJsonAtomic } from './store.mjs';
import { createLocalData, num, tableRows } from './localdata.mjs';

const TOL = { vol: 0.03, broker: 0.02, brokerBelowMi: 0.05, brokerAboveMi: 0.005, mv: 0.02 };
const PASS = { kbar: 0.95, tick: 0.95, broker: 0.9, 'price-limit': 0.98, dividend: 0.99, 'market-value': 0.9 };
const MAX_GROUPS = 10;
const MAX_MISMATCH = 10;
const NO_LIMIT = 9995;   // 官方無漲跌幅哨兵：ETF 9999.95、≥1000 元（檔位 5）個股 9995（2026-10-08 試抓實測 2645）

const eq = (a, b) => a != null && b != null && Number.isFinite(+a) && Math.abs(+a - +b) < 1e-6;
const within = (a, b, tol) => Number.isFinite(+a) && Number(b) > 0 && Math.abs(+a / +b - 1) <= tol;

function verdict(kind, checked, matched, extra = {}) {
  const ratio = checked ? matched / checked : null;
  const status = !checked ? 'no-official' : ratio >= PASS[kind] ? 'pass' : 'fail';
  return { status, checked, matched, ratio, ...extra };
}

/** 代號分類：研究主體是 4 碼普通股；ETF（00 開頭）與其他（REITs、ETN、權證等）另計。 */
//   4 碼的 0050～0057 是 ETF（2026-10-08 試抓實測：舊規則 /^\d{4}$/ 把它們算進 4 碼股，ETF 檔位錯誤混進閘門）
export const categoryOf = code => (/^[1-9]\d{3}$/.test(code) ? 'stock4' : /^00/.test(code) ? 'etf' : 'other');

/** 分類統計：閘門只看 4 碼股（有的話），ETF／其他照列，讓已知的分類性錯誤看得見。 */
function tally() {
  const by = {};
  return {
    add(code, ok) { const c = categoryOf(code); const x = (by[c] ||= { checked: 0, matched: 0 }); x.checked += 1; if (ok) x.matched += 1; },
    gate() { return by.stock4 || Object.values(by).reduce((a, x) => ({ checked: a.checked + x.checked, matched: a.matched + x.matched }), { checked: 0, matched: 0 }); },
    by,
  };
}

const median = xs => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// ── 串流彙總 ──
export function createAgg(kind) {
  const m = new Map();
  const get = (k, init) => { let x = m.get(k); if (!x) { x = init(); m.set(k, x); } return x; };
  const adders = {
    kbar: r => {
      const x = get(String(r.stock_id), () => ({ first: null, last: null, high: -Infinity, low: Infinity, vol: 0, n: 0 }));
      if (!x.first || r.minute < x.first.minute) x.first = r;
      if (!x.last || r.minute > x.last.minute) x.last = r;
      x.high = Math.max(x.high, +r.high); x.low = Math.min(x.low, +r.low); x.vol += +r.volume || 0; x.n += 1;
    },
    tick: r => {
      const x = get(String(r.stock_id), () => ({ last: null, vol: 0, n: 0 }));
      if (!x.last || String(r.Time) >= String(x.last.Time)) x.last = r;
      x.vol += +r.volume || 0; x.n += 1;
    },
    broker: r => { const x = get(String(r.stock_id), () => ({ buy: 0, sell: 0, n: 0 })); x.buy += +r.buy || 0; x.sell += +r.sell || 0; x.n += 1; },
    rows: r => { get('*', () => []).push(r); },
  };
  const add = adders[kind] || adders.rows;
  const result = () => {
    if (kind === 'kbar') return new Map([...m].map(([k, x]) => [k, { open: +x.first.open, high: x.high, low: x.low, close: +x.last.close, vol: x.vol, n: x.n }]));
    if (kind === 'tick') return new Map([...m].map(([k, x]) => [k, { close: +x.last.deal_price, vol: x.vol, n: x.n }]));
    if (kind === 'broker') return m;
    return m.get('*') || [];
  };
  return { add, result };
}

// ── 比對器 ──
/** 分 K／逐筆共用：價格是閘門；量只報告（實測 FinMind 分 K／逐筆量約為官方的 92–94%，口徑不同）。 */
function comparePriceVol(kind, agg, { close, quotes }, priceOk) {
  const t = tally(); let volOk = 0, missingOfficial = 0; const mismatches = []; const volRatios = [];
  for (const [code, f] of agg) {
    const ref = close?.get(code) || quotes?.get(code);
    if (!ref || ref.close == null) { missingOfficial += 1; continue; }
    const ok = priceOk(f, ref);
    t.add(code, ok);
    if (!ok && mismatches.length < MAX_MISMATCH) mismatches.push({ code, finmind: f, official: ref });
    const lots = close?.get(code)?.lots;
    if (lots > 0) volRatios.push(f.vol / lots);
    if (within(f.vol, lots, TOL.vol) || within(f.vol * 1000, quotes?.get(code)?.shares, TOL.vol)) volOk += 1;
  }
  const g = t.gate();
  return verdict(kind, g.checked, g.matched, { byCategory: t.by, volOk, volRatioMedian: median(volRatios), missingOfficial, mismatches });
}

export function compareKbar(agg, refs) {
  return comparePriceVol('kbar', agg, refs, (f, r) => eq(f.open, r.open) && eq(f.high, r.high) && eq(f.low, r.low) && eq(f.close, r.close));
}

export function compareTick(agg, refs) {
  return comparePriceVol('tick', agg, refs, (f, r) => eq(f.close, r.close));
}

/** 分點合計 vs 官方：分點不含鉅額交易 ⇒ 對 MI_INDEX 股數只會偏低（容許 −5%～+0.5%）；對 chipArchive 張數×1000 容許 ±2%。 */
const brokerOk = (v, shares, lots) => (Number(shares) > 0 && v >= shares * (1 - TOL.brokerBelowMi) && v <= shares * (1 + TOL.brokerAboveMi)) || within(v, lots * 1000, TOL.broker);

export function compareBroker(agg, { close, quotes }) {
  const t = tally(); let missingOfficial = 0; const mismatches = []; const ratios = [];
  for (const [code, f] of agg) {
    const shares = quotes?.get(code)?.shares; const lots = close?.get(code)?.lots;
    if (!(shares > 0) && !(lots > 0)) { missingOfficial += 1; continue; }
    const ok = brokerOk(f.buy, shares, lots) && brokerOk(f.sell, shares, lots);
    t.add(code, ok);
    if (shares > 0) ratios.push(f.buy / shares);
    if (!ok && mismatches.length < MAX_MISMATCH) mismatches.push({ code, buy: f.buy, sell: f.sell, officialShares: shares ?? null, chipLots: lots ?? null });
  }
  const g = t.gate();
  return verdict('broker', g.checked, g.matched, { byCategory: t.by, buyToMiSharesMedian: median(ratios), missingOfficial, mismatches });
}

export function comparePriceLimit(rows, { twt84u, otcPrev }) {
  if (!twt84u && !otcPrev) return verdict('price-limit', 0, 0);
  const t = tally(); const mismatches = [];
  for (const r of rows) {
    const code = String(r.stock_id);
    const a = twt84u?.get(code); const o = otcPrev?.get(code);
    const ref = a ? { up: a.up, down: a.down } : o ? { up: o.nextUp, down: o.nextDown } : null;
    if (!ref || !(+r.limit_up > 0) || !(ref.up > 0) || ref.up >= NO_LIMIT) continue;
    const ok = eq(r.limit_up, ref.up) && eq(r.limit_down, ref.down);
    t.add(code, ok);
    if (!ok && categoryOf(code) === 'stock4' && mismatches.length < MAX_MISMATCH) mismatches.push({ code, finmind: { up: r.limit_up, down: r.limit_down }, official: ref });
  }
  const g = t.gate();
  return verdict('price-limit', g.checked, g.matched, { byCategory: t.by, mismatches });
}

export function compareDividend(rows, { official }) {
  if (!official) return verdict('dividend', 0, 0);
  const fm = new Map(rows.map(r => [String(r.stock_id), r]));
  if (!official.size && !fm.size) return { status: 'agree-empty', checked: 0, matched: 0, ratio: null };
  let matched = 0; const mismatches = [];
  for (const [code, o] of official) {
    const f = fm.get(code);
    if (f && eq(f.before_price, o.before) && eq(f.after_price, o.after)) matched += 1;
    else if (mismatches.length < MAX_MISMATCH) mismatches.push({ code, finmind: f ? { before: f.before_price, after: f.after_price } : null, official: o });
  }
  const extra = [...fm.keys()].filter(k => !official.has(k));
  if (!official.size) return { status: 'fail', checked: 0, matched: 0, ratio: null, extra, mismatches };
  return verdict('dividend', official.size, matched, { extra, mismatches });
}

export function compareMarketValue(rows, { quotes }) {
  const t = tally(); const mismatches = [];
  for (const r of rows) {
    const code = String(r.stock_id);
    const q = quotes?.get(code);
    if (!q || q.market !== 'otc' || !(q.issued > 0) || !(q.close > 0)) continue;
    const expect = q.close * q.issued;
    const ok = within(r.market_value, expect, TOL.mv);
    t.add(code, ok);
    if (!ok && categoryOf(code) === 'stock4' && mismatches.length < MAX_MISMATCH) mismatches.push({ code, finmind: r.market_value, official: expect });
  }
  const g = t.gate();
  return verdict('market-value', g.checked, g.matched, { byCategory: t.by, mismatches });
}

export function checkStructural(spec, g, st) {
  const problems = [];
  if (!st.rows && !spec.emptyOk) problems.push('0 列');
  if (st.rows && st.cols) { const miss = spec.cols.filter(c => !st.cols.includes(c)); if (miss.length) problems.push(`缺欄位 ${miss.join('、')}`); }
  if (st.badDates) problems.push(`${st.badDates} 列日期不在請求範圍`);
  return { status: problems.length ? 'fail' : 'pass', rows: st.rows, problems };
}

export function overallStatus(results) {
  if (results.some(r => r.status === 'fail')) return 'fail';
  return results.some(r => r.status === 'pass') ? 'pass' : 'insufficient';
}

// ── 官方資料讀取 ──
export function readTwt84u(ld, date) {
  const pl = ld.mirrorPayload('www.twse.com.tw', 'twse_twt84u', date);
  if (!pl?.fields) return null;
  const f = pl.fields.map(s => String(s).trim());
  const [iCode, iUp, iRef, iDown] = ['證券代號', '漲停價', '開盤競價基準', '跌停價'].map(k => f.indexOf(k));
  return new Map((pl.data || []).map(r => [String(r[iCode]).trim(), { up: num(r[iUp]), ref: num(r[iRef]), down: num(r[iDown]) }]));
}

export function readExRights(ld, date) {
  const t = ld.mirrorPayload('www.twse.com.tw', 'twse_twt49u', date);
  const o = ld.mirrorPayload('www.tpex.org.tw', 'tpex_bulletin_exdailyq', date);
  if (!t || !o) return null;   // 兩市都要有官方資料才比（少一邊會誤判 FinMind 多出來）
  const m = new Map();
  for (const r of tableRows(t, f => f.includes('股票代號') && f.includes('除權息參考價'))) m.set(String(r['股票代號']).trim(), { before: num(r['除權息前收盤價']), after: num(r['除權息參考價']) });
  for (const r of tableRows(o, f => f.includes('代號') && f.includes('除權息參考價'))) m.set(String(r['代號']).trim(), { before: num(r['除權息前收盤價']), after: num(r['除權息參考價']) });
  return m;
}

const prevDay = (days, d) => { const i = days.indexOf(d); return i > 0 ? days[i - 1] : null; };

function officialCompare(spec, g, agg, ld, days) {
  const d = g.date;
  switch (spec.validator) {
    case 'kbar': return compareKbar(agg, { close: ld.closeFor(d), quotes: ld.officialQuotes(d) });
    case 'tick': return compareTick(agg, { close: ld.closeFor(d), quotes: ld.officialQuotes(d) });
    case 'broker': return compareBroker(agg, { close: ld.closeFor(d), quotes: ld.officialQuotes(d) });
    case 'price-limit': { const p = prevDay(days, d); return comparePriceLimit(agg, { twt84u: readTwt84u(ld, d), otcPrev: p ? ld.officialQuotes(p) : null }); }
    case 'dividend': return compareDividend(agg, { official: readExRights(ld, d) });
    case 'market-value': return compareMarketValue(agg, { quotes: ld.officialQuotes(d) });
    default: return null;
  }
}

function listGroups(dir) {
  const out = new Set();
  const walk = d => { for (const f of (existsSync(d) ? readdirSync(d) : [])) { if (/^\d{4}$/.test(f)) walk(join(d, f)); const m = f.match(/^(.+?)(?:\.part)?\.idx\.tsv$/); if (m) out.add(m[1]); } };
  walk(dir);
  return [...out].sort().reverse();
}

/** 驗證一個資料集：回傳並寫入 _validation.json。 */
export async function validateDataset({ spec, root, ld, dates = null, route = 'broker', days = [], now = Date.now }) {
  const variant = spec.mode === 'broker-day' && route === 'stock' ? 'by-stock' : null;
  const names = dates?.length ? dates : listGroups(datasetDir(root, spec.name, variant)).slice(0, MAX_GROUPS);
  const kind = ['kbar', 'tick', 'broker'].includes(spec.validator) ? spec.validator : 'rows';
  const groups = [];
  for (const name of names) {
    const paths = groupPaths(root, spec.name, name, variant);
    const g = { group: name, date: /^\d{4}-\d{2}-\d{2}$/.test(name) ? name : null };
    const agg = createAgg(kind); let cols = null; let badDates = 0;
    const rows = await forEachRow(paths, r => {
      if (!cols && r && typeof r === 'object') cols = Object.keys(r);
      if (g.date && r?.date && String(r.date).slice(0, 10) !== g.date) badDates += 1;
      agg.add(r);
    });
    const structural = checkStructural(spec, g, { rows, cols, badDates });
    const partialDay = spec.validator === 'broker' && !variant && !existsSync(paths.final);
    const official = structural.status === 'fail' || partialDay || !g.date ? null : officialCompare(spec, g, agg.result(), ld, days);
    const status = structural.status === 'fail' ? 'fail' : partialDay ? 'partial' : official ? official.status : structural.status;
    groups.push({ group: name, status, rows, structural, official });
  }
  const res = { dataset: spec.name, method: spec.validator, route: spec.mode === 'broker-day' ? route : null, status: overallStatus(groups), checkedAt: new Date(now()).toISOString(),
    thresholds: { pass: PASS[spec.validator] ?? null, tolerance: TOL }, source: SOURCE_LABEL, groups };
  writeJsonAtomic(join(datasetDir(root, spec.name), '_validation.json'), res);
  return res;
}

export function validationOk(root, spec) {
  return readJson(join(datasetDir(root, spec.name), '_validation.json'), null)?.status === 'pass';
}

// ── CLI ──
async function main() {
  const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const root = resolve(arg('--root') || join(repo, 'second-brain', 'finmind'));
  const spec = getSpec(arg('--dataset'));
  const ld = createLocalData({ backup: join(repo, 'second-brain', 'backup'), official: join(repo, 'second-brain', 'official'), finmind: root });
  const dates = arg('--dates') ? arg('--dates').split(',').map(s => s.trim()).filter(Boolean) : null;
  const res = await validateDataset({ spec, root, ld, dates, route: arg('--route') || 'broker', days: ld.tradingDays() });
  for (const g of res.groups) {
    const o = g.official;
    const cat = o?.byCategory ? `｜分類 ${Object.entries(o.byCategory).map(([k, v]) => `${k} ${v.matched}/${v.checked}`).join('、')}` : '';
    const vol = o?.volRatioMedian != null ? `｜量／官方張數 中位 ${o.volRatioMedian.toFixed(3)}` : o?.buyToMiSharesMedian != null ? `｜買進合計／MI 股數 中位 ${o.buyToMiSharesMedian.toFixed(3)}` : '';
    console.log(`${g.status === 'pass' ? '✓' : g.status === 'fail' ? '✖' : '·'} ${spec.name} ${g.group} ${g.status} 列 ${g.rows}${o ? `｜官方比對 ${o.matched}/${o.checked}${cat}${vol}` : ''}${g.structural.problems.length ? `｜${g.structural.problems.join('；')}` : ''}`);
  }
  console.log(`${res.status === 'pass' ? '✓' : '✖'} ${spec.name} 驗證 ${res.status}（${res.method}）→ ${join(datasetDir(root, spec.name), '_validation.json')}｜${SOURCE_LABEL}`);
  process.exit(res.status === 'pass' ? 0 : res.status === 'fail' ? 1 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(`✖ ${e.message}`); process.exit(1); });
}
