// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki：組裝＋寫檔。只讀本地（備份＋.cache），零上游請求。
// 寫檔規則：
//   · 每頁「✍ 個人筆記」標記以下的內容重建時原封保留
//   · 上一輪產生、這一輪不再產生的頁：沒有個人筆記才刪，有筆記就留著（寧可留孤兒頁也不丟使用者的字）
//   · 內容沒變不重寫（mtime 不跳，Obsidian／同步工具不會整庫重新索引）
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { loadBackup, loadStockNews, loadFinReport } from './load-local.mjs';
import { readMopsCompany } from './sources.mjs';
import { buildModel, chainNeighbors, nearestPeers, PROFILE_KINDS, SOURCES } from './model.mjs';
import { makeLinks, FOLDERS } from './links.mjs';
import { renderStock, renderEtf } from './render-stock.mjs';
import { renderIndustry, renderChain, renderGroup, renderHolder, renderRegion, renderEtfList, renderDay, renderEntity, renderFamily } from './render-hubs.mjs';
import { renderReadme } from './render-readme.mjs';
import { extractNotes, withNotes } from './util.mjs';
import { readProfile } from './profiles.mjs';
import { loadTaxonomy } from './taxonomy.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const taipeiToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

const writeAtomic = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, text); fs.renameSync(`${file}.tmp`, file); };

/** 同資料夾裡「{代號} 舊名.md」——公司改名時新頁找不到舊筆記，要靠代號接回 */
function findByCodePrefix(dir, code, exceptBase) {
  try { return fs.readdirSync(dir).filter(f => f.startsWith(`${code} `) && f.endsWith('.md') && f !== exceptBase).map(f => path.join(dir, f)); } catch { return []; }
}

function makeWriter(wikiDir) {
  const written = new Set(); const stat = { written: 0, unchanged: 0, notesMoved: 0 };
  const write = (rel, content, { keepNotes = true, code = null } = {}) => {
    const file = path.join(wikiDir, rel);
    let old = null; try { old = fs.readFileSync(file, 'utf8'); } catch { /* 新檔 */ }
    let notes = extractNotes(old);
    if (keepNotes && old == null && code) {
      // 個股／ETF 改名：把舊檔名的筆記搬到新檔，舊檔刪掉（筆記已搬走，不會遺失）
      for (const prev of findByCodePrefix(path.dirname(file), code, path.basename(file))) {
        const n = extractNotes(fs.readFileSync(prev, 'utf8'));
        if (n.trim()) { notes = notes ? `${notes}\n${n}` : n; stat.notesMoved++; }
        fs.unlinkSync(prev);
      }
    }
    const next = keepNotes ? withNotes(content, notes) : content;
    written.add(rel);
    if (old === next) { stat.unchanged++; return; }
    writeAtomic(file, next); stat.written++;
  };
  return { write, written, stat };
}

/**
 * 完整性閘門（2026-10-03 審查）：備份缺檔、快照少一個市場、檔數比上一輪驟減 ⇒ 不重建（不寫、不刪、不動 stocks.json）。
 * 「總數 > 0」不是完整性條件（CLAUDE.md 殘缺宇宙）——缺一邊時寧可保留上一版 vault。
 */
export function completenessProblems(bk, model, prevManifest) {
  const problems = [...bk.missing.map(m => `備份缺 ${m}`)];
  const markets = new Set(Object.values(bk.quotes || {}).map(q => q?.market));
  for (const m of ['tse', 'otc']) if (!markets.has(m)) problems.push(`收盤快照缺 ${m === 'tse' ? '上市' : '上櫃'}`);
  const prevStocks = prevManifest?.stocks || 0;
  if (prevStocks && model.stocks.size < prevStocks * 0.95) problems.push(`個股數 ${model.stocks.size} 比上一輪 ${prevStocks} 少超過 5%`);
  return problems;
}

/** 刪除上一輪有、這一輪沒有、且沒有個人筆記的頁 */
function pruneStale(wikiDir, prevList, written, log) {
  let removed = 0; let kept = 0;
  for (const rel of prevList || []) {
    if (written.has(rel)) continue;
    const file = path.join(wikiDir, rel);
    let content; try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (extractNotes(content).trim()) { kept++; log(`  · 保留有個人筆記的舊頁：${rel}`); continue; }
    fs.unlinkSync(file); removed++;
  }
  return { removed, kept };
}

