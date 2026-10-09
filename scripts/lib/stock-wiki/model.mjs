// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki：把各來源組成一個實體圖（個股／ETF／產業／產業鏈／集團／法人股東／地區／指數／投信／重大訊息日）
// 純資料組裝，不碰檔案系統以外的東西（輸入都由 build.mjs 讀好傳進來），可單元測試。
// 每個欄位記來源代號（SOURCES 的 key），渲染時標在段落標題上。
// ─────────────────────────────────────────────────────────────────────────────
import { rocToIso, parseShares, countyOf } from './util.mjs';
import { learnCodeNames, resolveIndustry } from './industry.mjs';
import { corporateHoldings, deriveGroups } from './groups.mjs';
import { normalizeEtfRow } from './etf.mjs';
import { isEtfCode, isStockCode } from './load-local.mjs';
import { applyProductLinks } from './product-links.mjs';
import { normEntityName, normPlace } from './profiles.mjs';

export const SOURCES = {
  'mops-t05st03': { label: 'MOPS 公司基本資料', tier: '官方' },
  'twse-t187ap03': { label: '證交所 上市公司基本資料', tier: '官方' },
  'twse-t187ap02': { label: '證交所 持股逾10%大股東', tier: '官方' },
  'twse-t187ap11': { label: '證交所 董監事持股明細', tier: '官方' },
  'twse-t187ap47': { label: '證交所 基金(ETF)基本資料', tier: '官方' },
  peerComps: { label: '站內同業表（MOPS 月營收；官方產業別）', tier: '官方衍生' },
  finSummary: { label: '站內財報摘要（MOPS 財報彙總）', tier: '官方衍生' },
  themeMap: { label: '站內主題產業鏈（人工維護 seed）', tier: '站內整理' },
  groups: { label: '關係企業群（由法人董監／大股東推導）', tier: '站內推導' },
  etfInfluence: { label: '0050/006208 成分（市值近似，非官方權重）', tier: '近似' },
  mopsNews: { label: 'MOPS 重大訊息', tier: '官方' },
  news: { label: '媒體新聞標題（Google News／Yahoo 等）', tier: '媒體' },
  snapshot: { label: '站內收盤快照', tier: '官方衍生' },
};

const MARKET_LABEL = { tse: '上市', otc: '上櫃', esb: '興櫃' };
const ROLE_ORDER = { 上游: 0, 中游: 1, 下游: 2 };

function peerIndex(peerIndustries) {
  const byCode = new Map();
  for (const [ind, rows] of Object.entries(peerIndustries || {})) for (const r of rows || []) if (r?.code) byCode.set(r.code, { ...r, industry: ind });
  return byCode;
}

/** 個股基本資料：MOPS 為主，t187ap03_L 補上市欄位 */
function buildStock(code, base, mops, twse, peerRow, codeNames, quote) {
  const m = mops?.data || {};
  const industry = resolveIndustry({ mopsName: m.industryCategory, twseCode: twse?.['產業別']?.trim(), peerName: peerRow?.industry }, codeNames);
  const shares = parseShares(m.commonStockAmount) ?? parseShares(twse?.['已發行普通股數或TDR原股發行股數']);
  const price = Number(quote?.price) > 0 ? Number(quote.price) : null;
  const address = m.address || twse?.['住址'] || null;
  const foreignReg = [m.foreignCompanyRegisterPlace, twse?.['外國企業註冊地國']].map(s => String(s || '').replace(/[－-]/g, '').trim()).find(Boolean) || null;
  return {
    code, name: m.companyAbbreviation || twse?.['公司簡稱'] || base.name,
    market: MARKET_LABEL[base.market] || base.market,
    fullName: m.companyName || twse?.['公司名稱'] || null,
    englishName: m.companyEnglishName || null,
    englishAbbr: m.companyEnglishAbbreviation || twse?.['英文簡稱'] || null,
    industry,
    mainBusiness: m.mainBusiness || null,
    chairman: m.chairman || twse?.['董事長'] || null,
    president: m.president || twse?.['總經理'] || null,
    establishDate: rocToIso(m.establishDate) || rocToIso(twse?.['成立日期']),
    listDate: rocToIso(m.listingDate) || rocToIso(twse?.['上市日期']) || rocToIso(m.OTCDate) || rocToIso(m.ROTCDate),
    capital: parseShares(m.capitalAmount) ?? parseShares(twse?.['實收資本額']),
    shares, price, mktCap: price && shares ? price * shares : null,
    address, county: countyOf(address), foreignReg,
    website: m.internetAddress || twse?.['網址'] || null,
    auditor: m.accountingOffice || twse?.['簽證會計師事務所'] || null,
    reportType: m.reportType || null,
    src: { basic: mops?.data ? 'mops-t05st03' : twse ? 'twse-t187ap03' : 'snapshot', mopsAt: mops?.fetchedAt || null },
    peer: peerRow ? { pe: peerRow.pe, pb: peerRow.pb, yield: peerRow.yield, revYoY: peerRow.revYoY } : null,
    chains: [], etfs: [], announcements: [], news: [], groupId: null, holders: [], holdings: [], referencedBy: [],
  };
}

