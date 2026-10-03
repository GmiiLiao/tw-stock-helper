// 台股 wiki：彙總頁（產業／產業鏈／集團／法人股東／地區／指數／投信／重大訊息日／經營輪廓實體）
import { frontmatter, fmtYi, fmtNum, fmtPct, cell } from './util.mjs';
import { SOURCES } from './model.mjs';

const short = (s, n = 40) => { const t = String(s || '').replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n)}…` : t; };
const ROLE_ORDER = ['上游', '中游', '下游', '族群'];

function memberTable(model, codes, L) {
  return ['| 個股 | 市場 | 市值 | 主要經營業務 |', '|---|---|---|---|',
    ...codes.map(c => { const s = model.stocks.get(c); return `| ${cell(L.stock(c))} | ${s.market} | ${s.mktCap ? fmtYi(s.mktCap) : '—'} | ${cell(short(s.mainBusiness))} |`; })].join('\n');
}

export function renderIndustry(model, ind, L, today) {
  const sm = ind.summary;
  const chainsHere = model.chains.filter(ch => ch.segs.some(g => g.codes.some(c => model.stocks.get(c)?.industry?.name === ind.name)));
  return [frontmatter({ type: 'industry', name: ind.name, count: ind.members.length, tags: ['產業'] }), '',
    `# ${ind.name}`, '', `> 官方產業別（MOPS／證交所）｜${ind.members.length} 檔（上市櫃興櫃，依市值排序）`, '',
    sm ? `產業中位數〔${SOURCES.peerComps.label}〕：本益比 ${fmtNum(sm.medPe)}、股價淨值比 ${fmtNum(sm.medPb)}、殖利率 ${fmtPct(sm.medYield)}、月營收年增 ${fmtPct(sm.medRevYoY)}\n` : '',
    chainsHere.length ? `相關產業鏈：${chainsHere.map(ch => L.chain(ch.name)).join('、')}\n` : '',
    '## 成員', '', memberTable(model, ind.members, L), '',
    crossSection(model, ind, L)].join('\n');
}

// 官方產業別不同、但有產品屬於本產業的公司（多角化公司的其他產品線）
function crossSection(model, ind, L) {
  const xs = ind.crossMembers || [];
  if (!xs.length) return '';
  return [`## 依產品跨入的公司（官方產業別不同·AI 分類待驗）`, '', `> 這些公司的官方產業別不是「${ind.name}」，但有產品經產品分類樹歸到本產業。`, '',
    '| 個股 | 官方產業別 | 相關產品 |', '|---|---|---|',
    ...xs.map(x => { const s = model.stocks.get(x.code); return `| ${cell(L.stock(x.code))} | ${cell(s.industry ? L.industry(s.industry.name) : '—')} | ${cell(x.via.slice(0, 6).map(v => L.entity('產品', v)).join('、'))} |`; }),
    ''].join('\n');
}

export function renderChain(model, ch, L, today) {
  const segs = [...ch.segs].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const roles = ROLE_ORDER.filter(r => r !== '族群' && segs.some(g => g.role === r));
  const mermaid = roles.length > 1 ? ['```mermaid', 'flowchart LR',
    ...segs.filter(g => g.role !== '族群').map((g, i) => `  S${i}["${g.role}｜${g.label || g.role}"]`),
    ...roles.slice(0, -1).flatMap((r, ri) => {
      const from = segs.map((g, i) => [g, i]).filter(([g]) => g.role === r);
      const to = segs.map((g, i) => [g, i]).filter(([g]) => g.role === roles[ri + 1]);
      return from.flatMap(([, i]) => to.map(([, j]) => `  S${i} --> S${j}`));
    }), '```', ''].join('\n') : '';
  return [frontmatter({ type: 'chain', key: ch.key, name: ch.name, tags: ['產業鏈'] }), '',
    `# ${ch.name}`, '', `> 〔${SOURCES.themeMap.tier}·${SOURCES.themeMap.label}〕上中下游分段是站內人工整理，非官方分類；每段只列代表股。`, '',
    mermaid,
    ...segs.map(g => [`## ${g.role}${g.label ? `｜${g.label}` : ''}`, '', g.codes.length ? memberTable(model, g.codes, L) : '- （成員不在目前宇宙）', ''].join('\n'))].join('\n');
}

