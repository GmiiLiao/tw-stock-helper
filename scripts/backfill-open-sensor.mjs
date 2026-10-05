#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器回補（一次性；使用者 2026-10-05 裁定 S7「回補 MI_5MINS 與 MI_5MINS_INDEX 近 60 交易日約 118 個請求；只存衍生值」）
//   規格：scratchpad warroom/opensensor/design-v2.md §9、design.md §5.5。衍生值的算法在 scripts/lib/open-sensor-marks.mjs（純函式＋測試）。
//
// 上游（只有這兩個，都在 www.twse.com.tw rwd；MIS 零請求、不碰 TPEx／Yahoo／openapi 線上端點）：
//   MI_5MINS?date=…        → openMarks（上市累積成交金額億元／成交量張／筆數：競價列、檢查點、占全日比例、每分鐘序列、全日）
//   MI_5MINS_INDEX?date=…  → indexMarks（加權與類股指數：09:00:00 官方開盤列、有效開盤 E＝≥09:02:00 首列、高低、收盤、失真 pp）
//   10/02 的 MI_5MINS 本機官方鏡像已有 openapi 原始檔：全日三值（金額、量、筆數）和 orderFlowArchive 逐位吻合才拿來用（省 1 個請求），否則照打 rwd。
//
// 節奏與停止（design-v2 §9）：每請求間隔 ≥3 秒＋0–1.5 秒抖動；HTTP 307／429（以及 30x／401／403、封鎖頁）立刻停整批、不重試；
//   5xx／逾時記失敗不重試，連續 3 次失敗停；每次送出前檢查鏡像禁跑窗（平日 07:30–15:30、16:25–16:55、21:40–22:35）與 --deadline。
//   回音驗證：stat=OK、頂層 date＝請求日、title 民國日期＝請求日；不符就丟，不拿別日頂替。
//
// 存放（只存衍生值，不在 second-brain/official 落原始檔）：
//   ① 本機 second-brain/backup/open-sensor/{YYYY-MM-DD}.json（openMarks＋indexMarks＋來源回音）、_index.json、_runs.json、_alerts.json（交易日缺口）
//   ② Firestore orderFlowArchive/{date} 新增欄位 openMarks、indexMarks（update：文件必須已存在且有 curveJson，不建空殼；
//      不動既有欄位。backfill-orderflow.mjs 對已存在的日子會跳過，所以兩邊不互相覆蓋）。
//      openMarks 只在「MI_5MINS 全日三值＝orderFlowArchive 既有 tradeValue／tradeVol／trans」時才寫（同端點交叉驗證）。
//
// 用法：
//   node scripts/backfill-open-sensor.mjs --dates 2026-10-05 --no-firestore --verbose   # 先跑 1 日驗格式
//   node scripts/backfill-open-sensor.mjs --n 60 --end 2026-10-05 --deadline 06:00        # 全部（本機已有同版衍生檔的日子不重抓）
//   node scripts/backfill-open-sensor.mjs --n 60 --end 2026-10-05 --phase2-only           # 不打網路，只重算昨收相關欄位並寫 Firestore
// 旗標：--max-requests N（預設 130，硬上限）、--refetch（忽略本機衍生檔重抓）、--no-firestore。
// ─────────────────────────────────────────────────────────────────────────
import admin from 'firebase-admin';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { httpFetch, blockedReason, MIN_GAP_MS, taipeiDate, taipeiNow, decodeBody } from './lib/official-mirror.mjs';
import * as M from './lib/open-sensor-marks.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SB = join(ROOT, 'second-brain');
const OUT = join(SB, 'backup', 'open-sensor');
const MI5_MIRROR = d => join(SB, 'official', 'openapi.twse.com.tw', 'twse_oa_exchangeReport_MI_5MINS', `${d}.json.gz`);
const MI_INDEX_MIRROR = d => join(SB, 'official', 'www.twse.com.tw', 'twse_mi_index', `${d}.json.gz`);
const JITTER_MS = 1500;
const MAX_CONSEC_FAIL = 3;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_BASIS = 'openSensorBackfill-v1';

