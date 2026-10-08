// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki → 新聞判讀的事實錨點（使用者 2026-10-03：「新聞判讀改讀 wiki 產業鏈」）
//
// 來源：second-brain/wiki/_graph/stocks.json（scripts/build-stock-wiki.mjs 產生，本地檔、零上游請求）。
// 分兩區，**不可混**：
//   facts      官方或站內推導（MOPS 主要經營業務、站內產業鏈位置與上下游、原料↔產品推導、法人董監推導的關聯群）
//   reference  經營輪廓——年報萃取標「年報」，AI 整理標「待驗」；提示詞明說不可單獨當連動依據
// 檔案不存在、壞掉或資料日過舊（>WIKI_MAX_AGE_DAYS）就回空——少一個錨不擋判讀（舊行為：只有官方產業別）。
//
// 年報層讀取端核對（使用者 2026-10-08 J4-4「ok並強制不可有幻覺」；J4 設計 R1／R2／R4／R7）：
//   loadWikiStocks 每讀到新版 stocks.json，就拿本機 .cache/annual/{state,text} 的年報節錄逐項再驗（annual-grounding.mjs），
//   不過的年報項目、年報推導邊（derivedUpstream／Downstream）直接剔除（不是降級），理由計數見 wikiGroundingReport() 與 onWarn 日誌。
//   年報衍生的參考區欄位（2026-10-09 反證審查）：derived*Ai、productGeo、crossIndustries 是 wiki 由「年報層＋AI 層」合併輪廓推出來的，
//   唯一來源是被剔除的年報項目者＝幻覺的衍生物，同屬 J4-4 一併剔除（見 pruneAnnualDerivedRefs）。
//   真正來自 AI 層的內容（AI 鋪底層項目、靠 AI 項目支撐的 derived*Ai／productGeo／crossIndustries）與非 0 字年報的摘要維持原樣
//   （J4 設計 §11 第 4 件待使用者決定）。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { GROUND_VER, prepareText, textUsable, groundName, isGarbledName, isPlaceholderCounterparty, codedAliasInText, counterpartyEvidence, prepareKnownNames } from './annual-grounding.mjs';

let _cache = { file: '', mtimeMs: 0, raw: null, generatedAt: null, grounded: undefined, groundedDir: null };
let _lastWarn = '';
let _groundReport = null;

/** wiki 資料日超過這個天數就不當事實錨點（G2-38·2026-10-04）。nightly 每晚重建、資料不完整時重建會拒絕覆蓋，
 *  連續拒絕兩週以上代表管線壞了；舊的產業鏈事實餵給新聞判讀，比少一個錨更糟。 */
export const WIKI_MAX_AGE_DAYS = 14;
const DAY_MS = 86400000;

/**
 * 資料日年齡（日）。generatedAt＝YYYY-MM-DD（build.mjs 寫入）；缺時退回檔案 mtime。
 * @returns {number|null}
 */
export function wikiAgeDays(generatedAt, mtimeMs, nowMs = Date.now()) {
  const t = typeof generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(generatedAt)
    ? Date.parse(`${generatedAt.slice(0, 10)}T00:00:00+08:00`) : mtimeMs;
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / DAY_MS)) : null;
}

/** 年報節錄快取的預設位置：stocks.json 在 <wiki>/_graph/，節錄在 <wiki>/.cache/annual/（wiki session 寫，這裡只讀） */
export const defaultAnnualDir = (stocksFile) => path.join(path.dirname(stocksFile), '..', '.cache', 'annual');

/** 最近一次年報核對的理由計數（稽核用；回複本）。尚未核對過回 null */
export const wikiGroundingReport = () => (_groundReport ? structuredClone(_groundReport) : null);

/**
 * 依 mtime 快取；讀不到回 null（沿用上一份好的）。
 * G2-38／G1-28（2026-10-04）：讀失敗與過舊都經 onWarn 留 log（同一原因只報一次）；
 *   資料日超過 maxAgeDays ⇒ 回 null，判讀退回只有官方產業別（不把舊事實當錨點）。
 * J4-4（2026-10-08）：回傳的是年報層核對過的版本（groundWikiAnnual）；每個新版 stocks.json 經 onWarn 記一行理由計數。
 * @param {string} file
 * @param {{ maxAgeDays?: number, now?: number, onWarn?: (msg: string) => void, annualDir?: string }} [opts]
 */
