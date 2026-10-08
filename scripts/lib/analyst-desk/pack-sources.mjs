// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊·資料包來源讀取器（W1）
//
//   本機檔（second-brain/**）用 fs 讀；Firestore 一律走「注入的 fsGet(collection, docId)」（async，回 data|null），
//   本模組**不 import firebase-admin**、不打任何網路——測試以假 fsGet 餵資料；真實接線在 scripts/build-analyst-pack.mjs。
//   每個讀取器回 { data, echo, sha256, absent?, reason?, source }：
//     · 缺檔／缺文件／回聲日期對不上 → absent:true（絕不捏造、不補 0、不給預設值）
//     · echo ＝來源「自報」的資料日（不是檔名日、不是寫入時刻）；呼叫端比對後才採用
//   時間語意：台北 UTC+8 無夏令；美東用 Intl（America/New_York）算，不寫死 04:00／05:00。
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { verdictJsonOf } from '../news-verdict-codec.mjs';
import {
  DS, readManifest, tradingDates as mirrorTradingDates, parseMiIndex, parseTpex, toIsoDate, num, isCommonStock,
} from '../daily-heatmap/inputs.mjs';

export { mirrorTradingDates, isCommonStock, toIsoDate, num };

// ── 時間工具 ─────────────────────────────────────────────────────────────────
export const TPE_OFFSET_H = 8;
export const tpeDate = ms => new Date(ms + TPE_OFFSET_H * 3600e3).toISOString().slice(0, 10);
export const tpeHHMM = ms => new Date(ms + TPE_OFFSET_H * 3600e3).toISOString().slice(11, 16);
export function taipeiMs(date, h = 0, m = 0) {
  const [y, mo, d] = date.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, h - TPE_OFFSET_H, m);
}
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 864e5).toISOString().slice(0, 10);
}
export const weekdayOf = date => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=日
export const isoOfMs = ms => new Date(ms).toISOString();

const NY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function nyParts(ms) {
  const o = {};
  for (const p of NY_FMT.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), minute: Number(o.minute) };
}
export const nyDate = ms => nyParts(ms).date;
/** 美東某日 16:00 的 UTC 毫秒（夏令 EDT／冬令 EST 由 Intl 判定，不寫死台北 04:00／05:00）。 */
export function nyCloseMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  for (const off of [4, 5]) {
    const ms = Date.UTC(y, m - 1, d, 16 + off, 0);
    const p = nyParts(ms);
    if (p.date === date && p.hour === 16 && p.minute === 0) return ms;
  }
  return null;
}
/** cutoff 當下「已收盤的最近一個美股平日」（美股國定假日無來源 → 可能偏晚一天，呼叫端須容忍）。 */
export function expectedUsDay(cutoffMs) {
  let d = nyDate(cutoffMs);
  for (let i = 0; i < 10; i++) {
    const wd = weekdayOf(d);
    if (wd >= 1 && wd <= 5) {
      const c = nyCloseMs(d);
      if (c != null && c <= cutoffMs) return d;
    }
    d = addDays(d, -1);
  }
  return null;
}

// ── 雜項 ──────────────────────────────────────────────────────────────────────
export const sha256Hex = buf => createHash('sha256').update(buf).digest('hex');
/** 鍵序穩定的 JSON（Firestore 資料的雜湊用）。 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
const absentRes = (source, reason) => ({ data: null, echo: null, sha256: null, absent: true, reason, source });
const okRes = (source, data, echo, sha256) => ({ data, echo: echo ?? null, sha256: sha256 ?? null, source });
function readGz(file) {
  const raw = readFileSync(file);
  return { obj: JSON.parse(gunzipSync(raw).toString('utf8')), sha: sha256Hex(raw), raw };
}
/** 民國日期（'1151002'／'115/10/02'）或西元 → ISO；解析失敗回 null。 */
export const isoOf = v => toIsoDate(v);

// ── 本機：每日熱力定版檔 ────────────────────────────────────────────────────────
export function latestHeatmapDay(root) {
  const f = join(root, 'daily-heatmap', 'latest.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')).dataDate ?? null; } catch { return null; }
}

