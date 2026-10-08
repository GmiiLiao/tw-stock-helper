// ─────────────────────────────────────────────────────────────────────────
// 上櫃收盤檔（櫃買中心）解析與完整性驗證——純函式，不碰網路與檔案（2026-10-08）
//   兩種官方格式都認：
//   ① openapi tpex_mainboard_daily_close_quotes：JSON 陣列、每列自報民國 Date（4.7MB 未壓縮，含約 11,000 檔權證）
//   ② 帶日期端點 afterTrading/dailyQuotes?date=YYYY/MM/DD：{stat, date, tables:[上櫃股票行情, 管理股票]}（兩表同欄，要合併）
//   兩者一律轉成 openapi 形狀的列（欄名同 openapi），讀者不必知道資料從哪一支來。
//   帶日期端點的數字帶千分位（"20,798,776"），轉換時去掉千分位與前後空白；openapi 列保留原樣（讀者本來就會處理）。
//   等價證據：鏡像本機 2026-10-02 兩檔 11,928 列、代號集合相同，16 個對應欄位去掉千分位與空白後 0 差異（只驗過這一天）。
// ─────────────────────────────────────────────────────────────────────────
import { gunzipSync } from 'node:zlib';

export const OPENAPI_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
/** 帶日期端點（TPEx 只認 YYYY/MM/DD；不認得的日期會靜默回最新一份——一定要回聲驗證） */
export function datedUrl(iso) {
  const [y, m, d] = String(iso).split('-');
  return `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(`${y}/${m}/${d}`)}&type=EW&id=&response=json`;
}

export const OPENAPI_FIELDS = Object.freeze(['Date', 'SecuritiesCompanyCode', 'CompanyName', 'Close', 'Change', 'Open', 'High', 'Low', 'Average',
  'TradingShares', 'TransactionAmount', 'TransactionNumber', 'LatestBidPrice', 'LatesAskPrice', 'Capitals', 'NextReferencePrice', 'NextLimitUp', 'NextLimitDown']);
/** 帶日期端點欄名（去空白後比對）→ openapi 欄名。[12]／[14] 最後買／賣量是 openapi 沒有的欄，不轉。 */
const DATED_TO_OPENAPI = Object.freeze({
  代號: 'SecuritiesCompanyCode', 名稱: 'CompanyName', 收盤: 'Close', 漲跌: 'Change', 開盤: 'Open', 最高: 'High', 最低: 'Low', 均價: 'Average',
  成交股數: 'TradingShares', '成交金額(元)': 'TransactionAmount', 成交筆數: 'TransactionNumber', 最後買價: 'LatestBidPrice', 最後賣價: 'LatesAskPrice',
  發行股數: 'Capitals', 次日參考價: 'NextReferencePrice', 次日漲停價: 'NextLimitUp', 次日跌停價: 'NextLimitDown',
});
const REQUIRED_DATED = ['代號', '名稱', '收盤', '開盤', '最高', '最低', '成交股數'];

/**
 * 驗證門檻——看系統實際會用到的部分（4 碼股、00 開頭 ETF、收盤可解析、與前一份相比的缺漏），不看總列數的季節起落。
 *   總列數約九成是權證，隨季節大幅起落：官方鏡像 tpex_dailyquotes 1,026 個交易日（2022-07～2026-10）最低 7,243（2023-01-17），
 *   2026-06/07 有 8 天低於 10,000（最低 07-03 的 9,882）——舊門檻 10,000 會把這些真實完整的檔判成殘缺（2026-10-08 審查 HIGH）。
 *   ⇒ minRows 只當「明顯不是這張表」的底線（5,000，低於歷史最低）；完整性由下列四道把關：
 *   4 碼股 ≥800（2024 起最低 811、2025 起 834、2026 起 872；2022 有 794 的日子——那年的歷史日會被拒，讀者照舊走 looseRows）、
 *   00 開頭 ≥60（歷史最低 86）、收盤可解析 ≥90%（歷史最低 94.6%）、與前一份相比缺 ≤3%（歷史逐日最大 0.48%）。
 *   daemon、收件匣、匯入 CLI、官方鏡像本機檔一律用這一套（不再各自放寬）。
 */
export const LIMITS = Object.freeze({ minRows: 5000, minStocks4: 800, minEtf00: 60, minCloseParse: 0.9, maxMissingVsPrev: 0.03 });

