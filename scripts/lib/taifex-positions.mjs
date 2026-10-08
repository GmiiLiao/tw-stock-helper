// ─────────────────────────────────────────────────────────────────────────
// 外資台指期未平倉（taifexPositions/latest 的外資部分）——純函式＋請求描述，不碰檔案（2026-10-08）
//   舊版（ai-daemon trackTaifex）POST futContractsDate 拿整頁 HTML，取「最後一個『外資』字樣後第 5 個數字」——
//   實際取到的是外資及陸資在 23 種期貨商品的「交易口數淨額」合計（研究：scripts/sara-lab/taifex_foreign_oi.py
//   daemon_style_trade_net_sum；10-07 舊值 −21,459、正確值 −79,101），卻寫進 foreignTxfNetOI、網站標「外資期貨淨部位」。
//   正確口徑：期交所「三大法人－區分各期貨契約」臺股期貨（TX）× 外資及陸資的未平倉淨口數＝多方未平倉口數 − 空方未平倉口數
//   （與 CSV 的「多空未平倉口數淨額」欄互相核對，不一致就拒收）。
//   來源：與官方鏡像 taifex_fut_contracts 同一支 CSV 端點（futContractsDateDown，cp950），依欄名取值、不猜位置；
//   資料日一律用 CSV 自報的「日期」欄（回聲≠期望日＝notYet，不把別天的值寫成期望日）。
//   文件加 basisVersion：舊文件沒有這個欄＝舊口徑（交易淨額合計），讀者一律不顯示其 foreignTxfNetOI（舊值沒有歷史可修）。
// 單元測試：node --test scripts/lib/taifex-positions.test.mjs
// ─────────────────────────────────────────────────────────────────────────

import { TAIFEX_POSITIONS_BASIS, isCurrentTaifexBasis } from './taifex-basis.mjs';

export { TAIFEX_POSITIONS_BASIS, isCurrentTaifexBasis };
export const TAIFEX_FUT_CONTRACTS_URL = 'https://www.taifex.com.tw/cht/3/futContractsDateDown';
export const TAIFEX_TIMEOUT_MS = 20_000;

const COL = Object.freeze({
  date: '日期', product: '商品名稱', who: '身份別',
  tradeNet: '多空交易口數淨額', longOI: '多方未平倉口數', shortOI: '空方未平倉口數', netOI: '多空未平倉口數淨額',
});
const PRODUCT_TX = '臺股期貨';
const WHO_FOREIGN = '外資及陸資';

const slash = iso => String(iso).replace(/-/g, '/');
const isoOf = s => { const m = String(s ?? '').trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const intOf = s => { const t = String(s ?? '').replace(/[,\s]/g, ''); return /^-?\d+$/.test(t) ? Number(t) : null; };

/** 與官方鏡像 adapters-dated.mjs taifex_fut_contracts 相同的請求（全部商品；約 5KB）；signal 一律帶逾時 */
export function futContractsRequest(iso, timeoutMs = TAIFEX_TIMEOUT_MS) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) throw new Error(`日期格式不符：${iso}`);
  const d = slash(iso);   // 與官方鏡像逐字相同（斜線不編碼；鏡像 8 個交易日 CSV 已驗證這個請求）
  const body = `queryStartDate=${d}&queryEndDate=${d}&commodityId=`;   // 期交所表單欄名（不是文件欄位）
  return {
    url: TAIFEX_FUT_CONTRACTS_URL,
    init: { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(timeoutMs) },
  };
}

/** 位元組（官方 cp950）或字串 → 文字 */
function textOf(input) {
  if (typeof input === 'string') return input;
  if (input == null) return '';
  const buf = Buffer.from(input);
  try { return new TextDecoder('big5').decode(buf); } catch { return buf.toString('utf8'); }
}

/** CSV → { idx, body:[cells[]] }；表頭缺必要欄回 { missing } */
function table(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].includes(COL.date)) return { empty: true };
  const head = lines[0].split(',').map(s => s.trim());
  const idx = Object.fromEntries(Object.entries(COL).map(([k, name]) => [k, head.indexOf(name)]));
  const missing = Object.entries(idx).filter(([, i]) => i < 0).map(([k]) => COL[k]);
  if (missing.length) return { missing };
  const need = Math.max(...Object.values(idx));
  return { idx, body: lines.slice(1).map(l => l.split(',').map(s => s.trim())).filter(c => c.length > need) };
}

/**
 * futContractsDateDown CSV → 臺股期貨×外資及陸資的未平倉
 * @returns {{status:'ok'|'notYet'|'invalid', dataDate:string|null, longOI?:number, shortOI?:number, netOI?:number, tradeNet?:number, reason:string|null}}
 */
