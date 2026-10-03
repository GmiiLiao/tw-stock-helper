// 台股 wiki：個股頁、ETF 頁
import { frontmatter, fmtYi, fmtNum, fmtPct, cell } from './util.mjs';
import { SOURCES, PROFILE_KINDS, chainNeighbors, nearestPeers } from './model.mjs';

const tag = (srcKey) => (SOURCES[srcKey] ? `〔${SOURCES[srcKey].tier}·${SOURCES[srcKey].label}〕` : '');
const NEWS_MAX = 15; const ANN_MAX = 15;
const REL_LABEL = { director: '法人董監', major_holder: '大股東(≥10%)' };
const HOLDER_KIND = { listed: '上市櫃公司', private: '非上市法人', public: '公股／政府基金', vc: '創投／開發資本' };

function overviewTable(s, L) {
  const rows = [
    ['全名', s.fullName], ['英文', [s.englishName, s.englishAbbr].filter(Boolean).join('／') || null],
    ['市場', s.market], ['產業別', s.industry ? `${L.industry(s.industry.name)}` : null],
    ['董事長／總經理', [s.chairman, s.president].filter(Boolean).join('／') || null],
    ['成立／掛牌', [s.establishDate, s.listDate].map(x => x || '—').join('／')],
    ['實收資本額', s.capital ? fmtYi(s.capital) : null],
    ['收盤價／市值', s.price ? `${s.price}／${s.mktCap ? fmtYi(s.mktCap) : '—'}` : null],
    ['總公司', [s.address, s.county ? L.region(s.county) : null].filter(Boolean).join('　') || null],
    ['註冊地', s.foreignReg ? `外國企業：${L.region(s.foreignReg)}` : '本國企業'],
    ['網址', s.website], ['簽證會計師', s.auditor], ['財報類型', s.reportType],
  ];
  return ['| 項目 | 內容 |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`)].join('\n');
}

function chainSection(model, s, L) {
  const nb = chainNeighbors(model, s.code);
  if (!nb.length) return `- 站內主題產業鏈尚未收錄本檔（同產業請見 ${s.industry ? L.industry(s.industry.name) : '產業頁'}）。`;
  const list = (arr) => (arr.length ? arr.map(x => `${L.stock(x.code)}（${x.seg}）`).join('、') : '—');
  return nb.map(n => [
    `### ${L.chain(n.chain)}：${n.role}${n.label ? `·${n.label}` : ''}`,
    `- 同段：${n.sameSeg.length ? n.sameSeg.map(x => L.stock(x.code)).join('、') : '—'}`,
    n.role === '族群' ? null : `- ⬆ 上游：${list(n.upstream)}`,
    n.role === '族群' ? null : `- ⬇ 下游：${list(n.downstream)}`,
  ].filter(Boolean).join('\n')).join('\n\n');
}

function flowSection(s, L) {
  const fmt = (arr) => {
    const by = new Map();
    for (const x of arr) { const e = by.get(x.code) || by.set(x.code, { via: new Set(), annual: false }).get(x.code); e.via.add(x.via); if (x.tier === 'annual') e.annual = true; }
    return [...by.entries()].slice(0, 15).map(([c, e]) => `${L.stock(c)}（${[...e.via].join('、')}${e.annual ? '' : '·AI待驗'}）`).join('、');
  };
  if (!s.derivedUpstream?.length && !s.derivedDownstream?.length) return '';
  return ['### 依經營輪廓推導的上下游〔站內推導·原料與產品名稱比對；兩端皆來自年報才不標待驗〕', '',
    s.derivedUpstream.length ? `- ⬆ 生產本公司原料者：${fmt(s.derivedUpstream)}` : '',
    s.derivedDownstream.length ? `- ⬇ 以本公司產品為原料者：${fmt(s.derivedDownstream)}` : '', ''].filter(x => x !== '').join('\n') + '\n';
}

function profileSection(model, s, L) {
  const p = s.profile;
  const head = `## 經營輪廓：產品／原料／客戶／設備／廠房／國內外 ${p?.src ? `〔${p.src}${p.asOf ? `·${p.asOf}` : ''}〕` : ''}`;
  if (!p) {
    return [head, '',
      '> 尚未建立。官方結構化資料沒有這些欄位，需由年報「營運概況」萃取或 AI 整理後放入 `.cache/profiles/` 再重建（見 [[README#擴充：經營輪廓]]）。',
      '', '| 面向 | 內容 |', '|---|---|', ...Object.values(PROFILE_KINDS).map(k => `| ${k.label} | 待建 |`)].join('\n');
  }
  const fmtItem = (folder, it, kind) => {
    const name = typeof it === 'string' ? it : it.name;
    const extra = typeof it === 'string' ? [] : [it.share, it.country, it.location, it.products?.length ? `產：${it.products.join('、')}` : null, it.note].filter(Boolean);
    const conf = typeof it === 'object' && it.conf ? `〔${it.conf}${it.src === 'ai-knowledge' ? '·AI待驗' : ''}〕` : '';
    const key = model.keyOf(kind, it);
    const link = typeof it === 'object' && it.code && model.stocks.has(it.code) ? L.stock(it.code) : L.entity(folder, key, name);
    return `${link}${extra.length ? `（${extra.join('·')}）` : ''}${conf}`;
  };
  const rows = Object.entries(PROFILE_KINDS).map(([k, meta]) => `| ${meta.label} | ${(p[k] || []).length ? cell(p[k].map(it => fmtItem(meta.folder, it, k)).join('、')) : '—'} |`);
  return [head, '', p.summary ? `> ${p.summary}\n` : '', '| 面向 | 內容 |', '|---|---|', ...rows,
    p.conf ? `\n可信度：${p.conf}${p.note ? `。${p.note}` : ''}` : ''].join('\n');
}

// 產品分布：每項產品的產品族、所屬官方產業、生產地、銷售地（AI 分類·待驗）
function productMapSection(model, s, L) {
  const lines = s.productLines || [];
  if (!lines.length) return '';
  const places = (arr, folder) => (arr.length ? arr.map(c => L.entity(folder, c)).join('、') : '—');
  const cross = s.crossIndustries.map(x => `${L.industry(x.industry)}（${x.via.slice(0, 4).join('、')}）`);
  return ['### 產品分布：產業 × 國家〔AI 分類·待驗；生產地含年報／AI 廠區標註〕', '',
    `- 官方產業別：${s.industry ? L.industry(s.industry.name) : '未分類'}${cross.length ? `｜依產品另涉：${cross.join('、')}` : ''}`, '',
    '| 產品 | 產品族 | 所屬產業 | 生產地 | 銷售地 | 比重 |', '|---|---|---|---|---|---|',
    ...lines.map(l => `| ${cell(L.entity('產品', l.canon, l.name))} | ${cell(l.family ? L.family(l.family) : '—')} | ${cell(l.industries.length ? l.industries.map(i => L.industry(i)).join('、') : '—')} | ${cell(places(l.madeIn, '生產據點'))} | ${cell(places(l.soldTo, '銷售市場'))} | ${cell(l.share || '—')} |`),
    ''].join('\n');
}

const REF_LABEL = { customers: '列為客戶', suppliers: '列為供應商', competitors: '列為競爭者', products: '列為產品', materials: '列為原料', equipment: '列為設備', plants: '列為廠區', markets: '列為市場' };
function referencedSection(s, L) {
  if (!s.referencedBy.length) return '';
  const by = {};
  for (const r of s.referencedBy) (by[r.kind] ||= []).push(`${L.stock(r.from)}${r.conf ? `〔${r.conf}${r.src === 'ai-knowledge' ? '·AI待驗' : ''}〕` : ''}`);
  return ['### 被其他公司提及', '', ...Object.entries(by).map(([k, arr]) => `- 被${REF_LABEL[k] || k}：${arr.join('、')}`), ''].join('\n');
}

function groupSection(model, s, L) {
  const out = [];
  if (s.groupId) {
    const g = model.groups.find(x => x.id === s.groupId);
    out.push(`- 所屬：${L.group(s.groupId)}（${g?.members.length || '?'} 家上市櫃）`);
  }
  if (s.holders.length) {
    out.push('- 本公司的法人董監／大股東：');
    const sorted = [...s.holders].sort((a, b) => (b.stake || 0) - (a.stake || 0));
    for (const h of sorted) out.push(`  - ${h.from ? L.stock(h.from) : L.holder(h.holder)}　${REL_LABEL[h.rel] || h.rel}·${HOLDER_KIND[h.kind]}${h.stake ? `·持股 ${fmtPct(h.stake * 100, 2)}` : ''}${h.isParent ? '　**← 最大法人股東**' : ''}`);
  }
  if (s.holdings.length) out.push(`- 本公司擔任法人董監／大股東：${s.holdings.map(h => `${L.stock(h.to)}${h.stake ? `（${fmtPct(h.stake * 100, 1)}）` : ''}`).join('、')}`);
  return out.length ? out.join('\n') : '- 官方董監／大股東名單中沒有法人股東（或屬上櫃／興櫃，董監明細來源暫不可達）。';
}

function finSection(s) {
  const f = s.fin; const q = s.finReport?.quarters?.[0]; const pr = s.peer;
  if (!f && !q && !pr) return '- 來源未提供。';
  const rows = [];
  if (f) rows.push(`| 近四季 EPS | ${fmtNum(f.eps)} | EPS 年增 | ${fmtPct(f.yoy)} |`, `| ROE | ${fmtPct(f.roe)} | 營收年增 | ${fmtPct(f.ryoy)} |`,
    `| 毛利率 | ${fmtPct(f.gm)} | 淨利率 | ${fmtPct(f.nm)} |`, `| 負債比 | ${fmtPct(f.dr)} | 連續獲利季數 | ${f.stk ?? '—'} |`, `| 本益比 | ${fmtNum(f.pe)} | 股價淨值比 | ${fmtNum(f.pb)} |`);
  if (pr) rows.push(`| 殖利率 | ${fmtPct(pr.yield)} | 月營收年增 | ${fmtPct(pr.revYoY)} |`);
  const qLine = q ? `\n最近財報：${q.y}Q${q.s}（年度累計）營收 ${fmtYi(q.rev * 1000)}、營業利益 ${fmtYi(q.op * 1000)}、稅後淨利 ${fmtYi(q.ni * 1000)}、EPS ${fmtNum(q.eps)}` : '';
  return ['| 指標 | 值 | 指標 | 值 |', '|---|---|---|---|', ...rows].join('\n') + qLine;
}

export function renderStock(model, s, L, today) {
  const nb = chainNeighbors(model, s.code);
  const fm = frontmatter({
    type: 'stock', code: s.code, name: s.name, market: s.market, industry: s.industry?.name,
    chains: [...new Set(s.chains.map(c => c.name))], group: s.groupId,
    aliases: [s.name, s.code, s.englishAbbr].filter(Boolean),
    tags: ['個股', s.market, s.industry ? `產業/${s.industry.name}` : null].filter(Boolean).map(t => t.replace(/\s+/g, '')),
  });
  const peers = nearestPeers(model, s.code);
  const sameSeg = new Set(nb.flatMap(n => n.sameSeg.map(x => x.code)));
  const news = s.news.slice(0, NEWS_MAX);
  const ann = s.announcements.slice(0, ANN_MAX);
  return [fm, '', `# ${s.code} ${s.name}`, '',
    `> ${s.market}｜${s.industry ? L.industry(s.industry.name) : '產業未分類'}${s.chains.length ? `｜產業鏈：${[...new Set(s.chains.map(c => L.chain(c.name)))].join('、')}` : ''}${s.groupId ? `｜${L.group(s.groupId)}` : ''}`,
    '', `## 公司概況 ${tag(s.src.basic)}`, '', overviewTable(s, L), '',
    `### 主要經營業務 ${s.mainBusiness ? tag('mops-t05st03') : ''}`, '', s.mainBusiness ? `> ${s.mainBusiness.replace(/\n+/g, ' ')}` : '- 來源未提供。', '',
    `## 產業鏈位置與上下游 ${tag('themeMap')}`, '', chainSection(model, s, L), '', flowSection(s, L),
    profileSection(model, s, L), '',
    productMapSection(model, s, L),
    referencedSection(s, L),
    `## 同業 ${tag(s.industry?.src || 'peerComps')}`, '',
    peers.length ? `- 同產業、市值相近：${peers.map(c => L.stock(c)).join('、')}` : (s.mktCap ? '- —' : '- 市值未知（缺股價或股數），不列「市值相近」'),
    sameSeg.size ? `- 同產業鏈同段：${[...sameSeg].map(c => L.stock(c)).join('、')}` : '',
    s.industry ? `- 完整名單：${L.industry(s.industry.name)}（${model.industries.get(s.industry.name)?.members.length} 檔）` : '', '',
    `## 集團／關係企業 ${tag('groups')}`, '', groupSection(model, s, L), '',
    s.etfs.length ? `## 被納入的 ETF ${tag('etfInfluence')}\n\n${s.etfs.map(e => `- ${L.etf(e.code)}　近似權重 ${fmtPct(e.weight, 2)}`).join('\n')}\n` : '',
    `## 財務摘要 ${tag('finSummary')}`, '', finSection(s), '',
    `## 重大訊息（近 ${ANN_MAX} 則） ${tag('mopsNews')}`, '',
    ann.length ? ann.map(a => `- ${L.day(a.date)}　${cell(a.subject)}`).join('\n') : '- 本地備份期間內無。', '',
    `## 近期新聞 ${tag('news')}`, '',
    news.length ? news.map(n => `- ${String(n.time).slice(0, 10)}　${n.category === 'industry' ? '〔產業〕' : ''}${n.source ? `${n.source}｜` : ''}${n.url ? `[${cell(n.title).replace(/[[\]]/g, '')}](${n.url})` : cell(n.title)}`).join('\n') : '- 本地新聞快取未收錄（daemon 只快取自選／持股與熱門股）。',
  ].filter(x => x !== null).join('\n');
}

export function renderEtf(model, e, L, today) {
  const fm = frontmatter({ type: 'etf', code: e.code, name: e.name, market: e.market, index: e.index, issuer: e.issuer, aliases: [e.name, e.code].filter(Boolean), tags: ['ETF', ...(e.tags || [])] });
  const rows = [
    ['全名', e.fullName], ['英文', e.englishName], ['市場', e.market], ['類型', e.type], ['標籤', (e.tags || []).join('、')],
    ['追蹤指數', e.index ? L.index(e.index) : null], ['客製化指數', e.customIndex], ['含國外成分', e.hasForeign],
    ['發行投信（由名稱推導）', e.issuer ? L.issuer(e.issuer) : null], ['成立／上市', [e.establishDate, e.listDate].map(x => x || '—').join('／')],
    ['基金經理人', e.manager], ['保管機構', e.custodian], ['發行單位數', e.units ? e.units.toLocaleString('en-US') : null], ['收盤價', e.price],
  ];
  const sameIndex = e.index ? (model.indexes.get(e.index) || []).filter(c => c !== e.code) : [];
  const cons = e.constituents || [];
  return [fm, '', `# ${e.code} ${e.name}`, '',
    `## 基本資料 ${tag(e.src)}`, '', '| 項目 | 內容 |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`), '',
    e.src === 'snapshot' ? '> 上櫃 ETF 基本資料來源（櫃買中心）目前無法連線，只有快照名稱與價格。\n' : '',
    sameIndex.length ? `## 追蹤同一指數\n\n${sameIndex.map(c => `- ${L.etf(c)}`).join('\n')}\n` : '',
    `## 成分股 ${cons.length ? tag('etfInfluence') : ''}`, '',
    cons.length ? [`資料日 ${e.constituentsDate}；以市值近似，實際成分與權重以投信／指數公司公告為準。`, '', '| # | 個股 | 近似權重 |', '|---|---|---|',
      ...cons.map(x => `| ${x.rank} | ${cell(L.stock(x.code))} | ${fmtPct(x.weight, 2)} |`)].join('\n')
      : '- 來源未提供（需投信每日申購買回清單 PCF；見 README 擴充計畫）。',
  ].join('\n');
}