/** 熱力 {day}.json.gz：回 payload＋manifest 資訊。payload.dataDate 必須等於 day（回聲）；marketHealth.date 這類「記錄日」不可當資料日。 */
export function readHeatmapDay(root, day) {
  const source = `dailyHeatmap:${day}`;
  const dir = join(root, 'daily-heatmap');
  let row = null;
  const manF = join(dir, '_manifest.json');
  if (existsSync(manF)) { try { row = JSON.parse(readFileSync(manF, 'utf8')).rows?.[day] ?? null; } catch { row = null; } }
  if (row && row.status !== 'final') return absentRes(source, `manifest status=${row.status}`);
  const file = join(dir, row?.file ?? `${day}.json.gz`);
  if (!existsSync(file)) return absentRes(source, 'file-missing');
  const { obj, sha } = readGz(file);
  if (obj.dataDate !== day) return absentRes(source, `echo-mismatch(${obj.dataDate})`);
  return okRes(source, {
    payload: obj, rebuilt: row?.rebuilt === true, canonicalAt: row?.canonicalAt ?? null, degraded: row?.degraded ?? [],
  }, obj.dataDate, sha);
}

// ── 本機：官方鏡像 ──────────────────────────────────────────────────────────────
const officialDir = root => join(root, 'official');
function readMirror(root, ds, day) {
  const man = readManifest(officialDir(root), ds);
  const row = man?.rows?.[day];
  if (!row || row.status !== 'ok') return null;
  const file = join(officialDir(root), ds[0], ds[1], row.file || `${day}.json.gz`);
  if (!existsSync(file)) return null;
  const { obj, sha } = readGz(file);
  return { entry: obj, sha, rowEcho: row.echo ?? null };
}

const DS_EXTRA = {
  t86: ['www.twse.com.tw', 'twse_t86'],
  tpexInsti: ['www.tpex.org.tw', 'tpex_insti_dailytrade'],
  bfi82u: ['www.twse.com.tw', 'twse_bfi82u'],
  notetrans: ['www.twse.com.tw', 'twse_notetrans'],
  twsePunish: ['openapi.twse.com.tw', 'twse_oa_announcement_punish'],
  twseNotice: ['openapi.twse.com.tw', 'twse_oa_announcement_notice'],
  tpexWarningBulletin: ['www.tpex.org.tw', 'tpex_bulletin_warning'],
  tpexDisposal: ['www.tpex.org.tw', 'tpex_oa_tpex_disposal_information'],
  tpexTradingWarning: ['www.tpex.org.tw', 'tpex_oa_tpex_trading_warning_information'],
  t187L: ['openapi.twse.com.tw', 'twse_oa_opendata_t187ap03_L'],
  t187O: ['www.tpex.org.tw', 'tpex_oa_mopsfin_t187ap03_O'],
  taifexContracts: ['www.taifex.com.tw', 'taifex_fut_contracts'],
  taifexPc: ['www.taifex.com.tw', 'taifex_pcratio'],
  taifexVix: ['www.taifex.com.tw', 'taifex_vix'],
};

/** 上市 MI_INDEX：個股收盤、官方各類指數（漲跌符號取 HTML 顏色）、一般股票成交金額。echo＝表內民國日期。 */
export function readMiIndexDay(root, day) {
  const source = `twse_mi_index:${day}`;
  const m = readMirror(root, DS.mi, day);
  if (!m) return absentRes(source, 'missing-or-not-ok');
  const parsed = parseMiIndex(m.entry);
  if (parsed.titleDay !== day) return absentRes(source, `echo-mismatch(${parsed.titleDay})`);
  const tables = (m.entry.payload || m.entry).tables || [];
  const idxT = tables.find(t => /價格指數\(臺灣證券交易所\)/.test(t?.title || ''));
  const indices = {};
  for (const r of idxT?.data || []) {
    const close = num(r[1]);
    const pts = num(r[3]);
    if (close == null || pts == null) continue;
    const signed = /green/.test(String(r[2])) ? -pts : pts;
    indices[String(r[0]).trim()] = { close, pts: signed, pct: close - signed !== 0 ? (signed / (close - signed)) * 100 : null };
  }
  return okRes(source, { rows: parsed.rows, index: parsed.index, indices, officialStockValue: parsed.officialStockValue }, parsed.titleDay, m.sha);
}

