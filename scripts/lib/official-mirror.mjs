// ── 第二大腦·官方資料鏡像核心（2026-10-04 使用者：「官網上能下載的都下載補入第二大腦，交易日盤後自動更新」）──
// 規範：技能 tw-official-data-sources（官方來源、回聲驗證、PIT、節奏）；盤點清單 docs/OFFICIAL-DATA-INVENTORY-2026-10-04.md。
// 只做三件事：①依樣板組請求 ②驗證官方回應「是不是這一天／這一期」③原樣 gzip 存檔＋逐檔清單。不解析、不改欄位。
// 存放：second-brain/official/{host}/{dataset}/{key}.json.gz（JSON：{meta, payload}）或 {key}.{html|csv|txt}.gz（原始位元組，meta 在 _manifest.json）。
// 節奏：同一出口 IP 也是站上 daemon 的出口 ⇒ 每個機構（證交所系／櫃買系／期交所）一條佇列、逐請求 ≥3 秒＋抖動；平日 07:30～15:30 不跑；
//       每日 16:25–16:55、21:40–22:35 也不跑（daemon 上櫃併入／資料到齊班車、資券歸檔＋訓練窗，2026-10-04·WM-SCAN G4-32）；
//       403／30x／429／封鎖頁立即停該機構；5xx 退避重試一次；連續 3 次失敗停（2026-10-04 程式審查修正）。
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const MIN_GAP_MS = 3000;
const BACKOFF_MS = [15000, 60000, 300000];
const MAX_CONSEC_FAIL = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 日期與樣板 ─────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
export function taipeiNow(now = new Date()) { return new Date(now.getTime() + 8 * 3600e3); }
export function taipeiDate(now = new Date()) { return taipeiNow(now).toISOString().slice(0, 10); }

/** 樣板變數：{date8}{dateSlash}{dateDash}{rocDate}{rocYear}{year}{month}{month2}{ym01}{season}{season2}{market}，以及任意 extra。 */
export function ctxOf({ day = null, year = null, month = null, season = null, market = null, extra = {} } = {}) {
  const c = { ...extra };
  if (day) {
    const [y, m, d] = day.split('-').map(Number);
    Object.assign(c, { date8: `${y}${pad2(m)}${pad2(d)}`, dateSlash: `${y}/${pad2(m)}/${pad2(d)}`, dateDash: day, rocDate: `${y - 1911}/${pad2(m)}/${pad2(d)}`,
      rocYear: y - 1911, year: y, month: m, month2: pad2(m), ym01: `${y}${pad2(m)}01`, dateSlashNoPad: `${y}/${m}/${d}` });
  }
  if (year != null) Object.assign(c, { year, rocYear: year - 1911 });
  if (month != null) Object.assign(c, { month, month2: pad2(month), ym01: `${c.year}${pad2(month)}01` });
  if (season != null) Object.assign(c, { season, season2: pad2(season), seasonZh: ['', '第一季', '第二季', '第三季', '第四季'][season] });
  if (market != null) Object.assign(c, { market, marketName: { sii: '上市公司', otc: '上櫃公司' }[market] || market });
  return c;
}

export function render(tpl, ctx) {
  return String(tpl).replace(/\{([A-Za-z_]\w*)\}/g, (m, k) => {   // 只認識別字變數；正規式量詞 {4} 不動
    if (!(k in ctx)) throw new Error(`樣板變數 {${k}} 沒有值（${tpl}）`);
    return String(ctx[k]);
  });
}

/** 民國／西元日期字串 → YYYY-MM-DD；認不得回 null。 */
export function normDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/); if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{2,3})[/.](\d{1,2})[/.](\d{1,2})$/); if (m) return `${+m[1] + 1911}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{3})(\d{2})(\d{2})$/); if (m) return `${+m[1] + 1911}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/); if (m) return `${+m[1] + 1911}-${pad2(m[2])}-${pad2(m[3])}`;
  return null;
}

/** 平日 07:30～15:30（台北）不跑：盤前試撮、盤中、收盤歸檔都在這段，daemon 正用同一個出口打官網。 */
export function inQuietWindow(now = new Date()) {
  const tw = taipeiNow(now); const dow = tw.getUTCDay(); const m = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  return dow >= 1 && dow <= 5 && m >= 7 * 60 + 30 && m < 15 * 60 + 30;
}

