// ── MOPS 月營收彙總表 t21sc03 的純函式（2026-10-04）──────────────────────────────
// 抓取端 scripts/backfill-mops-revenue.mjs（daemon 每天加厚最近 2 個月）與零網路回補
// scripts/backfill-revenue-from-mirror.mjs（讀第二大腦官方鏡像）共用；沒有 I/O，可單元測試。
//
// 為什麼要 4 頁：t21sc03_{民國年}_{月}_0.html 只有**本國**公司，外國公司（-KY／DR）在 _1.html。
//   2026-10-04 前回補器只抓 _0 ⇒ 上市 KY 78~93 檔、上櫃 KY 27~30 檔的月營收在 revenueArchive 全部缺值
//   （研究測試期 73 檔 KY 月營收 100% 缺）。兩表欄位完全相同（11 欄、單位千元），代號零重疊。
// 為什麼要「依資料定版」：舊版以「既有 ≥1700 檔」當完整並永久略過 ⇒ 次月 10 日後才上表的晚申報者
//   （金控／保險 2880~2892、5880、2816 等）在 2026-07、2026-08 永久漏掉 17~22 檔。
//   現在定版三個條件都要（isMonthFinal）：
//   ① 4 頁皆成功；
//   ② 名冊完整：上月文件的代號（扣掉上月自己的「留存」）在本月 4 頁名冊缺 ≤ MAX_MISSING_VS_PREV 檔
//      ——晚申報者上月有申報，本月還沒上表就會在這裡被點名（2026-10-04 審查：只看「筆數沒增加」擋不住
//      「11 日後隔幾天才整批上表」的金融業）；
//   ③ 穩定：次月 11 日（含）起、相隔 ≥3 個日曆日的兩次觀測，合併筆數沒有增加。
//   觀測時刻用頁面自報的「出表日期」（gen），不用抓取時鐘：MOPS 回的是快取頁（實測可舊 3 天以上）。

export const REV_DOC_VERSION = 2;
export const MAX_DOC_BYTES = 900_000;          // Firestore 單文件上限 1,048,487 bytes；留 15% 餘裕
export const FETCH_LOG_MAX = 8;
export const FINAL_AFTER_DAY = 11;             // 法定申報期限＝次月 10 日 ⇒ 11 日（含）起的觀測才算數
export const FINAL_MIN_GAP_DAYS = 3;
// 名冊比對容許的缺檔（下市／暫停）：2026-10-04 實測，08-10 寫入的上月文件對 10-04 產生的本月頁，
//   8 週內下市 3 檔（2867、5371、8183）；晚申報的金融群一次 15~17 檔。5 介於兩者之間。
export const MAX_MISSING_VS_PREV = 5;
const MISSING_CODES_KEPT = 40;                 // 文件裡只留前 40 個缺檔代號給稽核看（筆數另記）

/** 4 張表：市場 × 本國(_0)／外國(_1)。label 也是 bySrc 的鍵。 */
export const T21_PAGES = Object.freeze([
  Object.freeze({ mkt: 'sii', page: '0', label: '上市' }),
  Object.freeze({ mkt: 'sii', page: '1', label: '上市KY' }),
  Object.freeze({ mkt: 'otc', page: '0', label: '上櫃' }),
  Object.freeze({ mkt: 'otc', page: '1', label: '上櫃KY' }),
]);
export const RETAINED_LABEL = '留存';          // 既有文件有、本次各頁都沒出現的代號（只加不減，保留舊值）

const pad2 = n => String(n).padStart(2, '0');

/** 民國年、月份**不補零**（是 `_8_` 不是 `_08_`）。 */
export function t21Url(mkt, roc, month, page) {
  return `https://mopsov.twse.com.tw/nas/t21/${mkt}/t21sc03_${roc}_${month}_${page}.html`;
}

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
// 增減 % 欄：官方表在「基期為 0」時留白 ⇒ 存 null，不可補 0（補 0 是捏造：會被當成「持平」）
const pct = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? +n.toFixed(2) : null; };