export function renderGroup(model, g, L, today) {
  const memberSet = new Set(g.members);
  const edges = g.members.flatMap(c => model.stocks.get(c).holders.filter(h => h.isParent || (h.from && memberSet.has(h.from)))
    .map(h => `- ${h.from ? L.stock(h.from) : L.holder(h.holder)} → ${L.stock(c)}（${h.rel === 'director' ? '法人董監' : '大股東'}${h.stake ? `·${fmtPct(h.stake * 100, 1)}` : ''}${h.isParent ? '·最大法人股東' : ''}）`));
  const shared = g.viaHolders.filter(n => !model.holders.get(n)?.listedCode);
  return [frontmatter({ type: 'group', name: g.name, core: g.core, count: g.members.length, tags: ['集團'] }), '',
    `# ${g.name}`, '', `> 〔${SOURCES.groups.tier}〕由官方董監／大股東名單推導：每家公司連到其最大法人股東，串成持股關聯群。含控制關係與策略投資，**不等於公司法定義的關係企業**；群名取群內市值最大者，**不是集團官方名稱**。`, '',
    '## 成員', '', memberTable(model, g.members, L), '',
    edges.length ? `## 持股／董監關係（每家公司只連到「最大法人股東」：持股比例最高且 ≥5% 或名列 10% 大股東）\n\n${edges.join('\n')}\n` : '',
    shared.length ? `## 共同的非上市法人股東（家族投資公司等）\n\n${shared.map(n => `- ${L.holder(n)}`).join('\n')}\n` : ''].join('\n');
}

export function renderHolder(model, h, L, today) {
  const kind = { private: '非上市法人', public: '公股／政府基金', vc: '創投／開發資本' }[h.kind] || h.kind;
  return [frontmatter({ type: 'holder', name: h.name, kind, count: h.codes.size, tags: ['法人股東'] }), '',
    `# ${h.name}`, '', `> ${kind}｜擔任 ${h.codes.size} 家公司的法人董監或大股東〔${SOURCES['twse-t187ap11'].label}／${SOURCES['twse-t187ap02'].label}〕`, '',
    memberTable(model, [...h.codes].sort(), L)].join('\n');
}

export function renderRegion(model, name, codes, L, today) {
  const isTw = /[市縣]$/.test(name);
  return [frontmatter({ type: 'region', name, count: codes.length, tags: ['地區'] }), '',
    `# ${name}`, '', `> ${isTw ? '總公司設於此縣市' : '外國企業註冊地'}（依官方登記地址）｜${codes.length} 檔。生產據點／海外廠房見各股「經營輪廓」。`, '',
    memberTable(model, [...codes].sort((a, b) => (model.stocks.get(b).mktCap || 0) - (model.stocks.get(a).mktCap || 0)), L)].join('\n');
}

export function renderEtfList(model, kind, name, codes, L, today) {
  return [frontmatter({ type: kind, name, count: codes.length, tags: [kind === 'index' ? '指數' : '投信'] }), '',
    `# ${name}`, '', kind === 'issuer' ? '> 發行投信由基金名稱推導。' : '> 追蹤此指數的 ETF。', '',
    '| ETF | 類型 | 標籤 |', '|---|---|---|',
    ...codes.sort().map(c => { const e = model.etfs.get(c); return `| ${cell(L.etf(c))} | ${cell(e.type)} | ${cell((e.tags || []).join('、'))} |`; })].join('\n');
}

export function renderDay(model, d, L, today) {
  return [frontmatter({ type: 'announcements', date: d.date, count: d.items.length, tags: ['重大訊息'] }), '',
    `# ${d.date} 重大訊息`, '', `> 〔${SOURCES.mopsNews.label}〕${d.items.length} 則（本地備份）`, '',
    ...d.items.map(it => `- ${new Date(it.at || 0).toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }).slice(0, 5)}　${L.stock(it.code)}　${cell(it.subject)}`)].join('\n');
}

// 產品頁表頭：所屬產品族／產業、合併進來的其他寫法
function productHeader(model, name, L) {
  const t = model.taxonomy?.termOf(name);
  const fam = t?.family ? model.families.get(t.family) : null;
  const aliases = fam ? [...(fam.canons.get(name) || [])].filter(a => a !== name) : [];
  return [fam ? `產品族：${L.family(fam.name)}${fam.industries.length ? `｜所屬產業：${fam.industries.map(i => L.industry(i)).join('、')}` : ''}〔AI 分類·待驗〕` : '',
    aliases.length ? `其他寫法：${aliases.join('、')}` : ''].filter(Boolean).join('\n\n');
}