/**
 * daemon 的重任務窗（台北，每天都避開；2026-10-04·WM-SCAN G4-32）：
 *   16:25–16:55 上櫃收盤併入＋資料到齊班車（打 TPEx／TWSE 帶日期端點）；
 *   21:40–22:35 資券後班車（21:45 資券／借券歸檔、軋空訓練、做空樣本、檢討）。
 * 鏡像與 daemon 共用出口 IP：在這兩段被上游限流時，連坐的是 daemon 的交易日歸檔（資料缺漏）。
 */
export const DAEMON_BUSY_WINDOWS = [[16 * 60 + 25, 16 * 60 + 55, '16:25–16:55 daemon 上櫃併入／資料到齊班車'], [21 * 60 + 40, 22 * 60 + 35, '21:40–22:35 daemon 資券歸檔＋訓練']];
export function inDaemonBusyWindow(now = new Date()) {
  const tw = taipeiNow(now); const m = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  return DAEMON_BUSY_WINDOWS.find(([a, b]) => m >= a && m < b)?.[2] || null;
}
/** 鏡像全部禁跑窗（平日盤中＋daemon 重任務窗）：回傳原因字串（真值）或 null。FamilyQueue 預設用這個。 */
export function blockedReason(now = new Date()) {
  if (inQuietWindow(now)) return '平日 07:30～15:30 禁跑窗';
  return inDaemonBusyWindow(now);
}

// ── 驗證：回傳 {status: ok|empty|mismatch|bad, echo, rows, note} ───────────────
const tablesOf = j => (Array.isArray(j?.tables) ? j.tables : j?.fields ? [{ fields: j.fields, data: j.data, title: j.title }] : []);
const rowCount = j => tablesOf(j).reduce((n, t) => n + (Array.isArray(t.data) ? t.data.length : 0), 0);