/** 頁面上每一列「≥8 欄、第 1 欄是 4 碼代號」的儲存格（表頭、產業標題、合計列、6 碼存託憑證都被這道濾掉）。 */
function* t21CodeRows(html) {
  for (const m of String(html ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(x => x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (tds.length >= 8 && /^\d{4}$/.test(tds[0])) yield tds;
  }
}

/**
 * 解析一張 t21sc03 表（已用 big5 解碼的 HTML）→ [{c,n,rev,prev,last,mom,yoy,cum}]（金額單位千元、% 兩位小數）。
 * 篩法沿用舊回補器（頁面有 68 個排版用巢狀 table，不能用第 N 個表定位）：≥8 欄、第 1 欄是 4 碼代號、當月營收 > 0。
 * ⚠ 當月營收 ≤ 0 的列**照舊不收**——這包含官方公布的負營收（金控／證券評價損失，例 2881 2023-11 −8,994,147）
 *   與 0 營收，不只是「新上市未公布」。是否改收要與研究端 revenue_official.py（同一條規則）一起改並記 EXPERIMENTS，
 *   2026-10-04 審查列為另案。名冊比對不受這條影響（用 t21Codes，含這些列）。
 */
export function parseT21sc03(html) {
  const out = [];
  for (const tds of t21CodeRows(html)) {
    const rev = num(tds[2]);
    if (rev <= 0) continue;                       // 見上方 ⚠：負值／0 營收不收（沿用舊行為）
    out.push({
      c: tds[0], n: tds[1],
      rev: Math.round(rev),                       // 當月營收（千元）
      prev: Math.round(num(tds[3])),              // 上月營收
      last: Math.round(num(tds[4])),              // 去年當月營收
      mom: pct(tds[5]),                           // 上月比較增減 %（留白＝null）
      yoy: pct(tds[6]),                           // 去年同月增減 %（留白＝null）
      cum: Math.round(num(tds[7])),               // 當月累計營收
    });
  }
  return out;
}

/** 頁面列出的全部 4 碼代號（含當月營收 0／負值的列）——名冊比對用，與 parseT21sc03 的營收篩選無關。 */
export function t21Codes(html) { return [...t21CodeRows(html)].map(tds => tds[0]); }

/** 頁面自報的產生時刻「出表日期：115/10/04<!--20:00:18-->」→ epoch ms（台北時間）；只有日期記當日 00:00；認不得回 null。 */
export function t21Gen(html) {
  const m = String(html ?? '').match(/出表日期[：:]\s*(\d{2,3})\/(\d{1,2})\/(\d{1,2})\s*(?:<!--\s*(\d{1,2}):(\d{2}):(\d{2})\s*-->)?/);
  if (!m) return null;
  const t = Date.parse(`${+m[1] + 1911}-${pad2(m[2])}-${pad2(m[3])}T${pad2(m[4] ?? 0)}:${m[5] ?? '00'}:${m[6] ?? '00'}+08:00`);
  return Number.isFinite(t) ? t : null;
}

/**
 * 頁面自報身分（回音）：標題「上市公司115年8月份」＋表尾「全部國內／國外上市公司合計」＋產生時刻 gen。
 * 認不得標題回 null；表尾認不得時 kind／kindMarket 為 null。
 */
export function t21Echo(html) {
  const s = String(html ?? '');
  const t = s.match(/(上市|上櫃)公司(\d+)年(\d+)月份/);
  if (!t) return null;
  const k = s.match(/全部(國內|國外)(上市|上櫃)公司合計/);
  return {
    market: t[1] === '上市' ? 'sii' : 'otc', roc: +t[2], month: +t[3],
    kind: k ? (k[1] === '國內' ? '0' : '1') : null,
    kindMarket: k ? (k[2] === '上市' ? 'sii' : 'otc') : null,
    gen: t21Gen(s),
  };
}

/** 回音必須與請求的市場、民國年、月相符；給 page 時表尾的本國／外國與市場也必須相符（防 _0／_1 互換）。 */
export function echoOk(html, mkt, roc, month, page = null) {
  const e = t21Echo(html);
  if (!e || e.market !== mkt || e.roc !== Number(roc) || e.month !== Number(month)) return false;
  if (page == null) return true;
  return e.kind === String(page) && e.kindMarket === mkt;
}

// ── 官方「另存CSV」（2026-10-04）：server-java/FileDownLoad 的 t21sc03_{民國年}_{月}.csv ─────────────
// 為什麼：MOPS 端 2026-03 上市 _0／_1 靜態頁回 HTTP 200、0 bytes（重試多次），鏡像缺頁 ⇒ 該月無法補上市 KY。
//   同站「另存CSV」是同一份資料（頁面註明「檔案內容包含國內及國外公司」）：UTF-8（BOM）、CRLF、每欄雙引號、14 欄；
//   本國與外國在同一檔、沒有市場欄；% 欄是全精度（HTML 是向零截斷到 2 位）。
//   研究端 revenue_official.py 實測 2026-02 上市與 _0＋_1 兩頁逐格相同（1,082 列、0 差異）。
export const T21_CSV_HEADER = Object.freeze(['出表日期', '資料年月', '公司代號', '公司名稱', '產業別',
  '營業收入-當月營收', '營業收入-上月營收', '營業收入-去年當月營收', '營業收入-上月比較增減(%)', '營業收入-去年同月增減(%)',
  '累計營業收入-當月累計營收', '累計營業收入-去年累計營收', '累計營業收入-前期比較增減(%)', '備註']);

/** RFC 4180：逗號分欄、雙引號包欄（內含逗號／換行）、"" 跳脫；CRLF／LF 皆可；開頭 BOM 去掉、空行略過。引號未閉合丟錯。 */
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch !== '"') f += ch;
      else if (s[i + 1] === '"') { f += '"'; i++; }
      else q = false;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += ch;
  }
  if (q) throw new Error('CSV 引號未閉合');
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

