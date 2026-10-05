// ─────────────────────────────────────────────────────────────────────────────
// ETF／興櫃官方日 K（AI 停損 stop-v1.1 第二輪 A3「3」；規範 .claude/skills/tw-ai-stoploss/SKILL.md §2A、實作計畫 §2.11）
//   讀第二大腦官方鏡像（second-brain/official；scripts/official-mirror.mjs 的 daily／retry／backfill 自動抓），
//   解析成與 chipArchive 同口徑的日 K（closeJson［收, 量張, 開, 高, 低］；bars {date,o,h,l,c,v張}）。
//   ETF（barArchiveOf(code)==='etf'：5～6 碼與英文字尾）：上市＝MI_INDEX type=ALLBUT0999「每日收盤行情」表；
//     上櫃＝dailyQuotes「上櫃股票行情」表。兩者都是可指定日期的 www 端點，鏡像 2022-07-18 起逐日有回聲。
//   興櫃（呼叫端告知 market:'emerging'）：官方沒有可指定日期的興櫃全表（2026-10-05 實測：emerging/historical 必須帶個股代號，
//     且只有最高／最低／均價、沒有最後成交價）⇒ 只能每日快照累積：PRIMARY＝www emerging/latest（tpex_emerging_latest），
//     FALLBACK＝openapi tpex_esb_latest_statistics；兩者都以官方回聲日為鍵。沒有開盤價（o＝null，closeJson 記 0）；收盤＝最後成交價。
// 規則：只讀本機檔（0 網路請求）、不 import firebase、不讀時鐘；每份都驗「官方回聲日＝鍵」，不符就丟並列進 problems（不捏造、不補值）。
// 還原：本模組回原始價；除權息與結構事件由 ai-stoploss adjustBars(raw, ex) 依 SKILL §7 的係數表處理。兩支涵蓋自檢（不取代係數表）：
//   refFactorItems＋uncoveredFactors：官方參考價推的除權息係數（上市 TWT84U 本日開盤競價基準÷前日收盤價、上櫃 dailyQuotes 次日參考價÷收盤）
//     對 exright-history.json，找係數表漏掉的除權息；
//   structuralBreaks：日 K 停止買賣後的大幅斷點＝分割／反分割候選（exright-history 沒有這類事件；2024-12 起 ETF 有 9 件）。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { fileURLToPath } from 'node:url';
import * as C from './official-mirror.mjs';
import { barArchiveOf, STRUCT_BREAK } from './ai-stoploss.mjs';