/** 上市一般股票成交金額（元）——量比用，只解析大盤統計表那一列（比整檔解析快）。缺／回聲不符回 null。 */
export function readMiStockValueDay(root, day) {
  const m = readMirror(root, DS.mi, day);
  if (!m) return null;
  const tables = (m.entry.payload || m.entry).tables || [];
  const stat = tables.find(t => /大盤統計資訊/.test(t?.title || ''));
  if (toIsoDate(stat?.title) !== day) return null;
  const row = (stat?.data || []).find(r => String(r[0]).startsWith('1.一般股票'));
  return row ? num(row[1]) : null;
}

/** 上櫃日收盤（名稱／收盤／成交值）。echo＝表內日期。 */
export function readTpexQuotesDay(root, day) {
  const source = `tpex_dailyquotes:${day}`;
  const m = readMirror(root, DS.tpex, day);
  if (!m) return absentRes(source, 'missing-or-not-ok');
  const p = parseTpex(m.entry);
  if (p.titleDay !== day) return absentRes(source, `echo-mismatch(${p.titleDay})`);
  return okRes(source, { rows: p.rows }, p.titleDay, m.sha);
}

/** 三大法人逐檔（股）：上市 T86（外資[4]不含外資自營、投信[10]、自營商[11]）、上櫃（外資[4]、投信[13]、自營[22]）。各市場獨立 echo。 */
export function readInstDay(root, day) {
  const out = { tse: null, otc: null };
  const absent = [];
  const t = readMirror(root, DS_EXTRA.t86, day);
  if (t) {
    const p = t.entry.payload || t.entry;
    const echo = toIsoDate(p.date) || toIsoDate(p.title);
    if (echo === day) {
      const rows = new Map();
      for (const r of p.data || []) rows.set(String(r[0]).trim(), { foreign: num(r[4]), trust: num(r[10]), dealer: num(r[11]) });
      out.tse = { rows, echo, sha256: t.sha };
    } else absent.push(`twse_t86:${day}(echo-mismatch ${echo})`);
  } else absent.push(`twse_t86:${day}`);
  const o = readMirror(root, DS_EXTRA.tpexInsti, day);
  if (o) {
    const p = o.entry.payload || o.entry;
    const tb = (p.tables || [])[0] || {};
    const echo = toIsoDate(tb.date) || toIsoDate(p.date);
    if (echo === day) {
      const rows = new Map();
      for (const r of tb.data || []) rows.set(String(r[0]).trim(), { foreign: num(r[4]), trust: num(r[13]), dealer: num(r[22]) });
      out.otc = { rows, echo, sha256: o.sha };
    } else absent.push(`tpex_insti_dailytrade:${day}(echo-mismatch ${echo})`);
  } else absent.push(`tpex_insti_dailytrade:${day}`);
  return { source: `inst:${day}`, data: out, absentParts: absent, absent: !out.tse && !out.otc, echo: day, sha256: sha256Hex(stableStringify({ tse: out.tse?.sha256 ?? null, otc: out.otc?.sha256 ?? null })) };
}

/** 官方 BFI82U 三大法人買賣金額（元）。目前鏡像只有少數日：缺就 absent，不拿估算頂替。 */
export function readBfi82uDay(root, day) {
  const source = `twse_bfi82u:${day}`;
  const m = readMirror(root, DS_EXTRA.bfi82u, day);
  if (!m) return absentRes(source, 'missing-or-not-ok');
  const p = m.entry.payload || m.entry;
  const echo = toIsoDate(p.date);
  if (echo !== day) return absentRes(source, `echo-mismatch(${echo})`);
  const byName = {};
  for (const r of p.data || []) byName[String(r[0]).trim()] = num(r[3]);
  return okRes(source, {
    foreign: byName['外資及陸資(不含外資自營商)'] ?? null,
    trust: byName['投信'] ?? null,
    dealerSelf: byName['自營商(自行買賣)'] ?? null,
    dealerHedge: byName['自營商(避險)'] ?? null,
    total: byName['合計'] ?? null,
  }, echo, m.sha);
}