export function buildModel({ bk, twse, mopsOf, newsOf, finReportOf, profileOf, taxonomy = null }) {
  const t03 = new Map((twse.t187ap03_L || []).map(r => [String(r['公司代號']).trim(), r]));
  const peerBy = peerIndex(bk.peer.industries);

  // 宇宙
  const universe = new Map();
  for (const [c, q] of Object.entries(bk.quotes)) if (isStockCode(c)) universe.set(c, { name: q.name, market: q.market, quote: q });
  for (const [c, q] of Object.entries(bk.emerging)) if (isStockCode(c) && !universe.has(c)) universe.set(c, { name: q.name, market: 'esb', quote: q });

  // 產業代碼對照：由同時有 MOPS 與 t03 的上市公司學
  const pairs = [];
  for (const [c, r] of t03) { const m = mopsOf(c); if (m?.data?.industryCategory) pairs.push([String(r['產業別']).trim(), m.data.industryCategory]); }
  const codeNames = learnCodeNames(pairs);

  const stocks = new Map();
  for (const [code, base] of universe) {
    stocks.set(code, buildStock(code, base, mopsOf(code), t03.get(code), peerBy.get(code), codeNames, base.quote));
  }

  // 產業
  const industries = new Map();
  for (const s of stocks.values()) {
    const n = s.industry?.name || '未分類';
    (industries.get(n) || industries.set(n, { name: n, members: [], summary: bk.peer.summary?.[n] || null }).get(n)).members.push(s.code);
  }
  for (const ind of industries.values()) ind.members.sort((a, b) => (stocks.get(b).mktCap || 0) - (stocks.get(a).mktCap || 0) || a.localeCompare(b));

  // 產業鏈（themeMap）
  const chains = (bk.themeChains || []).map(c => ({
    key: c.key, name: c.name,
    segs: (c.segs || []).map(g => ({ role: g.role || '族群', label: g.label || '', codes: (g.codes || []).filter(x => stocks.has(x)) })),
  }));
  for (const ch of chains) for (const g of ch.segs) for (const code of g.codes) stocks.get(code).chains.push({ key: ch.key, name: ch.name, role: g.role, label: g.label });

  // 集團／法人股東
  const holdings = corporateHoldings(twse.t187ap11_L || [], twse.t187ap02_L || []);
  const companies = new Map([...stocks.values()].map(s => [s.code, { code: s.code, name: s.name, fullName: s.fullName, mktCap: s.mktCap, shares: s.shares }]));
  const g = deriveGroups(holdings, companies);
  for (const l of g.links) {
    stocks.get(l.to)?.holders.push(l);
    if (l.from) stocks.get(l.from)?.holdings.push(l);
  }
  for (const [code, gid] of g.groupOf) stocks.get(code).groupId = gid;

  // ETF
  const etfs = new Map();
  for (const r of twse.t187ap47_L || []) { const e = normalizeEtfRow(r); if (e.code) etfs.set(e.code, { ...e, market: '上市' }); }
  for (const [c, q] of Object.entries(bk.quotes)) {
    if (!isEtfCode(c)) continue;
    const prev = etfs.get(c);
    const market = MARKET_LABEL[q.market] || q.market;
    etfs.set(c, prev ? { ...prev, market, price: q.price } : { code: c, name: q.name, market, price: q.price, tags: [], src: 'snapshot' });
  }
  const approxSet = new Set((bk.etfInfluence?.bigcapEtfs || []).map(e => e.code));
  const constituents = (bk.etfInfluence?.constituents || []).filter(x => stocks.has(x.code));
  for (const ec of approxSet) {
    const e = etfs.get(ec); if (!e) continue;
    e.constituents = constituents.map(x => ({ code: x.code, name: x.name, weight: x.weight, rank: x.rank }));
    e.constituentsSrc = 'etfInfluence'; e.constituentsDate = bk.etfInfluence.date;
    for (const x of constituents) stocks.get(x.code).etfs.push({ code: ec, name: e.name, weight: x.weight, approx: true });
  }
  const indexes = new Map(); const issuers = new Map();
  for (const e of etfs.values()) {
    if (e.index) (indexes.get(e.index) || indexes.set(e.index, []).get(e.index)).push(e.code);
    if (e.issuer) (issuers.get(e.issuer) || issuers.set(e.issuer, []).get(e.issuer)).push(e.code);
  }

  // 地區（總公司所在縣市／外國註冊地）
  const regions = new Map();
  for (const s of stocks.values()) {
    for (const r of [s.county, s.foreignReg && s.foreignReg !== '臺灣' ? s.foreignReg : null]) {
      if (r) (regions.get(r) || regions.set(r, []).get(r)).push(s.code);
    }
  }

  // 重大訊息（依日）
  const announceDays = [];
  for (const d of bk.mopsNews || []) {
    const items = (d.items || []).filter(it => stocks.has(it.code)).sort((a, b) => (b.at || 0) - (a.at || 0));
    if (!items.length) continue;
    announceDays.push({ date: d.date, items });
    for (const it of items) stocks.get(it.code).announcements.push({ date: d.date, subject: it.subject, at: it.at });
  }

  // 新聞、財報、財務摘要
  for (const s of stocks.values()) {
    s.news = newsOf ? newsOf(s.code) : [];
    s.fin = bk.finSummary?.[s.code] || null;
    s.finReport = finReportOf ? finReportOf(s.code) : null;
    s.announcements.sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  // 產品／原料實體頁以「標準名」為鍵（產品分類樹把同義寫法合併），推導上下游因此能跨寫法接上
  const keyOf = makeKeyOf(taxonomy);
  const entities = collectProfileEntities(stocks, profileOf, keyOf);
  deriveMaterialFlows(stocks, entities);

  const model = { stocks, etfs, industries, chains, groups: g.groups, holders: g.holders, regions, indexes, issuers, announceDays, codeNames, entities, keyOf, taxonomy };
  return applyProductLinks(model, taxonomy);
}

// ── 經營輪廓（產品／原料／客戶／供應商／設備／廠房／國內外同業）────────────────
// 官方結構化來源沒有這些欄位；由年報萃取或 AI 整理後放進 .cache/profiles/{code}.json，重建時併入。
// 每個項目可帶 src（如 annual-report-2025、ai-knowledge）與 conf（高/中/低），渲染時照實標示。
export const PROFILE_KINDS = {
  products: { folder: '產品', label: '主要產品／服務' },
  materials: { folder: '原料', label: '主要原料' },
  customers: { folder: '客戶', label: '主要客戶' },
  suppliers: { folder: '供應商', label: '主要供應商' },
  equipment: { folder: '設備', label: '生產設備' },
  plants: { folder: '生產據點', label: '生產據點／廠房' },   // 實體頁依「國家」彙總（廠名是各公司自己的，不跨公司合併）
  competitors: { folder: '競爭者', label: '國內外競爭者' },
  markets: { folder: '銷售市場', label: '銷售地區／市場' },
};
const itemName = (it) => (typeof it === 'string' ? it : it?.name || '').trim();
/** 實體頁的鍵：生產據點用國家（沒填國家就取 location 第一段），其他用名稱 */
export function entityKey(kind, it) {
  if (kind !== 'plants' || typeof it !== 'object') return itemName(it);
  const loc = String(it.location || '').split(/[／/、,，]/)[0].trim();
  return normPlace(it.country || loc || itemName(it));
}

/** 實體頁鍵：產品／原料走分類樹的標準名，其他同 entityKey */
export function makeKeyOf(taxonomy) {
  return (kind, it) => ((kind === 'products' || kind === 'materials') && taxonomy ? taxonomy.termOf(itemName(it)).canon : entityKey(kind, it));
}

function collectProfileEntities(stocks, profileOf, keyOf = entityKey) {
  const entities = Object.fromEntries(Object.keys(PROFILE_KINDS).map(k => [k, new Map()]));
  if (!profileOf) return entities;
  for (const s of stocks.values()) {
    const p = profileOf(s.code); if (!p) continue;
    s.profile = p;
    for (const kind of Object.keys(PROFILE_KINDS)) {
      for (const it of p[kind] || []) {
        const name = keyOf(kind, it); if (!name) continue;
        // 項目本身是台股上市櫃公司（帶 code）⇒ 連到個股頁，並在對方頁記「被誰列為客戶／供應商／競爭者」
        if (typeof it === 'object' && it.code && stocks.has(it.code) && it.code !== s.code) {
          stocks.get(it.code).referencedBy.push({ from: s.code, kind, conf: it.conf, src: it.src || p.src });
          continue;
        }
        const m = entities[kind];
        (m.get(name) || m.set(name, []).get(name)).push({ code: s.code, item: typeof it === 'string' ? { name } : it });
      }
    }
  }
  return entities;
}

// ── 推導上下游：A 的原料＝B 的產品 ⇒ B 是 A 的上游（名稱完全相同才算；名稱比對，站內推導）──
// tier：兩端項目都來自年報才是 'annual'（可當事實），否則 'ai'（只能當參考）——2026-10-03 審查：
//   原本不分來源，AI 輪廓推出來的邊被放進判讀提示詞的「已知事實」區。
// 排序：年報優先，再依名稱的「具體度」（共用該名稱的公司越少越具體；「鋼板」這種泛稱排後面）。
const FLOW_MAX = 15;
const fromAnnual = (it, p) => /^annual-report/.test((typeof it === 'object' && it?.src) || p?.src || '');
// 兩端原文名稱逐字相同才算年報等級：靠 AI 分類樹把不同寫法合併才接上的邊是 AI 判斷，只能當參考（2026-10-03 審查）
const sameRawName = (a, b) => normEntityName(itemName(a)) === normEntityName(itemName(b));
function deriveMaterialFlows(stocks, entities) {
  const ups = new Map(); const downs = new Map();
  const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
  for (const [name, users] of entities.materials) {
    const makers = entities.products.get(name); if (!makers) continue;
    const spec = makers.length * users.length;
    for (const u of users) for (const mk of makers) {
      if (u.code === mk.code) continue;
      const tier = fromAnnual(u.item, stocks.get(u.code).profile) && fromAnnual(mk.item, stocks.get(mk.code).profile) && sameRawName(u.item, mk.item) ? 'annual' : 'ai';
      push(ups, u.code, { code: mk.code, via: name, tier, spec });
      push(downs, mk.code, { code: u.code, via: name, tier, spec });
    }
  }
  const rank = (arr) => arr.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'annual' ? -1 : 1) || a.spec - b.spec).slice(0, FLOW_MAX * 3);
  for (const s of stocks.values()) { s.derivedUpstream = rank(ups.get(s.code) || []); s.derivedDownstream = rank(downs.get(s.code) || []); }
}

