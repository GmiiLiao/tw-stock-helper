// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki：產品連動——產品族／跨產業成員／產品×國家（使用者 2026-10-03：
//   「一家公司有多種產品分佈在不同產業與國家」要能連動）
//
// 官方產業別每家只有一個；多角化公司（南亞：塑膠＋銅箔基板＋乙二醇）的其他產品線在別的產業頁看不到。
// 這裡依產品分類樹（taxonomy.mjs）把每項產品對到產品族與官方產業，並把產品×國家（AI 層 geo 或年報廠區）彙總：
//   s.productLines     每項產品一列 { name, canon, family, industries, madeIn, soldTo, share, conf, src }
//   s.productIndustries 產品涉及的官方產業 [{ industry, via:[標準名], official }]；s.crossIndustries＝其中非官方產業別者
//   ind.crossMembers    依產品跨入此產業的公司 [{ code, via }]
//   model.families      產品族 → { name, industries, desc, producers: Map(code→Set), users: Map(code→Set), canons: Map(標準名→Set(原名)) }
//   model.productGeo    { made: Map(國家→Map(code→Set(標準名))), sold: Map(地區→Map(code→Set(標準名))) }
// 產品族與產業歸屬是 AI 分類、生產地／銷售地多為 AI 整理：頁面一律標「AI 分類·待驗」，判讀只放參考區。
// ─────────────────────────────────────────────────────────────────────────────
import { normEntityName, normPlace } from './profiles.mjs';
import { NOT_TARGET } from './taxonomy.mjs';

const nameOf = (it) => normEntityName(typeof it === 'string' ? it : it?.name);
const addTo = (m, k, v) => (m.get(k) || m.set(k, new Set()).get(k)).add(v);
const addTo2 = (m, k1, k2, v) => addTo(m.get(k1) || m.set(k1, new Map()).get(k1), k2, v);
const plantCountry = (pl) => normPlace(pl?.country || String(pl?.location || '').split(/[／/、,，]/)[0] || '');
const plainTerm = (n) => ({ canon: normEntityName(n), family: null, industries: [] });

/** 一家公司的產品線：生產地＝產品自己的 madeIn ∪ 標明生產該產品的廠區所在國 */
export function productLinesOf(profile, termOf = plainTerm) {
  if (!profile) return [];
  const byPlant = new Map();
  for (const pl of profile.plants || []) {
    const c = plantCountry(pl); if (!c) continue;
    for (const pn of pl.products || []) addTo(byPlant, termOf(pn).canon, c);
  }
  return (profile.products || []).map(it => {
    const name = nameOf(it); const t = termOf(name);
    const o = typeof it === 'object' && it ? it : {};
    return {
      name, canon: t.canon, family: t.family, industries: t.industries,
      madeIn: [...new Set([...(o.madeIn || []), ...(byPlant.get(t.canon) || [])])],
      soldTo: [...new Set(o.soldTo || [])],
      share: o.share || null, conf: o.conf || null, src: o.src || profile.src || null,
    };
  }).filter(l => l.name);
}

export function applyProductLinks(model, taxonomy) {
  // 產業歸屬只收本次宇宙裡真的存在的官方產業別（AI 寫錯字或已改名的產業丟掉）
  const okInd = (i) => model.industries.has(i) && !NOT_TARGET.has(i);
  const termOf = taxonomy ? (n) => { const t = taxonomy.termOf(n); return { ...t, industries: t.industries.filter(okInd) }; } : plainTerm;
  const families = new Map();
  for (const [name, f] of taxonomy?.families || []) families.set(name, { ...f, industries: f.industries.filter(okInd), producers: new Map(), users: new Map(), canons: new Map() });
  const made = new Map(); const sold = new Map();
  for (const ind of model.industries.values()) ind.crossMembers = [];

  for (const s of model.stocks.values()) {
    const p = s.profile;
    s.productLines = productLinesOf(p, termOf);
    for (const l of s.productLines) {
      const fam = l.family && families.get(l.family);
      if (fam) { addTo(fam.producers, s.code, l.canon); addTo(fam.canons, l.canon, l.name); }
      for (const c of l.madeIn) addTo2(made, c, s.code, l.canon);
      for (const r of l.soldTo) addTo2(sold, r, s.code, l.canon);
    }
    for (const it of p?.materials || []) {
      const name = nameOf(it); if (!name) continue;
      const t = termOf(name); const fam = t.family && families.get(t.family);
      if (fam) { addTo(fam.users, s.code, t.canon); addTo(fam.canons, t.canon, name); }
    }
    const byInd = new Map();
    for (const l of s.productLines) for (const ind of l.industries) addTo(byInd, ind, l.canon);
    s.productIndustries = [...byInd].map(([industry, via]) => ({ industry, via: [...via], official: industry === s.industry?.name }));
    s.crossIndustries = s.productIndustries.filter(x => !x.official);
    for (const x of s.crossIndustries) model.industries.get(x.industry)?.crossMembers.push({ code: s.code, via: x.via });
  }
  const cap = (c) => model.stocks.get(c)?.mktCap || 0;
  for (const ind of model.industries.values()) ind.crossMembers.sort((a, b) => cap(b.code) - cap(a.code) || a.code.localeCompare(b.code));
  model.families = new Map([...families].filter(([, f]) => f.producers.size || f.users.size));
  model.productGeo = { made, sold };
  return model;
}