/**
 * CSV 的增減 % 是全精度（Java double 字串，可能是 5.0E-4 這種科學記號）；HTML 版是「向零截斷到 2 位」。
 * 用十進位字串移位截斷，不經浮點乘除（1.15*100 會變 114.999…）。留白、- 等非數字回 null（不補 0）。
 */
export function truncPct2(v) {
  const m = String(v ?? '').replace(/,/g, '').trim().match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m || !(m[2] || m[3])) return null;
  const digits = `${m[2]}${m[3] ?? ''}`; const point = m[2].length + Number(m[4] ?? 0);
  const intPart = point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0');
  const frac = point <= 0 ? `${'0'.repeat(-point)}${digits}` : digits.slice(point);
  const n = Number(`${m[1]}${intPart || '0'}.${`${frac}00`.slice(0, 2)}`);
  return Number.isFinite(n) ? n + 0 : null;              // + 0：-0 → 0
}

/** CSV 不分本國／外國：名稱含 KY（含「-KY創」）或 91xx 存託憑證＝外國發行人（_1 表）。與研究端 revenue_official.py is_foreign 同一條。 */
export function isForeignIssuer(code, name) { return String(name ?? '').includes('KY') || String(code ?? '').startsWith('91'); }

/** 民國日期「115/10/04」→ 台北當日 00:00 的 epoch ms；認不得回 null。 */
function rocDayMs(s) {
  const m = String(s ?? '').trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const t = Date.parse(`${+m[1] + 1911}-${pad2(m[2])}-${pad2(m[3])}T00:00:00+08:00`);
  return Number.isFinite(t) ? t : null;
}