export function loadWikiStocks(file, { maxAgeDays = WIKI_MAX_AGE_DAYS, now = Date.now(), onWarn, annualDir = defaultAnnualDir(file) } = {}) {
  const warn = (key, msg) => { if (key !== _lastWarn) { _lastWarn = key; try { onWarn?.(msg); } catch { /* log 失敗不擋 */ } } };
  let mtimeMs = 0;
  try {
    const st = fs.statSync(file);
    mtimeMs = st.mtimeMs;
    if (_cache.file !== file || _cache.mtimeMs !== st.mtimeMs) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      _cache = { file, mtimeMs: st.mtimeMs, raw: j?.stocks || null, generatedAt: j?.generatedAt ?? null, grounded: undefined, groundedDir: null };
    }
  } catch (e) {
    // 寫到一半／壞檔：沿用上一份好的（年齡仍照上一份的資料日檢查）
    if (_cache.file !== file || !_cache.raw) { warn(`read:${e.code || 'parse'}`, `wiki stocks.json 讀取失敗（${e.code || String(e.message).slice(0, 40)}），新聞判讀不帶 wiki 錨點`); return null; }
    warn(`read-stale:${e.code || 'parse'}`, `wiki stocks.json 讀取失敗（${e.code || String(e.message).slice(0, 40)}），沿用上一份（資料日 ${_cache.generatedAt || '未知'}）`);
    ({ mtimeMs } = _cache);
  }
  const { raw, generatedAt } = _cache;
  if (!raw) { warn('empty', 'wiki stocks.json 沒有 stocks 欄位，新聞判讀不帶 wiki 錨點'); return null; }
  const age = wikiAgeDays(generatedAt, mtimeMs, now);
  if (age != null && age > maxAgeDays) {
    warn(`stale:${generatedAt}`, `wiki 資料日 ${generatedAt || '未知'} 已 ${age} 日未更新（上限 ${maxAgeDays} 日），不當事實錨點——查 stock-wiki-nightly 與 build 完整性閘門`);
    return null;
  }
  // 年報核對只對要拿來用的那一版做一次（同一份 stocks.json 不重核；之後節錄被改寫不影響這份，重啟後由 R7 同版檢查擋）
  if (_cache.grounded === undefined || _cache.groundedDir !== annualDir) {
    _cache = { ..._cache, grounded: groundLoaded(raw, { annualDir, generatedAt, onWarn }), groundedDir: annualDir };
  }
  if (!_cache.grounded) { warn('empty', 'wiki stocks.json 沒有 stocks 欄位，新聞判讀不帶 wiki 錨點'); return null; }
  if (_lastWarn) _lastWarn = '';   // 恢復正常：下次再壞要再報
  return _cache.grounded;
}

// ── 年報層讀取端核對（J4-4）────────────────────────────────────────────────────
export const ANNUAL_KINDS = Object.freeze(['products', 'materials', 'customers', 'suppliers', 'equipment', 'plants', 'competitors', 'markets']);
const COUNTERPARTY_KINDS = new Set(['customers', 'suppliers', 'competitors']);
const ROLE_KINDS = new Set(['customers', 'suppliers']);
const arr = (v) => (Array.isArray(v) ? v : []);
const itemName = (it) => String((typeof it === 'string' ? it : it?.name) ?? '').trim();
const isAnnualSrc = (s) => /^annual-report/.test(String(s || ''));
// 與 wiki model.mjs 的 fromAnnual 同口徑：項目沒標 src 就看整份輪廓的 src
const isAnnualItem = (it, p) => isAnnualSrc((typeof it === 'object' && it?.src) || p?.src);
const hasAnnualLayer = (p) => !!p && (/annual-report/.test(String(p.src || '')) || ANNUAL_KINDS.some(k => arr(p[k]).some(it => isAnnualItem(it, p))));
const profileFy = (p) => (String(p?.src || '').match(/annual-report-(\d{4})/) || [])[1] || null;
// 與 wiki profiles.mjs 的 normEntityName 同口徑（推導邊「兩端原名逐字相同」）；不 import：daemon 不依賴 wiki 內部模組，口徑由測試對照
const PLACE_ALIAS = { 台灣: '臺灣', 中國大陸: '中國', 大陸: '中國', 南韓: '韓國', 香港地區: '香港' };
export function normEntityNameMirror(s) {
  const t = String(s || '').replace(/（/g, '(').replace(/）/g, ')')
    .replace(/\s*([\u3400-\u9fff])\s*/g, '$1').replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')').trim();
  return PLACE_ALIAS[t] || t;
}