function graphJson(model, L) {
  const nodes = []; const edges = [];
  const E = (s, t, rel, src, extra) => edges.push({ s, t, rel, src, ...extra });
  for (const s of model.stocks.values()) {
    nodes.push({ id: `stock:${s.code}`, type: 'stock', code: s.code, name: s.name, market: s.market, industry: s.industry?.name || null, page: L.path.stock(s.code) });
    if (s.industry) E(`stock:${s.code}`, `industry:${s.industry.name}`, 'in_industry', s.industry.src);
    for (const c of s.chains) E(`stock:${s.code}`, `chain:${c.key}`, 'in_chain', 'themeMap', { role: c.role, label: c.label });
    for (const h of s.holders) E(h.from ? `stock:${h.from}` : `holder:${h.holder}`, `stock:${s.code}`, h.rel, h.rel === 'major_holder' ? 'twse-t187ap02' : 'twse-t187ap11', { kind: h.kind });
    if (s.groupId) E(`stock:${s.code}`, `group:${s.groupId}`, 'in_group', 'groups');
    for (const r of [s.county, s.foreignReg]) if (r) E(`stock:${s.code}`, `region:${r}`, r === s.county ? 'hq_in' : 'registered_in', 'mops-t05st03');
    for (const e of s.etfs) E(`etf:${e.code}`, `stock:${s.code}`, 'holds_approx', 'etfInfluence', { weight: e.weight });
    for (const u of s.derivedUpstream || []) E(`stock:${u.code}`, `stock:${s.code}`, 'supplies_derived', 'profile-match', { via: u.via, tier: u.tier });
    for (const l of s.productLines) {
      if (l.family) E(`stock:${s.code}`, `family:${l.family}`, 'makes_family', 'taxonomy-ai', { product: l.canon });
      for (const c of l.madeIn) E(`stock:${s.code}`, `plants:${c}`, 'makes_in', 'profile', { product: l.canon });
      for (const r of l.soldTo) E(`stock:${s.code}`, `markets:${r}`, 'sells_to', 'profile', { product: l.canon });
    }
    for (const kind of Object.keys(PROFILE_KINDS)) for (const it of s.profile?.[kind] || []) {
      const name = model.keyOf(kind, it);
      const target = typeof it === 'object' && it.code && model.stocks.has(it.code) ? `stock:${it.code}` : `${kind}:${name}`;
      if (name) E(`stock:${s.code}`, target, `has_${kind}`, (typeof it === 'object' && it.src) || s.profile.src || 'profile', { conf: typeof it === 'object' ? it.conf : undefined });
    }
  }
  for (const e of model.etfs.values()) {
    nodes.push({ id: `etf:${e.code}`, type: 'etf', code: e.code, name: e.name, market: e.market, page: L.path.etf(e.code) });
    if (e.index) E(`etf:${e.code}`, `index:${e.index}`, 'tracks', e.src);
    if (e.issuer) E(`issuer:${e.issuer}`, `etf:${e.code}`, 'issues', 'derived');
  }
  for (const ind of model.industries.values()) nodes.push({ id: `industry:${ind.name}`, type: 'industry', name: ind.name, page: L.path.named('industry', ind.name) });
  for (const ch of model.chains) nodes.push({ id: `chain:${ch.key}`, type: 'chain', name: ch.name, page: L.path.named('chain', ch.name) });
  for (const g of model.groups) nodes.push({ id: `group:${g.id}`, type: 'group', name: g.name, core: g.core, page: L.path.named('group', g.name) });
  for (const h of model.holders.values()) if (!h.listedCode) nodes.push({ id: `holder:${h.name}`, type: 'holder', name: h.name, kind: h.kind, page: L.holderHasPage(h.name) ? L.path.named('holder', h.name) : null });
  for (const r of model.regions.keys()) nodes.push({ id: `region:${r}`, type: 'region', name: r, page: L.path.named('region', r) });
  for (const i of model.indexes.keys()) nodes.push({ id: `index:${i}`, type: 'index', name: i, page: L.path.named('index', i) });
  for (const i of model.issuers.keys()) nodes.push({ id: `issuer:${i}`, type: 'issuer', name: i, page: L.path.named('issuer', i) });
  const geoKeys = { plants: model.productGeo.made, markets: model.productGeo.sold };
  for (const [kind, m] of Object.entries(model.entities)) {
    for (const n of new Set([...m.keys(), ...(geoKeys[kind]?.keys() || [])])) nodes.push({ id: `${kind}:${n}`, type: kind, name: n, page: L.path.named(PROFILE_KINDS[kind].folder, n) });
  }
  for (const f of model.families.values()) {
    nodes.push({ id: `family:${f.name}`, type: 'family', name: f.name, page: L.path.named('family', f.name) });
    for (const ind of f.industries) E(`family:${f.name}`, `industry:${ind}`, 'family_in_industry', 'taxonomy-ai');
  }
  return { nodes, edges };
}