export const VALIDATORS = {
  /** 證交所 rwd：stat=OK、頂層 date＝請求日；「沒有符合條件」＝空（非錯）。 */
  twseDate(j, ctx) {
    if (!j || typeof j !== 'object') return { status: 'bad', note: '非物件' };
    const stat = String(j.stat ?? '');
    if (/沒有符合|查無|無資料|尚未/.test(stat)) return { status: 'empty', note: stat };
    if (stat.toUpperCase() !== 'OK') return { status: 'bad', note: `stat=${stat}` };
    if (ctx.date8 && String(j.date ?? '') !== ctx.date8) return { status: 'mismatch', echo: normDate(j.date), note: `date=${j.date}` };
    const rows = rowCount(j);
    return rows > 0 ? { status: 'ok', echo: ctx.dateDash, rows } : { status: 'empty', echo: ctx.dateDash, rows: 0 };
  },
  /** 證交所 rwd 月表（date 帶月初）：stat=OK、date 前 6 碼＝請求年月。 */
  twseMonth(j, ctx) {
    const stat = String(j?.stat ?? '');
    if (/沒有符合|查無/.test(stat)) return { status: 'empty', note: stat };
    if (stat.toUpperCase() !== 'OK') return { status: 'bad', note: `stat=${stat}` };
    if (String(j.date ?? '').slice(0, 6) !== String(ctx.ym01).slice(0, 6)) return { status: 'mismatch', note: `date=${j.date}` };
    const rows = rowCount(j); return { status: rows > 0 ? 'ok' : 'empty', echo: `${ctx.year}-${ctx.month2}`, rows };
  },
  /** 證交所 rwd 區間查詢（start=end=當日）：stat=OK；可為 0 筆（當天沒有公告）＝empty 但合法。 */
  twseRange(j, ctx) {
    const stat = String(j?.stat ?? '');
    if (/沒有符合|查無/.test(stat)) return { status: 'empty', echo: ctx.dateDash, rows: 0, note: stat };
    if (stat.toUpperCase() !== 'OK') return { status: 'bad', note: `stat=${stat}` };
    const title = tablesOf(j).map(t => t.title || '').join(' ') + ' ' + (j.title || '');
    if (title && /\d{2,3}\/\d{2}\/\d{2}/.test(title) && !title.includes(ctx.rocDate) && !title.includes(String(ctx.date8))) return { status: 'mismatch', note: `title=${title.slice(0, 60)}` };
    const rows = rowCount(j); return { status: rows > 0 ? 'ok' : 'empty', echo: ctx.dateDash, rows };
  },
  /** 櫃買 www：stat=ok（小寫）、頂層 date＝請求日。 */
  tpexDate(j, ctx) {
    if (!j || typeof j !== 'object') return { status: 'bad', note: '非物件' };
    const stat = String(j.stat ?? '').toLowerCase();
    if (stat !== 'ok') return { status: /查無|沒有/.test(String(j.stat)) ? 'empty' : 'bad', note: `stat=${j.stat}` };
    if (ctx.date8 && j.date != null && String(j.date) !== ctx.date8) return { status: 'mismatch', echo: normDate(j.date), note: `date=${j.date}` };
    const rows = rowCount(j); return { status: rows > 0 ? 'ok' : 'empty', echo: ctx.dateDash, rows };
  },
  /** 櫃買 www 區間公告（注意／處置）：stat=ok；表頭（title／title2）若帶民國日期必須含請求日；0 筆合法。 */
  tpexRange(j, ctx) {
    const stat = String(j?.stat ?? '').toLowerCase();
    if (stat !== 'ok') return { status: 'bad', note: `stat=${j?.stat}` };
    const head = tablesOf(j).map(t => `${t.title || ''} ${t.title2 || ''} ${t.subtitle || ''}`).join(' ');
    if (/\d{2,3}\/\d{2}\/\d{2}/.test(head) && !head.includes(ctx.rocDate)) return { status: 'mismatch', note: `表頭=${head.slice(0, 60)}` };
    const rows = rowCount(j); return { status: rows > 0 ? 'ok' : 'empty', echo: ctx.dateDash, rows };
  },
  /** 櫃買舊站 php 月表（d=民國年/月）：stat=ok、tables[0].date 以 YYYYMM 開頭（或資料日落在該月）。 */
  tpexMonth(j, ctx) {
    const stat = String(j?.stat ?? '').toLowerCase();
    if (stat !== 'ok') return { status: 'bad', note: `stat=${j?.stat}` };
    const d = String(tablesOf(j)[0]?.date ?? j.date ?? '');
    const ym = normDate(d.length === 6 ? `${d}01` : d)?.slice(0, 7) || (/^\d{3}\/\d{2}/.test(d) ? `${+d.slice(0, 3) + 1911}-${d.slice(4, 6)}` : null);
    if (ym && ym !== `${ctx.year}-${ctx.month2}`) return { status: 'mismatch', note: `date=${d}` };
    const rows = rowCount(j); return { status: rows > 0 ? 'ok' : 'empty', echo: `${ctx.year}-${ctx.month2}`, rows };
  },
  /** 證交所 rwd 不帶日期的快照：stat=OK；資料日取 title 開頭的民國日期（date 欄是服務日，不可當資料日）。 */
  twseSnap(j) {
    const stat = String(j?.stat ?? '');
    if (/沒有符合|查無/.test(stat)) return { status: 'empty', rows: 0, note: stat };
    if (stat.toUpperCase() !== 'OK') return { status: 'bad', note: `stat=${stat}` };
    const rows = rowCount(j); return { status: rows > 0 ? 'ok' : 'empty', echo: normDate(String(j.title || '').match(/\d{2,3}年\d{1,2}月\d{1,2}日/)?.[0]), rows };
  },
  /** 櫃買 www 不帶日期的快照：stat=ok。 */
  tpexSnap(j) {
    const stat = String(j?.stat ?? '').toLowerCase();
    if (stat !== 'ok') return { status: 'bad', note: `stat=${j?.stat}` };
    const t0 = tablesOf(j)[0]; const rows = rowCount(j); return { status: rows > 0 ? 'ok' : 'empty', echo: normDate(t0?.date ?? j.date), rows };
  },
  /** openapi 快照：JSON 陣列；資料日取常見日期欄位（出表日期／資料日期／Date…）的最大值。 */
  openapi(j) {
    const arr = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : null;
    if (!arr) return { status: 'bad', note: '非陣列' };
    if (!arr.length) return { status: 'empty', rows: 0 };
    const keys = ['出表日期', '資料日期', 'Date', 'date', '日期', 'DataDate', '資料年月'];
    let echo = null;
    for (const row of arr.slice(0, 50)) for (const k of keys) { const v = normDate(row?.[k]); if (v && (!echo || v > echo)) echo = v; }
    return { status: 'ok', echo, rows: arr.length };
  },
  /** 文字（HTML／CSV／TXT）：必須包含某些字串（例：民國年月、市場名稱），且長度足夠。 */
  contains(text, ctx, spec) {
    if (typeof text !== 'string' || text.length < (spec.minLen ?? 200)) return { status: 'bad', note: '內容過短' };
    if (spec.emptyRe && new RegExp(spec.emptyRe).test(text)) return { status: 'empty', note: '查無資料' };
    for (const t of spec.mustContain || []) { const s = render(t, ctx); if (!text.includes(s)) return { status: 'mismatch', note: `缺「${s}」` }; }
    for (const t of spec.mustMatch || []) { const re = new RegExp(render(t, ctx)); if (!re.test(text)) return { status: 'mismatch', note: `不符 /${re.source.slice(0, 40)}/` }; }
    return { status: 'ok', echo: ctx.dateDash || (ctx.month ? `${ctx.year}-${ctx.month2}` : null), rows: null };
  },
};