export function parseForeignTxfOI(input, expectIso) {
  const t = table(textOf(input));
  if (t.empty) return { status: 'notYet', dataDate: null, reason: '查無資料（沒有表頭）' };
  if (t.missing) return { status: 'invalid', dataDate: null, reason: `欄位不符：缺 ${t.missing.join('、')}` };
  if (!t.body.length) return { status: 'notYet', dataDate: null, reason: '只有表頭（官方尚未出表）' };
  const dates = new Set(t.body.map(c => isoOf(c[t.idx.date])));
  if (dates.size !== 1 || dates.has(null)) return { status: 'invalid', dataDate: null, reason: `日期欄不一致或認不得（${[...dates].slice(0, 3).join('、')}）` };
  const dataDate = [...dates][0];
  if (expectIso && dataDate !== expectIso) return { status: 'notYet', dataDate, reason: `回聲 ${dataDate}≠${expectIso}` };
  const row = t.body.find(c => c[t.idx.product] === PRODUCT_TX && c[t.idx.who] === WHO_FOREIGN);
  if (!row) return { status: 'invalid', dataDate, reason: `找不到「${PRODUCT_TX}×${WHO_FOREIGN}」列` };
  const longOI = intOf(row[t.idx.longOI]); const shortOI = intOf(row[t.idx.shortOI]);
  const netCol = intOf(row[t.idx.netOI]); const tradeNet = intOf(row[t.idx.tradeNet]);
  if ([longOI, shortOI, netCol, tradeNet].some(v => v == null)) return { status: 'invalid', dataDate, reason: '數字欄認不得' };
  const netOI = longOI - shortOI;
  if (netOI !== netCol) return { status: 'invalid', dataDate, reason: `淨額欄 ${netCol} ≠ 多方 ${longOI} − 空方 ${shortOI}` };
  return { status: 'ok', dataDate, longOI, shortOI, netOI, tradeNet, reason: null };
}

/** 舊 daemon 口徑（只供對照與測試）：外資及陸資在所有期貨商品的「交易口數淨額」合計 */
export function foreignTradeNetSumOf(input) {
  const t = table(textOf(input));
  if (!t.idx) return null;
  return t.body.filter(c => c[t.idx.who] === WHO_FOREIGN).reduce((s, c) => s + (intOf(c[t.idx.tradeNet]) || 0), 0);
}

/**
 * taifexPositions/latest 文件。date＝期望資料日（YYYYMMDD；外資取得時即 CSV 自報日）；外資沒取得（notYet／invalid）時四個未平倉欄全為 null，
 * 原因寫在 foreignTxfStatus——不沿用別天的值（同一文件不可混兩個資料日）。putCallRatio 沿用既有解析（另一支端點）。
 */
export function taifexPositionsDoc({ expectYmd, foreign, putCallRatio = null }, nowMs = Date.now()) {
  const ok = foreign?.status === 'ok';
  return {
    updatedAt: nowMs,
    date: ok ? foreign.dataDate.replace(/-/g, '') : String(expectYmd || ''),
    basisVersion: TAIFEX_POSITIONS_BASIS,
    foreignTxfNetOI: ok ? foreign.netOI : null,
    foreignTxfLongOI: ok ? foreign.longOI : null,
    foreignTxfShortOI: ok ? foreign.shortOI : null,
    foreignTxfTradeNet: ok ? foreign.tradeNet : null,
    foreignTxfStatus: ok ? 'ok' : `${foreign?.status || 'failed'}：${String(foreign?.reason || '').slice(0, 80)}`,
    putCallRatio: putCallRatio ?? null,
  };
}

/**
 * 同一資料日重跑時合併（2026-10-08 審查 LOW）：trackTaifex 在 15:10 與 16:30 都會跑；後一輪期交所逾時、只拿到 P/C 時，
 *   整份 set() 會把前一輪已取得的「同一資料日」未平倉蓋成 null。cur＝Firestore 現有文件、next＝這一輪的 taifexPositionsDoc 結果。
 *   只在 cur 是現行口徑（basisVersion）且 date 相同時保留：未平倉四欄（cur 為 ok、next 不是 ok）、P/C（next 沒拿到、cur 有）。
 *   別天、舊口徑、cur 也沒取得 ⇒ 原樣回 next（不沿用別天的值）。
 */
export function mergeTaifexPositionsDoc(cur, next) {
  if (!next || !isCurrentTaifexBasis(cur) || String(cur.date || '') !== String(next.date || '')) return next;
  const keepOI = next.foreignTxfStatus !== 'ok' && cur.foreignTxfStatus === 'ok';
  const keepPc = next.putCallRatio == null && cur.putCallRatio != null;
  if (!keepOI && !keepPc) return next;
  return {
    ...next,
    ...(keepOI ? {
      foreignTxfNetOI: cur.foreignTxfNetOI ?? null, foreignTxfLongOI: cur.foreignTxfLongOI ?? null, foreignTxfShortOI: cur.foreignTxfShortOI ?? null,
      foreignTxfTradeNet: cur.foreignTxfTradeNet ?? null, foreignTxfStatus: 'ok',
    } : {}),
    ...(keepPc ? { putCallRatio: cur.putCallRatio } : {}),
  };
}
