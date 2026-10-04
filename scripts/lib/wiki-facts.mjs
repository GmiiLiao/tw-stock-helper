// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki → 新聞判讀的事實錨點（使用者 2026-10-03：「新聞判讀改讀 wiki 產業鏈」）
//
// 來源：second-brain/wiki/_graph/stocks.json（scripts/build-stock-wiki.mjs 產生，本地檔、零上游請求）。
// 分兩區，**不可混**：
//   facts      官方或站內推導（MOPS 主要經營業務、站內產業鏈位置與上下游、原料↔產品推導、法人董監推導的關聯群）
//   reference  經營輪廓——年報萃取標「年報」，AI 整理標「待驗」；提示詞明說不可單獨當連動依據
// 檔案不存在、壞掉或資料日過舊（>WIKI_MAX_AGE_DAYS）就回空——少一個錨不擋判讀（舊行為：只有官方產業別）。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';

let _cache = { file: '', mtimeMs: 0, data: null, generatedAt: null };
let _lastWarn = '';

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

/**
 * 依 mtime 快取；讀不到回 null（沿用上一份好的）。
 * G2-38／G1-28（2026-10-04）：讀失敗與過舊都經 onWarn 留 log（同一原因只報一次）；
 *   資料日超過 maxAgeDays ⇒ 回 null，判讀退回只有官方產業別（不把舊事實當錨點）。
 * @param {string} file
 * @param {{ maxAgeDays?: number, now?: number, onWarn?: (msg: string) => void }} [opts]
 */
export function loadWikiStocks(file, { maxAgeDays = WIKI_MAX_AGE_DAYS, now = Date.now(), onWarn } = {}) {
  const warn = (key, msg) => { if (key !== _lastWarn) { _lastWarn = key; try { onWarn?.(msg); } catch { /* log 失敗不擋 */ } } };
  let data = null, generatedAt = null, mtimeMs = 0;
  try {
    const st = fs.statSync(file);
    mtimeMs = st.mtimeMs;
    if (_cache.file === file && _cache.mtimeMs === st.mtimeMs) ({ data, generatedAt } = _cache);
    else {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      data = j?.stocks || null; generatedAt = j?.generatedAt ?? null;
      _cache = { file, mtimeMs: st.mtimeMs, data, generatedAt };
    }
  } catch (e) {
    // 寫到一半／壞檔：沿用上一份好的（年齡仍照上一份的資料日檢查）
    if (_cache.file !== file || !_cache.data) { warn(`read:${e.code || 'parse'}`, `wiki stocks.json 讀取失敗（${e.code || String(e.message).slice(0, 40)}），新聞判讀不帶 wiki 錨點`); return null; }
    warn(`read-stale:${e.code || 'parse'}`, `wiki stocks.json 讀取失敗（${e.code || String(e.message).slice(0, 40)}），沿用上一份（資料日 ${_cache.generatedAt || '未知'}）`);
    ({ data, generatedAt, mtimeMs } = _cache);
  }
  if (!data) { warn('empty', 'wiki stocks.json 沒有 stocks 欄位，新聞判讀不帶 wiki 錨點'); return null; }
  const age = wikiAgeDays(generatedAt, mtimeMs, now);
  if (age != null && age > maxAgeDays) {
    warn(`stale:${generatedAt}`, `wiki 資料日 ${generatedAt || '未知'} 已 ${age} 日未更新（上限 ${maxAgeDays} 日），不當事實錨點——查 stock-wiki-nightly 與 build 完整性閘門`);
    return null;
  }
  if (_lastWarn) _lastWarn = '';   // 恢復正常：下次再壞要再報
  return data;
}

// 每欄位長度上限（G1-28·2026-10-04）：profile／產品／國家等欄位一部分是「年報 PDF → 本機模型萃取」的產物，
//   等於一條間接提示注入路徑。這裡逐欄截斷、壓掉換行，並拿掉會冒充提示詞區段標題的【】與反引號；
//   整塊另有 WIKI_BLOCK_MAX 總長上限。官方欄位（mainBusiness）同樣過濾，一致處理。
export const WIKI_FIELD_MAX = { name: 16, item: 24, chain: 20, group: 30, place: 12, mainBusiness: 110, summary: 40 };
export const WIKI_BLOCK_MAX = 1200;
const short = (s, n) => { const t = String(s ?? '').replace(/[【】`]/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const names = (wiki, codes, n = 6) => (codes || []).slice(0, n).map(c => `${short(c, 6)} ${short(wiki[c]?.name, WIKI_FIELD_MAX.name)}`.trim()).join('、');
const items = (arr, n = 5) => (arr || []).slice(0, n).map(x => short(typeof x === 'string' ? x : x?.name, WIKI_FIELD_MAX.item)).filter(Boolean).join('、');

const arr = (v) => (Array.isArray(v) ? v : []);
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