const pad2 = n => String(n).padStart(2, '0');
/** 民國 YYYMMDD／西元 YYYYMMDD／YYYY-MM-DD／YYYY/MM/DD／民國 115/10/08 → YYYY-MM-DD；認不得回 null */
export function toIso(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return s;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/); if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{3})(\d{2})(\d{2})$/); if (m) return `${+m[1] + 1911}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/); if (m) return `${+m[1] + 1911}-${pad2(m[2])}-${pad2(m[3])}`;
  return null;
}
export const rocOf = iso => `${+iso.slice(0, 4) - 1911}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
export const ymdOf = iso => iso.replace(/-/g, '');

const num = v => { const n = parseFloat(String(v ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const clean = v => String(v ?? '').replace(/,/g, '').trim();
export const isStock4 = c => /^\d{4}$/.test(c);
/** daemon 宇宙的既有口徑：4 碼或 00 開頭 4～6 碼（帶字母的 ETF 不收，例 00679B——不要動） */
export const isSeedCode = c => /^\d{4}$/.test(c) || /^00\d{2,4}$/.test(c);
/** 網站對外宇宙的既有口徑（twse-api-server isSecurity）：4 碼（可帶一個字母）與 00 開頭 ETF（可帶字母） */
export const isWebSecurity = c => /^\d{4}[A-Z]?$/.test(c) || /^00\d{2,4}[A-Z]?$/.test(c);

/** 位元組／字串／已解析物件 → JSON；gzip 自動解開、去 BOM。截斷檔＝非 JSON。 */
export function decodeJson(input) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input) && !(input instanceof Uint8Array)) return { json: input };
  let buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input ?? []);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = gunzipSync(buf); } catch (e) { return { error: `gzip 解壓失敗（可能是截斷檔）：${e.message}` }; }
  }
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return { error: '空檔' };
  try { return { json: JSON.parse(text) }; } catch (e) { return { error: `非完整 JSON（可能是截斷檔）：${e.message.slice(0, 80)}` }; }
}

function parseOpenapi(arr) {
  const dates = new Set(arr.map(r => String(r?.Date ?? '').trim()));
  if (!arr.length) return { format: 'openapi', echo: null, rows: [], error: '空陣列' };
  if (dates.size !== 1) return { format: 'openapi', echo: null, rows: [], error: `Date 不一致（${[...dates].slice(0, 3).join('、')}）` };
  const echo = toIso([...dates][0]);
  if (!echo) return { format: 'openapi', echo: null, rows: [], error: `Date 認不得（${[...dates][0]}）` };
  if (!arr.every(r => r && typeof r === 'object' && 'SecuritiesCompanyCode' in r)) return { format: 'openapi', echo, rows: [], error: '缺 SecuritiesCompanyCode 欄' };
  return { format: 'openapi', echo, rows: arr };
}

function parseDated(j) {
  if (String(j.stat ?? '').toLowerCase() !== 'ok') return { format: 'dated', echo: null, rows: [], error: `stat=${j.stat}`, empty: /查無|沒有/.test(String(j.stat ?? '')) };
  const tables = Array.isArray(j.tables) ? j.tables : [];
  const top = toIso(j.date);
  const head = toIso(tables[0]?.date);
  if (!top || top !== head) return { format: 'dated', echo: top, rows: [], error: `date=${j.date} tables[0].date=${tables[0]?.date} 不一致` };
  const key = f => String(f ?? '').replace(/\s/g, '');
  const use = tables.filter(t => Array.isArray(t?.fields) && REQUIRED_DATED.every(f => t.fields.map(key).includes(f)));
  if (!use.length) return { format: 'dated', echo: top, rows: [], error: '找不到上櫃股票行情表' };
  const roc = rocOf(top);
  const rows = use.flatMap(t => {
    const cols = t.fields.map(f => DATED_TO_OPENAPI[key(f)] || null);
    return (t.data || []).map(r => {
      const o = { Date: roc };
      for (let i = 0; i < cols.length; i++) if (cols[i]) o[cols[i]] = clean(r[i]);
      return o;
    });
  });
  return { format: 'dated', echo: top, rows };
}