// ── 存放與清單 ──────────────────────────────────────────────
export function datasetDir(root, host, id) { return join(root, host, id); }

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJsonAtomic(p, obj) { mkdirSync(dirname(p), { recursive: true }); const tmp = `${p}.tmp`; writeFileSync(tmp, JSON.stringify(obj)); renameSync(tmp, p); }

export function loadManifest(root, host, id) { return readJson(join(datasetDir(root, host, id), '_manifest.json'), { id, host, rows: {} }); }
export function saveManifest(root, man) { writeJsonAtomic(join(datasetDir(root, man.host, man.id), '_manifest.json'), man); }

/** 已定版的鍵不再抓：ok／empty／unchanged 且沒有標 final=false（月表當月、申報期內的月營收／季財報會標 false，之後再刷新）。 */
export function isFinal(man, key) {
  const r = man.rows?.[key];
  return !!r && (r.status === 'ok' || r.status === 'empty' || r.status === 'unchanged') && r.final !== false;
}
/** 有好資料（可能尚未定版）。 */
export function hasGood(man, key) { const r = man.rows?.[key]; return !!r && (r.status === 'ok' || r.status === 'unchanged'); }

/**
 * 依資料集規則判定定版。ad.stable（內容穩定規則）的資料集：由內容穩定判定的定版（finalBy='stable'）算數；
 * 舊時鐘規則留下的 final=true 只對期間早於 ad.stable.legacyTrustBefore 的鍵算數（2026-10-04 鏡像回補的歷史頁，
 * 皆在申報期限後 ≥24 日抓取、已含晚申報者）——不重抓、不降級（2026-10-04 審查：MOPS 歷史頁依現行名冊重產，
 * 舊月份內容永遠會小變，重新取得定版資格會卡在 final:false，研究端 revenue_official.py 會把它當缺頁）。
 * 其他資料集同 isFinal。
 */
export function isFinalFor(ad, man, key) {
  if (!isFinal(man, key)) return false;
  if (!ad?.stable) return true;
  const r = man.rows[key];
  if (r.finalBy === 'stable' || r.finalBy === 'legacy') return true;      // legacy：已信任的舊定版列被重抓後保持定版
  const cut = ad.stable.legacyTrustBefore;
  return !!cut && !r.stableSha && String(key).slice(0, 7) < cut;
}

export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