// 生產據點（國家）／銷售市場頁：依產品×國家列出在此生產或銷往此地的產品
function geoSection(model, folder, name, L) {
  const m = folder === '生產據點' ? model.productGeo?.made.get(name) : folder === '銷售市場' ? model.productGeo?.sold.get(name) : null;
  if (!m?.size) return '';
  const title = folder === '生產據點' ? '在此生產的產品' : '銷往此地的產品';
  const codes = [...m.keys()].sort((a, b) => (model.stocks.get(b)?.mktCap || 0) - (model.stocks.get(a)?.mktCap || 0));
  return [`\n## ${title}（依產品×國家·AI 整理待驗／年報廠區）`, '', '| 個股 | 產品 |', '|---|---|',
    ...codes.map(c => `| ${cell(L.stock(c))} | ${cell([...m.get(c)].map(p => L.entity('產品', p)).join('、'))} |`), ''].join('\n');
}

export function renderFamily(model, f, L, today) {
  const cap = (c) => model.stocks.get(c)?.mktCap || 0;
  const rows = (m, folder) => [...m.keys()].sort((a, b) => cap(b) - cap(a)).map(c => {
    const s = model.stocks.get(c);
    const official = s.industry?.name;
    const crossTag = official && f.industries.length && !f.industries.includes(official) ? '（跨入）' : '';
    return `| ${cell(L.stock(c))} | ${cell(official ? `${L.industry(official)}${crossTag}` : '—')} | ${cell([...m.get(c)].map(p => L.entity(folder, p)).join('、'))} |`;
  });
  const canons = [...f.canons.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  return [frontmatter({ type: 'family', name: f.name, industries: f.industries, producers: f.producers.size, users: f.users.size, tags: ['產品族'] }), '',
    `# ${f.name}`, '', `> 〔AI 分類·待驗〕${f.desc || ''}`, '',
    `- 所屬官方產業：${f.industries.length ? f.industries.map(i => L.industry(i)).join('、') : '—（服務或無對應產業別）'}`,
    `- 包含品項：${canons.map(c => (model.entities.products.has(c) || model.entities.materials.has(c) ? L.entity(model.entities.products.has(c) ? '產品' : '原料', c) : c)).join('、')}`, '',
    `## 生產者（${f.producers.size} 家）`, '', f.producers.size ? ['| 個股 | 官方產業別 | 產品 |', '|---|---|---|', ...rows(f.producers, '產品')].join('\n') : '- —', '',
    `## 以此為原料者（${f.users.size} 家）`, '', f.users.size ? ['| 個股 | 官方產業別 | 原料 |', '|---|---|---|', ...rows(f.users, '原料')].join('\n') : '- —', ''].join('\n');
}

export function renderEntity(model, folder, label, name, refs, L, today) {
  // 同名的產品／原料互相指：產品頁列「誰拿它當原料」、原料頁列「誰生產它」
  const cross = folder === '產品' ? ['以此為原料者', model.entities.materials.get(name), '原料']
    : folder === '原料' ? ['生產此項者', model.entities.products.get(name), '產品'] : null;
  const crossLine = cross?.[1]?.length ? `\n## ${cross[0]}（見 ${L.entity(cross[2], name)}）\n\n${[...new Set(cross[1].map(r => r.code))].map(c => `- ${L.stock(c)}`).join('\n')}\n` : '';
  const head = folder === '產品' || folder === '原料' ? productHeader(model, name, L) : '';
  const detail = (r) => {
    const it = r.item;
    const own = folder === '產品' || folder === '原料' ? (it.name !== name ? `寫作「${it.name}」` : null) : null;
    const geo = folder === '產品' ? [it.madeIn?.length ? `產地 ${it.madeIn.join('、')}` : null, it.soldTo?.length ? `銷往 ${it.soldTo.join('、')}` : null] : [];
    return [own, folder === '生產據點' ? it.name : null, it.share, folder === '生產據點' ? null : it.country, it.location,
      folder === '生產據點' && it.products?.length ? `產：${it.products.join('、')}` : null, ...geo, it.note].filter(Boolean).join('·');
  };
  return [frontmatter({ type: 'entity', kind: folder, name, count: refs.length, tags: [folder] }), '',
    `# ${name}`, '', `> ${label}｜${refs.length} 家公司提及（來源見各股經營輪廓的標示）`, '',
    head ? `${head}\n` : '',
    refs.length ? ['| 個股 | 細節 | 可信度 | 來源 |', '|---|---|---|---|',
      ...refs.map(r => `| ${cell(L.stock(r.code))} | ${cell(detail(r))} | ${cell(r.item.conf)} | ${cell(r.item.src || model.stocks.get(r.code)?.profile?.src)} |`)].join('\n') : '',
    crossLine, geoSection(model, folder, name, L)].join('\n');
}
