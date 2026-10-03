// 官方除權除息計算結果表（區間查詢）→ 還原係數。backfill-exright-history.mjs 與 scoring-v3-shadow.mjs 共用。
//   上市 TWSE rwd exRight/TWT49U（GET、title 回聲區間）；上櫃 TPEx www bulletin/exDailyQ（POST 區間）。兩者皆已登錄核准。
//   factor＝除權息參考價 ÷ 除權息前收盤價（事件日「之前」的價格 × factor ≈ 事件後口徑，與 price-factors.mjs 同義）。
//   任一來源失敗或欄位／回聲對不上就 throw（呼叫端不得以「空表＝沒有除權息」繼續）。

const UA = { 'User-Agent': 'Mozilla/5.0' };
const FACTOR_MIN = 0.3, FACTOR_MAX = 1.2;
const num = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : null; };
const rocToIso = s => { const m = String(s || '').match(/^(\d{2,3})\D(\d{1,2})\D(\d{1,2})/); return m ? `${+m[1] + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const rocOf = iso => `${+iso.slice(0, 4) - 1911}年${iso.slice(5, 7)}月${iso.slice(8, 10)}日`;

function toItem(date, code, prev, ref, from, to) {
  code = String(code || '').trim();
  if (!date || !code || !(prev > 0) || !(ref > 0) || date < from || date > to) return null;
  const factor = ref / prev;
  return factor >= FACTOR_MIN && factor <= FACTOR_MAX && factor !== 1 ? { date, code, factor: +factor.toFixed(6) } : null;
}

async function twse(from, to) {
  const u = `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${from.replace(/-/g, '')}&endDate=${to.replace(/-/g, '')}&response=json`;
  const j = await (await fetch(u, { headers: { ...UA, Referer: 'https://www.twse.com.tw/' }, signal: AbortSignal.timeout(30000) })).json();
  if (j?.stat !== 'OK') throw new Error(`TWSE 除權息 stat=${j?.stat}`);
  const t = String(j.title || ''); if (!t.startsWith(rocOf(from)) || !t.includes(rocOf(to))) throw new Error(`TWSE 除權息區間回聲不符：${t}`);
  const f = j.fields || []; const iD = f.indexOf('資料日期'), iC = f.indexOf('股票代號'), iP = f.indexOf('除權息前收盤價'), iR = f.indexOf('除權息參考價');
  if ([iD, iC, iP, iR].some(i => i < 0)) throw new Error('TWSE 除權息欄位對不上');
  const data = j.data || [];
  return { raw: data.length, items: data.map(r => toItem(rocToIso(r[iD]), r[iC], num(r[iP]), num(r[iR]), from, to)).filter(Boolean) };
}

async function tpex(from, to) {
  const body = new URLSearchParams({ startDate: from.replace(/-/g, '/'), endDate: to.replace(/-/g, '/'), response: 'json' });
  const j = await (await fetch('https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ', { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30000) })).json();
  const tb = j?.tables?.[0]; if (j?.stat !== 'ok' || !tb) throw new Error(`TPEx 除權息 stat=${j?.stat}`);
  const f = tb.fields || []; const iD = f.indexOf('除權息日期'), iC = f.indexOf('代號'), iP = f.indexOf('除權息前收盤價'), iR = f.indexOf('除權息參考價');
  if ([iD, iC, iP, iR].some(i => i < 0)) throw new Error('TPEx 除權息欄位對不上');
  // TPEx 沒有區間標題 ⇒ 以資料日期落在請求區間為回聲（toItem 已濾區間外的列）
  const data = tb.data || [];
  return { raw: data.length, items: data.map(r => toItem(rocToIso(r[iD]), r[iC], num(r[iP]), num(r[iR]), from, to)).filter(Boolean) };
}

/** 區間內上市＋上櫃除權息 → { counts, items:[[日期, 代號, factor]] }（同檔同日去重、依日期排序） */
export async function fetchExright(from, to, { gapMs = 3000 } = {}) {
  const a = await twse(from, to);
  await new Promise(r => setTimeout(r, gapMs));
  const b = await tpex(from, to);
  const seen = new Set(); const items = [];
  for (const x of [...a.items, ...b.items].sort((p, q) => p.date.localeCompare(q.date) || p.code.localeCompare(q.code))) {
    const k = `${x.date}:${x.code}`; if (seen.has(k)) continue; seen.add(k); items.push([x.date, x.code, x.factor]);
  }
  return { counts: { twse: { raw: a.raw, used: a.items.length }, tpex: { raw: b.raw, used: b.items.length } }, items };
}

/** 官方除權息 items ＋ priceEvents（減資／面額變更）→ factorsFromItems 可吃的清單；同檔同日以官方除權息為準（不重複乘） */
export function mergeFactorItems(exItems, priceEventItems) {
  const exKeys = new Set(exItems.map(([d, c]) => `${d}:${c}`));
  const pe = (priceEventItems || []).filter(e => e.factor > 0 && !exKeys.has(`${e.date}:${e.code}`));
  return [...exItems.map(([date, code, factor]) => ({ date, code, factor })), ...pe];
}

/**
 * 官方除權息 items → (日期, 代號) ⇒ factor 查表（2026-10-03 持股「近 5 日漲跌合計」用）。
 *   applied：已套在日線上的 priceEvents 係數 { code:[{date,factor}] }——同檔同日略過，避免重複乘。
 *   cover：{ from, to } 查詢涵蓋的區間；區間外回 undefined（＝不知道有沒有除權息），區間內沒有事件回 null。
 */
export function exFactorLookup(exItems, applied = {}, cover = null) {
  const done = new Set(Object.entries(applied || {}).flatMap(([c, evs]) => (evs || []).map(e => `${e.date}:${c}`)));
  const m = new Map();
  for (const [d, c, f] of exItems || []) { const k = `${d}:${c}`; if (f > 0 && !done.has(k)) m.set(k, f); }
  return (date, code) => (cover && (date < cover.from || date > cover.to) ? undefined : m.get(`${date}:${code}`) ?? null);
}