// ── 內容穩定定版（2026-10-04：月營收 t21sc03 兩表；取代「次月 11 日的隔天」時鐘規則）────────────
// 官方頁面每次產生都帶「出表日期：115/10/04<!--20:00:18-->」⇒ 原始位元組的 sha256 每次都不同，
// 要先去掉產生時戳（ad.stable.strip）再比。定版條件（三者皆成立）：
//   ① 次月 afterDay 日（含）起、相隔 ≥minGapDays 個日曆日的兩次觀測，內容雜湊相同；
//      觀測時刻＝頁面自報的產生時刻（spec.genRe「出表日期」），不是抓取時鐘——MOPS 回快取頁（實測舊 3 天以上）。
//   ② 名冊完整（spec.roster）：上一期同一鍵的頁面列出的代號，這一頁缺 ≤ spec.maxMissing 個（晚申報者上月有、本月還沒上表會被擋）；
//      沒有上一期可比 ⇒ 無法證明完整、不定版。
//   ③ 已定版的列不降級（isFinalFor 為真的列重抓也保持定版）。
// 申報期內或內容還在變 ⇒ final=false，每日／回補會繼續抓（回補對「有好資料、等穩定」的列不設 3 次上限）。
/** 去掉產生時戳後的內容雜湊。 */
export function stableShaOf(text, spec) {
  const s = String(text ?? '');
  return sha256(spec?.strip ? s.replace(new RegExp(spec.strip, 'g'), '') : s);
}
/** 頁面自報的產生時刻（spec.genRe 依序擷取 民國年、月、日[、時、分、秒]）→ ISO（台北 +08:00 換成 UTC）；認不得回 null。 */
export function genOf(text, spec) {
  if (!spec?.genRe) return null;
  const m = String(text ?? '').match(new RegExp(spec.genRe));
  if (!m) return null;
  const t = Date.parse(`${+m[1] + 1911}-${pad2(m[2])}-${pad2(m[3])}T${pad2(m[4] ?? 0)}:${pad2(m[5] ?? 0)}:${pad2(m[6] ?? 0)}+08:00`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
/** 月表期間（ctx.year／ctx.month）的次月 afterDay 日（YYYY-MM-DD）。 */
export function stableThreshold(ctx, afterDay) {
  const [ny, nm] = Number(ctx.month) === 12 ? [Number(ctx.year) + 1, 1] : [Number(ctx.year), Number(ctx.month) + 1];
  return `${ny}-${pad2(nm)}-${pad2(afterDay)}`;
}
/** 月表上一期的鍵（同 jobsFor：YYYY-MM[.market]）。 */
export function prevPeriodKey(ctx) {
  const [py, pm] = Number(ctx.month) === 1 ? [Number(ctx.year) - 1, 12] : [Number(ctx.year), Number(ctx.month) - 1];
  return `${py}-${pad2(pm)}${ctx.market ? `.${ctx.market}` : ''}`;
}
const dayGap = (a, b) => Math.round((Date.parse(`${taipeiDate(new Date(b))}T00:00:00Z`) - Date.parse(`${taipeiDate(new Date(a))}T00:00:00Z`)) / 864e5);
/**
 * prev：上一筆清單列（舊規則留下的列沒有 stableSha／gen 時由呼叫端從檔案補算；沒有 stableFrom 時以它的觀測時刻當起點）。
 * gen：本次頁面產生時刻（ISO，可無 ⇒ 用抓取時刻 at）；missing：名冊比對缺的代號（null＝無參照）。
 * 回傳 { final, stableFrom }：stableFrom＝目前這份內容在門檻日（含）之後第一次被觀測到的時刻（ISO）。
 */
export function stableDecision(prev, { stableSha, at, gen = null, ctx, spec, missing = null }) {
  const th = stableThreshold(ctx, spec.afterDay ?? 11);
  const obs = gen || at;
  if (taipeiDate(new Date(obs)) < th) return { final: false, stableFrom: null };
  const good = prev && (prev.status === 'ok' || prev.status === 'empty');
  const prevObs = good ? (prev.gen || prev.at) : null;
  const from = good ? (prev.stableFrom ?? (prevObs && taipeiDate(new Date(prevObs)) >= th ? prevObs : null)) : null;
  if (good && from && prev.stableSha === stableSha) {
    const complete = !spec.roster || (Array.isArray(missing) && missing.length <= (spec.maxMissing ?? 0));
    return { final: complete && dayGap(from, obs) >= (spec.minGapDays ?? 3), stableFrom: from };
  }
  return { final: false, stableFrom: obs };
}
/** 舊列沒有 stableSha／gen 時，從已存的檔案補算（只讀本機檔，0 請求）；讀不到回 {}（當成沒有前一次觀測）。 */
function prevStable(root, ad, prev) {
  if (!prev) return {};
  if (prev.stableSha) return { stableSha: prev.stableSha, gen: prev.gen ?? null };
  if (!prev.file || !(prev.status === 'ok' || prev.status === 'empty')) return {};
  try {
    const text = decodeBody(readEntry(root, ad.host, ad.id, prev.file), ad.encoding);
    return { stableSha: stableShaOf(text, ad.stable), gen: genOf(text, ad.stable) };
  } catch { return {}; }
}
/** 名冊比對：上一期同鍵頁面（本機檔）列出的代號，本頁沒有的 ⇒ 陣列；上一期沒有可讀的頁 ⇒ null（無法證明完整）。 */
function rosterMissing(root, ad, man, ctx, text) {
  if (!ad.stable?.roster) return null;
  const pr = man.rows?.[prevPeriodKey(ctx)];
  if (pr?.status === 'empty') return [];
  if (!pr?.file || !(pr.status === 'ok' || pr.status === 'unchanged')) return null;
  let ref;
  try { ref = ad.stable.roster(decodeBody(readEntry(root, ad.host, ad.id, pr.file), ad.encoding)); } catch { return null; }
  const have = new Set(ad.stable.roster(text));
  return [...new Set(ref)].filter(c => !have.has(c)).sort();
}

/** 內容穩定資料集的一列：{ fin, stab }（stab 併進清單列：stableSha、gen、stableFrom、missingVsPrev、finalBy）。已定版的不降級。 */
function stableRow(root, ad, man, key, ctx, text, at) {
  const prev = man.rows[key];
  const stableSha = stableShaOf(text, ad.stable);
  const gen = genOf(text, ad.stable);
  const missing = rosterMissing(root, ad, man, ctx, text);
  const base = { stableSha, gen, missingVsPrev: Array.isArray(missing) ? { n: missing.length, codes: missing.slice(0, 20) } : null };
  if (isFinalFor(ad, man, key)) return { fin: true, stab: { ...base, stableFrom: prev.stableFrom ?? null, finalBy: prev.finalBy ?? 'legacy' } };
  const d = stableDecision(prev ? { ...prev, ...prevStable(root, ad, prev) } : null, { stableSha, at, gen, ctx, spec: ad.stable, missing });
  return { fin: d.final, stab: { ...base, stableFrom: d.stableFrom, ...(d.final ? { finalBy: 'stable' } : {}) } };
}

function writeAtomic(p, buf) { const tmp = `${p}.tmp`; writeFileSync(tmp, buf); renameSync(tmp, p); }

/** 寫一份檔（原子）：JSON 存 {meta, payload}；文字存原始位元組（.html/.csv/.txt .gz）。回傳相對路徑。 */
export function writeEntry(root, host, id, key, { kind, ext = 'json', payload, buffer, meta }) {
  const dir = datasetDir(root, host, id); mkdirSync(dir, { recursive: true });
  if (kind === 'json') { const f = `${key}.json.gz`; writeAtomic(join(dir, f), gzipSync(JSON.stringify({ meta, payload }))); return f; }
  const f = `${key}.${ext}.gz`; writeAtomic(join(dir, f), gzipSync(buffer)); return f;
}

export function readEntry(root, host, id, file) {
  const raw = gunzipSync(readFileSync(join(datasetDir(root, host, id), file)));
  return file.endsWith('.json.gz') ? JSON.parse(raw.toString('utf8')) : raw;
}

// ── 請求 ─────────────────────────────────────────────────
export async function httpFetch(req, { timeoutMs = 45000, fetchImpl = fetch } = {}) {
  const headers = { 'User-Agent': UA, Accept: req.accept || '*/*', ...(req.headers || {}) };
  if (req.body && !headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const r = await fetchImpl(req.url, { method: req.method || 'GET', headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, contentType: r.headers.get('content-type') || '', buf };
}

export function decodeBody(buf, encoding = 'utf-8') {
  try { return new TextDecoder(encoding).decode(buf); } catch { return buf.toString('utf8'); }
}

/** 封鎖／限流／安全頁的字樣：一出現就停整個機構的主機群（同一出口 IP 也是站上 daemon 的出口）。 */
export const BLOCK_RE = /SECURITY REASONS|因為安全性考量|驗證碼|captcha|請求過於頻繁|Too Many Requests|系統忙碌中|Access Denied|拒絕存取/i;

/** 主機家族：同一機構的主機共用一條佇列（證交所系含 www／openapi／mops／mopsov、櫃買系、期交所）。 */
export function familyOf(host) {
  if (/(^|\.)twse\.com\.tw$/.test(host)) return 'twse';
  if (/(^|\.)tpex\.org\.tw$/.test(host)) return 'tpex';
  if (/(^|\.)taifex\.com\.tw$/.test(host)) return 'taifex';
  return host;
}

/**
 * 每個家族一條佇列（程序內共用）：逐請求 ≥gap＋抖動、每次送出前都檢查禁跑窗；
 * fatal（403／401／30x／429／封鎖頁）⇒ 立即停整個家族；5xx／網路錯誤 ⇒ 退避 15 秒重試一次；連續 3 次失敗停家族。
 * 結果分類：failed 計入連續失敗；neutral（官方還沒出這天、回聲不符）不計也不清零；其餘清零。
 */
export class FamilyQueue {
  constructor(family, { gapMs = MIN_GAP_MS, quiet = blockedReason, log = console.log, sleepFn = sleep } = {}) {
    this.family = family; this.gapMs = Math.max(MIN_GAP_MS, gapMs); this.quiet = quiet; this.log = log; this.sleep = sleepFn;
    this.consecFail = 0; this.stopped = false; this.stopReason = null; this.last = 0; this.count = 0;
  }
  stop(reason) { if (!this.stopped) { this.stopped = true; this.stopReason = reason; this.log(`[${this.family}] 停止：${reason}`); } }
  async gate() {
    if (this.stopped) return false;
    const why = q => `進入禁跑窗（${typeof q === 'string' ? q : '平日 07:30～15:30／daemon 重任務窗'}）`;
    let q = this.quiet(); if (q) { this.stop(why(q)); return false; }
    const wait = this.last + this.gapMs + Math.floor(Math.random() * 800) - Date.now();
    if (wait > 0) await this.sleep(wait);
    q = this.quiet(); if (q) { this.stop(why(q)); return false; }
    return true;
  }
  async run(fn) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await this.gate())) return { skipped: this.stopReason || 'stopped' };
      this.last = Date.now(); this.count++;
      let out;
      try { out = await fn(); } catch (e) { out = { retryable: true, failed: true, note: e.message }; }
      if (out?.fatal) { this.stop(`官方回應封鎖／限流訊號（${out.note || ''}）`); return out; }
      if (out?.retryable && attempt === 0) { this.log(`[${this.family}] ${out.note || '暫時性錯誤'}，15 秒後重試一次`); await this.sleep(BACKOFF_MS[0]); continue; }
      if (out?.failed) { this.consecFail++; if (this.consecFail >= MAX_CONSEC_FAIL) this.stop(`連續失敗 ${this.consecFail} 次`); }
      else if (!out?.neutral) this.consecFail = 0;
      return out;
    }
    return { failed: true };
  }
}