/** 任一格式 → { format, echo(YYYY-MM-DD), rows(openapi 形狀), error? } */
export function parseTpexClose(input) {
  const d = decodeJson(input);
  if (d.error) return { format: null, echo: null, rows: [], error: d.error };
  const j = d.json;
  if (Array.isArray(j)) return parseOpenapi(j);
  if (j && typeof j === 'object' && ('tables' in j || 'stat' in j)) return parseDated(j);
  return { format: null, echo: null, rows: [], error: '不是櫃買收盤檔（既非 openapi 陣列也非 dailyQuotes 物件）' };
}

/** 列數統計：總列數、4 碼、00 開頭、4 碼收盤可解析比例、重複代號數 */
export function statsOf(rows) {
  let stocks4 = 0, etf00 = 0, closeOk = 0;
  const seen = new Set(); let dup = 0;
  for (const r of rows) {
    const c = String(r.SecuritiesCompanyCode ?? '').trim();
    if (seen.has(c)) dup++; else seen.add(c);
    if (isStock4(c)) { stocks4++; if (Number.isFinite(parseFloat(String(r.Close ?? '').replace(/[,\s]/g, '')))) closeOk++; }
    else if (/^00/.test(c)) etf00++;
  }
  return { rows: rows.length, stocks4, etf00, dup, closeParse: stocks4 ? +(closeOk / stocks4).toFixed(4) : 0 };
}
export const codes4Of = rows => new Set(rows.map(r => String(r.SecuritiesCompanyCode ?? '').trim()).filter(isStock4));

const weekday = iso => { const dow = new Date(`${iso}T12:00:00Z`).getUTCDay(); return dow >= 1 && dow <= 5; };

/**
 * 完整性驗證 → { status: ok|notYet|invalid, dataDate, reason, stats, structOk }
 *   structOk：結構與筆數都過（notYet 時資料本身仍是另一天的合格檔，可以存在它自己的資料日下）。
 *   expect：期望資料日；不符＝notYet（官方還沒出那一天，中性結果，不算失敗）。
 *   沒有 expect 時（收件匣）：資料日要 ≤ today 且是交易日（isTradingDay 可注入；預設只排除週末）。
 *   prevCodes4：前一份已驗證檔的 4 碼集合；這份缺超過 3% ⇒ invalid。
 */
export function validateTpexClose(parsed, { expect = null, today = null, isTradingDay = weekday, prevCodes4 = null, limits = LIMITS } = {}) {
  if (!parsed || parsed.error) return { status: 'invalid', dataDate: parsed?.echo ?? null, reason: parsed?.error || '無內容', stats: null, structOk: false, empty: !!parsed?.empty };
  const dataDate = parsed.echo;
  const st = statsOf(parsed.rows);
  const bad = reason => ({ status: 'invalid', dataDate, reason, stats: st, structOk: false });
  if (st.rows < limits.minRows) return bad(`總列數 ${st.rows} < ${limits.minRows}`);
  if (st.stocks4 < limits.minStocks4) return bad(`4 碼股 ${st.stocks4} < ${limits.minStocks4}`);
  if (limits.minEtf00 != null && st.etf00 < limits.minEtf00) return bad(`00 開頭 ${st.etf00} < ${limits.minEtf00}`);
  if (st.dup) return bad(`代號重複 ${st.dup} 筆`);
  if (st.closeParse < limits.minCloseParse) return bad(`4 碼收盤可解析 ${(st.closeParse * 100).toFixed(1)}% < ${limits.minCloseParse * 100}%`);
  if (prevCodes4 && prevCodes4.size) {
    const have = codes4Of(parsed.rows);
    let miss = 0; for (const c of prevCodes4) if (!have.has(c)) miss++;
    if (miss / prevCodes4.size > limits.maxMissingVsPrev) return bad(`與前一份相比缺 ${miss}/${prevCodes4.size} 檔 4 碼股（> ${limits.maxMissingVsPrev * 100}%）`);
  }
  const iso = expect ? toIso(expect) : null;
  if (iso && dataDate !== iso) return { status: 'notYet', dataDate, reason: `回聲 ${dataDate}≠${iso}`, stats: st, structOk: true };
  if (!iso) {
    if (today && dataDate > today) return bad(`資料日 ${dataDate} 晚於今天 ${today}`);
    if (!isTradingDay(dataDate)) return bad(`資料日 ${dataDate} 不是交易日`);
  }
  return { status: 'ok', dataDate, reason: null, stats: st, structOk: true };
}