/** chipArchive/{日}.json（字串化 JSON 欄位）。兩市未到齊（complete!==true／otcPending）→ absent，不寫兩市合計。 */
export function readChipArchiveDay(root, day) {
  const source = `chipArchive:${day}`;
  const f = join(root, 'backup', 'chipArchive', `${day}.json`);
  if (!existsSync(f)) return absentRes(source, 'file-missing');
  const raw = readFileSync(f);
  const d = JSON.parse(raw.toString('utf8'));
  if (d.date !== day) return absentRes(source, `echo-mismatch(${d.date})`);
  if (d.complete !== true || d.otcPending === true) return absentRes(source, `not-complete(complete=${d.complete},otcPending=${d.otcPending})`);
  const p = k => (d[k] ? JSON.parse(d[k]) : null);
  return okRes(source, {
    close: p('closeJson'), inst: p('instJson'), margin: p('marginJson'), sbl: p('sblJson'), dayTrade: p('dayTradeJson'),
    dtOtcStat: d.dtOtcStat ?? null,
  }, d.date, sha256Hex(raw));
}

const decBig5 = buf => new TextDecoder('big5').decode(buf);
const gzFile = (root, ds, name) => {
  const f = join(officialDir(root), ds[0], ds[1], name);
  return existsSync(f) ? gunzipSync(readFileSync(f)) : null;
};
function mirrorFileName(root, ds, day) {
  const man = readManifest(officialDir(root), ds);
  const row = man?.rows?.[day];
  return row && row.status === 'ok' ? { name: row.file, rowEcho: row.echo ?? null } : null;
}