const QUEUES = new Map();
/** 程序內共用的家族佇列（daily 先後兩批、或多個指令階段都用同一條，間隔與停止狀態延續）。 */
export function queueFor(host, opts) { const f = familyOf(host); if (!QUEUES.has(f)) QUEUES.set(f, new FamilyQueue(f, opts)); return QUEUES.get(f); }
export function resetQueues() { QUEUES.clear(); }

/**
 * 空表定版要「隔一段時間再看一次仍是空」（2026-10-04·WM-SCAN G2-37）：非 must 的帶日期表回空表，舊版直接 final＝永不重抓——
 * 官方當下還沒出表、或一次錯誤回應，就會把那天永久標成「沒有資料」（MI_INDEX 空＝休市，連帶整天的帶日期表都不抓）。
 * 第一次空：寫 empty、final=false、emptySince＝這次時刻；之後的補漏／retry 再抓，距 emptySince ≥ EMPTY_CONFIRM_MS 仍空才定版。
 * 快照（snapshot）與內容穩定資料集（ad.stable）不適用（各有自己的規則）；已定版的舊空列不降級。
 */
export const EMPTY_CONFIRM_MS = 6 * 3600e3;   // daily 22:40 → retry 隔日 06:45 約 8 小時；同一輪內的重抓不算確認
export function emptyDecision(prev, at, callerFinal) {
  const since = prev?.status === 'empty' ? (prev.emptySince || prev.at || null) : null;
  const confirmed = !!since && Date.parse(at) - Date.parse(since) >= EMPTY_CONFIRM_MS;
  return { final: !!callerFinal && confirmed, emptySince: since || at, emptySeen: (prev?.status === 'empty' ? (prev.emptySeen || 1) : 0) + 1 };
}