const argv = process.argv.slice(2);
const flag = k => argv.includes(k);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const OPT = {
  dates: arg('--dates') ? arg('--dates').split(',').map(s => s.trim()).filter(Boolean) : null,
  n: Number(arg('--n', '60')),
  end: arg('--end'),
  maxRequests: Number(arg('--max-requests', '130')),
  deadline: arg('--deadline'),            // 'HH:MM'（台北）：到點就不再送新請求
  noFirestore: flag('--no-firestore'),
  refetch: flag('--refetch'),
  phase2Only: flag('--phase2-only'),
  verbose: flag('--verbose'),
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hhmmss = () => taipeiNow().toISOString().slice(11, 19);
const log = (...a) => console.log(hhmmss(), ...a);
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const readGzJson = p => JSON.parse(gunzipSync(readFileSync(p)).toString('utf8'));
function writeJsonAtomic(p, obj) { const tmp = `${p}.tmp`; writeFileSync(tmp, JSON.stringify(obj, null, 1)); renameSync(tmp, p); }
const localPath = d => join(OUT, `${d}.json`);
const readLocal = d => (existsSync(localPath(d)) ? readJson(localPath(d)) : null);

// ── 參數檢查（輸入在邊界驗）──────────────────────────────
function validateOptions() {
  const bad = [];
  if (OPT.dates && OPT.dates.some(d => !ISO_RE.test(d))) bad.push(`--dates 格式錯：${OPT.dates.join(',')}`);
  if (OPT.end && !ISO_RE.test(OPT.end)) bad.push(`--end 格式錯：${OPT.end}`);
  if (!(OPT.n >= 1 && OPT.n <= 250)) bad.push(`--n 要在 1–250：${OPT.n}`);
  if (!(OPT.maxRequests >= 0 && OPT.maxRequests <= 300)) bad.push(`--max-requests 要在 0–300：${OPT.maxRequests}`);
  if (OPT.deadline && !/^\d{2}:\d{2}$/.test(OPT.deadline)) bad.push(`--deadline 格式錯：${OPT.deadline}`);
  if (bad.length) { console.error(bad.join('\n')); process.exit(2); }
}

// ── 請求帳與節流 ─────────────────────────────────────────
const ledger = [];                     // 每個實際送出的請求：{date, ep, url, at, http, result}
const state = { stop: null, consecFail: 0, lastAt: 0, deadlineTs: null };

/** 'HH:MM'（台北）→ 程式啟動後下一次到達該時刻的 epoch ms */
function nextTaipeiTs(hhmm, now = new Date()) {
  const tw = taipeiNow(now);
  const [h, m] = hhmm.split(':').map(Number);
  const ts = Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate(), h, m) - 8 * 3600e3;
  return ts > now.getTime() ? ts : ts + 86400e3;
}

function preSendBlock() {
  if (state.stop) return state.stop;
  if (ledger.length >= OPT.maxRequests) return `達請求上限 ${OPT.maxRequests}`;
  const blocked = blockedReason(new Date());
  if (blocked) return `進入禁跑窗：${blocked}`;
  if (state.deadlineTs && Date.now() >= state.deadlineTs) return `到達 --deadline ${OPT.deadline}`;
  return null;
}

/** 送一個請求（節流＋停止條件＋回音）。回 {j, echo} 或 {err, stop?} */
async function fetchOfficial(date, ep, url) {
  const block = preSendBlock();
  if (block) { state.stop ||= { reason: block, date, ep }; return { err: block, stop: true }; }
  const wait = state.lastAt + MIN_GAP_MS + Math.floor(Math.random() * JITTER_MS) - Date.now();
  if (wait > 0) await sleep(wait);
  const rec = { date, ep, url, at: new Date().toISOString(), http: null, result: null };
  ledger.push(rec);
  state.lastAt = Date.now();
  let res;
  try {
    res = await httpFetch({ url, headers: { Referer: 'https://www.twse.com.tw/', Accept: 'application/json' } }, { timeoutMs: 30000 });
  } catch (e) {
    rec.result = `network:${e.name === 'TimeoutError' ? 'timeout' : e.message}`.slice(0, 120);
    return failOne(rec);
  } finally { state.lastAt = Date.now(); }
  rec.http = res.status;
  const text = decodeBody(res.buf);
  const v = M.httpVerdict(res.status, text);
  if (v.kind === 'stop') { rec.result = `stop:${v.note}`; state.stop = { reason: v.note, date, ep }; return { err: v.note, stop: true }; }
  if (v.kind === 'fail') { rec.result = `fail:${v.note}`; return failOne(rec); }
  let j;
  try { j = JSON.parse(text); } catch { rec.result = 'fail:JSON 解析失敗'; return failOne(rec); }
  const echo = M.echoCheck(j, date);
  rec.result = echo.ok ? 'ok' : `${echo.status}:${echo.note || ''}`.slice(0, 120);
  if (!echo.ok) return { err: rec.result };   // 回音不符／空表：不算連續失敗（官方回應正常），但這日不採用
  state.consecFail = 0;
  return { j, echo };
}
function failOne(rec) {
  state.consecFail++;
  if (state.consecFail >= MAX_CONSEC_FAIL) state.stop ||= { reason: `連續 ${MAX_CONSEC_FAIL} 次失敗`, date: rec.date, ep: rec.ep };
  return { err: rec.result };
}