/** 期交所：外資臺股期貨（交易／未平倉淨額，口）、TXO Put/Call 比、臺指 VIX 開盤。三者各自 echo，缺哪個列進 absentParts。 */
export function readTaifexDay(root, day) {
  const out = {};
  const absent = [];
  const shas = {};
  // fut contracts（big5 csv）
  const fc = mirrorFileName(root, DS_EXTRA.taifexContracts, day);
  const fcBuf = fc ? gzFile(root, DS_EXTRA.taifexContracts, fc.name) : null;
  if (fcBuf) {
    const lines = decBig5(fcBuf).split(/\r?\n/).filter(Boolean);
    const hdr = lines[0].split(',');
    const iNet = hdr.indexOf('多空交易口數淨額');
    const iOi = hdr.indexOf('多空未平倉口數淨額');
    for (const ln of lines.slice(1)) {
      const c = ln.split(',');
      if (c[1] === '臺股期貨' && c[2] === '外資及陸資') {
        const echo = toIsoDate(c[0].replace(/\//g, ''));
        if (echo === day) out.foreignTxf = { tradeNet: num(c[iNet]), oiNet: num(c[iOi]) };
        else absent.push(`taifex_fut_contracts:${day}(echo-mismatch ${echo})`);
        break;
      }
    }
    shas.fut = sha256Hex(fcBuf);
    if (!out.foreignTxf && !absent.length) absent.push(`taifex_fut_contracts:${day}(row-not-found)`);
  } else absent.push(`taifex_fut_contracts:${day}`);
  // P/C ratio（html 表）
  const pc = mirrorFileName(root, DS_EXTRA.taifexPc, day);
  const pcBuf = pc ? gzFile(root, DS_EXTRA.taifexPc, pc.name) : null;
  if (pcBuf) {
    const html = pcBuf.toString('utf8');
    const head = html.indexOf('買賣權未平倉量比率');
    const tds = head >= 0 ? [...html.slice(head).matchAll(/<td[^>]*>\s*([^<]*?)\s*<\/td>/g)].slice(0, 7).map(m => m[1]) : [];
    const echo = tds[0] ? toIsoDate(tds[0].split('/').map((x, i) => (i ? x.padStart(2, '0') : x)).join('')) : null;
    if (tds.length === 7 && echo === day) out.putCall = { volRatio: num(tds[3]), oiRatio: num(tds[6]) };
    else absent.push(`taifex_pcratio:${day}(${tds.length === 7 ? `echo ${echo}` : 'parse-failed'})`);
    shas.pc = sha256Hex(pcBuf);
  } else absent.push(`taifex_pcratio:${day}`);
  // VIX（tab 分隔 big5 txt；第一個有值列＝開盤）
  const vx = mirrorFileName(root, DS_EXTRA.taifexVix, day);
  const vxBuf = vx ? gzFile(root, DS_EXTRA.taifexVix, vx.name) : null;
  if (vxBuf) {
    const rows = decBig5(vxBuf).split(/\r?\n/).map(l => l.split('\t')).filter(c => /^\d{8}$/.test(c[0] || ''));
    const first = rows.find(c => num(c[c.length - 1]) != null);
    if (first && toIsoDate(first[0]) === day) out.vixOpen = num(first[first.length - 1]);
    else absent.push(`taifex_vix:${day}(${first ? `echo ${toIsoDate(first[0])}` : 'no-rows'})`);
    shas.vix = sha256Hex(vxBuf);
  } else absent.push(`taifex_vix:${day}`);
  const has = out.foreignTxf || out.putCall || out.vixOpen != null;
  return { source: `taifex:${day}`, data: out, absentParts: absent, absent: !has, echo: has ? day : null, sha256: sha256Hex(stableStringify(shas)) };
}

// ── 風險旗標快照（處置／注意／可能達處置）──────────────────────────────────────────
function parsePeriodRoc(s) {
  const t = String(s || '');
  let m = t.match(/(\d{3})\/(\d{2})\/(\d{2})\s*[～~]\s*(\d{3})\/(\d{2})\/(\d{2})/);
  if (m) return { start: `${+m[1] + 1911}-${m[2]}-${m[3]}`, end: `${+m[4] + 1911}-${m[5]}-${m[6]}` };
  m = t.match(/(\d{7})\s*[～~]\s*(\d{7})/);
  if (m) return { start: toIsoDate(m[1]), end: toIsoDate(m[2]) };
  return null;
}
const addTo = (map, code, v) => { if (!map.has(code)) map.set(code, []); map.get(code).push(v); };

/**
 * 某日的風險旗標「該日 PIT 快照」：只認 manifest 該日 status=ok 的鏡像檔（快照抓取時刻不等於當日，期間與公告日用來源自報欄位判斷）。
 * verified.{tse,otc} 分三項：disposal（處置名單可得）、attention（當日注意股可得：必須有 Date==day 的列）、near（可能達處置名單可得）。
 * 注意：上市 announcement/notice 在非交易日抓取時只回一列 Number:"0" 的空殼——視為「不可得」而不是「沒有注意股」。
 */
export function readRiskSnapshot(root, day) {
  const source = `risk:${day}`;
  const disposal = new Map();   // code → [{start,end,market}]
  const attention = new Map();  // code → [{market}]（當日）
  const near = new Map();       // code → [{market, note}]
  const verified = { tse: { disposal: false, attention: false, near: false }, otc: { disposal: false, attention: false, near: false } };
  const parts = [];
  const shas = {};

  const pu = readMirror(root, DS_EXTRA.twsePunish, day);
  if (pu && Array.isArray(pu.entry.payload)) {
    verified.tse.disposal = true; shas.punish = pu.sha;
    for (const r of pu.entry.payload) {
      const per = parsePeriodRoc(r.DispositionPeriod);
      if (r.Code) addTo(disposal, String(r.Code).trim(), { market: '上市', start: per?.start ?? null, end: per?.end ?? null, announce: toIsoDate(r.Date) });
    }
  } else parts.push(`twse_oa_announcement_punish:${day}`);

  const nt = readMirror(root, DS_EXTRA.twseNotice, day);
  if (nt && Array.isArray(nt.entry.payload)) {
    shas.notice = nt.sha;
    const rows = nt.entry.payload.filter(r => r.Code && String(r.Code).trim());
    const todays = rows.filter(r => toIsoDate(r.Date) === day);
    if (todays.length) {
      verified.tse.attention = true;
      for (const r of todays) addTo(attention, String(r.Code).trim(), { market: '上市' });
    } else parts.push(`twse_oa_announcement_notice:${day}(${rows.length ? 'no-rows-for-day' : 'empty-shell'})`);
  } else parts.push(`twse_oa_announcement_notice:${day}`);

  const nr = readMirror(root, DS_EXTRA.notetrans, day);
  if (nr) {
    const p = nr.entry.payload || nr.entry;
    if (toIsoDate(p.title) === day || toIsoDate(nr.rowEcho) === day || nr.rowEcho === day) {
      verified.tse.near = true; shas.notetrans = nr.sha;
      for (const r of p.data || []) addTo(near, String(r[1]).trim(), { market: '上市', note: String(r[3] || '').slice(0, 80) });
    } else parts.push(`twse_notetrans:${day}(echo-mismatch)`);
  } else parts.push(`twse_notetrans:${day}`);

  const td = readMirror(root, DS_EXTRA.tpexDisposal, day);
  if (td && Array.isArray(td.entry.payload)) {
    verified.otc.disposal = true; shas.tpexDisposal = td.sha;
    for (const r of td.entry.payload) {
      const per = parsePeriodRoc(r.DispositionPeriod);
      if (r.SecuritiesCompanyCode) addTo(disposal, String(r.SecuritiesCompanyCode).trim(), { market: '上櫃', start: per?.start ?? null, end: per?.end ?? null, announce: toIsoDate(r.Date) });
    }
  } else parts.push(`tpex_disposal_information:${day}`);

  const tw = readMirror(root, DS_EXTRA.tpexTradingWarning, day);
  if (tw && Array.isArray(tw.entry.payload)) {
    shas.tpexWarning = tw.sha;
    const todays = tw.entry.payload.filter(r => toIsoDate(r.Date) === day && r.SecuritiesCompanyCode);
    if (todays.length) {
      verified.otc.attention = true;
      for (const r of todays) addTo(attention, String(r.SecuritiesCompanyCode).trim(), { market: '上櫃' });
    } else parts.push(`tpex_trading_warning_information:${day}(no-rows-for-day)`);
  } else parts.push(`tpex_trading_warning_information:${day}`);

  const tb = readMirror(root, DS_EXTRA.tpexWarningBulletin, day);
  if (tb) {
    const p = tb.entry.payload || tb.entry;
    const t0 = (p.tables || [])[0];
    if (t0 && (toIsoDate(String(t0.date)) === day || tb.rowEcho === day)) {
      verified.otc.near = true; shas.tpexBulletin = tb.sha;
      for (const r of t0.data || []) addTo(near, String(r[1]).trim(), { market: '上櫃', note: String(r[3] || '').slice(0, 80) });
    } else parts.push(`tpex_bulletin_warning:${day}(echo-mismatch)`);
  } else parts.push(`tpex_bulletin_warning:${day}`);

  const any = verified.tse.disposal || verified.otc.disposal || verified.tse.attention || verified.otc.attention;
  if (!any && !Object.keys(shas).length) return { ...absentRes(source, 'no-snapshot'), absentParts: parts };
  return { source, data: { disposal, attention, near, verified }, absentParts: parts, echo: day, sha256: sha256Hex(stableStringify(shas)) };
}

// ── 本機：wiki、上市日期、櫃買指數 ───────────────────────────────────────────────────
export function readWikiStocks(root) {
  const source = 'wiki:stocks.json';
  const f = join(root, 'wiki', '_graph', 'stocks.json');
  if (!existsSync(f)) return absentRes(source, 'file-missing');
  const raw = readFileSync(f);
  const d = JSON.parse(raw.toString('utf8'));
  return okRes(source, { generatedAt: d.generatedAt ?? null, stocks: d.stocks || {} }, d.generatedAt ?? null, sha256Hex(raw));
}

/** 上市（t187ap03_L 上市日期）＋上櫃（t187ap03_O DateOfListing）。快照檔以最新 ok 日為準；缺的代號＝來源未提供。 */
export function readListingDates(root) {
  const source = 'listingDates';
  const map = new Map();
  const shas = [];
  const parts = [];
  for (const [ds, codeKey, dateKey, mkt] of [[DS_EXTRA.t187L, '公司代號', '上市日期', '上市'], [DS_EXTRA.t187O, 'SecuritiesCompanyCode', 'DateOfListing', '上櫃']]) {
    const man = readManifest(officialDir(root), ds);
    const day = man ? Object.keys(man.rows || {}).filter(d => man.rows[d]?.status === 'ok').sort().pop() : null;
    const m = day ? readMirror(root, ds, day) : null;
    if (!m || !Array.isArray(m.entry.payload)) { parts.push(`${ds[1]}`); continue; }
    shas.push(m.sha);
    for (const r of m.entry.payload) {
      const code = String(r[codeKey] || '').trim();
      const ld = String(r[dateKey] || '').trim();
      if (code && /^\d{8}$/.test(ld)) map.set(code, { date: `${ld.slice(0, 4)}-${ld.slice(4, 6)}-${ld.slice(6, 8)}`, market: mkt });
    }
  }
  if (!map.size) return { ...absentRes(source, 'no-listing-source'), absentParts: parts };
  return { source, data: { map }, absentParts: parts, echo: null, sha256: sha256Hex(shas.join(',')) };
}

/** 櫃買指數日線（backup/indexHistory/otc.json：{YYYYMMDD:[開,高,低,收]}）。漲跌點由相鄰交易日收盤差得；缺前一日則無漲跌。 */
export function readOtcIndexDays(root, days) {
  const source = 'otcIndex';
  const f = join(root, 'backup', 'indexHistory', 'otc.json');
  if (!existsSync(f)) return absentRes(source, 'file-missing');
  const raw = readFileSync(f);
  const rows = JSON.parse(JSON.parse(raw.toString('utf8')).rowsJson || '{}');
  const out = {};
  for (const day of days) {
    const bar = rows[day.replace(/-/g, '')];
    if (bar) out[day] = bar[3];
  }
  return okRes(source, { closeByDay: out, rows }, null, sha256Hex(raw));
}

// ── Firestore 來源（注入 fsGet）──────────────────────────────────────────────────────
async function fsRead(source, fsGet, collection, docId, build) {
  if (typeof fsGet !== 'function') return absentRes(source, 'no-firestore');
  let doc;
  try { doc = await fsGet(collection, docId); } catch (e) { return absentRes(source, `fsGet-error:${String(e?.message || e).slice(0, 80)}`); }
  if (!doc) return absentRes(source, 'doc-missing');
  try {
    const r = build(doc);
    if (r.absent) return absentRes(source, r.reason);
    return okRes(source, r.data, r.echo, sha256Hex(stableStringify(doc)));
  } catch (e) { return absentRes(source, `parse-error:${String(e?.message || e).slice(0, 80)}`); }
}
const maybeJson = v => (typeof v === 'string' ? JSON.parse(v) : v);

/** newsVerdict/{適用日}：文件 date＝適用日；單筆 verdict 的 at＝判讀時刻（ms）。呼叫端須以 cutoff 濾掉 at 之後的。 */
export const readNewsVerdictDoc = (fsGet, day) => fsRead(`newsVerdict:${day}`, fsGet, 'newsVerdict', day, doc => {
  const dd = doc.dataDate ?? doc.date ?? null;
  if (dd !== day && doc.date !== day) return { absent: true, reason: `echo-mismatch(${dd})` };
  const verdicts = maybeJson(verdictJsonOf(doc) ?? doc.verdictJson) || {};   // 新舊格式都讀（壓縮 verdictGz，2026-10-08）
  return { data: { day, universeSize: doc.universeSize ?? null, judged: doc.judged ?? null, lastPass: doc.lastPass ?? null, verdicts }, echo: doc.date ?? dd };
});

/** mopsNews/{發言日}：itemsJson（key→{code,name,subject,at,body…}）。 */
export const readMopsNewsDoc = (fsGet, day) => fsRead(`mopsNews:${day}`, fsGet, 'mopsNews', day, doc => {
  const dd = doc.dataDate ?? doc.date ?? null;
  if (dd !== day) return { absent: true, reason: `echo-mismatch(${dd})` };
  const itemsObj = maybeJson(doc.itemsJson) || {};
  const items = Object.values(itemsObj).filter(x => x && x.code).sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.key < b.key ? -1 : 1));
  return { data: { day, items, n: doc.n ?? items.length }, echo: dd };
});

