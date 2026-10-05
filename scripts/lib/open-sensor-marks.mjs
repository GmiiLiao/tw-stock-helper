// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器：官方 5 秒資料的「衍生值」計算（純函式；不打網路、不讀時鐘、不碰 Firestore）
//   規格：scratchpad warroom/opensensor/design-v2.md §3、§4.4、§8、§9（使用者 2026-10-05 裁定 S1、S2、S5、S7）。
//   來源（只打 www.twse.com.tw rwd，呼叫端負責節流）：
//     MI_5MINS        每 5 秒委託成交統計 → 上市累積成交金額／成交量／筆數（openMarks）
//     MI_5MINS_INDEX  每 5 秒指數        → 加權與幾個類股指數的早盤摘要、有效開盤 E、官方開盤（indexMarks）
//   只存衍生值（S7）：09:00–10:00 每分鐘取樣、檢查點累積值與占全日比例、全日總值、指數早盤摘要；不留原始 5 秒全表。
//   單位鐵則（design-v2 §1）：成交金額一律「億元」(yi)、成交量一律「張」(lots)、筆數 (tx)，分列、不互相換算。
//     MI_5MINS 的累積成交金額原單位是百萬元（10/05：1,150,804 百萬元＝11,508 億），這裡 ÷100 成億元。
//   回音驗證：stat=OK、頂層 date＝請求日（有給才比）、title 的民國日期＝請求日（必要）；不符就丟，不拿別日頂替。
// ─────────────────────────────────────────────────────────────────────────
import { BLOCK_RE } from './official-mirror.mjs';

export const BASIS = 'openSensorMarks-v1';          // openMarks（MI_5MINS 衍生）的口徑版本
export const INDEX_BASIS = 'openSensorIndex-v2';    // indexMarks 的口徑版本（v2：10/05 實測後改正官方開盤列，見 deriveIndexMarks）
export const MI5_URL = d8 => `https://www.twse.com.tw/rwd/zh/afterTrading/MI_5MINS?date=${d8}&response=json`;
export const IDX_URL = d8 => `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_INDEX?date=${d8}&response=json`;

const pad2 = n => String(n).padStart(2, '0');
/** 感應器檢查點（首判 09:02 與備援 09:03／09:04、09:05、每 10 分鐘複判至 10:00；09:01 供揭示落後對照） */
export const CHECK_MARKS = Object.freeze(['09:01', '09:02', '09:03', '09:04', '09:05', '09:10', '09:20', '09:30', '09:40', '09:50', '10:00']);
/** 09:00–10:00 每分鐘（61 點） */
export const MINUTES = Object.freeze(Array.from({ length: 61 }, (_, m) => `${pad2(9 + Math.floor(m / 60))}:${pad2(m % 60)}`));
const OPEN_T = '09:00:00';
const AUCTION_T = '09:00:05';
const E_T = '09:02:00';
const CLOSE_T = '13:30:00';

