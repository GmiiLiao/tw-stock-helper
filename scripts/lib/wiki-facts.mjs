// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki → 新聞判讀的事實錨點（使用者 2026-10-03：「新聞判讀改讀 wiki 產業鏈」）
//
// 來源：second-brain/wiki/_graph/stocks.json（scripts/build-stock-wiki.mjs 產生，本地檔、零上游請求）。
// 分兩區，**不可混**：
//   facts      官方或站內推導（MOPS 主要經營業務、站內產業鏈位置與上下游、原料↔產品推導、法人董監推導的關聯群）
//   reference  經營輪廓——年報萃取標「年報」，AI 整理標「待驗」；提示詞明說不可單獨當連動依據
// 檔案不存在或壞掉就回空——少一個錨不擋判讀（舊行為：只有官方產業別）。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';

let _cache = { file: '', mtimeMs: 0, data: null };

/** 依 mtime 快取；讀不到回 null */
export function loadWikiStocks(file) {
  try {
    const st = fs.statSync(file);
    if (_cache.file === file && _cache.mtimeMs === st.mtimeMs) return _cache.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))?.stocks || null;
    _cache = { file, mtimeMs: st.mtimeMs, data };
    return data;
  } catch { return _cache.file === file ? _cache.data : null; }   // 寫到一半／壞檔：沿用上一份好的
}

const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const names = (wiki, codes, n = 6) => (codes || []).slice(0, n).map(c => `${c} ${wiki[c]?.name || ''}`.trim()).join('、');
const items = (arr, n = 5) => (arr || []).slice(0, n).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean).join('、');

const arr = (v) => (Array.isArray(v) ? v : []);
function productLinkLines(s) {
  const out = [];
  const cross = arr(s.crossIndustries).filter(x => x?.industry).slice(0, 3);
  if (cross.length) out.push(`· 依產品另涉產業〔AI分類·待驗〕：${cross.map(x => `${x.industry}（${arr(x.via).slice(0, 3).join('、')}）`).join('；')}`);
  const geo = arr(s.productGeo).filter(g => g?.product && (arr(g.madeIn).length || arr(g.soldTo).length)).slice(0, 4);
  if (geo.length) {
    out.push(`· 產品×國家〔待驗〕：${geo.map(g => `${g.product}（${[arr(g.madeIn).length ? `產 ${arr(g.madeIn).join('/')}` : '', arr(g.soldTo).length ? `銷 ${arr(g.soldTo).join('/')}` : ''].filter(Boolean).join('，')}）`).join('；')}`);
  }
  return out;
}

/** @returns {{ facts: string[], reference: string[] }} 每行已帶「· 」前綴 */
export function wikiFactLines(code, wiki) {
  const s = wiki?.[code];
  if (!s) return { facts: [], reference: [] };
  const facts = [];
  if (s.mainBusiness) facts.push(`· 主要經營業務（官方登記）：${short(s.mainBusiness, 110)}`);
  for (const c of (s.chains || []).slice(0, 2)) facts.push(`· 產業鏈位置（站內整理）：${c.name}／${c.role}${c.label ? `·${c.label}` : ''}`);
  if (s.upstream?.length) facts.push(`· 鏈上上游：${names(wiki, s.upstream)}`);
  if (s.downstream?.length) facts.push(`· 鏈上下游：${names(wiki, s.downstream)}`);
  // 只有「兩端都來自年報」的推導邊才進事實區（AI 輪廓推出來的進參考區，見下）
  if (s.derivedUpstream?.length) facts.push(`· 推導上游（年報原料↔產品名稱比對）：${names(wiki, s.derivedUpstream, 5)}`);
  if (s.derivedDownstream?.length) facts.push(`· 推導下游（年報產品↔原料名稱比對）：${names(wiki, s.derivedDownstream, 5)}`);
  if (s.group) facts.push(`· 持股關聯群（官方董監／大股東推導）：${s.group}`);
  const reference = [];
  if (s.derivedUpstreamAi?.length) reference.push(`· 推導上游（AI 輪廓名稱比對·待驗）：${names(wiki, s.derivedUpstreamAi, 5)}`);
  if (s.derivedDownstreamAi?.length) reference.push(`· 推導下游（AI 輪廓名稱比對·待驗）：${names(wiki, s.derivedDownstreamAi, 5)}`);
  const p = s.profile;
  if (p) {
    const tag = /annual-report/.test(p.src || '') ? (/ai-knowledge/.test(p.src) ? '年報＋AI待驗' : '年報') : 'AI整理·待驗';
    const parts = [
      p.summary ? `定位 ${short(p.summary, 40)}` : '',
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
  return [
    ...facts,
    ...(reference.length ? ['【參考·未完全驗證（不可單獨當作連動依據）】', ...reference] : []),
  ].join('\n');
}