/** daemon 宇宙種子：既有口徑（4 碼＋00 開頭 4～6 碼）→ {code,name,market,close,change,vol,open,high,low} */
export function seedRowsOf(rows) {
  const out = [];
  for (const x of rows || []) {
    const code = String(x.SecuritiesCompanyCode ?? '').trim();
    if (!isSeedCode(code)) continue;
    out.push({ code, name: String(x.CompanyName ?? '').trim(), market: 'otc', close: num(x.Close), change: num(x.Change), vol: num(x.TradingShares), open: num(x.Open), high: num(x.High), low: num(x.Low) });
  }
  return out;
}

/** 上櫃 4 碼發行股數（Capitals＝股數，例：台燿 299,493,093）→ {code: 股數} */
export function sharesOf(rows) {
  const map = {};
  for (const x of rows || []) {
    const c = String(x.SecuritiesCompanyCode ?? '').trim();
    const n = num(x.Capitals);
    if (isStock4(c) && n > 0) map[c] = n;
  }
  return map;
}

/** 網站用欄位（twse-api-server 讀的就這些；Date 放文件層 roc） */
export const WEB_FIELDS = Object.freeze(['SecuritiesCompanyCode', 'CompanyName', 'Close', 'Change', 'Open', 'High', 'Low', 'TradingShares', 'TransactionAmount', 'TransactionNumber']);

/**
 * Firestore tpexClose/{latest|date} 文件（daemon 與匯入 CLI 共用同一個寫入格式）：
 *   rowsJson＝isWebSecurity 篩過的列，每列依 fields 排成陣列（1,005 列約 120KB）；dataDate＝來源自報資料日。
 *   第三方後備（2026-10-08，scripts/lib/tpex-close-finmind.mjs）另帶 grade:'3P'、volumeBasis、missingFields——只在內部標示，
 *   網站不顯示來源字樣；官方文件不帶這三欄（形狀與既有相同）。官方到了以 set() 整份覆蓋，這三欄隨之消失。
 */
export function firestoreDocOf({ dataDate, rows, source, sha256, fetchedAt, grade = null, volumeBasis = null, missingFields = null }, nowMs = Date.now()) {
  const keep = rows.filter(r => isWebSecurity(String(r.SecuritiesCompanyCode ?? '').trim()));
  const st = statsOf(rows);
  return {
    dataDate, roc: rocOf(dataDate), source: source || null, sha256: sha256 || null,
    rows: keep.length, stocks4: st.stocks4, etf00: st.etf00, fields: [...WEB_FIELDS],
    rowsJson: JSON.stringify(keep.map(r => WEB_FIELDS.map(f => String(r[f] ?? '')))),
    fetchedAt: fetchedAt || null, updatedAt: nowMs,
    ...(grade && grade !== 'official' ? { grade, volumeBasis: volumeBasis || null, missingFields: Array.isArray(missingFields) ? [...missingFields] : [] } : {}),
  };
}

/**
 * 網站讀回用：Firestore tpexClose 文件（firestoreDocOf 的輸出）→ { dataDate, roc, rows(openapi 形狀；每列 Date＝roc), source, grade, volumeBasis }；
 * 格式不符回 null（不捏造欄位）。grade：沒有此欄＝'official'；第三方後備＝'3P'（讀者以 grade !== 'official' 排除「只收官方」的用途）。
 */