/** 讀一檔的年報狀態與節錄（只讀；讀不到回 reason） */
function readAnnualSource(annualDir, code) {
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(annualDir, 'state', `${code}.json`), 'utf8')); } catch { return { reason: 'no-state' }; }
  try { return { state, text: fs.readFileSync(path.join(annualDir, 'text', `${code}.txt`), 'utf8') }; } catch { return { reason: 'no-text' }; }
}

/** 這份輪廓的年報層能不能拿這份節錄核對（R7 同版＋節錄門檻）；不能就整份不用 */
function annualSourceVerdict(p, source) {
  if (!source || source.reason) return { ok: false, reason: source?.reason || 'no-state' };
  const st = source.state || {};
  if (st.status !== 'text') return { ok: false, reason: 'state-not-text' };
  // R7：節錄比萃取新（年報季先覆寫 text、隔天才萃取）或年度不同 ⇒ 輪廓不是從這份節錄來的
  if (!(Number(st.extractedAt) >= Number(st.fetchedAt)) || String(st.fy ?? '') !== String(profileFy(p) ?? '')) return { ok: false, reason: 'text-profile-version' };
  const T = prepareText(source.text);
  const u = textUsable(T, st.anchors);
  return u.ok ? { ok: true, T } : { ok: false, reason: u.reason };
}

function itemDropReason(kind, it, T, known) {
  const name = itemName(it);
  if (isGarbledName(name)) return 'garbled';
  if (COUNTERPARTY_KINDS.has(kind) && isPlaceholderCounterparty(name)) return 'placeholder';
  if (!groundName(name, T).ok) return 'not-in-text';
  if (COUNTERPARTY_KINDS.has(kind) && codedAliasInText(name, T)) return 'placeholder';
  if (ROLE_KINDS.has(kind)) { const v = counterpartyEvidence(name, T, kind, { known }).verdict; if (v !== 'proven') return `role-${v}`; }
  return null;
}

/** 一檔輪廓：年報項目逐一核對（回新物件，不改輸入）；AI 層項目原樣保留 */
function groundStockProfile(p, source, known) {
  const v = annualSourceVerdict(p, source);
  const dropped = [];
  const kinds = {};
  for (const k of ANNUAL_KINDS) {
    if (!Array.isArray(p[k])) continue;
    kinds[k] = p[k].filter(it => {
      if (!isAnnualItem(it, p)) return true;
      const reason = v.ok ? itemDropReason(k, it, v.T, known) : v.reason;
      if (reason) dropped.push({ kind: k, name: itemName(it), reason });
      return !reason;
    });
  }
  const unusable = v.ok ? null : v.reason;
  // 整份不用 ⇒ 年報摘要一併不用、不由 AI 層補位；非 0 字年報的摘要去留待使用者決定（J4 §11 第 4 件），照舊
  const annualSummary = !!p.summary && /annual-report/.test(String(p.src || ''));
  const summaryDropped = !!unusable && annualSummary;
  if (!dropped.length && !summaryDropped) return { profile: p, dropped, unusable, summaryDropped };
  const { summary, ...rest } = p;
  const out = { ...rest, ...(summaryDropped || summary === undefined ? {} : { summary }), ...kinds };
  const annualLeft = (annualSummary && !summaryDropped) || ANNUAL_KINDS.some(k => arr(out[k]).some(it => isAnnualItem(it, p)));
  if (!annualLeft) {
    const notAnnual = (x) => !/^annual-report/.test(String(x || ''));
    out.src = String(p.src || '').split('＋').filter(notAnnual).join('＋') || null;
    if (Array.isArray(p.layers)) out.layers = p.layers.filter(notAnnual);
  }
  const empty = !out.summary && ANNUAL_KINDS.every(k => !arr(out[k]).length);
  return { profile: empty ? null : out, dropped, unusable, summaryDropped };
}

