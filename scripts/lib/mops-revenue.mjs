// ── MOPS 月營收彙總表 t21sc03 的純函式（2026-10-04）──────────────────────────────
// 抓取端 scripts/backfill-mops-revenue.mjs（daemon 每天加厚最近 2 個月）與零網路回補
// scripts/backfill-revenue-from-mirror.mjs（讀第二大腦官方鏡像）共用；沒有 I/O，可單元測試。
//
// 為什麼要 4 頁：t21sc03_{民國年}_{月}_0.html 只有**本國**公司，外國公司（-KY／DR）在 _1.html。
//   2026-10-04 前回補器只抓 _0 ⇒ 上市 KY 78~93 檔、上櫃 KY 27~30 檔的月營收在 revenueArchive 全部缺值
//   （研究測試期 73 檔 KY 月營收 100% 缺）。兩表欄位完全相同（11 欄、單位千元），代號零重疊。
// 為什麼要「依資料定版」：舊版以「既有 ≥1700 檔」當完整並永久略過 ⇒ 次月 10 日後才上表的晚申報者
//   （金控／保險 2880~2892、5880、2816 等）在 2026-07、2026-08 永久漏掉 17~22 檔。
//   現在定版只看資料：4 頁皆成功，且次月 11 日（含）起、相隔 ≥3 個日曆日的兩次成功抓取，合併筆數沒有增加。

export const REV_DOC_VERSION = 2;
export const MAX_DOC_BYTES = 900_000;          // Firestore 單文件上限 1,048,487 bytes；留 15% 餘裕
export const FETCH_LOG_MAX = 8;
export const FINAL_AFTER_DAY = 11;             // 法定申報期限＝次月 10 日 ⇒ 11 日（含）起的觀測才算數
export const FINAL_MIN_GAP_DAYS = 3;

/** 4 張表：市場 × 本國(_0)／外國(_1)。label 也是 bySrc 的鍵。 */
export const T21_PAGES = Object.freeze([
  Object.freeze({ mkt: 'sii', page: '0', label: '上市' }),
  Object.freeze({ mkt: 'sii', page: '1', label: '上市KY' }),
  Object.freeze({ mkt: 'otc', page: '0', label: '上櫃' }),
  Object.freeze({ mkt: 'otc', page: '1', label: '上櫃KY' }),
]);
export const RETAINED_LABEL = '留存';          // 既有文件有、本次各頁都沒出現的代號（只加不減，保留舊值）

/** 民國年、月份**不補零**（是 `_8_` 不是 `_08_`）。 */
export function t21Url(mkt, roc, month, page) {
  return `https://mopsov.twse.com.tw/nas/t21/${mkt}/t21sc03_${roc}_${month}_${page}.html`;
}

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
// 增減 % 欄：官方表在「基期為 0」時留白 ⇒ 存 null，不可補 0（補 0 是捏造：會被當成「持平」）
const pct = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? +n.toFixed(2) : null; };

/**
 * 解析一張 t21sc03 表（已用 big5 解碼的 HTML）→ [{c,n,rev,prev,last,mom,yoy,cum}]（金額單位千元、% 兩位小數）。
 * 篩法沿用舊回補器（頁面有 68 個排版用巢狀 table，不能用第 N 個表定位）：≥8 欄、第 1 欄是 4 碼代號、當月營收 > 0。
 * 表頭、產業標題列、合計列都被「4 碼代號」這道濾掉；6 碼的存託憑證（912000）同樣不收（全站消費端只認 4 碼）。
 */
export function parseT21sc03(html) {
  const out = [];
  for (const m of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(x => x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (tds.length < 8) continue;
    const code = tds[0];
    if (!/^\d{4}$/.test(code)) continue;
    const rev = num(tds[2]);
    if (rev <= 0) continue;                       // 無營收（新上市未公布）不佔位
    out.push({
      c: code, n: tds[1],
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

/**
 * 頁面自報身分（回音）：標題「上市公司115年8月份」＋表尾「全部國內／國外上市公司合計」。
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
  };
}

/** 回音必須與請求的市場、民國年、月相符；給 page 時表尾的本國／外國與市場也必須相符（防 _0／_1 互換）。 */
export function echoOk(html, mkt, roc, month, page = null) {
  const e = t21Echo(html);
  if (!e || e.market !== mkt || e.roc !== Number(roc) || e.month !== Number(month)) return false;
  if (page == null) return true;
  return e.kind === String(page) && e.kindMarket === mkt;
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
 * override=true：同代號以新值取代（daemon 重抓官方頁＝較新的官方值）；false：舊值不動（只補缺）。
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
const pad2 = n => String(n).padStart(2, '0');
/** 毫秒時戳 → 台北日曆日 YYYY-MM-DD。 */
export function taipeiDay(ms) { return new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 10); }
/** 'YYYY-MM' 的次月第 day 日（YYYY-MM-DD）。 */
export function nextMonthDay(monthId, day) {
  const [y, m] = String(monthId).split('-').map(Number);
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return `${ny}-${pad2(nm)}-${pad2(day)}`;
}
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const validEntry = e => e && Number.isFinite(Number(e.at)) && Number.isFinite(Number(e.n));

/**
 * 記一次「4 頁皆成功」的觀測 {at(ms), n(合併後筆數), src}。
 * 同筆數的連續觀測只留該段的第一筆＋最新一筆（不跨過次月 11 日的界線），長度上限 max——
 * 定版只需要「該段在 11 日後的起點」與「最新一筆」，一天三輪的抓取不會把起點擠掉。
 */
export function appendFetchLog(log, entry, { monthId, afterDay = FINAL_AFTER_DAY, max = FETCH_LOG_MAX } = {}) {
  const prev = (Array.isArray(log) ? log : []).filter(validEntry);
  const th = monthId ? nextMonthDay(monthId, afterDay) : null;
  const side = e => (th ? taipeiDay(e.at) >= th : true);
  const k = prev.length;
  // 比最新一筆還舊的觀測（例：daemon 已抓過之後才跑鏡像回補）⇒ 依時間插入，不做合併
  if (k && Number(entry.at) < Number(prev[k - 1].at)) return [...prev, entry].sort((a, b) => a.at - b.at).slice(-max);
  if (k >= 2 && prev[k - 1].n === entry.n && prev[k - 2].n === entry.n
    && side(prev[k - 2]) === side(entry) && side(prev[k - 1]) === side(entry)) {
    return [...prev.slice(0, -1), entry].slice(-max);
  }
  return [...prev, entry].slice(-max);
}

/**
 * 月份是否已定版：次月 afterDay 日（含）起的成功觀測中，最新一筆的筆數已持續 ≥minGapDays 個日曆日沒有增加。
 * 只有一次觀測、或都在申報期內 ⇒ 未定版。
 */
export function revenueFinal(monthId, fetchLog, { afterDay = FINAL_AFTER_DAY, minGapDays = FINAL_MIN_GAP_DAYS } = {}) {
  const th = nextMonthDay(monthId, afterDay);
  const obs = (Array.isArray(fetchLog) ? fetchLog : []).filter(validEntry)
    .map(e => ({ at: Number(e.at), n: Number(e.n) })).filter(e => taipeiDay(e.at) >= th).sort((a, b) => a.at - b.at);
  if (obs.length < 2) return false;
  const last = obs[obs.length - 1];
  let i = obs.length - 1;
  while (i > 0 && obs[i - 1].n === last.n) i--;
  return dayDiff(taipeiDay(obs[i].at), taipeiDay(last.at)) >= minGapDays;
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