export const DEFAULT_OFFICIAL_ROOT = fileURLToPath(new URL('../../second-brain/official', import.meta.url));
const TWSE = 'www.twse.com.tw', TPEX = 'www.tpex.org.tw';
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 官方數字字串 → 數值；'--'、'---'、''、'X'、非數字 ⇒ null */
export function num(v) {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const pos = v => { const n = num(v); return n != null && n > 0 ? n : null; };
const colIdx = (fields, names) => names.map(n => fields.indexOf(n));
const keepFor = kind => (kind === 'emerging' ? c => barArchiveOf(c, 'emerging') === 'emerging' : kind === 'all' ? () => true : c => barArchiveOf(c) === 'etf');

/** 一列 → 統一列；沒有收盤（當日無成交）回 null——不拿前一日價充數 */
function rowOf(code, name, market, { o, h, l, c, shares }) {
  const close = pos(c);
  if (!close) return null;
  return { code, name: String(name ?? '').trim(), market, o: pos(o), h: pos(h), l: pos(l), c: close, shares: num(shares) ?? 0 };
}

// ── 解析：回 { status: ok|empty|mismatch|bad, echo, rows, note } ─────────────────

/** 上市 MI_INDEX（type=ALLBUT0999）：stat=OK、頂層 date 與「每日收盤行情」表 title 的民國日期一致（且＝expect） */
export function parseTwseMiIndex(payload, { expect = null, kind = 'etf' } = {}) {
  if (String(payload?.stat ?? '').toUpperCase() !== 'OK') return { status: 'bad', echo: null, rows: [], note: `stat=${payload?.stat}` };
  const need = ['證券代號', '證券名稱', '開盤價', '最高價', '最低價', '收盤價', '成交股數'];
  const t = (Array.isArray(payload.tables) ? payload.tables : []).find(x => Array.isArray(x?.fields) && need.every(f => x.fields.includes(f)));
  if (!t) return { status: 'bad', echo: null, rows: [], note: '找不到每日收盤行情表' };
  const top = C.normDate(payload.date);
  const head = C.normDate(String(t.title ?? '').match(/\d{2,3}年\d{1,2}月\d{1,2}日/)?.[0]);
  if (!top || top !== head) return { status: 'mismatch', echo: top, rows: [], note: `date=${payload.date} title=${String(t.title ?? '').slice(0, 20)}` };
  if (expect && top !== expect) return { status: 'mismatch', echo: top, rows: [], note: `回聲 ${top}≠${expect}` };
  const [iC, iN, iO, iH, iL, iK, iV] = colIdx(t.fields, need);
  const keep = keepFor(kind);
  const rows = (t.data || []).map(r => (keep(String(r[iC] ?? '').trim())
    ? rowOf(String(r[iC]).trim(), r[iN], 'tse', { o: r[iO], h: r[iH], l: r[iL], c: r[iK], shares: r[iV] }) : null)).filter(Boolean);
  return { status: rows.length ? 'ok' : 'empty', echo: top, rows, note: null };
}

/** 上櫃 dailyQuotes：stat=ok、頂層 date 與 tables[0].date（民國）一致（且＝expect）；同欄名的表（上櫃股票行情、管理股票）都收 */
export function parseTpexDailyQuotes(payload, { expect = null, kind = 'etf' } = {}) {
  if (String(payload?.stat ?? '').toLowerCase() !== 'ok') return { status: 'bad', echo: null, rows: [], note: `stat=${payload?.stat}` };
  const tables = Array.isArray(payload.tables) ? payload.tables : [];
  const need = ['代號', '名稱', '收盤', '開盤', '最高', '最低', '成交股數'];
  const use = tables.filter(x => Array.isArray(x?.fields) && need.every(f => x.fields.includes(f)));
  if (!use.length) return { status: 'bad', echo: null, rows: [], note: '找不到上櫃股票行情表' };
  const top = C.normDate(payload.date);
  const head = C.normDate(tables[0]?.date);
  if (!top || top !== head) return { status: 'mismatch', echo: top, rows: [], note: `date=${payload.date} tables[0].date=${tables[0]?.date}` };
  if (expect && top !== expect) return { status: 'mismatch', echo: top, rows: [], note: `回聲 ${top}≠${expect}` };
  const keep = keepFor(kind);
  const rows = use.flatMap(t => {
    const [iC, iN, iK, iO, iH, iL, iV] = colIdx(t.fields, need);
    return (t.data || []).map(r => (keep(String(r[iC] ?? '').trim())
      ? rowOf(String(r[iC]).trim(), r[iN], 'otc', { o: r[iO], h: r[iH], l: r[iL], c: r[iK], shares: r[iV] }) : null));
  }).filter(Boolean);
  return { status: rows.length ? 'ok' : 'empty', echo: top, rows, note: null };
}

/**
 * 興櫃 openapi tpex_esb_latest_statistics（陣列；每列自報民國 Date）：全表 Date 必須一致（且＝expect）。
 * 沒有開盤價（o＝null）；收盤＝LatestPrice（最後成交價）；當日沒有成交（TransactionVolume≤0）不成一根——LatestPrice 可能是舊成交。
 */
export function parseEsbOpenapi(payload, { expect = null, kind = 'emerging' } = {}) {
  const arr = Array.isArray(payload) ? payload : null;
  if (!arr) return { status: 'bad', echo: null, rows: [], note: '非陣列' };
  if (!arr.length) return { status: 'empty', echo: null, rows: [], note: null };
  const dates = new Set(arr.map(r => C.normDate(r?.Date)));
  if (dates.size !== 1 || dates.has(null)) return { status: 'mismatch', echo: null, rows: [], note: `Date 不一致：${[...dates].slice(0, 3).join(',')}` };
  const [echo] = dates;
  if (expect && echo !== expect) return { status: 'mismatch', echo, rows: [], note: `回聲 ${echo}≠${expect}` };
  const keep = keepFor(kind);
  const rows = arr.map(r => {
    const code = String(r?.SecuritiesCompanyCode ?? '').trim();
    if (!keep(code) || !(pos(r.TransactionVolume) > 0)) return null;
    return rowOf(code, r.CompanyName, 'emerging', { o: null, h: r.Highest, l: r.Lowest, c: r.LatestPrice, shares: r.TransactionVolume });
  }).filter(Boolean);
  return { status: rows.length ? 'ok' : 'empty', echo, rows, note: null };
}

/**
 * 興櫃 www emerging/latest（PRIMARY）：stat=ok、tables[0].date「115年10月05日 16:33:03」的民國日期＝expect。
 * 欄位依欄名：收盤＝「成交」（最後成交價）、日最高／日最低、成交量（股）；沒有開盤價；當日沒有成交不成一根。
 */
export function parseEsbWwwLatest(payload, { expect = null, kind = 'emerging' } = {}) {
  if (String(payload?.stat ?? '').toLowerCase() !== 'ok') return { status: 'bad', echo: null, rows: [], note: `stat=${payload?.stat}` };
  const t = (Array.isArray(payload.tables) ? payload.tables : [])[0];
  const need = ['代號', '名稱', '日最高', '日最低', '成交', '成交量'];
  if (!Array.isArray(t?.fields) || !need.every(f => t.fields.includes(f))) return { status: 'bad', echo: null, rows: [], note: '找不到興櫃當日行情表' };
  const echo = C.normDate(t.date);
  if (!echo) return { status: 'mismatch', echo: null, rows: [], note: `tables[0].date=${t.date}` };
  if (expect && echo !== expect) return { status: 'mismatch', echo, rows: [], note: `回聲 ${echo}≠${expect}` };
  const [iC, iN, iH, iL, iK, iV] = colIdx(t.fields, need);
  const keep = keepFor(kind);
  const rows = (t.data || []).map(r => {
    const code = String(r[iC] ?? '').trim();
    if (!keep(code) || !(pos(r[iV]) > 0)) return null;
    return rowOf(code, r[iN], 'emerging', { o: null, h: r[iH], l: r[iL], c: r[iK], shares: r[iV] });
  }).filter(Boolean);
  return { status: rows.length ? 'ok' : 'empty', echo, rows, note: null };
}

/**
 * 來源表：每個市場一列，alts 依序嘗試（第一個＝PRIMARY，其後＝FALLBACK；PRIMARY 缺或不符才用下一個，用了 FALLBACK 記一筆 problems）。
 * 鍵：帶日期資料集＝資料日；快照（snapshot，keyByEcho）＝官方回聲日，同回聲日內容變了另存 .rN（取最後一版）。
 */
const src = (host, id, parse, snapshot = false) => Object.freeze({ host, id, parse, snapshot });
export const BAR_SOURCES = Object.freeze({
  etf: Object.freeze([
    Object.freeze({ market: 'tse', alts: Object.freeze([src(TWSE, 'twse_mi_index', parseTwseMiIndex)]) }),
    Object.freeze({ market: 'otc', alts: Object.freeze([src(TPEX, 'tpex_dailyquotes', parseTpexDailyQuotes)]) }),
  ]),
  emerging: Object.freeze([
    Object.freeze({ market: 'emerging', alts: Object.freeze([src(TPEX, 'tpex_emerging_latest', parseEsbWwwLatest, true), src(TPEX, 'tpex_oa_tpex_esb_latest_statistics', parseEsbOpenapi, true)]) }),
  ]),
});
/** 交易日曆：上市 MI_INDEX 鏡像 status=ok 的鍵（官方回聲確認的交易日；不用日曆日推） */
export const CALENDAR_SOURCE = Object.freeze({ host: TWSE, id: 'twse_mi_index' });

/** 鏡像清單裡某日可讀的列：帶日期＝鍵本身；快照＝鍵或 鍵.rN 的最後一版（unchanged 指向 same 檔） */
function rowFor(man, date, snapshot) {
  const ok = r => r && (r.status === 'ok' || r.status === 'unchanged');
  if (!snapshot) return ok(man.rows?.[date]) ? { key: date, row: man.rows[date] } : null;
  const keys = Object.keys(man.rows || {}).filter(k => (k === date || k.startsWith(`${date}.r`)) && ok(man.rows[k]));
  keys.sort((a, b) => (Number(a.split('.r')[1] || 1) - Number(b.split('.r')[1] || 1)));
  const key = keys.at(-1);
  return key ? { key, row: man.rows[key] } : null;
}

/** 交易日清單（舊→新）：鏡像 MI_INDEX 回聲 ok 的日子 */
export function tradingDaysOf(root = DEFAULT_OFFICIAL_ROOT) {
  const man = C.loadManifest(root, CALENDAR_SOURCE.host, CALENDAR_SOURCE.id);
  return Object.keys(man.rows || {}).filter(k => YMD_RE.test(k) && man.rows[k]?.status === 'ok').sort();
}

/**
 * 逐交易日讀鏡像 → [{ date, ok, missing:[市場], counts:{市場:檔數}, rows, sources:[{id,key,echo,sha256}] }] 與 problems。
 * ok＝每個市場都有回聲相符的資料且至少 1 檔（市場組成閘門）。範圍：from／to（含）、lastN（取最後 N 個交易日）。
 */
export function readOfficialDays({ root = DEFAULT_OFFICIAL_ROOT, kind = 'etf', from = null, to = null, lastN = null, readEntry = C.readEntry } = {}) {
  const markets = BAR_SOURCES[kind];
  if (!markets) throw new Error(`未知的歸檔種類：${kind}`);
  let dates = tradingDaysOf(root).filter(d => (!from || d >= from) && (!to || d <= to));
  if (Number.isInteger(lastN) && lastN > 0) dates = dates.slice(-lastN);
  const mans = new Map(markets.flatMap(m => m.alts).map(a => [a.id, C.loadManifest(root, a.host, a.id)]));
  const problems = [];
  /** 一個來源、一天 → { parsed, hit } 或失敗原因 */
  const tryAlt = (a, date) => {
    const hit = rowFor(mans.get(a.id), date, a.snapshot);
    if (!hit) return { fail: { status: 'missing', note: '鏡像沒有這天' } };
    try {
      const parsed = a.parse(readEntry(root, a.host, a.id, hit.row.status === 'unchanged' ? hit.row.same : hit.row.file).payload, { expect: date, kind });
      return parsed.status === 'ok' ? { parsed, hit } : { fail: { status: parsed.status, note: parsed.note } };
    } catch (e) { return { fail: { status: 'bad', note: `讀檔失敗：${e.message}` } }; }
  };
  const days = dates.map(date => {
    const rows = []; const counts = {}; const missing = []; const sources = [];
    let pendingOnly = true;   // 缺的市場全是「鏡像還沒有這天」（尚未抓到，不是回聲不符或壞檔）
    for (const m of markets) {
      const fails = [];
      let got = null;
      for (const a of m.alts) {
        const r = tryAlt(a, date);
        if (r.parsed) { got = { a, ...r }; break; }
        fails.push({ date, market: m.market, id: a.id, ...r.fail });
      }
      if (!got) { missing.push(m.market); problems.push(...fails); if (fails.some(f => f.status !== 'missing')) pendingOnly = false; continue; }
      if (fails.length) problems.push(...fails.map(f => ({ ...f, status: `fallback:${f.status}`, note: `改用 ${got.a.id}${f.note ? `（${f.note}）` : ''}` })));
      counts[m.market] = got.parsed.rows.length;
      rows.push(...got.parsed.rows);
      sources.push({ id: got.a.id, key: got.hit.key, echo: got.parsed.echo, sha256: got.hit.row.sha256 ?? null });
    }
    const ok = missing.length === 0;
    return { date, ok, pending: !ok && pendingOnly, missing, counts, rows, sources };
  });
  return { kind, days, problems };
}

/** 一天的列 → chipArchive 同格式 closeJson：code → [收, 量張, 開(無＝0), 高, 低]（同 ai-daemon 收盤歸檔：量＝round(股/1000)） */
export function closeJsonOf(rows) {
  const out = {};
  for (const r of rows || []) if (r?.c > 0) out[r.code] = [r.c, Math.round((r.shares || 0) / 1000), r.o || 0, r.h || 0, r.l || 0];
  return out;
}

/** 逐日結果 → 代號 → 日 K（舊→新；{date,o,h,l,c,v張}，lineInputsOf／adjustBars 直接吃）。只收 ok 的日子（缺市場的日子整天不收，不半套）。 */
export function barsByCodeOf(days, codes = null) {
  const want = codes ? new Set(codes) : null;
  const out = {};
  for (const d of days || []) {
    if (!d.ok) continue;
    for (const r of d.rows) {
      if (want && !want.has(r.code)) continue;
      (out[r.code] ||= []).push({ date: d.date, o: r.o, h: r.h ?? r.c, l: r.l ?? r.c, c: r.c, v: Math.round((r.shares || 0) / 1000) });
    }
  }
  return out;
}

/** 讀鏡像 → { kind, barsByCode, days(不含 rows), problems }：ai-stoploss 組成線（ATR 帶、持有期最高收盤）用 */
export function readOfficialBars(opts = {}) {
  const { kind, days, problems } = readOfficialDays(opts);
  return { kind, barsByCode: barsByCodeOf(days, opts.codes || null), days: days.map(({ rows, ...d }) => d), problems };
}

const yieldLoop = () => new Promise(r => setImmediate(r));

/**
 * daemon 盤前供給用（使用者 2026-10-06 R8「ok 如建議」：ETF／興櫃日 K 由 daemon 盤前讀本機官方鏡像，0 次 Firestore 讀寫、0 上游請求）：
 * 截至 to（含）的最後 lastN 個交易日，依交易日切成 chunkDays 天一段讀，段與段之間讓出事件迴圈——readOfficialDays 是同步讀檔＋解壓＋
 * JSON 解析（ETF 80 個交易日一次讀完約 0.8 秒，會卡住 daemon 的報價迴圈）。驗證與 readOfficialBars 相同（逐份回聲、市場組成）。
 * 回 { kind, barsByCode, days（不含 rows）, problems, gates（archiveGates：閘門 ①②③） }。呼叫端依 gates 決定用不用（fail-closed）。
 */
export async function readOfficialBarsAsync({
  root = DEFAULT_OFFICIAL_ROOT, kind = 'etf', to = null, lastN = 80, codes = null, chunkDays = 10, readEntry = C.readEntry, pause = yieldLoop,
} = {}) {
  if (!BAR_SOURCES[kind]) throw new Error(`未知的歸檔種類：${kind}`);
  let dates = tradingDaysOf(root).filter(d => !to || d <= to);
  if (Number.isInteger(lastN) && lastN > 0) dates = dates.slice(-lastN);
  const step = Number.isInteger(chunkDays) && chunkDays > 0 ? chunkDays : 10;
  const days = []; const problems = [];
  for (let i = 0; i < dates.length; i += step) {
    const part = dates.slice(i, i + step);
    const r = readOfficialDays({ root, kind, from: part[0], to: part[part.length - 1], readEntry });
    days.push(...r.days); problems.push(...r.problems);
    if (i + step < dates.length) await pause();
  }
  return { kind, barsByCode: barsByCodeOf(days, codes), days: days.map(({ rows: _rows, ...d }) => d), problems, gates: archiveGates(days) };
}

/**
 * 歸檔文件（Firestore etfDailyArchive／emergingDailyArchive 的 doc 內容，由整合端寫入；本模組不寫 Firestore）：
 * date＝官方回聲日；closeJson 字串同 chipArchive；counts 市場組成；sources 官方檔鍵與雜湊；只產 ok 的日子。
 */
export function archiveDocsOf(days, kind) {
  return (days || []).filter(d => d.ok).map(d => ({
    date: d.date, kind, closeJson: JSON.stringify(closeJsonOf(d.rows)), counts: { ...d.counts },
    sources: d.sources.map(s => ({ ...s })), source: 'official',
  }));
}

/**
 * 驗證閘門（SKILL §2A ①②③；④⑤⑥ 需 daemon 快照與稽核契約，由整合端做）：
 *   ① 每份回聲日＝鍵（readOfficialDays 已逐份驗，不符的日子 ok=false）；
 *   ② 最近連續 ≥minRun 個交易日 ok（MA20、ATR14 都有值）；③ 市場組成：每個市場每天都有貢獻（同 ok）。
 *   最後 ≤2 個交易日若只是「鏡像還沒抓到」（pending）不算斷，記在 pendingTail。
 */
export function archiveGates(days, { minRun = 20, maxPendingTail = 2 } = {}) {
  const list = days || [];
  let i = list.length - 1; let pendingTail = 0;
  // 最後 ≤maxPendingTail 個交易日只是「還沒抓到」（鏡像 daily 22:40、retry 隔日 06:45 才補）：不算斷，但也不算進連續天數
  while (i >= 0 && !list[i].ok && list[i].pending && pendingTail < maxPendingTail) { pendingTail++; i--; }
  let tailRun = 0;
  for (; i >= 0 && list[i].ok; i--) tailRun++;
  const bad = list.filter(d => !d.ok).map(d => ({ date: d.date, missing: [...d.missing], pending: !!d.pending }));
  return { tailRun, pendingTail, minRun, pass: tailRun >= minRun, lastDate: list.at(-1)?.date ?? null, bad };
}

// ── 官方參考價係數（係數表涵蓋自檢用） ──────────────────────────────────────

const FACTOR_EPS = 0.0005;
const factorOf = (ref, base) => (ref && base && Math.abs(ref / base - 1) > FACTOR_EPS ? +(ref / base).toFixed(6) : null);

/**
 * 上市 TWT84U 一日 → [[date, code, factor]]：本日開盤競價基準 ÷ 前日收盤價（欄名重複，依 groups「本日」「前日」定位）。
 * 只收「前一交易日有成交」的列（最近成交日＝prevDay）：ETF 沒有成交時，開盤競價基準跟著淨值走（實測 00625K 每天變），不是除權息——
 * 停止買賣期間的分割／反分割因此不在這裡，改由 structuralBreaks 從日 K 斷點找。
 */
export function twt84uFactors(payload, { expect = null, prevDay = null, kind = 'etf' } = {}) {
  if (String(payload?.stat ?? '').toUpperCase() !== 'OK') return [];
  const echo = C.normDate(payload.date);
  if (!echo || (expect && echo !== expect) || C.normDate(String(payload.title ?? '').match(/\d{2,3}年\d{1,2}月\d{1,2}日/)?.[0]) !== echo) return [];
  const f = payload.fields || []; const g = payload.groups || [];
  const inGroup = (title, name) => { const gr = g.find(x => x.title === title); if (!gr) return -1; for (let i = gr.start; i < gr.start + gr.span; i++) if (f[i] === name) return i; return -1; };
  const iC = f.indexOf('證券代號'), iRef = inGroup('本日', '開盤競價基準'), iPc = inGroup('前日', '收盤價'), iLast = f.indexOf('最近成交日');
  if ([iC, iRef, iPc, iLast].some(i => i < 0)) return [];
  const keep = keepFor(kind); const out = [];
  for (const r of payload.data || []) {
    const code = String(r[iC] ?? '').trim(); if (!keep(code)) continue;
    if (prevDay && C.normDate(r[iLast]) !== prevDay) continue;
    const fac = factorOf(pos(r[iRef]), pos(r[iPc]));
    if (fac) out.push([echo, code, fac]);
  }
  return out;
}

/** 上櫃 dailyQuotes 一日 → 下一交易日的係數 [[nextDay, code, 次日參考價÷收盤]]；當日沒有成交的列略過（理由同上） */
export function dailyQuotesNextFactors(payload, { expect = null, nextDay = null, kind = 'etf' } = {}) {
  if (!nextDay || String(payload?.stat ?? '').toLowerCase() !== 'ok') return [];
  const t = (payload.tables || [])[0]; const f = t?.fields || [];
  const echo = C.normDate(payload.date);
  if (!echo || echo !== C.normDate(t?.date) || (expect && echo !== expect)) return [];
  const iC = f.indexOf('代號'), iK = f.indexOf('收盤'), iV = f.indexOf('成交股數'), iRef = f.findIndex(x => /^次日\s*參考價$/.test(String(x)));
  if ([iC, iK, iV, iRef].some(i => i < 0)) return [];
  const keep = keepFor(kind); const out = [];
  for (const r of t.data || []) {
    const code = String(r[iC] ?? '').trim(); if (!keep(code)) continue;
    if (!(pos(r[iV]) > 0)) continue;
    const fac = factorOf(pos(r[iRef]), pos(r[iK]));
    if (fac) out.push([nextDay, code, fac]);
  }
  return out;
}

/** 鏡像 → 官方參考價推得的 ETF 逐日係數（上市＋上櫃，只含前一日有成交者），依日期排序；只讀本機檔 */
export function refFactorItems({ root = DEFAULT_OFFICIAL_ROOT, from = null, to = null, kind = 'etf', readEntry = C.readEntry } = {}) {
  const cal = tradingDaysOf(root);
  const lim = d => (!from || d >= from) && (!to || d <= to);
  const t84 = C.loadManifest(root, TWSE, 'twse_twt84u'); const dq = C.loadManifest(root, TPEX, 'tpex_dailyquotes');
  const read = (host, id, row) => readEntry(root, host, id, row.file).payload;
  const out = [];
  cal.forEach((d, i) => {
    const r84 = t84.rows?.[d];
    if (lim(d) && i > 0 && r84?.status === 'ok') out.push(...twt84uFactors(read(TWSE, 'twse_twt84u', r84), { expect: d, prevDay: cal[i - 1], kind }));
    const next = cal[i + 1]; const rdq = dq.rows?.[d];
    if (next && lim(next) && rdq?.status === 'ok') out.push(...dailyQuotesNextFactors(read(TPEX, 'tpex_dailyquotes', rdq), { expect: d, nextDay: next, kind }));
  });
  return out.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

/**
 * 日 K 結構斷點（分割／反分割候選）：相鄰兩根之間隔了 ≥1 個交易日沒有成交（停止買賣），且收盤比 <lo 或 >hi。
 * 回 [{ code, prevDate（停止買賣前最後一根）, date（恢復買賣日）, gapDays, ratio }]——ratio 是收盤比（含停止期間淨值變動），**只是近似，不可當係數**；
 * 係數表（SKILL §7）沒有這件事件時，該檔該段日 K 不可直接算 ATR 帶：lineInputsOf 以同一組門檻（STRUCT_BREAK）逐檔查，
 * 斷點之前的根數記進 exGapBars（fail-closed）；這裡的斷點全數有官方係數，是 'etf' 列入 verifiedArchives 的前提（SKILL §2A 閘門 ⑦）。
 */
export function structuralBreaks(barsByCode, tradingDays, { lo = STRUCT_BREAK.lo, hi = STRUCT_BREAK.hi } = {}) {
  const idx = new Map((tradingDays || []).map((d, i) => [d, i]));
  const out = [];
  for (const [code, bars] of Object.entries(barsByCode || {})) {
    for (let i = 1; i < bars.length; i++) {
      const a = bars[i - 1], b = bars[i];
      const gapDays = (idx.get(b.date) ?? 0) - (idx.get(a.date) ?? 0) - 1;
      const ratio = b.c / a.c;
      if (gapDays >= 1 && (ratio < lo || ratio > hi)) out.push({ code, prevDate: a.date, date: b.date, gapDays, ratio: +ratio.toFixed(4) });
    }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || x.code.localeCompare(y.code));
}

/**
 * 官方參考價係數 vs 係數表（[[date, code, factor]]）：係數表沒有（或差 >1%）的官方除權息事件（2022-07～2026-09 的 ETF 實測 0 件）。
 * prevDayOf(d)：前一交易日（有給時，係數表把事件記在休市日〔颱風假原定的除息日〕、官方在下一交易日生效，視為同一件：
 *   adjustBars 只看「事件日之前的根」，兩個日期之前的根相同）。
 */
export function uncoveredFactors(refItems, tableItems, { tol = 0.01, prevDayOf = null } = {}) {
  const byCode = new Map();
  for (const [d, c, f] of tableItems || []) {
    if (!(f > 0)) continue;
    if (!byCode.has(c)) byCode.set(c, []);
    byCode.get(c).push([d, f]);
  }
  return (refItems || []).filter(([d, c, f]) => {
    const lo = typeof prevDayOf === 'function' ? prevDayOf(d) : null;
    return !(byCode.get(c) || []).some(([td, tf]) => (td === d || (lo && td > lo && td < d)) && Math.abs(tf / f - 1) <= tol);
  });
}