/** 推導邊兩端的年報原名索引：code → kind → Set(名稱)。帶代號指向他檔的項目不算（同 wiki collectProfileEntities） */
function annualNameIndex(stocks, profiles) {
  const idx = new Map();
  for (const [code, p] of profiles) {
    if (!p) continue;
    const per = {};
    for (const k of ['materials', 'products']) {
      per[k] = new Set(arr(p[k]).filter(it => isAnnualItem(it, p) && !(typeof it === 'object' && it?.code && stocks[it.code] && it.code !== code))
        .map(it => normEntityNameMirror(itemName(it))).filter(Boolean));
    }
    idx.set(code, per);
  }
  return idx;
}
const sharesName = (idx, a, ka, b, kb) => { const A = idx.get(a)?.[ka]; const B = idx.get(b)?.[kb]; if (!A || !B) return false; for (const n of A) if (B.has(n)) return true; return false; };

// ── 年報衍生的參考區欄位（J4-4；2026-10-09 反證審查 HIGH）──────────────────────────
// wiki 的 derived*Ai（AI 輪廓名稱比對推導邊）、productGeo、crossIndustries 由合併後輪廓推出：推導邊要兩端的原料／產品經
// 分類樹標準名對上（tier 'ai'＝任一端是 AI 項目或靠分類樹合併）；productGeo＝每項產品的產地（產品自帶 madeIn ∪ 列這項產品的廠區國家）
// 與銷售地；crossIndustries＝產品所屬的非本業產業。實測 0 字年報 40 檔的這三欄全部出自被剔除的年報項目（1234 黑松「推導上游
// 1310 台苯…」、1218 泰山「產品A（產 臺灣）」）。讀取端不讀 wiki 分類樹，只剔「可證明只靠被剔項目」者，不會誤剔 AI 內容：
//   推導邊：任一端在該面向（上游＝本檔原料↔對方產品；下游反之）核對前有項目、核對後一項不剩
//   crossIndustries：核對後一項產品不剩
//   productGeo：核對後一項產品不剩；或產地／銷售地只可能來自被剔除的廠區（核對後沒有列產品的廠區、產品也都沒自帶產地／銷售地）
// 漏網（某一端還剩別的項目、但這條邊其實靠被剔的那項）要分類樹才分得出來，留給 wiki 寫入端閘門（J4-W5～W8）。
const entityItems = (stocks, code, p, kind) => arr(p?.[kind]).filter(it => itemName(it) && !(typeof it === 'object' && it?.code && stocks[it.code] && it.code !== code));
const ownGeo = (it) => typeof it === 'object' && !!it && (arr(it.madeIn).length > 0 || arr(it.soldTo).length > 0);
const plantGeo = (pl) => typeof pl === 'object' && !!pl && arr(pl.products).length > 0 && !!String(pl.country || pl.location || '').trim();
const geoSource = (p) => arr(p?.plants).some(plantGeo) || arr(p?.products).some(ownGeo);

/**
 * 推導邊、productGeo、crossIndustries 裡只靠被剔除年報項目的部分（before／after：核對前後的輪廓，只含有年報層的個股）
 * @returns {Map<string, { fields: object, drops: { field: string, code?: string, n?: number, reason: string }[] }>}
 *   推導邊一條一筆（code＝對方代號）；productGeo／crossIndustries 整欄一筆（n＝拿掉的筆數）
 */