/**
 * 解析官方 CSV（已解碼的文字）→ { gen, dom: {rows, codes}, fgn: {rows, codes} }；格式或回音不符丟錯（呼叫端不可用這份檔）。
 * 回音：表頭 14 欄逐欄相符；每一列「資料年月」＝`${roc}/${month}`（月不補零）且欄數 14；出表日期全檔同一天（gen＝台北當日 00:00）。
 * 列的篩法與 parseT21sc03 相同（4 碼代號、當月營收 > 0 才收；名冊 codes 含營收 ≤0 的列）；% 向零截斷 2 位＝HTML 呈現。
 */
export function parseT21Csv(text, { roc, month }) {
  const all = parseCsv(text);
  const hdr = (all[0] || []).map(h => h.trim());
  if (hdr.length !== T21_CSV_HEADER.length || hdr.some((h, i) => h !== T21_CSV_HEADER[i])) throw new Error(`CSV 表頭不符：${hdr.slice(0, 4).join(',')}`);
  const body = all.slice(1);
  if (!body.length) throw new Error('CSV 沒有資料列');
  const want = `${Number(roc)}/${Number(month)}`;
  const days = new Set(body.map(r => String(r[0] ?? '').trim()));
  const bad = body.find(r => r.length !== T21_CSV_HEADER.length || r[1].trim() !== want);
  if (bad) throw new Error(bad.length !== T21_CSV_HEADER.length ? `CSV 欄數不符（${bad.length}）：${bad.slice(0, 4).join(',')}` : `CSV 回音不符：資料年月 ${bad[1]} ≠ ${want}`);
  if (days.size !== 1) throw new Error(`CSV 出表日期不一致：${[...days].slice(0, 3).join(',')}`);
  const gen = rocDayMs([...days][0]);
  if (gen == null) throw new Error(`CSV 出表日期認不得：${[...days][0]}`);
  const listed = body.map(r => ({ r, c: r[2].trim(), n: r[3].trim() })).filter(x => /^\d{4}$/.test(x.c));
  const side = foreign => {
    const mine = listed.filter(x => isForeignIssuer(x.c, x.n) === foreign);
    const rows = mine.filter(x => num(x.r[5]) > 0).map(({ r, c, n }) => ({     // 營收 ≤0 不收：同 parseT21sc03 的 ⚠
      c, n, rev: Math.round(num(r[5])), prev: Math.round(num(r[6])), last: Math.round(num(r[7])),
      mom: truncPct2(r[8]), yoy: truncPct2(r[9]), cum: Math.round(num(r[10])),
    }));
    return { rows, codes: mine.map(x => x.c) };
  };
  return { gen, dom: side(false), fgn: side(true) };
}

/** CSV 列出的全部 4 碼代號（鏡像內容穩定定版的名冊）；不做回音、解析失敗回 []（名冊缺 ⇒ 不定版，不丟錯）。 */
export function t21CsvCodes(text) {
  try { return parseCsv(text).slice(1).map(r => String(r[2] ?? '').trim()).filter(c => /^\d{4}$/.test(c)); } catch { return []; }
}

/**
 * CSV 沒有市場欄、也不分表 ⇒ 兩道核對都拿同市場「參照頁」（鏡像相鄰月份的 _0／_1 HTML 頁，它們有自己的市場與表別回音）：
 *   ① 市場：CSV 代號落在參照名冊（_0∪_1）的比例 ≥ minShare（上市與上櫃代號不相交，拿錯市場的檔比例≈0）；
 *   ② 分類：參照 _0 的代號在 CSV 被判成外國、或參照 _1 的代號被判成本國 ⇒ 分類規則失效（isForeignIssuer），不可用。
 * ref：{ dom: 參照 _0 代號, fgn: 參照 _1 代號 }；沒有參照回 ok:false（無法證明）。
 */