const codesOf = (arr, tier) => [...new Set((arr || []).filter(x => x.tier === tier).map(x => x.code))].slice(0, 15);

/** 給本地 AI／daemon 查的單檔精簡輪廓（code → 一行物件） */
function stocksJson(model) {
  const out = {};
  for (const s of model.stocks.values()) {
    const nb = chainNeighbors(model, s.code);
    out[s.code] = {
      name: s.name, market: s.market, industry: s.industry?.name || null, mainBusiness: s.mainBusiness,
      chains: s.chains.map(c => ({ name: c.name, role: c.role, label: c.label })),
      upstream: [...new Set(nb.flatMap(n => n.upstream.map(x => x.code)))], downstream: [...new Set(nb.flatMap(n => n.downstream.map(x => x.code)))],
      peers: nearestPeers(model, s.code, 8), group: s.groupId,
      corporateHolders: s.holders.map(h => h.from || h.holder), holdsBoardSeatIn: s.holdings.map(h => h.to),
      etfsApprox: s.etfs.map(e => e.code), county: s.county, foreignReg: s.foreignReg,
      // 年報兩端的推導邊（可當事實）與 AI 輪廓推導邊（只能當參考）分開給
      derivedUpstream: codesOf(s.derivedUpstream, 'annual'), derivedDownstream: codesOf(s.derivedDownstream, 'annual'),
      derivedUpstreamAi: codesOf(s.derivedUpstream, 'ai'), derivedDownstreamAi: codesOf(s.derivedDownstream, 'ai'),
      mktCap: s.mktCap ? Math.round(s.mktCap / 1e8) : null, profile: s.profile || null,
      // 產品連動（AI 分類／AI 整理·待驗）：依產品涉及的非官方產業別、產品×國家
      crossIndustries: s.crossIndustries.map(x => ({ industry: x.industry, via: x.via.slice(0, 4) })),
      productGeo: s.productLines.filter(l => l.madeIn.length || l.soldTo.length).slice(0, 8).map(l => ({ product: l.canon, family: l.family, madeIn: l.madeIn, soldTo: l.soldTo })),
    };
  }
  return out;
}

export function loadModel({ brainDir, cacheDir, log = () => {} }) {
  const bk = loadBackup(brainDir);
  if (bk.missing.length) log('⚠ 備份缺：', bk.missing.join('、'));
  const twse = {};
  for (const ep of ['t187ap03_L', 't187ap02_L', 't187ap11_L', 't187ap47_L']) twse[ep] = readJson(path.join(cacheDir, 'twse', `${ep}.json`))?.rows || [];
  const model = buildModel({
    bk, twse,
    mopsOf: (code) => { const m = readMopsCompany(cacheDir, code); return m?.notFound ? null : m; },
    newsOf: (code) => loadStockNews(brainDir, code),
    finReportOf: (code) => loadFinReport(brainDir, code),
    profileOf: (code) => readProfile(cacheDir, code),
    taxonomy: loadTaxonomy(cacheDir),   // 產品分類樹（沒跑過就是空的，產品照原名）
  });
  return { bk, model };
}

