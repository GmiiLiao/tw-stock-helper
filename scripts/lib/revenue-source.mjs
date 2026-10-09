// ── 月營收來源：同業比較（peerComps）／論點支柱 revGrowth／wiki 產業中位數共用的純函式（2026-10-04）──────────
// 為什麼不再用 openapi t187ap05_L＋_P：
//   ① 兩支都沒有上櫃（上櫃 888 檔、含 30 檔上櫃 KY 整批不在同業比較裡；論點支柱「月營收年增為正」對上櫃一律 ✗）；
//   ② _P 是**公開發行（未上市）**公司（273 家，例 7859 翰可能源），與上市櫃代號零重疊——混進同業表會灌水產業
//      （「其他」164 檔、「金融保險業」89 檔，實際上市只有 52、31），還多出「化學生技醫療」「電子工業」「期貨商」「證券」四個假產業；
//   ③ 消費端以 parseFloat→0 讀增減 %：官方留白（去年同月為 0）被寫成 0%＝捏造（CLAUDE.md「不要給資料欄位捏造預設值」）；
//   ④ openapi 落後約一個月。
// ⇒ 改以 MOPS t21sc03 歸檔 revenueArchive/{YYYY-MM}（v2：上市／上櫃 × 本國／KY，留白＝null；lib/mops-revenue.mjs）為準；
//   openapi 只剩兩個用途：歸檔比它舊時的後備、上市公司的官方產業別。上櫃產業別取 wiki（MOPS t05st03）。
import { REV_DOC_VERSION, MAX_MISSING_VS_PREV, rowsOf } from './mops-revenue.mjs';
import { normIndustry } from './stock-wiki/industry.mjs';

/** 只收上市（_L）；_P 是未上市公開發行公司，不收。 */
export const OPENAPI_REVENUE_EP = 't187ap05_L';
/** 同業表完整性：上市、上櫃各自要有這麼多檔有產業別（「總數 > 0」不是完整性條件）。 */
export const PEER_MIN_PER_MARKET = 300;
export const MARKETS = Object.freeze(['上市', '上櫃']);

const CODE_RE = /^\d{4}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** 民國「資料年月」'11508' → '2026-08'；認不得回 null。 */
export function rocToMonthId(roc) {
  const s = String(roc ?? '').trim();
  if (!/^\d{5,6}$/.test(s)) return null;
  const mo = +s.slice(-2);
  return mo >= 1 && mo <= 12 ? `${+s.slice(0, -2) + 1911}-${s.slice(-2)}` : null;
}
/** '2026-08' → '11508'（peerComps.month／revenue/latest.month 沿用民國格式，維持既有介面）；認不得回 ''。 */
export function monthIdToRoc(id) {
  return MONTH_RE.test(String(id ?? '')) ? `${+id.slice(0, 4) - 1911}${id.slice(5, 7)}` : '';
}