const DOC_REQUIRED = ['SecuritiesCompanyCode', 'CompanyName', 'Close'];
export function decodeTpexCloseDoc(d) {
  if (!d || typeof d !== 'object') return null;
  const dataDate = typeof d.dataDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.dataDate) ? d.dataDate : null;
  const roc = typeof d.roc === 'string' && /^\d{7}$/.test(d.roc) ? d.roc : null;
  const fields = Array.isArray(d.fields) ? d.fields.map(String) : null;
  if (!dataDate || !roc || !fields || typeof d.rowsJson !== 'string') return null;
  if (!DOC_REQUIRED.every(f => fields.includes(f))) return null;
  let arr;
  try { arr = JSON.parse(d.rowsJson); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const rows = [];
  for (const a of arr) {
    if (!Array.isArray(a)) continue;
    const o = {};
    fields.forEach((f, i) => { o[f] = String(a[i] ?? ''); });
    rows.push({
      Date: roc, SecuritiesCompanyCode: o.SecuritiesCompanyCode ?? '', CompanyName: o.CompanyName ?? '', Close: o.Close ?? '0', Change: o.Change ?? '0',
      Open: o.Open ?? '0', High: o.High ?? '0', Low: o.Low ?? '0', TradingShares: o.TradingShares ?? '0', TransactionAmount: o.TransactionAmount ?? '0', TransactionNumber: o.TransactionNumber ?? '0',
    });
  }
  const grade = d.grade == null || d.grade === 'official' ? 'official' : String(d.grade);
  return { dataDate, roc, rows, source: typeof d.source === 'string' ? d.source : null, grade, volumeBasis: typeof d.volumeBasis === 'string' ? d.volumeBasis : null };
}

const isoAddDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/**
 * 上櫃收盤是否落後超過一個交易日：closeIso 與 refIso（上市資料日；不明時用今天）之間「嚴格夾著」至少一個交易日 ⇒ true。
 *   D-1 對 D＝正常（櫃買比證交所晚出，舊版直打 openapi 也是這樣）；D-2 對 D＝落後兩天（daemon 停寫）⇒ 讀者當作讀不到、走既有的「上櫃缺」後備。
 *   上櫃比參考日新也不算落後。isTradingDay(iso) 可注入（網站用自己的休市表）；最多看 60 天，再遠一律算落後。
 */
export function isCloseLagging(closeIso, refIso, isTradingDay = weekday) {
  if (!closeIso || !refIso || closeIso >= refIso) return false;
  let d = isoAddDays(closeIso, 1);
  for (let i = 0; i < 60 && d < refIso; i++, d = isoAddDays(d, 1)) if (isTradingDay(d)) return true;
  return d < refIso;
}

/** 依每列自報的 Date 分出「資料日＝iso」與其他日子的列；沒有 Date 或認不得格式的列算 iso（舊行為：一律套參考日） */
export function splitRowsByDate(rows, iso) {
  const same = [], off = [];
  for (const r of rows || []) ((toIso(r?.Date) || iso) === iso ? same : off).push(r);
  return { same, off };
}

// ── 第三方後備等級在網站列上的傳遞（2026-10-08 審查 MEDIUM）──
//   twse-api-server 把 tpexClose 文件的 grade≠official 標在上櫃列 _grade；getStockDayAllDataInternal 的兩個出口（快照、closeOnly fallback）
//   逐欄重建物件，舊版沒帶 _grade ⇒ daily-close 的「歷史 K 棒不收 3P」形同虛設。出口一律展開 gradeTagOf(來源列)；daily-close 用 officialBarRows。
/** 列是否來自第三方後備（_grade 有值且不是 'official'） */
export const isThirdPartyRow = r => { const g = r?._grade; return g != null && g !== '' && g !== 'official'; };
/** 把來源列的非官方等級帶到新列（官方列回空物件＝形狀不變） */
export const gradeTagOf = r => (isThirdPartyRow(r) ? { _grade: String(r._grade) } : {});
/**
 * daily-close 寫歷史 K 棒前的篩選：列自帶 _grade≠official 排除；第二道防線——tpexClose 文件（readTpexClose）同資料日是 3P 時，
 *   上櫃列（_market==='otc'）也排除（列上的標記若在中途被丟掉仍擋得住）。上市列不受影響。
 * @param {any[]} rows
 * @param {{iso?:string, otcDoc?:{grade?:string|null, dataDate?:string|null}|null, isOtc?:(r:any)=>boolean}} [opts]
 * @returns {{keep:any[], thirdParty:any[]}}
 */
export function officialBarRows(rows, { iso, otcDoc = null, isOtc = r => r?._market === 'otc' } = {}) {
  const doc3P = !!otcDoc && otcDoc.grade != null && otcDoc.grade !== 'official' && otcDoc.dataDate === iso;
  const keep = [], thirdParty = [];
  for (const r of rows || []) ((isThirdPartyRow(r) || (doc3P && isOtc(r))) ? thirdParty : keep).push(r);
  return { keep, thirdParty };
}