export const readNewsDigest = (fsGet, day) => fsRead('newsDigest', fsGet, 'newsDigest', day, doc => {
  if (!Array.isArray(doc.cats)) return { absent: true, reason: 'no-cats' };
  return { data: { cats: doc.cats, updatedAt: doc.updatedAt ?? null }, echo: doc.date ?? day };
});

export const readGlobalMarkets = fsGet => fsRead('globalMarkets', fsGet, 'globalMarkets', 'latest', doc => {
  if (!Array.isArray(doc.markets)) return { absent: true, reason: 'no-markets' };
  return { data: { markets: doc.markets, updatedAt: doc.updatedAt ?? null }, echo: null };
});

export const readAsiaPremarket = fsGet => fsRead('asiaPremarket', fsGet, 'asiaPremarket', 'latest', doc => ({
  data: {
    date: doc.date ?? null, slot: doc.slot ?? null, phase: doc.phase ?? null, lateCatchup: doc.lateCatchup === true,
    indices: doc.indices || [], bellwethers: doc.bellwethers || [], updatedAt: doc.updatedAt ?? null,
  }, echo: doc.date ?? null,
}));

export const readAdrPremium = fsGet => fsRead('adrPremium', fsGet, 'adrPremium', 'latest', doc => {
  if (!Array.isArray(doc.items)) return { absent: true, reason: 'no-items' };
  return { data: { items: doc.items, fx: doc.fx ?? null, updatedAt: doc.updatedAt ?? null }, echo: null };
});