function describe(j) {
  const t = Array.isArray(j?.fields) ? j : j?.tables?.[0];
  if (!t) return '（無表格）';
  const d = t.data || [];
  return `title=${j.title || t.title}｜date=${j.date}｜欄位(${t.fields.length})=${t.fields.join('、').slice(0, 400)}｜列數=${d.length}｜首列=${JSON.stringify(d[0])}｜次列=${JSON.stringify(d[1])}｜末列=${JSON.stringify(d[d.length - 1])}`;
}

// ── Firestore ────────────────────────────────────────────
let _db = null;
function db() {
  if (_db) return _db;
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||= '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
  if (!admin.apps.length) admin.initializeApp();
  _db = admin.firestore();
  return _db;
}
async function readHolidays() {
  const doc = (await db().collection('system').doc('tradingCalendar').get()).data();
  if (!doc || !Array.isArray(doc.holidays) || !doc.holidays.length) throw new Error('system/tradingCalendar 沒有 holidays，無法決定交易日（不猜）');
  return new Set(doc.holidays.map(String));
}
async function readOrderFlow(dates) {
  const refs = dates.map(d => db().collection('orderFlowArchive').doc(d));
  const snaps = refs.length ? await db().getAll(...refs) : [];
  return Object.fromEntries(snaps.map(s => [s.id, s.exists ? s.data() : null]));
}

// ── 交易日與目標日 ───────────────────────────────────────
function targetDates(holidays) {
  if (OPT.dates) {
    const off = OPT.dates.filter(d => !M.isTradingIso(d, holidays));
    if (off.length) log(`⚠ 這些日子依休市日曆不是交易日，略過：${off.join('、')}`);
    return OPT.dates.filter(d => M.isTradingIso(d, holidays)).sort();
  }
  const end = OPT.end || M.prevTradingDay(taipeiDate(), holidays);
  if (!M.isTradingIso(end, holidays)) throw new Error(`--end ${end} 不是交易日`);
  return M.tradingDaysBack({ end, n: OPT.n, holidays });
}
/** 交易日曆 vs 官方鏡像 MI_INDEX 有無檔（兩個獨立來源互相對帳；只回報不阻擋） */
function calendarCrossCheck(dates, holidays) {
  const noMirror = dates.filter(d => !existsSync(MI_INDEX_MIRROR(d)));
  const extra = [];
  for (let d = dates[0]; d && d <= dates[dates.length - 1]; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10)) {
    if (!dates.includes(d) && existsSync(MI_INDEX_MIRROR(d))) extra.push(d);
  }
  return { noMirror, mirrorButHoliday: extra, holidaysInRange: [...holidays].filter(h => h >= dates[0] && h <= dates[dates.length - 1]).sort() };
}

// ── Phase 1：抓＋算（每日一檔本機衍生檔）────────────────────
/** MI_5MINS 全日三值 vs orderFlowArchive（同端點既有歸檔）：true／false；任一邊沒有資料＝null（無從比對） */
const ofTotalsMatch = (om, of) => (!om || !of || of.tradeValue == null ? null
  : Math.round(om.day.yi * 100) === of.tradeValue && om.day.lots === of.tradeVol && om.day.tx === of.trans);