// 金額欄：留白記 0（與 mops-revenue parseT21sc03 同一約定）；增減 %：留白＝null，不補 0
const amount = v => { const n = parseFloat(String(v ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? Math.round(n) : 0; };
const pct = v => { const n = parseFloat(String(v ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? +n.toFixed(2) : null; };
const finiteOrNull = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * openapi t187ap05_L 原始列 → { monthId, rows:[{c,n,ind,rev,prev,last,mom,yoy,cum}] }。
 * 列的形狀與 revenueArchive 相同（多一個官方產業別 ind）；只收 4 碼代號、當月營收 > 0（同 parseT21sc03）。
 * monthId 取各列「資料年月」的多數；不同月的列丟掉（同一份表混月＝來源異常，不能混算中位數）。
 */
export function parseOpenapiRevenue(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const votes = new Map();
  for (const x of list) { const m = rocToMonthId(x?.['資料年月']); if (m) votes.set(m, (votes.get(m) || 0) + 1); }
  const monthId = [...votes].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? null;
  const rows = []; const seen = new Set();
  for (const x of list) {
    const c = String(x?.['公司代號'] ?? '').trim();
    if (!CODE_RE.test(c) || seen.has(c) || rocToMonthId(x['資料年月']) !== monthId) continue;
    const rev = amount(x['營業收入-當月營收']);
    if (!(rev > 0)) continue;
    seen.add(c);
    rows.push({
      c, n: String(x['公司名稱'] ?? '').trim() || c, ind: normIndustry(x['產業別']),
      rev, prev: amount(x['營業收入-上月營收']), last: amount(x['營業收入-去年當月營收']),
      mom: pct(x['營業收入-上月比較增減(%)']), yoy: pct(x['營業收入-去年同月增減(%)']),
      cum: amount(x['累計營業收入-當月累計營收']),
    });
  }
  return { monthId, rows };
}

/** revenueArchive 文件 → 正規化列（c 為字串；yoy／mom 不是有限數一律 null）。JSON 壞掉丟錯（rowsOf）。 */
export function archiveRevenueRows(doc) {
  const out = []; const seen = new Set();
  for (const r of rowsOf(doc)) {
    const c = String(r?.c ?? '');
    if (!CODE_RE.test(c) || seen.has(c) || !(Number(r.rev) > 0)) continue;
    seen.add(c);
    out.push({
      c, n: String(r.n ?? '').trim() || c, rev: Number(r.rev),
      prev: Number(r.prev) || 0, last: Number(r.last) || 0,
      mom: finiteOrNull(r.mom), yoy: finiteOrNull(r.yoy), cum: Number(r.cum) || 0,
    });
  }
  return out;
}

/**
 * 選歸檔月份。metas：[{ id:'YYYY-MM', v, n, missingN }]（missingN＝文件的 missingVsPrev.n，名冊較上月缺幾檔；未知為 null）。
 * apiMonthId：openapi 的資料月（未知為 null）。回傳 { id, complete } 或 null（＝歸檔比 openapi 舊或沒有 v2 ⇒ 呼叫端用 openapi）。
 *
 * 為什麼不直接取「最新的 v2 月」：新月份在次月 1~10 日申報期內就會寫入（回補器門檻 ≥800 檔），那幾天只有部分公司。
 *   同業中位數會只由早申報者構成，論點支柱「月營收年增為正」會對還沒申報的持股判 ✗ 而誤發「論點轉弱」。
 *   ⇒ 只取**名冊完整**（較上月缺 ≤ MAX_MISSING_VS_PREV 檔，與回補器定版的條件②同一把尺）的最新月份；
 *     一個都沒有時，取最新兩個候選裡筆數較多者（同筆數取新），complete=false。
 * 候選只看 ≥ openapi 資料月的月份：openapi 若比歸檔新，表示歸檔停更，改用 openapi（上市限定，呼叫端要記 log）。
 */
export function pickArchiveMonth(metas, apiMonthId = null, { maxMissing = MAX_MISSING_VS_PREV } = {}) {
  const v2 = (Array.isArray(metas) ? metas : [])
    .filter(m => m && MONTH_RE.test(m.id) && Number(m.v) >= REV_DOC_VERSION && Number(m.n) > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const cands = MONTH_RE.test(String(apiMonthId ?? '')) ? v2.filter(m => m.id >= apiMonthId) : v2;
  if (!cands.length) return null;
  const complete = cands.filter(m => m.missingN != null && Number.isFinite(Number(m.missingN)) && Number(m.missingN) <= maxMissing);
  if (complete.length) return { id: complete[complete.length - 1].id, complete: true };
  const best = cands.slice(-2).reduce((a, b) => (Number(b.n) >= Number(a.n) ? b : a));
  return { id: best.id, complete: false };
}

/**
 * 產業別／市場查表：code → { ind, mkt, src } 或 null。優先序：
 *   ① openapi t187ap05_L 的產業別（上市、官方；與 wiki 名稱 1:1，2026-10-04 對帳 1,082 檔零差異）
 *   ② wiki stocks.json（MOPS t05st03；上市漏網＋上櫃，興櫃排除——不在即時快照）
 *   ③ 上一份 peerComps 的歸屬（只認有 mkt 的新格式列；wiki 暫時讀不到時上櫃不會整批消失）
 * 名稱一律 normIndustry（去空白、「其他業」→「其他」）——wiki 的產業頁以同一套名字查 peerComps 的中位數。
 */
export function makeIndustryLookup({ openapiRows = [], wikiStocks = null, prevIndustries = null } = {}) {
  const map = new Map();
  for (const r of openapiRows || []) {
    const ind = normIndustry(r?.ind);
    if (CODE_RE.test(String(r?.c)) && ind && !map.has(r.c)) map.set(r.c, { ind, mkt: '上市', src: 'twse' });
  }
  if (wikiStocks && typeof wikiStocks === 'object') {
    for (const c in wikiStocks) {
      const s = wikiStocks[c];
      if (!CODE_RE.test(c) || map.has(c) || !MARKETS.includes(s?.market)) continue;
      const ind = normIndustry(s.industry);
      if (ind) map.set(c, { ind, mkt: s.market, src: 'wiki' });
    }
  }
  if (prevIndustries && typeof prevIndustries === 'object') {
    for (const g in prevIndustries) {
      const ind = normIndustry(g);
      for (const it of Array.isArray(prevIndustries[g]) ? prevIndustries[g] : []) {
        const c = String(it?.code ?? '');
        if (ind && CODE_RE.test(c) && !map.has(c) && MARKETS.includes(it.mkt)) map.set(c, { ind, mkt: it.mkt, src: 'prev' });
      }
    }
  }
  return code => map.get(String(code)) ?? null;
}

const pos = v => (Number.isFinite(v) && v > 0 ? v : null);
const med = arr => { const v = arr.filter(n => n != null && Number.isFinite(n)).sort((a, b) => a - b); return v.length ? +v[Math.floor(v.length / 2)].toFixed(2) : null; };

/**
 * 月營收列＋查表 → { industries, summary, coverage }（peerComps/latest 的內容）。
 * bw：code → { pe, pb, yld }；rating：/api/rating 的 ratings；rs：code → RS；quotes：快照 quotes（也是交易中宇宙）。
 * 查不到產業別的列不進表（不歸「其他」——那是捏造分類），記在 coverage.noIndustry／noIndustryCodes。
 * 交易中但當月沒有營收列的上市櫃股（營收 ≤0 的新藥公司——MOPS 解析不收營收 ≤0 的列——或尚未申報）照樣進表、revYoY＝null，
 *   記在 coverage.noRevenue：2026-10-04 前它們在 openapi 版裡以「0%」出現（6838 台新藥、6919 康霈*、7827 漢康-KY創），
 *   改用歸檔後不可讓它們的同業表消失。
 */
export function buildPeerComps({ rows = [], lookup, bw = {}, rating = {}, rs = {}, quotes = {} }) {
  const industries = {};
  const coverage = { rows: 0, listed: 0, otc: 0, noRevenue: 0, noIndustry: 0, noIndustryCodes: [] };
  const push = (c, name, yoy) => {
    const hit = lookup?.(c);
    if (!hit) return false;
    if (hit.mkt === '上市') coverage.listed++; else if (hit.mkt === '上櫃') coverage.otc++;
    const b = bw[c] || {}; const r = rating[c] || {};
    (industries[hit.ind] ??= []).push({
      code: c, name, mkt: hit.mkt, price: quotes[c]?.price ?? null, changePct: quotes[c]?.changePercent ?? null,
      pe: pos(b.pe), pb: pos(b.pb), yield: pos(b.yld),
      revYoY: Number.isFinite(yoy) ? +yoy.toFixed(1) : null,   // 官方留白（去年同月為 0）或當月無營收列＝null，不是 0%
      // 評分＝未含風險扣分的技術評分（同業比強弱）；處置／注意另列 risk（2026-09-30）；訊號是行動訊號，維持含風險
      score: r.baseScore ?? r.score ?? null, risk: r.risk ?? null, signal: r.signal ?? null, rs: rs[c] ?? null,
    });
    return true;
  };
  const seen = new Set();
  for (const x of rows) {
    coverage.rows++; seen.add(x.c);
    if (!push(x.c, x.n, x.yoy)) { coverage.noIndustry++; if (coverage.noIndustryCodes.length < 40) coverage.noIndustryCodes.push(x.c); }
  }
  for (const c of Object.keys(quotes || {})) {
    if (!CODE_RE.test(c) || c.startsWith('00') || seen.has(c)) continue;   // 00 開頭是 ETF
    if (push(c, String(quotes[c]?.name ?? '').trim() || c, null)) coverage.noRevenue++;
  }
  const summary = {};
  for (const ind in industries) {
    const list = industries[ind];
    list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    summary[ind] = { count: list.length, medPe: med(list.map(s => s.pe)), medPb: med(list.map(s => s.pb)), medYield: med(list.map(s => s.yield)), medRevYoY: med(list.map(s => s.revYoY)) };
  }
  return { industries, summary, coverage };
}

/** 上市、上櫃各自 ≥ PEER_MIN_PER_MARKET 檔有產業別才算完整。 */
export const isPeerCoverageComplete = cov => (cov?.listed || 0) >= PEER_MIN_PER_MARKET && (cov?.otc || 0) >= PEER_MIN_PER_MARKET;

/**
 * 寫入閘門（stale-if-error）：新表完整就寫；新表殘缺時，只有舊表也殘缺（或沒有舊表）才寫——
 * 不准把「上市＋上櫃」的表蓋成只剩上市（openapi 後備、wiki 與舊歸屬都讀不到時）。
 * 舊表沒有 coverage（2026-10-04 前的 openapi 版）＝上市限定＝殘缺。
 */
export function peerCompsWriteDecision(coverage, prevCoverage) {
  const complete = isPeerCoverageComplete(coverage);
  if (complete) return { write: true, complete };
  if (isPeerCoverageComplete(prevCoverage)) {
    return { write: false, complete, reason: `新表殘缺（上市 ${coverage?.listed || 0}、上櫃 ${coverage?.otc || 0}），保留既有完整表` };
  }
  return { write: true, complete, reason: '新表殘缺，但既有表也殘缺或不存在' };
}