export const readSectorSpot = fsGet => fsRead('sectorSpot', fsGet, 'sectorSpot', 'latest', doc => {
  if (!Array.isArray(doc.items)) return { absent: true, reason: 'no-items' };
  return { data: { items: doc.items, updatedAt: doc.updatedAt ?? null }, echo: null }; // doc.date 是抓取日，報價日在 items[].asOf
});

/** taifexPositions：foreignTxfNetOI 實為「交易口數淨額」非未平倉（docs 03 §8.5）——本讀取器只放 P/C 與回聲日，不暴露 foreignTxfNetOI。 */
export const readTaifexPositions = fsGet => fsRead('taifexPositions', fsGet, 'taifexPositions', 'latest', doc => ({
  data: { putCallOi: Number.isFinite(doc.putCallRatio) ? doc.putCallRatio : null, updatedAt: doc.updatedAt ?? null },
  echo: doc.date ? toIsoDate(String(doc.date)) : null,
}));

export const readCatalystCalendar = fsGet => fsRead('catalystCalendar', fsGet, 'catalystCalendar', 'latest', doc => {
  if (!Array.isArray(doc.events)) return { absent: true, reason: 'no-events' };
  return { data: { from: doc.from ?? null, to: doc.to ?? null, events: doc.events, updatedAt: doc.updatedAt ?? null }, echo: null };
});

export const readDividendCalendar = fsGet => fsRead('dividendCalendar', fsGet, 'dividendCalendar', 'latest', doc => {
  if (!Array.isArray(doc.upcoming)) return { absent: true, reason: 'no-upcoming' };
  const upcoming = doc.upcoming.map(u => ({ code: u.code, name: u.name, day: toIsoDate(u.date), type: u.type ?? null, cash: u.cash ?? null, stockRatio: u.stockRatio ?? null })).filter(u => u.day);
  return { data: { upcoming, updatedAt: doc.updatedAt ?? null }, echo: null };
});

export const readTradingCalendar = fsGet => fsRead('system/tradingCalendar', fsGet, 'system', 'tradingCalendar', doc => {
  const set = new Set([...(doc.holidays || []), ...(doc.official || []), ...(doc.adHoc || [])].filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)));
  if (!set.size) return { absent: true, reason: 'no-holidays' };
  return { data: { holidays: [...set].sort(), coverYear: doc.coverYear ? Number(doc.coverYear) : null, updatedAt: doc.updatedAt ?? null }, echo: null };
});