async function phase1(dates, ofDocs) {
  const results = {};
  for (const d of dates) {
    const prev = OPT.refetch ? null : readLocal(d);
    // 各部分以自己的口徑版本判斷能否沿用（口徑改版的那一部分才重抓；另一部分不重打）
    const keepOm = prev?.openMarks?.basis === M.BASIS, keepIm = prev?.indexMarks?.basis === M.INDEX_BASIS;
    const reuse = keepOm && keepIm;
    const out = { date: d, basis: FILE_BASIS, mi5: keepOm ? prev.mi5 : null, idx: keepIm ? prev.idx : null,
      openMarks: keepOm ? prev.openMarks : null, indexMarks: keepIm ? prev.indexMarks : null, errors: [] };
    const had = { om: !!out.openMarks, im: !!out.indexMarks };
    const d8 = d.replace(/-/g, '');

    if (!out.openMarks) {
      // 本機鏡像 openapi 檔（只有 10/02 有）：和 orderFlowArchive 全日三值吻合才採用
      if (existsSync(MI5_MIRROR(d))) {
        try {
          const om = M.deriveOpenMarks(M.parseMi5OpenApi(readGzJson(MI5_MIRROR(d)).payload));
          if (ofTotalsMatch(om, ofDocs[d]) === true) {
            out.openMarks = om;
            out.mi5 = { src: 'mirror:openapi.twse.com.tw/twse_oa_exchangeReport_MI_5MINS（本機，0 請求）', echo: 'orderFlowArchive 全日金額／量／筆數逐位吻合', rows: om.n };
            log(`${d} MI_5MINS ← 本機鏡像檔（全日三值吻合，0 請求）`);
          } else log(`${d} 本機鏡像 MI_5MINS 與 orderFlowArchive 不吻合，改打 rwd`);
        } catch (e) { log(`${d} 本機鏡像 MI_5MINS 解析失敗：${e.message}，改打 rwd`); }
      }
      if (!out.openMarks && !state.stop) {
        const url = M.MI5_URL(d8);
        const r = await fetchOfficial(d, 'MI_5MINS', url);
        if (r.j) {
          if (OPT.verbose) log(`${d} MI_5MINS 原始結構：${describe(r.j)}`);
          try {
            out.openMarks = M.deriveOpenMarks(M.parseMi5(r.j));
            out.mi5 = { src: url, echo: r.echo.echo, title: r.j.title ?? null, rows: out.openMarks.n };
          } catch (e) { out.errors.push(`MI_5MINS 解析：${e.message}`); }
        } else out.errors.push(`MI_5MINS：${r.err}`);
      }
    }

    if (!out.indexMarks && !state.stop) {
      const url = M.IDX_URL(d8);
      const r = await fetchOfficial(d, 'MI_5MINS_INDEX', url);
      if (r.j) {
        if (OPT.verbose) log(`${d} MI_5MINS_INDEX 原始結構：${describe(r.j)}`);
        try {
          out.indexMarks = M.deriveIndexMarks(M.parseIndex(r.j));
          out.idx = { src: url, echo: r.echo.echo, title: r.j.title ?? null, rows: out.indexMarks.n, cols: out.indexMarks.cols };
        } catch (e) { out.errors.push(`MI_5MINS_INDEX 解析：${e.message}`); }
      } else out.errors.push(`MI_5MINS_INDEX：${r.err}`);
    }

    const gained = (!had.om && out.openMarks) || (!had.im && out.indexMarks);
    if (gained || out.errors.length) writeJsonAtomic(localPath(d), { ...out, fetchedAt: Date.now() });
    results[d] = out;
    const om = out.openMarks, im = out.indexMarks;
    log(`${d} ${reuse ? '（本機已有）' : ''}全日 ${om ? om.day.yi.toLocaleString() + ' 億／' + om.day.lots.toLocaleString() + ' 張' : '—'}｜09:02 ${om?.marks.m0902 ? om.marks.m0902.yi + ' 億(' + (om.marks.m0902.pctYi * 100).toFixed(2) + '%)' : '—'}｜加權 昨收列 ${im?.ref0900?.v ?? '—'} 官方開盤 ${im?.open?.v ?? '—'} E ${im?.e?.v ?? '—'} 收 ${im?.close?.v ?? '—'}｜請求累計 ${ledger.length}${out.errors.length ? '｜✖ ' + out.errors.join('；') : ''}`);
    if (state.stop) { log(`⛔ 停止整批：${state.stop.reason}（停在 ${state.stop.date} ${state.stop.ep}）`); break; }
  }
  return results;
}