/**
 * 快照鍵用官方回聲日（2026-10-04·WM-SCAN G2-37）：舊版一律用執行日（asOf），openapi 這類整批落後一日的快照會把
 * 昨天的內容存成今天的鍵（PIT 錯位）。keyByEcho 時以驗證器的 echo（YYYY-MM-DD）為鍵；同一回聲日已存不同內容 ⇒ 加 .rN。
 * 回傳 { key, same }：same＝該鍵已存同一份內容（不必再寫檔）。echo 不是日期 ⇒ 用原本的 key。
 */
export function echoKeyFor(man, key, echo, hash) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(echo || ''))) return { key, same: false, echoUsed: false };
  let k = echo; let n = 2;
  for (;;) {
    const r = man.rows?.[k];
    if (!r) return { key: k, same: false, echoUsed: true };
    if (r.sha256 === hash) return { key: k, same: true, echoUsed: true };
    if (!isFinal(man, k)) return { key: k, same: false, echoUsed: true };   // 未定版（失敗／待確認）的列可覆寫
    k = `${echo}.r${n++}`;
  }
}

/**
 * 抓一個鍵：組請求 → 送出 → 解碼 → 驗證 → 存檔＋更新清單。
 * opts.final：寫入列是否定版（月表當月、申報期內傳 false）；opts.mustHaveRows：已確認是交易日、這張表不可能為空 ⇒ empty 不定版。
 * opts.keyByEcho：快照改用官方回聲日當鍵（回傳的 key 才是實際寫入的鍵，呼叫端要用它讀清單列）。
 * 已有好資料時，這次失敗／空／不符都不會覆蓋（只記 lastTry）。
 */