/** 產業鏈上下游：同鏈中角色在前者為上游、在後者為下游；「族群」無方向 */
export function chainNeighbors(model, code) {
  const out = [];
  for (const c of model.stocks.get(code)?.chains || []) {
    const ch = model.chains.find(x => x.key === c.key); if (!ch) continue;
    const my = ROLE_ORDER[c.role];
    const pick = (pred) => ch.segs.filter(pred).flatMap(g => g.codes.filter(x => x !== code).map(x => ({ code: x, seg: `${g.role}·${g.label}` })));
    out.push({
      chain: ch.name, role: c.role, label: c.label,
      upstream: my == null ? [] : pick(g => ROLE_ORDER[g.role] != null && ROLE_ORDER[g.role] < my),
      downstream: my == null ? [] : pick(g => ROLE_ORDER[g.role] != null && ROLE_ORDER[g.role] > my),
      sameSeg: pick(g => g.role === c.role && g.label === c.label),
    });
  }
  return out;
}

/** 同業：同產業別、市值最接近的 n 檔 */
export function nearestPeers(model, code, n = 12) {
  const s = model.stocks.get(code); if (!s?.industry || !s.mktCap) return [];   // 市值未知不捏造「相近」
  const members = model.industries.get(s.industry.name)?.members || [];
  const lm = Math.log10(s.mktCap);
  return members.filter(c => c !== code && model.stocks.get(c).mktCap)
    .map(c => ({ c, d: Math.abs(Math.log10(model.stocks.get(c).mktCap) - lm) }))
    .sort((a, b) => a.d - b.d).slice(0, n).map(x => x.c);
}