// ── Phase 2：補昨收相關欄位、交叉驗證、寫 Firestore（零網路）──────
function officialPrevClose(d, holidays) {
  const pd = M.prevTradingDay(d, holidays);
  if (pd && existsSync(MI_INDEX_MIRROR(pd))) {
    const t = M.taiexFromMiIndex(readGzJson(MI_INDEX_MIRROR(pd)).payload);
    if (t) return { prevClose: t.close, prevSrc: `mirror:twse_mi_index/${pd}` };
  }
  if (existsSync(MI_INDEX_MIRROR(d))) {
    const t = M.taiexFromMiIndex(readGzJson(MI_INDEX_MIRROR(d)).payload);
    if (t?.chg != null) return { prevClose: +(t.close - t.chg).toFixed(2), prevSrc: `mirror:twse_mi_index/${d}（收盤−漲跌）` };
  }
  return { prevClose: null, prevSrc: null };
}
const closeOfficialOf = d => (existsSync(MI_INDEX_MIRROR(d)) ? M.taiexFromMiIndex(readGzJson(MI_INDEX_MIRROR(d)).payload)?.close ?? null : null);

async function phase2(dates, ofDocs, holidays) {
  const rows = [], fsWrites = [], fsSkips = [];
  for (const d of dates) {
    const loc = readLocal(d);
    if (!loc) { rows.push({ date: d, missing: ['openMarks', 'indexMarks'] }); continue; }
    const indexMarks = loc.indexMarks ? M.enrichIndex(loc.indexMarks, { ...officialPrevClose(d, holidays), closeOfficial: closeOfficialOf(d) }) : null;
    const of = ofDocs[d];
    const ofMatch = ofTotalsMatch(loc.openMarks, of);
    const next = { ...loc, indexMarks, ofMatch };
    writeJsonAtomic(localPath(d), next);

    const payload = {};
    const stamp = Date.now();
    if (loc.openMarks && ofMatch === true) payload.openMarks = { ...loc.openMarks, src: loc.mi5?.src ?? null, echo: loc.mi5?.echo ?? null, backfilledAt: stamp };
    if (indexMarks) payload.indexMarks = { ...indexMarks, src: loc.idx?.src ?? null, echo: loc.idx?.echo ?? null, backfilledAt: stamp };
    const why = !of ? 'orderFlowArchive 無此日文件（不建空殼）' : !of.curveJson ? 'orderFlowArchive 文件不完整（無 curveJson）' : null;
    if (OPT.noFirestore) fsSkips.push(`${d}：--no-firestore`);
    else if (why) fsSkips.push(`${d}：${why}`);
    else if (!Object.keys(payload).length) fsSkips.push(`${d}：沒有可寫的欄位`);
    else {
      try { await db().collection('orderFlowArchive').doc(d).update(payload); fsWrites.push(`${d}:${Object.keys(payload).join('+')}`); }
      catch (e) { fsSkips.push(`${d}：寫入失敗 ${e.message.slice(0, 80)}`); }
    }
    if (loc.openMarks && ofMatch === false) fsSkips.push(`${d}：openMarks 全日三值≠orderFlowArchive，未寫 openMarks`);
    const om = loc.openMarks;
    rows.push({
      date: d,
      missing: [!om && 'openMarks', !indexMarks && 'indexMarks'].filter(Boolean),
      A: om?.day.yi ?? null, lots: om?.day.lots ?? null,
      auc: om?.auction.yi ?? null, aucPct: om?.auction.pctYi ?? null,
      v0902: om?.marks.m0902?.yi ?? null, p0902: om?.marks.m0902?.pctYi ?? null,
      p0930: om?.marks.m0930?.pctYi ?? null, p1000: om?.marks.m1000?.pctYi ?? null,
      offPct: indexMarks?.officialOpen?.pct ?? null, ePct: indexMarks?.ePct ?? null, distortPp: indexMarks?.distortPp ?? null,
      closePct: indexMarks?.closePct ?? null, closeMatch: indexMarks?.closeMatch ?? null, refMatch: indexMarks?.refMatch ?? null, ofMatch,
    });
  }
  return { rows, fsWrites, fsSkips };
}