export function csvRefCheck(parsed, ref, { minShare = 0.9 } = {}) {
  if (!ref || !ref.dom?.length || !ref.fgn?.length) return { ok: false, note: '沒有同市場參照頁可核對市場與本國／外國分類' };
  const refDom = new Set(ref.dom.map(String)); const refFgn = new Set(ref.fgn.map(String));
  const codes = [...parsed.dom.codes, ...parsed.fgn.codes];
  const share = codes.length ? codes.filter(c => refDom.has(c) || refFgn.has(c)).length / codes.length : 0;
  const misDom = parsed.fgn.codes.filter(c => refDom.has(c)); const misFgn = parsed.dom.codes.filter(c => refFgn.has(c));
  if (share < minShare) return { ok: false, share, note: `市場回音不符：CSV 代號在參照名冊的比例 ${(share * 100).toFixed(1)}% < ${minShare * 100}%` };
  if (misDom.length || misFgn.length) return { ok: false, share, note: `本國／外國分類與參照頁不符：判外國但在 _0 [${misDom.slice(0, 8)}]、判本國但在 _1 [${misFgn.slice(0, 8)}]` };
  return { ok: true, share };
}

/** 把成功的各頁併成一份：同一代號只取第一次出現（4 頁實測零重疊；重疊會記在 dup）。srcOf：代號→頁 label。 */
export function combinePages(pages) {
  const rows = []; const srcOf = new Map(); const dup = [];
  for (const p of pages || []) {
    for (const r of p.rows || []) {
      const c = String(r.c);
      if (srcOf.has(c)) { dup.push(c); continue; }
      srcOf.set(c, p.label); rows.push(r);
    }
  }
  return { rows, srcOf, dup };
}

/**
 * 依代號聯集，**永不變薄**：舊列一律保留（順序不變）；新代號接在後面。
 * override=true：同代號以新值取代；false：舊值不動（只補缺）。何時可以 override 見 hasSettledObservation。
 * 回傳新陣列，不改動輸入。
 */
export function mergeRows(oldRows, newRows, { override = false } = {}) {
  const out = []; const idx = new Map();
  for (const r of oldRows || []) {
    if (!r || r.c == null) continue;
    const c = String(r.c);
    if (!idx.has(c)) idx.set(c, out.length);
    out.push(r);
  }
  for (const r of newRows || []) {
    if (!r || r.c == null) continue;
    const c = String(r.c);
    if (idx.has(c)) { if (override) out[idx.get(c)] = r; continue; }
    idx.set(c, out.length); out.push(r);
  }
  return out;
}

/** 文件組成：各頁貢獻幾檔（本次各頁都沒出現的舊代號記「留存」）＋KY 檔數。 */
export function composition(rows, srcOf) {
  const bySrc = Object.fromEntries([...T21_PAGES.map(p => [p.label, 0]), [RETAINED_LABEL, 0]]);
  for (const r of rows || []) { const l = srcOf?.get(String(r.c)) ?? RETAINED_LABEL; bySrc[l] = (bySrc[l] || 0) + 1; }
  return { bySrc, kyN: bySrc['上市KY'] + bySrc['上櫃KY'] };
}

/** 讀 revenueArchive 文件的列（rowsJson 為陣列或物件皆可）；沒有文件回 []；JSON 壞掉丟錯（呼叫端不可覆蓋讀不懂的文件）。 */
export function rowsOf(doc) {
  if (!doc || typeof doc.rowsJson !== 'string') return [];
  const v = JSON.parse(doc.rowsJson);
  return Array.isArray(v) ? v : Object.values(v || {});
}

/**
 * daemon computeRevenue 以 openapi t187ap05 寫的薄版（沒有 v、沒有 bySrc）：_L＋_P 混有未上市的公開發行公司、沒有上櫃。
 * 不可當聯集基底——否則未上市公司會以「留存」永遠留在歸檔裡。由 MOPS 4 頁整份取代（筆數仍須 ≥ 既有）。
 */