function pruneAnnualDerivedRefs(stocks, before, after, usable) {
  const emptied = new Map();
  const kindEmptied = (code, kind) => {
    if (!before.has(code)) return false;
    const key = `${code}|${kind}`;
    if (!emptied.has(key)) emptied.set(key, entityItems(stocks, code, before.get(code), kind).length > 0 && entityItems(stocks, code, after.get(code), kind).length === 0);
    return emptied.get(key);
  };
  const side = (code, who) => `${who}-${usable.get(code) === false ? 'annual-unusable' : 'items-dropped'}`;
  const out = new Map();
  for (const [code, s] of Object.entries(stocks)) {
    const fields = {}; const drops = [];
    for (const [dir, mine, theirs] of [['derivedUpstreamAi', 'materials', 'products'], ['derivedDownstreamAi', 'products', 'materials']]) {
      if (!Array.isArray(s?.[dir]) || !s[dir].length) continue;
      const kept = s[dir].filter(other => {
        const reason = kindEmptied(code, mine) ? side(code, 'self') : kindEmptied(other, theirs) ? side(other, 'partner') : null;
        if (reason) drops.push({ field: dir, code: other, reason });
        return !reason;
      });
      if (kept.length !== s[dir].length) fields[dir] = kept;
    }
    if (before.has(code) && after.get(code) !== before.get(code)) {
      const pB = before.get(code); const pA = after.get(code);
      const noProducts = arr(pB?.products).some(itemName) && !arr(pA?.products).some(itemName);
      const geoGone = !noProducts && geoSource(pB) && !geoSource(pA);
      if (Array.isArray(s?.productGeo) && s.productGeo.length && (noProducts || geoGone)) {
        fields.productGeo = []; drops.push({ field: 'productGeo', n: s.productGeo.length, reason: noProducts ? 'no-products-left' : 'geo-source-dropped' });
      }
      if (Array.isArray(s?.crossIndustries) && s.crossIndustries.length && noProducts) {
        fields.crossIndustries = []; drops.push({ field: 'crossIndustries', n: s.crossIndustries.length, reason: 'no-products-left' });
      }
    }
    if (drops.length) out.set(code, { fields, drops });
  }
  return out;
}

/**
 * stocks.json 的 stocks → 年報層核對過的新物件（不改輸入；沒動到的個股共用原物件）
 * @param {Record<string, any>} stocks
 * @param {{ readAnnual: (code: string) => { state?: any, text?: string, reason?: string }, generatedAt?: string|null, annualDir?: string }} opts
 * @returns {{ stocks: Record<string, any>, report: object }}
 */