function printTable(rows) {
  const f = (v, k = 2) => (v == null ? '—' : typeof v === 'number' ? v.toFixed(k) : String(v));
  const p = v => (v == null ? '—' : (v * 100).toFixed(2) + '%');
  console.log('\n日期        全日億    競價億(占)        09:02億(占)        09:30占  10:00占  官方開盤%  E%      失真pp  收盤%   收盤驗 昨收驗 全日驗');
  for (const r of rows) {
    if (r.missing?.length === 2) { console.log(`${r.date}  缺 ${r.missing.join('、')}`); continue; }
    console.log(`${r.date}  ${f(r.A, 0).padStart(7)}  ${f(r.auc, 0).padStart(5)}(${p(r.aucPct).padStart(6)})  ${f(r.v0902, 0).padStart(6)}(${p(r.p0902).padStart(6)})  ${p(r.p0930).padStart(7)} ${p(r.p1000).padStart(7)}  ${f(r.offPct, 2).padStart(7)}  ${f(r.ePct, 2).padStart(6)}  ${f(r.distortPp, 2).padStart(6)}  ${f(r.closePct, 2).padStart(6)}  ${String(r.closeMatch).padEnd(5)} ${String(r.refMatch).padEnd(5)} ${String(r.ofMatch)}`);
  }
}

// ── main ────────────────────────────────────────────────
async function main() {
  validateOptions();
  mkdirSync(OUT, { recursive: true });
  if (OPT.deadline) state.deadlineTs = nextTaipeiTs(OPT.deadline);
  const startedIso = new Date().toISOString();
  const holidays = await readHolidays();
  const dates = targetDates(holidays);
  if (!dates.length) { log('沒有目標交易日'); process.exit(1); }
  const cal = calendarCrossCheck(dates, holidays);
  log(`▶ 目標 ${dates.length} 個交易日：${dates[0]} → ${dates[dates.length - 1]}｜區間內休市 ${cal.holidaysInRange.join('、') || '無'}`);
  if (cal.noMirror.length) log(`⚠ 交易日曆有、官方鏡像 MI_INDEX 沒檔：${cal.noMirror.join('、')}`);
  if (cal.mirrorButHoliday.length) log(`⚠ 鏡像有檔、日曆判休市或區間外：${cal.mirrorButHoliday.join('、')}`);
  const ofDocs = await readOrderFlow(dates);

  if (!OPT.phase2Only) {
    const block = blockedReason(new Date());
    if (block) { log(`⛔ 現在是禁跑窗（${block}），不送任何請求`); process.exit(3); }
    await phase1(dates, ofDocs);
  }
  const { rows, fsWrites, fsSkips } = await phase2(dates, ofDocs, holidays);
  printTable(rows);

  const missing = rows.filter(r => r.missing?.length).map(r => ({ date: r.date, missing: r.missing }));
  const ledgerSummary = {};
  for (const r of ledger) { const k = (r.result || 'unknown').split(':')[0]; ledgerSummary[k] = (ledgerSummary[k] || 0) + 1; }
  const run = {
    started: startedIso, finished: new Date().toISOString(), basis: FILE_BASIS, argv,
    targets: { from: dates[0], to: dates[dates.length - 1], n: dates.length },
    requests: ledger.length, byResult: ledgerSummary, stop: state.stop,
    fsWrites: fsWrites.length, fsSkips, missing, calendar: cal,
    ledger: ledger.map(r => ({ date: r.date, ep: r.ep, at: r.at, http: r.http, result: r.result })),
  };
  const runsPath = join(OUT, '_runs.json');
  const runs = existsSync(runsPath) ? readJson(runsPath) : [];
  writeJsonAtomic(runsPath, [...runs, run].slice(-50));
  writeJsonAtomic(join(OUT, '_alerts.json'), {
    basis: FILE_BASIS, asOfRun: run.finished, targets: run.targets,
    missing,                                  // 交易日缺任何一個衍生值都列在這（不捏造、待補）
    stop: state.stop,
  });
  writeJsonAtomic(join(OUT, '_index.json'), { basis: FILE_BASIS, updatedFromRun: run.finished, rows });

  console.log(`\n請求 ${ledger.length} 個 ${JSON.stringify(ledgerSummary)}｜Firestore 寫入 ${fsWrites.length} 日｜缺 ${missing.length} 日${state.stop ? `｜⛔ 停止：${state.stop.reason}（${state.stop.date} ${state.stop.ep}）` : ''}`);
  if (fsSkips.length) console.log(`Firestore 未寫：\n  ${fsSkips.join('\n  ')}`);
  if (missing.length) console.log(`缺口：${missing.map(m => `${m.date}(${m.missing.join('+')})`).join('、')}`);
  process.exit(state.stop ? 4 : 0);
}

main().catch(e => { console.error('✖', e.stack || e.message); process.exit(1); });