/** 官方數字字串 → 數值；''、'--'、非數字 ⇒ null（不補 0） */
export function num(v) {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** '09:00:05'／'090005'／'9:00:05' → 'HH:MM:SS'；認不得回 null */
export function normTime(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) return `${pad2(m[1])}:${m[2]}:${m[3]}`;
  m = s.match(/^(\d{2})(\d{2})(\d{2})$/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

/** 標題裡的民國日期（115年10月02日）→ 'YYYY-MM-DD'；沒有回 null */
export function rocTitleIso(title) {
  const m = String(title ?? '').match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  return m ? `${+m[1] + 1911}-${pad2(m[2])}-${pad2(m[3])}` : null;
}

const tableOf = j => (Array.isArray(j?.fields) ? { title: j.title, fields: j.fields, data: j.data }
  : Array.isArray(j?.tables) && j.tables[0]?.fields ? j.tables[0] : null);
const titleOf = j => String(j?.title || tableOf(j)?.title || '');

/**
 * 回音驗證。iso＝請求日 'YYYY-MM-DD'。
 * @returns {{ok:boolean, status:'ok'|'empty'|'bad'|'mismatch', echo?:string, note?:string}}
 */
export function echoCheck(j, iso) {
  if (!j || typeof j !== 'object') return { ok: false, status: 'bad', note: '非物件' };
  const stat = String(j.stat ?? '');
  if (/沒有符合|查無|無資料|尚未/.test(stat)) return { ok: false, status: 'empty', note: stat };
  if (stat.toUpperCase() !== 'OK') return { ok: false, status: 'bad', note: `stat=${stat}` };
  const d8 = iso.replace(/-/g, '');
  if (j.date != null && String(j.date) !== d8) return { ok: false, status: 'mismatch', note: `date=${j.date}` };
  const echo = rocTitleIso(titleOf(j));
  if (!echo) return { ok: false, status: 'mismatch', note: `title 無民國日期：${titleOf(j).slice(0, 40)}` };
  if (echo !== iso) return { ok: false, status: 'mismatch', echo, note: `title 日期 ${echo} ≠ 請求 ${iso}` };
  return { ok: true, status: 'ok', echo };
}

const STOP_HTTP = new Set([301, 302, 303, 307, 308, 401, 403, 429]);
/**
 * HTTP 結果分類：stop＝整批立刻停（30x／401／403／429／封鎖頁，不重試）；fail＝該請求失敗（5xx、其他 4xx）；ok。
 */
export function httpVerdict(status, text = '') {
  if (STOP_HTTP.has(status)) return { kind: 'stop', note: `HTTP ${status}` };
  if (status !== 200) return { kind: 'fail', note: `HTTP ${status}` };
  if (BLOCK_RE.test(String(text).slice(0, 4000))) return { kind: 'stop', note: '封鎖／限流頁' };
  return { kind: 'ok' };
}

// ── MI_5MINS ───────────────────────────────────────────────
const MI5_FIELDS = { tx: '累積成交筆數', lots: '累積成交數量', valM: '累積成交金額' };

/** rwd 回應 → [{t, tx, lots, valM}]（欄位以名稱找；找不到就丟錯，不猜位置） */
export function parseMi5(j) {
  const t = tableOf(j);
  if (!t || !Array.isArray(t.data)) throw new Error('MI_5MINS 沒有表格');
  const it = t.fields.findIndex(f => /時間/.test(String(f)));
  const idx = Object.fromEntries(Object.entries(MI5_FIELDS).map(([k, name]) => [k, t.fields.findIndex(f => String(f).includes(name))]));
  const missing = Object.entries(idx).filter(([, i]) => i < 0).map(([k]) => MI5_FIELDS[k]);
  if (it < 0) missing.unshift('時間');
  if (missing.length) throw new Error(`MI_5MINS 欄位缺：${missing.join('、')}`);
  return t.data.map(r => ({ t: normTime(r[it]), tx: num(r[idx.tx]), lots: num(r[idx.lots]), valM: num(r[idx.valM]) })).filter(x => x.t);
}

/** openapi 版（鏡像本機檔 payload：[{Time, AccTransaction, AccTradeVolume, AccTradeValue}]）→ 同 parseMi5 的列 */
export function parseMi5OpenApi(payload) {
  if (!Array.isArray(payload) || !payload.length) throw new Error('MI_5MINS openapi 空白');
  return payload.map(r => ({ t: normTime(r.Time), tx: num(r.AccTransaction), lots: num(r.AccTradeVolume), valM: num(r.AccTradeValue) })).filter(x => x.t);
}

const yiOf = valM => (valM == null ? null : +(valM / 100).toFixed(2));
const ratio = (a, b) => (a == null || !(b > 0) ? null : +(a / b).toFixed(5));
const byTime = rows => [...rows].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
/** 最後一列 t ≤ T（T 可為 HH:MM 或 HH:MM:SS），且 pick(列) 有值 */
function lastAtOrBefore(rows, T, pick) {
  const lim = T.length === 5 ? `${T}:00` : T;
  let hit = null;
  for (const r of rows) { if (r.t > lim) break; if (pick(r) != null) hit = r; }
  return hit;
}

/**
 * MI_5MINS 列 → openMarks（Firestore 可存：沒有巢狀陣列；序列用 JSON 字串，同 orderFlowArchive.curveJson 慣例）。
 *   auction：09:00 以後第一筆有成交的列（開盤競價，通常 09:00:05）；marks.mHHMM：該分 00 秒以前最後一列的累積值與占全日比例；
 *   day：最後一列（收盤）；minJson：[[HH:MM, 億元, 張, 筆], …] 09:00–10:00 每分鐘（09:00 尚無成交＝null）。
 */
export function deriveOpenMarks(rawRows) {
  const rows = byTime(rawRows);
  const traded = r => r.valM;
  const auction = rows.find(r => r.t >= OPEN_T && r.valM > 0) || null;
  const day = [...rows].reverse().find(r => r.valM > 0) || null;
  if (!auction || !day) throw new Error('MI_5MINS 沒有成交列');
  let nonMonotone = 0, prev = null;   // 累積值理應不減；有減就計數（只記錄，不改值）
  for (const r of rows) {
    if (r.valM == null) continue;
    if (prev && (r.valM < prev.valM || r.lots < prev.lots || r.tx < prev.tx)) nonMonotone++;
    prev = r;
  }
  const cell = r => ({ t: r.t, yi: yiOf(r.valM), lots: r.lots, tx: r.tx, pctYi: ratio(r.valM, day.valM), pctLots: ratio(r.lots, day.lots) });
  const marks = {};
  for (const T of CHECK_MARKS) {
    const r = lastAtOrBefore(rows, T, traded);
    marks[`m${T.replace(':', '')}`] = r ? cell(r) : null;
  }
  const min = MINUTES.map(T => {
    const r = lastAtOrBefore(rows, T, traded);
    return r ? [T, yiOf(r.valM), r.lots, r.tx] : [T, null, null, null];
  });
  return {
    basis: BASIS,
    units: 'yi＝成交金額億元（官方百萬元÷100）·lots＝成交量張·tx＝成交筆數；pct＝占當日收盤累積',
    auction: cell(auction),
    marks,
    day: { t: day.t, yi: yiOf(day.valM), lots: day.lots, tx: day.tx },
    minJson: JSON.stringify(min),
    n: rows.length,
    complete: day.t >= CLOSE_T,
    nonMonotone,
  };
}

// ── MI_5MINS_INDEX ─────────────────────────────────────────
/** 要留的指數欄（名稱比對；加權必須有，其他有就留） */
export const IDX_PICK = Object.freeze([
  ['taiex', /^發行量加權股價指數$/],
  ['exFin', /^未含金融保險股指數$/],
  ['exElec', /^未含電子股指數$/],
  ['exFinElec', /^未含金融電子股指數$/],
  ['elec', /^電子(工業)?類指數$/],
  ['semi', /^半導體類指數$/],
  ['fin', /^金融保險類指數$/],
]);

/** rwd 回應 → { keys, cols, rows:[{t, v:{taiex,…}}] } */
export function parseIndex(j) {
  const t = tableOf(j);
  if (!t || !Array.isArray(t.data)) throw new Error('MI_5MINS_INDEX 沒有表格');
  const it = t.fields.findIndex(f => /時間/.test(String(f)));
  if (it < 0) throw new Error('MI_5MINS_INDEX 欄位缺：時間');
  const found = IDX_PICK.map(([k, re]) => [k, t.fields.findIndex(f => re.test(String(f).trim()))]).filter(([, i]) => i >= 0);
  if (!found.some(([k]) => k === 'taiex')) throw new Error('MI_5MINS_INDEX 欄位缺：發行量加權股價指數');
  const rows = t.data.map(r => ({ t: normTime(r[it]), v: Object.fromEntries(found.map(([k, i]) => [k, num(r[i])])) }))
    .filter(x => x.t && x.v.taiex != null);
  return { keys: found.map(([k]) => k), cols: found.map(([, i]) => String(t.fields[i]).trim()), rows: byTime(rows) };
}

function highLow(rows, from, to) {
  let hi = null, lo = null;
  for (const r of rows) {
    if (r.t < from || r.t > to) continue;
    if (!hi || r.v.taiex > hi.v.taiex) hi = r;
    if (!lo || r.v.taiex < lo.v.taiex) lo = r;
  }
  return hi ? { hi: hi.v.taiex, hiT: hi.t, lo: lo.v.taiex, loT: lo.t } : null;
}

const IDX_TAIEX_MARKS = Object.freeze([OPEN_T, AUCTION_T, ...CHECK_MARKS]);
const IDX_OTHER_MARKS = Object.freeze([OPEN_T, AUCTION_T, '09:02', '09:05', '09:10', '09:20', '09:30', '09:40', '09:50', '10:00']);
/** '09:00:00'→m0900、'09:00:05'→m090005、'09:02'→m0902 */
const markKey = T => { const s = T.replace(/:/g, ''); return `m${s.length === 6 && s.endsWith('00') ? s.slice(0, 4) : s}`; };

/**
 * 指數列 → indexMarks（只有水準值；漲跌%等要昨收的欄位由 enrichIndex 補）。
 *   ⚠ 2026-10-06 以 10/05 實測定口徑：09:00:00 那一列＝**昨收**（48,475.74＝10/02 收盤，開盤前指數以昨收計），
 *     09:00:05 那一列＝**官方開盤**（48,574.95＝MIS t00 `o`）。所以：
 *   ref0900：09:00:00 列（昨收的回音，enrichIndex 拿它和 MI_INDEX 昨收對帳）；open：官方開盤＝09:00 之後第一列（通常 09:00:05）；
 *   e：揭示 ≥09:02:00 的第一列＝有效開盤 E（design-v2 §4.4）；hl0901：09:01–10:00 高低；hlDay：開盤後全日高低（不含 09:00:00 昨收列）；close：最後一列。
 */
export function deriveIndexMarks(parsed) {
  const { rows, keys, cols } = parsed;
  if (!rows?.length) throw new Error('MI_5MINS_INDEX 沒有指數列');
  const at = T => lastAtOrBefore(rows, T, r => r.v.taiex);
  const exact = T => rows.find(r => r.t === T) || null;
  const e = rows.find(r => r.t >= E_T) || null;
  const open = exact(AUCTION_T) || rows.find(r => r.t > OPEN_T) || null;
  const ref = exact(OPEN_T);
  const last = rows[rows.length - 1];
  const taiex = {};
  for (const T of IDX_TAIEX_MARKS) { const r = T.length === 8 ? exact(T) : at(T); taiex[markKey(T)] = r ? { t: r.t, v: r.v.taiex } : null; }
  const others = {};
  for (const k of keys.filter(x => x !== 'taiex')) {
    const o = {};
    for (const T of IDX_OTHER_MARKS) { const r = T.length === 8 ? exact(T) : at(T); o[markKey(T)] = r ? r.v[k] : null; }
    o.close = last.v[k] ?? null;
    others[k] = o;
  }
  const min = MINUTES.map(T => { const r = at(T); return [T, r ? r.v.taiex : null]; });
  return {
    basis: INDEX_BASIS,
    cols,
    first: { t: rows[0].t, v: rows[0].v.taiex },
    ref0900: ref ? { t: OPEN_T, v: ref.v.taiex } : null,
    open: open ? { t: open.t, v: open.v.taiex } : null,
    e: e ? { t: e.t, v: e.v.taiex } : null,
    taiex,
    hl0901: highLow(rows, '09:01:00', '10:00:00'),
    hlDay: open ? highLow(rows, open.t, '23:59:59') : null,
    close: { t: last.t, v: last.v.taiex },
    others,
    minJson: JSON.stringify(min),
    n: rows.length,
    complete: last.t >= CLOSE_T,
  };
}

const pct = (a, b) => (a == null || !(b > 0) ? null : +((a / b - 1) * 100).toFixed(3));

/**
 * 補上要昨收的欄位（不改輸入；回傳新物件）。
 *   prevClose：前一交易日官方收盤（MI_INDEX 鏡像本機檔）；closeOfficial：當日 MI_INDEX 收盤（交叉驗證 close）。
 *   refMatch：09:00:00 列（昨收回音）＝prevClose；distortPp＝E 漲跌% − 官方開盤漲跌%（正＝官方開盤低估了向上跳空）。
 */
export function enrichIndex(im, { prevClose = null, prevSrc = null, closeOfficial = null } = {}) {
  const offOpen = im.open?.v ?? null;
  const offPct = pct(offOpen, prevClose), ePct = pct(im.e?.v, prevClose);
  const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;
  return {
    ...im,
    prevClose, prevSrc,
    refMatch: prevClose == null || im.ref0900 == null ? null : eq(im.ref0900.v, prevClose),
    officialOpen: offOpen == null ? null : { t: im.open.t, v: offOpen, pct: offPct },
    ePct,
    distortPp: offPct == null || ePct == null ? null : +(ePct - offPct).toFixed(3),
    closePct: pct(im.close?.v, prevClose),
    closeOfficial,
    closeMatch: closeOfficial == null ? null : eq(im.close?.v, closeOfficial),
    openIsDayHigh: eq(offOpen, im.hlDay?.hi),
    openIsDayLow: eq(offOpen, im.hlDay?.lo),
  };
}

/** 官方 MI_INDEX（鏡像本機檔 payload）→ 加權收盤與帶正負號的漲跌點數；找不到回 null */
export function taiexFromMiIndex(payload) {
  const tables = Array.isArray(payload?.tables) ? payload.tables : [];
  for (const t of tables) {
    if (!Array.isArray(t?.data)) continue;
    const row = t.data.find(r => String(r?.[0] ?? '').trim() === '發行量加權股價指數');
    if (!row) continue;
    const close = num(row[1]), pts = num(row[3]);
    if (close == null) return null;
    const signTxt = String(row[2] ?? '').replace(/<[^>]*>/g, '').trim();
    const sign = signTxt === '-' ? -1 : signTxt === '+' ? 1 : 0;
    return { close, chg: pts == null ? null : sign * pts };
  }
  return null;
}

// ── 交易日 ─────────────────────────────────────────────────
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWeekday = iso => { const w = new Date(`${iso}T00:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; };
export const isTradingIso = (iso, holidays) => isWeekday(iso) && !holidays.has(iso);

/** end（含）往前 n 個交易日（平日扣休市日），由舊到新 */
export function tradingDaysBack({ end, n, holidays }) {
  const out = [];
  for (let d = end, guard = 0; out.length < n && guard < n * 3 + 30; d = addDays(d, -1), guard++) if (isTradingIso(d, holidays)) out.push(d);
  return out.reverse();
}

/** end 之前（不含）最近的交易日 */
export function prevTradingDay(iso, holidays) {
  for (let d = addDays(iso, -1), guard = 0; guard < 30; d = addDays(d, -1), guard++) if (isTradingIso(d, holidays)) return d;
  return null;
}