export function groundWikiAnnual(stocks, { readAnnual, generatedAt = null, annualDir = null }) {
  const known = prepareKnownNames(Object.values(stocks).map(s => s?.name).filter(Boolean));
  const before = new Map(); const after = new Map(); const usable = new Map();
  const report = {
    groundVer: GROUND_VER, generatedAt, annualDir,
    profiles: { annual: 0, usable: 0, unusable: 0, unusableByReason: {} },
    items: { annual: 0, kept: 0, dropped: 0, byReason: {}, byKind: {} },
    summariesDropped: 0, derived: { annual: 0, kept: 0, dropped: 0, byReason: {} },
    // 年報衍生的參考區欄位（pruneAnnualDerivedRefs）：derivedAi 上下游各計；productGeo／crossIndustries 以筆計
    annualDerivedRefs: { derivedAi: { listed: 0, dropped: 0, byReason: {} }, productGeo: { dropped: 0, byReason: {} }, crossIndustries: { dropped: 0, byReason: {} } },
    perCode: {},
  };
  const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
  const per = (code) => (report.perCode[code] ||= { dropped: [], derivedDropped: [] });
  for (const code of Object.keys(stocks).sort()) {
    const p = stocks[code]?.profile;
    if (!hasAnnualLayer(p)) continue;
    report.profiles.annual++;
    const annualItems = ANNUAL_KINDS.reduce((n, k) => n + arr(p[k]).filter(it => isAnnualItem(it, p)).length, 0);
    const g = groundStockProfile(p, readAnnual(code), known);
    before.set(code, p); after.set(code, g.profile); usable.set(code, !g.unusable);
    report.items.annual += annualItems; report.items.dropped += g.dropped.length; report.items.kept += annualItems - g.dropped.length;
    if (g.unusable) { report.profiles.unusable++; bump(report.profiles.unusableByReason, g.unusable); per(code).unusable = g.unusable; } else report.profiles.usable++;
    if (g.summaryDropped) { report.summariesDropped++; per(code).summaryDropped = true; }
    for (const d of g.dropped) { bump(report.items.byReason, d.reason); bump((report.items.byKind[d.kind] ||= {}), d.reason); per(code).dropped.push(d); }
  }
  const idxBefore = annualNameIndex(stocks, before); const idxAfter = annualNameIndex(stocks, after);
  const refs = pruneAnnualDerivedRefs(stocks, before, after, usable);
  const R = report.annualDerivedRefs;
  for (const s of Object.values(stocks)) R.derivedAi.listed += arr(s?.derivedUpstreamAi).length + arr(s?.derivedDownstreamAi).length;
  for (const [code, { drops }] of refs) {
    for (const d of drops) {
      const bucket = d.field === 'productGeo' ? R.productGeo : d.field === 'crossIndustries' ? R.crossIndustries : R.derivedAi;
      const n = d.n ?? 1;
      bucket.dropped += n; bump(bucket.byReason, d.reason, n);
    }
    per(code).refsDropped = drops;
  }
  const out = {};
  for (const [code, s] of Object.entries(stocks)) {
    const edges = {};
    for (const [dir, mine, theirs] of [['derivedUpstream', 'materials', 'products'], ['derivedDownstream', 'products', 'materials']]) {
      if (!Array.isArray(s?.[dir]) || !s[dir].length) continue;
      edges[dir] = s[dir].filter(other => {
        report.derived.annual++;
        let reason = null;
        if (!sharesName(idxBefore, code, mine, other, theirs)) reason = 'edge-unverifiable';
        else if (usable.get(code) === false) reason = 'self-annual-unusable';
        else if (usable.get(other) === false) reason = 'partner-annual-unusable';
        else if (!sharesName(idxAfter, code, mine, other, theirs)) reason = 'via-item-dropped';
        if (!reason) { report.derived.kept++; return true; }
        report.derived.dropped++; bump(report.derived.byReason, reason); per(code).derivedDropped.push({ dir, code: other, reason });
        return false;
      });
    }
    const profileChanged = after.has(code) && after.get(code) !== s.profile;
    const edgeChanged = Object.entries(edges).some(([dir, v]) => v.length !== s[dir].length);
    const refFields = refs.get(code)?.fields;
    out[code] = profileChanged || edgeChanged || refFields
      ? { ...s, ...(after.has(code) ? { profile: after.get(code) } : {}), ...edges, ...(refFields || {}) } : s;
  }
  return { stocks: out, report };
}

/** 年報核對失敗時的保底：年報層、年報推導邊與只靠年報項目的參考區欄位整份不用（fail-closed），AI 層照舊 */
export function stripAnnualLayer(stocks) {
  const before = new Map(); const after = new Map(); const usable = new Map();
  for (const [code, s] of Object.entries(stocks)) {
    const p = s?.profile;
    if (!hasAnnualLayer(p)) continue;
    before.set(code, p); after.set(code, groundStockProfile(p, { reason: 'grounding-failed' }, prepareKnownNames()).profile); usable.set(code, false);
  }
  const refs = pruneAnnualDerivedRefs(stocks, before, after, usable);
  const out = {};
  for (const [code, s] of Object.entries(stocks)) {
    const refFields = refs.get(code)?.fields;
    out[code] = after.has(code) || refFields || s?.derivedUpstream?.length || s?.derivedDownstream?.length
      ? { ...s, ...(after.has(code) ? { profile: after.get(code) } : {}), derivedUpstream: [], derivedDownstream: [], ...(refFields || {}) } : s;
  }
  return out;
}