export async function buildWiki({ brainDir, wikiDir, cacheDir, log = () => {} }) {
  const today = taipeiToday();
  const { bk, model } = loadModel({ brainDir, cacheDir, log });
  const manifestFile = path.join(cacheDir, 'manifest.json');
  const prevManifest = readJson(manifestFile);
  const problems = completenessProblems(bk, model, prevManifest);
  if (problems.length) {
    log(`⛔ 資料不完整，不重建（保留上一版 vault 與 stocks.json）：${problems.join('；')}`);
    return { aborted: true, problems };
  }
  const L = makeLinks(model);
  const W = makeWriter(wikiDir);

  for (const s of model.stocks.values()) W.write(L.path.stock(s.code), renderStock(model, s, L, today), { code: s.code });
  for (const e of model.etfs.values()) W.write(L.path.etf(e.code), renderEtf(model, e, L, today), { code: e.code });
  for (const ind of model.industries.values()) W.write(L.path.named('industry', ind.name), renderIndustry(model, ind, L, today));
  for (const ch of model.chains) W.write(L.path.named('chain', ch.name), renderChain(model, ch, L, today));
  for (const g of model.groups) W.write(L.path.named('group', g.name), renderGroup(model, g, L, today));
  for (const h of model.holders.values()) if (L.holderHasPage(h.name)) W.write(L.path.named('holder', h.name), renderHolder(model, h, L, today));
  for (const [r, codes] of model.regions) W.write(L.path.named('region', r), renderRegion(model, r, codes, L, today));
  for (const [i, codes] of model.indexes) W.write(L.path.named('index', i), renderEtfList(model, 'index', i, codes, L, today));
  for (const [i, codes] of model.issuers) W.write(L.path.named('issuer', i), renderEtfList(model, 'issuer', i, codes, L, today));
  for (const d of model.announceDays) W.write(L.path.named('day', d.date), renderDay(model, d, L, today));
  // 生產據點／銷售市場：只出現在產品×國家（沒有廠區／市場項目）的國家也要有頁
  const geoKeys = { plants: model.productGeo.made, markets: model.productGeo.sold };
  for (const [kind, m] of Object.entries(model.entities)) {
    const meta = PROFILE_KINDS[kind];
    const keys = new Set([...m.keys(), ...(geoKeys[kind]?.keys() || [])]);
    for (const n of keys) W.write(L.path.named(meta.folder, n), renderEntity(model, meta.folder, meta.label, n, m.get(n) || [], L, today));
  }
  for (const f of model.families.values()) W.write(L.path.named('family', f.name), renderFamily(model, f, L, today));

  const stats = {
    stocks: model.stocks.size, etfs: model.etfs.size, industries: model.industries.size, chains: model.chains.length,
    groups: model.groups.length, holderPages: [...model.holders.values()].filter(h => L.holderHasPage(h.name)).length,
    regions: model.regions.size, indexes: model.indexes.size, issuers: model.issuers.size, announceDays: model.announceDays.length,
    withMops: [...model.stocks.values()].filter(s => s.src.basic === 'mops-t05st03').length,
    withMainBusiness: [...model.stocks.values()].filter(s => s.mainBusiness).length,
    withIndustry: [...model.stocks.values()].filter(s => s.industry).length,
    inChain: [...model.stocks.values()].filter(s => s.chains.length).length,
    inGroup: [...model.stocks.values()].filter(s => s.groupId).length,
    withNews: [...model.stocks.values()].filter(s => s.news.length).length,
    withProfile: [...model.stocks.values()].filter(s => s.profile).length,
    families: model.families.size,
    crossIndustry: [...model.stocks.values()].filter(s => s.crossIndustries.length).length,
    withProductGeo: [...model.stocks.values()].filter(s => s.productLines.some(l => l.madeIn.length || l.soldTo.length)).length,
    snapshotDate: bk.snapshotDate, today,
  };
  W.write('README.md', renderReadme(model, L, stats, SOURCES, FOLDERS));

  const g = graphJson(model, L);
  W.write('_graph/graph.json', JSON.stringify({ generatedAt: today, sources: SOURCES, ...g }), { keepNotes: false });
  W.write('_graph/stocks.json', JSON.stringify({ generatedAt: today, stocks: stocksJson(model) }), { keepNotes: false });

  const pruned = pruneStale(wikiDir, prevManifest?.files, W.written, log);
  writeAtomic(manifestFile, JSON.stringify({ at: Date.now(), stocks: model.stocks.size, files: [...W.written].sort() }));
  return { ...stats, files: W.written.size, ...W.stat, ...pruned, nodes: g.nodes.length, edges: g.edges.length };
}