export function isOpenapiDoc(doc) { return !!doc && doc.v == null && doc.bySrc == null; }

/** v2 且已依資料定版的月份才略過；舊版（無 v）或未定版的一律重抓（自癒補上 KY 與晚申報者）。 */
export function shouldSkipMonth(doc) { return !!doc && Number(doc.v) >= REV_DOC_VERSION && doc.final === true; }

// ── 定版（看資料不看時鐘）───────────────────────────────────────────
/** 毫秒時戳 → 台北日曆日 YYYY-MM-DD。 */
export function taipeiDay(ms) { return new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 10); }
/** 'YYYY-MM' 的次月第 day 日（YYYY-MM-DD）。 */
export function nextMonthDay(monthId, day) {
  const [y, m] = String(monthId).split('-').map(Number);
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return `${ny}-${pad2(nm)}-${pad2(day)}`;
}
/** 'YYYY-MM' 的上個月（名冊比對的參照月）。 */
export function prevMonthId(monthId) {
  const [y, m] = String(monthId).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
/** 觀測時刻：頁面自報的產生時刻 gen 優先（MOPS 會回快取頁），沒有才用抓取時刻 at。 */
export const obsTime = e => (e?.gen != null && Number.isFinite(Number(e.gen)) ? Number(e.gen) : Number(e?.at));
const validEntry = e => e && Number.isFinite(obsTime(e)) && Number.isFinite(Number(e.n));

/**
 * 記一次「4 頁皆成功」的觀測 {at(抓取 ms), gen(4 頁中最早的產生時刻 ms), n(合併後筆數), src}。
 * 同一個產生時刻（gen 相同＝同一份快取頁）不是新觀測 ⇒ 不記。
 * 同筆數的連續觀測只留該段的第一筆＋最新一筆（不跨過次月 11 日的界線），長度上限 max——
 * 定版只需要「該段在 11 日後的起點」與「最新一筆」，一天三輪的抓取不會把起點擠掉。
 */
export function appendFetchLog(log, entry, { monthId, afterDay = FINAL_AFTER_DAY, max = FETCH_LOG_MAX } = {}) {
  const prev = (Array.isArray(log) ? log : []).filter(validEntry);
  if (entry?.gen != null && prev.some(e => e.gen != null && Number(e.gen) === Number(entry.gen))) return prev;
  const th = monthId ? nextMonthDay(monthId, afterDay) : null;
  const side = e => (th ? taipeiDay(obsTime(e)) >= th : true);
  const k = prev.length;
  // 比最新一筆還舊的觀測（例：daemon 已抓過之後才跑鏡像回補）⇒ 依觀測時刻插入，不做合併
  if (k && obsTime(entry) < obsTime(prev[k - 1])) return [...prev, entry].sort((a, b) => obsTime(a) - obsTime(b)).slice(-max);
  if (k >= 2 && prev[k - 1].n === entry.n && prev[k - 2].n === entry.n
    && side(prev[k - 2]) === side(entry) && side(prev[k - 1]) === side(entry)) {
    return [...prev.slice(0, -1), entry].slice(-max);
  }
  return [...prev, entry].slice(-max);
}

/**
 * 穩定條件：次月 afterDay 日（含）起的觀測中，最新一筆的筆數已持續 ≥minGapDays 個日曆日沒有增加（日期以觀測時刻 gen 優先）。
 * 只有一次觀測、或都在申報期內 ⇒ false。這只是三個定版條件之一，定版一律走 isMonthFinal。
 */
export function revenueFinal(monthId, fetchLog, { afterDay = FINAL_AFTER_DAY, minGapDays = FINAL_MIN_GAP_DAYS } = {}) {
  const th = nextMonthDay(monthId, afterDay);
  const obs = (Array.isArray(fetchLog) ? fetchLog : []).filter(validEntry)
    .map(e => ({ t: obsTime(e), n: Number(e.n) })).filter(e => taipeiDay(e.t) >= th).sort((a, b) => a.t - b.t);
  if (obs.length < 2) return false;
  const last = obs[obs.length - 1];
  let i = obs.length - 1;
  while (i > 0 && obs[i - 1].n === last.n) i--;
  return dayDiff(taipeiDay(obs[i].t), taipeiDay(last.t)) >= minGapDays;
}

/**
 * 名冊比對（資料完整性）：上月文件的代號——扣掉上月文件自己的「留存」（retained，當時頁面已沒有的舊代號）——
 * 在本月各頁名冊（codes，t21Codes 的聯集）都找不到的 ⇒ 尚未申報或已下市，排序後回傳。
 * 參照不可用（沒有上月文件、上月是 openapi 薄版、讀不懂）回 null ⇒ 完整性無法證明、不定版。
 */
export function missingVsPrev(prevDoc, codes) {
  if (!prevDoc || isOpenapiDoc(prevDoc)) return null;
  let rows;
  try { rows = rowsOf(prevDoc); } catch { return null; }
  if (!rows.length) return null;
  const retained = new Set(Array.isArray(prevDoc.retained) ? prevDoc.retained.map(String) : []);
  const have = new Set([...(codes || [])].map(String));
  return [...new Set(rows.map(r => String(r.c)))].filter(c => !retained.has(c) && !have.has(c)).sort();
}
/** 寫進文件給稽核看的摘要：{n, codes(前 40)}；參照不可用為 null。 */
export const missingSummary = missing => (Array.isArray(missing) ? { n: missing.length, codes: missing.slice(0, MISSING_CODES_KEPT) } : null);

/** 定版：①4 頁皆成功 ②名冊完整（較上月缺 ≤ maxMissing）③穩定（revenueFinal）——三者皆成立。 */
export function isMonthFinal(monthId, { allPages, missing, fetchLog }, { maxMissing = MAX_MISSING_VS_PREV, ...opts } = {}) {
  return !!allPages && Array.isArray(missing) && missing.length <= maxMissing && revenueFinal(monthId, fetchLog, opts);
}

/**
 * 是否已有「申報期後」的觀測（觀測時刻 ≥ 次月 11 日）：有的話既有列一律不動、只補缺——
 * 事後更正的官方值不回寫歷史（研究以「次月 11 日可得」使用歸檔值，回寫＝前視；2026-10-04 審查實測 52 列金額被更正過）。
 * 依據：fetchLog 的觀測時刻；沒有 fetchLog 的舊文件看寫入時刻 at。
 */
export function hasSettledObservation(monthId, doc, { afterDay = FINAL_AFTER_DAY } = {}) {
  if (!doc) return false;
  const th = nextMonthDay(monthId, afterDay);
  const log = (Array.isArray(doc.fetchLog) ? doc.fetchLog : []).filter(validEntry);
  if (log.length) return log.some(e => taipeiDay(obsTime(e)) >= th);
  const at = Number(doc.at);
  return Number.isFinite(at) && at > 0 && taipeiDay(at) >= th;
}

/**
 * 修正舊版捏造的 0：舊回補器把官方留白的增減 % 存成 0。
 * 只在「歸檔是 0 而官方頁同代號的該格是留白（null）」時改成 null；其他欄位與其他列一律不動。
 */
export function fixFabricatedZeros(rows, officialByCode) {
  const yoy = []; const mom = [];
  const out = (rows || []).map(r => {
    const o = officialByCode?.get(String(r?.c));
    if (!o) return r;
    let nr = r;
    if (r.yoy === 0 && o.yoy === null) { nr = { ...nr, yoy: null }; yoy.push(String(r.c)); }
    if (r.mom === 0 && o.mom === null) { nr = { ...nr, mom: null }; mom.push(String(r.c)); }
    return nr;
  });
  return { rows: out, yoy, mom };
}