function groundingLogLine(r) {
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('、') || '無';
  return `wiki 年報核對 ${r.groundVer}（資料日 ${r.generatedAt || '未知'}）：年報輪廓 ${r.profiles.annual} 份，整份不用 ${r.profiles.unusable} 份〔${fmt(r.profiles.unusableByReason)}〕；`
    + `年報項目 ${r.items.annual} 項剔除 ${r.items.dropped} 項〔${fmt(r.items.byReason)}〕；年報推導邊（上下游各計）${r.derived.annual} 條剔除 ${r.derived.dropped} 條〔${fmt(r.derived.byReason)}〕；`
    + `只靠被剔年報項目的參考區：AI 推導邊 ${r.annualDerivedRefs.derivedAi.listed} 條剔除 ${r.annualDerivedRefs.derivedAi.dropped} 條〔${fmt(r.annualDerivedRefs.derivedAi.byReason)}〕、`
    + `產品×國家剔除 ${r.annualDerivedRefs.productGeo.dropped} 筆、跨產業剔除 ${r.annualDerivedRefs.crossIndustries.dropped} 筆`;
}

/** loadWikiStocks 讀到新版時：核對並留一行日誌；核對本身出錯 ⇒ 年報層整份不用（不讓錯誤擋判讀，也不放未核對的年報內容） */
function groundLoaded(stocks, { annualDir, generatedAt, onWarn }) {
  if (!stocks) return null;
  const say = (m) => { try { onWarn?.(m); } catch { /* log 失敗不擋 */ } };
  try {
    const g = groundWikiAnnual(stocks, { readAnnual: (code) => readAnnualSource(annualDir, code), generatedAt, annualDir });
    _groundReport = g.report;
    if (g.report.profiles.annual) say(groundingLogLine(g.report));   // 沒有年報層就不必記
    return g.stocks;
  } catch (e) {
    _groundReport = { groundVer: GROUND_VER, generatedAt, annualDir, failed: String(e?.message || e).slice(0, 200) };
    say(`wiki 年報核對失敗（${_groundReport.failed}），年報層與年報推導邊整份不用`);
    try { return stripAnnualLayer(stocks); } catch { return null; }
  }
}