export async function fetchAndStore(ad, { root, key, ctx, man, fetchImpl, now = new Date(), snapshot = false, final = true, mustHaveRows = false, keyByEcho = false }) {
  const req = ad.request(ctx);
  const res = await httpFetch(req, { fetchImpl });
  const at = now.toISOString();
  const keep = (row, ret) => {
    if (hasGood(man, key)) { man.rows[key] = { ...man.rows[key], lastTry: { status: row.status, note: row.note || null, http: row.http ?? null, at } }; return { ...ret, row: man.rows[key] }; }
    man.rows[key] = row; return { ...ret, row };
  };
  if ([401, 403, 429, 301, 302, 303, 307, 308].includes(res.status)) return keep({ status: 'fail', http: res.status, at }, { fatal: true, failed: true, note: `HTTP ${res.status}` });
  if (res.status >= 500) return keep({ status: 'fail', http: res.status, at }, { retryable: true, failed: true, note: `HTTP ${res.status}` });
  if (res.status !== 200) return keep({ status: 'fail', http: res.status, at }, { failed: true });
  const text = decodeBody(res.buf, ad.kind === 'json' ? 'utf-8' : ad.encoding);
  if (BLOCK_RE.test(text.slice(0, 20000))) return keep({ status: 'fail', note: '封鎖／安全頁', at }, { fatal: true, failed: true, note: '封鎖／安全頁' });
  let v; let payload = null;
  if (ad.kind === 'json') {
    try { payload = JSON.parse(text); } catch { return keep({ status: 'bad', note: '非 JSON', at }, { failed: true }); }
    v = VALIDATORS[ad.validator](payload, ctx, ad.spec || {});
  } else v = VALIDATORS.contains(text, ctx, ad.spec || {});
  if (v.status === 'empty' && mustHaveRows) v = { ...v, status: 'pending', note: '已確認交易日卻是空表（官方可能尚未出表）' };
  const hash = sha256(res.buf);
  if (v.status === 'ok' || v.status === 'empty') {
    const runKey = key;
    if (snapshot && keyByEcho) {
      const ek = echoKeyFor(man, key, v.echo, hash);
      if (ek.echoUsed && ek.same) {   // 同一回聲日已存同一份內容：不另存，只記再確認時刻
        man.rows[ek.key] = { ...man.rows[ek.key], recheck: at };
        if (man.lastHash === hash) man.lastFile = man.rows[ek.key].file || man.lastFile;
        return { row: man.rows[ek.key], key: ek.key };
      }
      key = ek.key;
    }
    if (snapshot && man.lastHash === hash) { man.rows[key] = { status: 'unchanged', same: man.lastFile, at, final, ...(key !== runKey ? { runKey } : {}) }; return { row: man.rows[key], key }; }
    if (v.status === 'empty' && hasGood(man, key)) return { ...keep({ status: 'empty', at }, { neutral: true }), key };   // 已有內容的不被空表蓋掉
    // 內容穩定規則的資料集：定版由觀測決定，呼叫端傳的 final 不採用（要在寫檔前先讀舊檔的雜湊與上一期名冊）
    let fin = final; let stab = {};
    if (ad.stable) ({ fin, stab } = stableRow(root, ad, man, key, ctx, text, at));
    else if (v.status === 'empty' && !snapshot) {   // 空表要隔 ≥EMPTY_CONFIRM_MS 再看一次仍空才定版（G2-37）
      if (isFinal(man, key)) return { row: man.rows[key], key };                       // 已定版的舊空列：不降級、不重寫
      const ed = emptyDecision(man.rows[key], at, final);
      fin = ed.final; stab = { emptySince: ed.emptySince, emptySeen: ed.emptySeen };
    }
    const meta = { url: req.url, method: req.method || 'GET', fetchedAt: at, http: res.status, echo: v.echo ?? null, rows: v.rows ?? null, sha256: hash, bytes: res.buf.length, source: 'official' };
    const file = writeEntry(root, ad.host, ad.id, key, ad.kind === 'json' ? { kind: 'json', payload, meta } : { kind: 'text', ext: ad.ext || 'txt', buffer: res.buf, meta });
    man.rows[key] = { status: v.status, file, echo: v.echo ?? null, rows: v.rows ?? null, sha256: hash, at, final: fin, attempts: man.rows[key]?.attempts, ...stab, ...(key !== runKey ? { runKey } : {}) };
    if (snapshot) { man.lastHash = hash; man.lastFile = file; }
    return { row: man.rows[key], key };
  }
  // JSON 回聲不符／待出表＝官方還沒出這一天（或非交易日）：中性，不算主機故障；文字頁缺必要字樣多半是錯誤頁：算失敗
  const neutral = ad.kind === 'json' && (v.status === 'mismatch' || v.status === 'pending');
  return keep({ status: v.status, note: v.note || null, at }, neutral ? { neutral: true } : { failed: true });
}