// 每欄位長度上限（G1-28·2026-10-04）：profile／產品／國家等欄位一部分是「年報 PDF → 本機模型萃取」的產物，
//   等於一條間接提示注入路徑。這裡逐欄截斷、壓掉換行，並拿掉會冒充提示詞區段標題的【】與反引號；
//   整塊另有 WIKI_BLOCK_MAX 總長上限。官方欄位（mainBusiness）同樣過濾，一致處理。
export const WIKI_FIELD_MAX = { name: 16, item: 24, chain: 20, group: 30, place: 12, mainBusiness: 110, summary: 40 };
export const WIKI_BLOCK_MAX = 1200;
const short = (s, n) => { const t = String(s ?? '').replace(/[【】`]/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const names = (wiki, codes, n = 6) => (codes || []).slice(0, n).map(c => `${short(c, 6)} ${short(wiki[c]?.name, WIKI_FIELD_MAX.name)}`.trim()).join('、');
const items = (arr, n = 5) => (arr || []).slice(0, n).map(x => short(typeof x === 'string' ? x : x?.name, WIKI_FIELD_MAX.item)).filter(Boolean).join('、');

const places = (v) => arr(v).slice(0, 6).map(x => short(x, WIKI_FIELD_MAX.place)).filter(Boolean).join('/');
function productLinkLines(s) {
  const out = [];
  const cross = arr(s.crossIndustries).filter(x => x?.industry).slice(0, 3);
  if (cross.length) out.push(`· 依產品另涉產業〔AI分類·待驗〕：${cross.map(x => `${short(x.industry, WIKI_FIELD_MAX.chain)}（${arr(x.via).slice(0, 3).map(v => short(v, WIKI_FIELD_MAX.item)).join('、')}）`).join('；')}`);
  const geo = arr(s.productGeo).filter(g => g?.product && (arr(g.madeIn).length || arr(g.soldTo).length)).slice(0, 4);
  if (geo.length) {
    out.push(`· 產品×國家〔待驗〕：${geo.map(g => `${short(g.product, WIKI_FIELD_MAX.item)}（${[arr(g.madeIn).length ? `產 ${places(g.madeIn)}` : '', arr(g.soldTo).length ? `銷 ${places(g.soldTo)}` : ''].filter(Boolean).join('，')}）`).join('；')}`);
  }
  return out;
}

/** @returns {{ facts: string[], reference: string[] }} 每行已帶「· 」前綴 */
export function wikiFactLines(code, wiki) {
  const s = wiki?.[code];
  if (!s) return { facts: [], reference: [] };
  const facts = [];
  if (s.mainBusiness) facts.push(`· 主要經營業務（官方登記）：${short(s.mainBusiness, WIKI_FIELD_MAX.mainBusiness)}`);
  for (const c of (s.chains || []).slice(0, 2)) facts.push(`· 產業鏈位置（站內整理）：${short(c?.name, WIKI_FIELD_MAX.chain)}／${short(c?.role, WIKI_FIELD_MAX.chain)}${c?.label ? `·${short(c.label, WIKI_FIELD_MAX.chain)}` : ''}`);
  if (s.upstream?.length) facts.push(`· 鏈上上游：${names(wiki, s.upstream)}`);
  if (s.downstream?.length) facts.push(`· 鏈上下游：${names(wiki, s.downstream)}`);
  // 只有「兩端都來自年報」的推導邊才進事實區（AI 輪廓推出來的進參考區，見下）
  if (s.derivedUpstream?.length) facts.push(`· 推導上游（年報原料↔產品名稱比對）：${names(wiki, s.derivedUpstream, 5)}`);
  if (s.derivedDownstream?.length) facts.push(`· 推導下游（年報產品↔原料名稱比對）：${names(wiki, s.derivedDownstream, 5)}`);
  if (s.group) facts.push(`· 持股關聯群（官方董監／大股東推導）：${short(s.group, WIKI_FIELD_MAX.group)}`);
  const reference = [];
  if (s.derivedUpstreamAi?.length) reference.push(`· 推導上游（AI 輪廓名稱比對·待驗）：${names(wiki, s.derivedUpstreamAi, 5)}`);
  if (s.derivedDownstreamAi?.length) reference.push(`· 推導下游（AI 輪廓名稱比對·待驗）：${names(wiki, s.derivedDownstreamAi, 5)}`);
  const p = s.profile;
  if (p) {
    const tag = /annual-report/.test(p.src || '') ? (/ai-knowledge/.test(p.src) ? '年報＋AI待驗' : '年報') : 'AI整理·待驗';
    const parts = [
      p.summary ? `定位 ${short(p.summary, WIKI_FIELD_MAX.summary)}` : '',
      items(p.products) ? `產品 ${items(p.products)}` : '',
      items(p.materials) ? `原料 ${items(p.materials)}` : '',
      items(p.customers) ? `客戶 ${items(p.customers)}` : '',
      items(p.competitors) ? `競爭者 ${items(p.competitors)}` : '',
    ].filter(Boolean);
    if (parts.length) reference.push(`· 經營輪廓〔${tag}〕：${parts.join('；')}`);
  }
  // 產品連動（2026-10-03）：多角化公司的其他產品線所屬產業、產品×國家——關稅／制裁／地區新聞的連動線索。
  // 獨立 try：欄位形狀壞掉只少這兩行，不連累上面的官方事實（daemon 外層 catch 會把整塊清空）
  try { reference.push(...productLinkLines(s)); } catch { /* 形狀不合就略過 */ }
  return { facts, reference };
}

/** 組成提示詞片段（無資料回空字串） */
export function wikiPromptBlock(code, wiki) {
  const { facts, reference } = wikiFactLines(code, wiki);
  if (!facts.length && !reference.length) return '';
  const block = [
    ...facts,
    ...(reference.length ? ['【參考·未完全驗證（不可單獨當作連動依據）】', ...reference] : []),
  ].join('\n');
  return block.length > WIKI_BLOCK_MAX ? `${block.slice(0, WIKI_BLOCK_MAX)}…` : block;
}
