// 每日熱力主計算（純函式）：inputs → payload（確定性：鍵序固定、取整固定、不含時間戳）。
//   核心（market／industries／index／stocks）只依賴官方資料＋wiki 官方產業別 industry；
//   chains／segments／groups／families 是「wiki 連動層」，各自標等級、只描述，不進核心數字。
import { isCommonStock } from './inputs.mjs';
import { r, mean, sum, std, zscores, groupStats, roundGroup, MIN_SHOW, MIN_LIST } from './stats.mjs';
import { computeIndexContribution } from './index-contrib.mjs';

export const SCHEMA_VERSION = 1;
const UNLIMITED = 10.5;       // |報酬|>10.5%：新上市前 5 日無漲跌幅、減資恢復等，不進群統計
const MIN_VAL_BOARD = 1e8;    // 榜單成交金額下限（避免無量漲停霸榜）
const NB_MIN = 3, NB_Z = 2, NB_EFFECT = 0.75;
const IND_ALIAS = { 金融業: '金融保險業' };
export const indName = s => (s ? IND_ALIAS[s] || s : null);

export const USE_RULES = Object.freeze({
  usedForScoring: false,
  nature: '資料日收盤事實的結構化描述；不是訊號、不是評分、不是預測',
  allowed: ['盤前簡報以「昨日收盤事實」引用（不得用預測語氣）', '離線研究當診斷欄', '站上顯示（附免責）'],
  forbidden: ['進任何模型分數、排序鍵、濾網、門檻', '餵 AI 波段／新聞識讀 LLM 當方向依據', '取代 sectorWind（做空風控依賴它）'],
  disclaimer: '非投資建議；比對未扣成本；官方產業別為事實，站內整理與 AI 待驗關聯不是連動依據',
});

function tpexRef(row, prevRow) {
  if (row.chg != null && row.close != null) return { ref: +(row.close - row.chg).toFixed(4), src: 'close-chg' };
  if (prevRow?.nextRef > 0) return { ref: prevRow.nextRef, src: 'prevNextRef' };
  return { ref: null, src: null };
}

/** 兩市個股列（含漲跌停、鎖死、除權息日旗標）。 */
export function buildStockRows(inp) {
  const { mi, ref, tpex, tpexPrev, qfiis, t187, inst } = inp;
  const out = [];
  const instOf = code => (inst && inst[code] ? inst[code][0] + inst[code][1] : null);
  for (const [code, x] of mi.rows) {
    if (!isCommonStock(code)) continue;
    const rf = ref.rows.get(code);
    const shares = t187?.rows.get(code)?.shares ?? qfiis?.rows.get(code)?.shares ?? null;
    out.push(mk({
      code, name: x.name, market: '上市', close: x.close, high: x.high, low: x.low, val: x.val,
      ref: rf?.ref ?? null, refSrc: rf?.ref != null ? 'twt84u' : null, limitUp: rf?.limitUp ?? null, limitDown: rf?.limitDown ?? null,
      prev: rf?.prevClose > 0 ? rf.prevClose : null, shares, inst: instOf(code),
    }));
  }
  for (const [code, x] of tpex.rows) {
    if (!isCommonStock(code)) continue;
    const pv = tpexPrev?.rows.get(code);
    const { ref: rf, src } = tpexRef(x, pv);
    out.push(mk({
      code, name: x.name, market: '上櫃', close: x.close, high: x.high, low: x.low, val: x.val,
      ref: rf, refSrc: src, limitUp: pv?.nextLimitUp ?? null, limitDown: pv?.nextLimitDown ?? null,
      prev: pv?.close > 0 ? pv.close : null, shares: x.shares, inst: instOf(code),
    }));
  }
  return out;
}

/** 台股升降單位（SKILL §2.5）。 */
export function tickOf(p) {
  return p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
}
/** 官方漲跌停價缺時由參考價推（與 TPEx 官方次日漲跌停價 888 檔逐檔比對 0 不符，分析師實測）。 */
export function limitsFromRef(ref) {
  if (!(ref > 0)) return { up: null, down: null };
  const u = ref * 1.1, d = ref * 0.9;
  const up = Math.floor(u / tickOf(u) + 1e-9) * tickOf(u);
  const down = Math.ceil(d / tickOf(d) - 1e-9) * tickOf(d);
  return { up: +up.toFixed(2), down: +down.toFixed(2) };
}

function mk(x0) {
  const lim = limitsFromRef(x0.ref);
  const x = { ...x0, limitUp: x0.limitUp ?? lim.up, limitDown: x0.limitDown ?? lim.down };
  const traded = x.close != null && x.close > 0;
  const ret = traded && x.ref > 0 ? (x.close / x.ref - 1) * 100 : null;
  const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-6;
  const lu = traded && x.limitUp != null && x.close >= x.limitUp - 1e-6;
  const ld = traded && x.limitDown != null && x.limitDown > 0 && x.close <= x.limitDown + 1e-6;
  return {
    ...x, traded, ret, unlimited: ret != null && Math.abs(ret) > UNLIMITED,
    lu, ld, lockU: lu && eq(x.high, x.low) && eq(x.high, x.close),
    exDiv: x.prev != null && x.ref != null && Math.abs(x.ref - x.prev) > 1e-6,
    cap: x.shares > 0 && traded ? x.shares * x.close : null,
  };
}

const inUniverse = s => s.ret != null && !s.unlimited;

function marketStats(univ) {
  const rets = univ.map(s => s.ret);
  const withCap = univ.filter(s => s.cap != null);
  const cap = sum(withCap.map(s => s.cap));
  const val = sum(univ.map(s => s.val || 0));
  return {
    n: univ.length, ew: mean(rets), sigma: std(rets), cap, val,
    capW: cap ? sum(withCap.map(s => s.cap * s.ret)) / cap : null,
    valW: val ? sum(univ.map(s => (s.val || 0) * s.ret)) / val : null,
  };
}

/** 成分股明細（頁面收合區用）：代號、名稱、報酬、成交值、旗標、共振標籤；依報酬由高到低。 */
const memberRow = (s, lab) => ({
  code: s.code, name: s.name, ret: r(s.ret), valM: s.val != null ? Math.round(s.val / 1e6) : null, flags: flagsOf(s), resonance: lab?.get(s.code) ?? null,
});
const membersOut = (arr, lab) => [...arr].sort((a, b) => b.ret - a.ret || (a.code < b.code ? -1 : 1)).map(s => memberRow(s, lab));

const asMember = s => ({ code: s.code, ret: s.ret, val: s.val, cap: s.cap, lu: s.lu, ld: s.ld, lockU: s.lockU, inst: s.inst, close: s.close });

/** wiki 連動層的分組鍵（段只收有位置的 上游/中游/下游）。 */
function wikiKeys(w) {
  if (!w) return { seg: [], chain: [], group: [], fam: [] };
  const chain = [...new Set(w.chains.map(c => c.name).filter(Boolean))];
  const seg = [...new Set(w.chains.filter(c => ['上游', '中游', '下游'].includes(c.role)).map(c => `${c.name}｜${c.role}${c.label ? '·' + c.label : ''}`))];
  return { seg, chain, group: w.group ? [w.group] : [], fam: w.families || [] };
}

function bucket(map, key, item) { (map.get(key) || map.set(key, []).get(key)).push(item); }

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function layerOut(map, tier, minN, mkt, lab) {
  return [...map.entries()].filter(([, v]) => v.length >= minN).map(([key, v]) => {
    const g = groupStats(v.map(asMember), mkt);
    return {
      key, tier, n: g.n, lowN: g.n < MIN_SHOW, ew: r(g.ew), exMkt: r(g.exMkt), med: r(g.med), z: r(g.z, 1),
      up: g.up, dn: g.dn, luN: g.luN, capContribPp: r(g.capContribPp, 3),
      members: membersOut(v, lab).slice(0, 60),
    };
  }).sort((a, b) => b.exMkt - a.exMkt || byKey(a, b));
}

/** 族群共振／個股獨行（SKILL §5.2）：A 緊密共振／B 產業共振／C 真獨行／D 無緊密群連結。 */
function resonanceLabels(univ, wiki, mkt) {
  const sums = new Map();
  const add = (k, v) => { const s = sums.get(k) || sums.set(k, { s: 0, n: 0 }).get(k); s.s += v; s.n++; };
  const keysOf = new Map();
  for (const s of univ) {
    const w = wiki?.stocks.get(s.code);
    const wk = wikiKeys(w);
    const keys = [...wk.seg.map(k => `s:${k}`), ...wk.chain.map(k => `c:${k}`), ...wk.group.map(k => `g:${k}`), ...wk.fam.map(k => `f:${k}`)];
    const ik = w?.industry ? `i:${indName(w.industry)}` : null;
    keysOf.set(s.code, { tight: keys, ind: ik });
    const ex = s.ret - mkt.ew;
    for (const k of keys) add(k, ex);
    if (ik) add(ik, ex);
  }
  const out = new Map();
  for (const s of univ) {
    const ex = s.ret - mkt.ew;
    const { tight, ind } = keysOf.get(s.code);
    const test = k => {
      const a = sums.get(k);
      const nb = a.n - 1;
      if (nb < NB_MIN) return null;
      const m = (a.s - ex) / nb;
      const z = m / (mkt.sigma / Math.sqrt(nb));
      return { m, z, hit: Math.sign(m) === Math.sign(ex) && Math.abs(z) >= NB_Z && Math.abs(m) >= NB_EFFECT };
    };
    const t = tight.map(test).filter(Boolean);
    const i = ind ? test(ind) : null;
    out.set(s.code, t.some(x => x.hit) ? 'A' : i?.hit ? 'B' : t.length ? 'C' : 'D');
  }
  return out;
}

const LABEL_NAME = { A: '族群共振', B: '產業共振', C: '個股獨行', D: '無緊密群連結' };

function stockLinks(w) {
  if (!w) return null;
  return {
    chains: w.chains.map(c => ({ name: c.name, role: c.role, label: c.label || null, tier: '站內整理' })),
    group: w.group ? { name: w.group, tier: '站內推導' } : null,
    upstream: w.upstream.length ? { codes: w.upstream, tier: '站內整理' } : null,
    downstream: w.downstream.length ? { codes: w.downstream, tier: '站內整理' } : null,
    families: w.families.length ? { names: w.families.slice(0, 6), tier: 'AI待驗' } : null,
  };
}

function flagsOf(s) {
  return (s.lu ? 1 : 0) | (s.ld ? 2 : 0) | (s.lockU ? 4 : 0) | (s.exDiv ? 32 : 0) | (s.unlimited ? 64 : 0);
}

/** 預告表的現金股利／配股率要「自我驗證」才採用：(前收−現金)/(1+配股率) 必須對上官方參考價（±1 檔升降單位）。
 *  有現增認購（sub>0）者公式不同，不處理（維持舊口徑）。對不上＝單位或資料有誤，不用。 */
export function verifiedExDiv(plan, pa, ref) {
  if (!plan || !(pa > 0) || !(ref > 0) || plan.sub > 0 || !(plan.c > 0 || plan.g > 0)) return null;
  const pred = (pa - plan.c) / (1 + plan.g);
  return Math.abs(pred - ref) <= tickOf(ref) * 1.01 ? { c: plan.c, g: plan.g } : null;
}

export function computeHeatmap(inp) {
  const { date, wiki } = inp;
  const all = buildStockRows(inp);
  const univ = all.filter(inUniverse);
  const mkt = marketStats(univ);
  const sigma = mkt.sigma;
  const lab = resonanceLabels(univ, wiki, mkt);
  const indOf = code => indName(wiki?.stocks.get(code)?.industry);

  // 官方產業別（核心）
  const indMap = new Map();
  let noIndustry = 0;
  for (const s of univ) { const k = indOf(s.code); if (k) bucket(indMap, k, s); else noIndustry++; }
  const inds = [...indMap.entries()].map(([key, v]) => ({ key, g: groupStats(v.map(asMember), mkt), members: v }));
  const listable = inds.filter(x => x.g.n >= MIN_LIST);
  const zE = zscores(listable.map(x => x.g.exMkt)), zL = zscores(listable.map(x => x.g.luRatio));
  const heat = new Map(listable.map((x, i) => [x.key, 0.5 * zE[i] + 0.5 * zL[i]]));
  const heatSorted = [...heat.values()].sort((a, b) => a - b);
  const pct = h => r(heatSorted.filter(x => x <= h).length / heatSorted.length * 100, 0);
  const industries = inds.filter(x => x.g.n >= MIN_SHOW).map(({ key, g, members }) => ({
    ...roundGroup(g, { key, tier: '官方' }),
    members: membersOut(members, null), // 核心不含共振標籤（共振依 wiki 連動層，不得影響核心數字）
    ok: true, listable: g.n >= MIN_LIST,
    heat: heat.has(key) ? r(heat.get(key), 2) : null, heatPct: heat.has(key) ? pct(heat.get(key)) : null,
  })).sort((a, b) => (b.heat ?? -99) - (a.heat ?? -99) || byKey(a, b));

  // wiki 連動層
  const L = { seg: new Map(), chain: new Map(), group: new Map(), fam: new Map() };
  for (const s of univ) {
    const wk = wikiKeys(wiki?.stocks.get(s.code));
    for (const t of Object.keys(L)) for (const k of wk[t]) bucket(L[t], k, s);
  }
  const layers = {
    chains: layerOut(L.chain, '站內整理', 3, mkt, lab), segments: layerOut(L.seg, '站內整理', 3, mkt, lab),
    groups: layerOut(L.group, '站內推導', 3, mkt, lab), families: layerOut(L.fam, 'AI待驗', 5, mkt, lab),
  };

  // 指數貢獻（上市）
  const tseRows = all.filter(s => s.market === '上市').map(s => {
    const ld = inp.t187?.rows.get(s.code)?.listDate;
    const d = ld ? inp.tradingDates.filter(x => x > ld && x <= date).length : null;
    const prevClose = s.prev ?? (inp.miPrev?.rows.get(s.code)?.close > 0 ? inp.miPrev.rows.get(s.code).close : null);
    const t187s = inp.t187?.rows.get(s.code)?.shares;
    return {
      code: s.code, name: s.name, close: s.close, pa: prevClose, ref: s.ref, shares: s.shares,
      sharesSrc: t187s != null ? 't187' : s.shares != null ? 'qfiis' : null, listDays: d,
      exDivSplit: verifiedExDiv(inp.exDivPlan?.get(s.code), prevClose, s.ref),
    };
  });
  const idx = inp.mi.index && inp.mi.index.close != null && inp.mi.index.change != null
    ? computeIndexContribution({ rows: tseRows, index: inp.mi.index, inst: inp.inst }) : null;
  const sharesDisagree = [];
  if (inp.t187 && inp.qfiis) {
    for (const [code, a] of inp.t187.rows) {
      const b = inp.qfiis.rows.get(code)?.shares;
      if (isCommonStock(code) && a.shares > 0 && b > 0 && Math.abs(a.shares / b - 1) > 0.01) sharesDisagree.push({ code, t187: a.shares, qfiis: b });
    }
    sharesDisagree.sort((x, y) => (x.code < y.code ? -1 : 1));
  }

  // 廣度與背離
  const tseU = univ.filter(s => s.market === '上市');
  const ownUp = tseU.filter(s => s.ret > 0).length, ownDn = tseU.filter(s => s.ret < 0).length;
  const off = inp.mi.breadth;
  const up = off?.up?.n ?? ownUp, dn = off?.down?.n ?? ownDn;
  const idxRet = idx ? inp.mi.index.change / idx.prevIndex * 100 : null;
  const tseEw = mean(tseU.map(s => s.ret));
  const breadth = {
    source: off ? '官方漲跌證券數合計(股票欄)' : '自算',
    up, dn, flat: off?.flat?.n ?? null, upLimit: off?.up?.limit ?? null, dnLimit: off?.down?.limit ?? null,
    adr: up + dn ? r(up / (up + dn), 3) : null, net: up - dn,
    indexRetPct: r(idxRet, 3), tseEwPct: r(tseEw, 3), gapPp: idxRet != null && tseEw != null ? r(idxRet - tseEw, 2) : null,
  };

  // 個股榜
  const memberCnt = new Map(inds.map(x => [x.key, x.g.n]));
  const brief = s => {
    const w = wiki?.stocks.get(s.code);
    const ik = indOf(s.code);
    const n = memberCnt.get(ik) || 0;
    return {
      code: s.code, name: s.name, market: s.market, industry: ik, ret: r(s.ret), exMkt: r(s.ret - mkt.ew),
      valM: s.val != null ? Math.round(s.val / 1e6) : null, flags: flagsOf(s),
      resonance: lab.get(s.code), resonanceName: LABEL_NAME[lab.get(s.code)],
      contribEWPp: n ? r(s.ret / n, 3) : null, links: stockLinks(w),
    };
  };
  const liquid = univ.filter(s => (s.val || 0) >= MIN_VAL_BOARD);
  const desc = (a, f) => [...a].sort((x, y) => f(y) - f(x) || (x.code < y.code ? -1 : 1));
  const board = {
    gainers: desc(liquid, s => s.ret).slice(0, 60).map(brief),
    losers: desc(liquid, s => -s.ret).slice(0, 60).map(brief),
    byValue: desc(univ, s => s.val || 0).slice(0, 60).map(brief),
    contribCap: [...desc(univ.filter(s => s.cap), s => s.cap * s.ret).slice(0, 15), ...desc(univ.filter(s => s.cap), s => -s.cap * s.ret).slice(0, 15)]
      .map(s => ({ ...brief(s), contribCapPp: r(s.cap * s.ret / mkt.cap, 3) })),
  };

  // 下一交易日觀察清單（只描述；usedForScoring 恆為 false）
  const top5 = industries.filter(x => x.listable).slice(0, 5)
    .filter(x => x.exMkt >= 1.0 && x.z >= 2)
    .map(x => watchItem('continue', 'group', x.key, `heat 前5 且 exMkt≥+1.0pp 且 z≥2`, { heat: x.heat, exMkt: x.exMkt, z: x.z, n: x.n, luRatio: x.luRatio },
      { level: '實測（隔日群超額正向慣性，等權毛額、未扣成本）', caveat: '約 40% 來自今日已漲停連板（買不到）；非個股動能' },
      {
        reason: `${x.key}今日等權 ${sgn(x.ew)}%，高出大盤 ${sgn(x.exMkt)}pp；${x.n} 檔中 ${Math.round((x.upRatio ?? 0) * 100)}% 上漲、漲停 ${x.luN} 檔${x.shape ? `，型態「${x.shape}」` : ''}。熱度居前 5 且統計上明顯強於大盤，列為次日持續觀察的族群。`,
      }));
  const catchup = [];
  const risk = [];
  for (const s of liquid) {
    if (s.lu || s.ld) continue;
    const ex = s.ret - mkt.ew;
    const nb = neighborLeadGap(s, wiki, univ, mkt);
    if (nb && nb.mean >= 3 && ex <= 0.3) catchup.push(watchItem('catchup', 'stock', s.code, '同族(段/鏈/產品族)鄰居 LOO 超額≥+3pp 且自己≤+0.3pp、非漲跌停、成交≥1億', { nbMeanPp: r(nb.mean), exMktPp: r(ex), via: nb.via, n: nb.n },
      { level: '先驗·未驗證', caveat: '2022–2023 年無效果、含 wiki 前視偏誤；AI 待驗層來源已標' },
      {
        name: s.name, ret: r(s.ret),
        reason: `${s.name}今日 ${sgn(s.ret)}%（${sgn(ex)}pp，相對大盤持平或偏弱），但${viaText(nb.via)}的 ${nb.n} 檔同伴平均高出大盤 ${sgn(nb.mean)}pp，本檔尚未跟上同族走勢；成交值 ≥1 億、未漲跌停，列為次日觀察是否補上。`,
      }));
    if (ex >= 4 && lab.get(s.code) !== 'A') risk.push(watchItem('risk', 'stock', s.code, '超額≥+4pp、非漲停、非族群共振(B/C/D)', { exMktPp: r(ex), resonance: lab.get(s.code) },
      { level: '實測（歷史多數日隔日超額 −0.1～−0.3pp，個別日變異遠大於此）', caveat: '2022–2026 逐年皆負但幅度小；描述統計非訊號' },
      {
        name: s.name, ret: r(s.ret),
        reason: `${s.name}今日 ${sgn(s.ret)}%（高出大盤 ${sgn(ex)}pp、未漲停），${RES_WHY[lab.get(s.code)] ?? '與所屬族群未同步'}，屬個股獨行的大漲；歷史上這類個股隔日多半小幅回吐（平均約 0.1～0.3pp，個別日差異很大），列為次日留意追價風險。`,
      }));
  }
  const cap = (a, f, n) => desc(a, f).slice(0, n);
  const watch = {
    continue: top5,
    catchup: cap(catchup, w => w.trigger.values.nbMeanPp, 30),
    risk: cap(risk, w => w.trigger.values.exMktPp, 30),
  };

  const idxOut = idx ? (({ contribByCode, ...rest }) => rest)(idx) : null;
  return {
    schema: SCHEMA_VERSION, dataDate: date, useRules: USE_RULES,
    market: {
      n: mkt.n, tse: tseU.length, otc: univ.length - tseU.length, ew: r(mkt.ew), capW: r(mkt.capW), valW: r(mkt.valW),
      valWNote: '成交值加權有同期偏誤（當日上漲股成交值被灌大），僅診斷、不排名',
      sigma: r(sigma), up: univ.filter(s => s.ret > 0).length, dn: univ.filter(s => s.ret < 0).length,
      flat: univ.filter(s => s.ret === 0).length, luN: univ.filter(s => s.lu).length, ldN: univ.filter(s => s.ld).length,
      lockU: univ.filter(s => s.lockU).length, lockD: univ.filter(s => s.ld && s.high === s.low && s.high === s.close).length,
      valTotalM: Math.round(mkt.val / 1e6),
    },
    universe: {
      total: all.length, traded: all.filter(s => s.traded).length, used: univ.length, noIndustry,
      noTrade: all.filter(s => !s.traded).length, noRef: all.filter(s => s.traded && s.ref == null).length,
      unlimited: all.filter(s => s.unlimited).map(s => ({ code: s.code, ret: r(s.ret) })).sort((a, b) => (a.code < b.code ? -1 : 1)),
      refDisagree: all.filter(s => s.market === '上櫃' && s.refSrc === 'close-chg' && inp.tpexPrev?.rows.get(s.code)?.nextRef > 0
        && Math.abs(inp.tpexPrev.rows.get(s.code).nextRef - s.ref) > 0.005).length,
    },
    industries, index: idxOut, breadth, sharesDisagree, layers, board, watch,
    stocks: univ.map(s => [s.code, r(s.ret), s.val != null ? Math.round(s.val / 1e6) : null, flagsOf(s), lab.get(s.code), indOf(s.code)])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  };
}

const sgn = x => (x == null ? '—' : `${x > 0 ? '+' : ''}${(+x).toFixed(2)}`);
const RES_WHY = { B: '只有產業層同向、緊密族群沒有跟著漲', C: '有緊密族群連結但同族同伴沒有同向上漲', D: '查不到緊密的族群連結（wiki 無連結不等於沒有關聯）' };
const VIA_LABEL = { chain: '主題鏈', seg: '鏈內段', fam: '產品族（AI待驗）' };
/** via 形如 'chain:矽晶圓'／'fam:晶圓代工（AI待驗）' → 「主題鏈「矽晶圓」」。 */
function viaText(via) {
  const i = String(via).indexOf(':');
  const t = via.slice(0, i), k = via.slice(i + 1).replace('（AI待驗）', '');
  return `${VIA_LABEL[t] ?? '族群'}「${k}」`;
}

function watchItem(list, kind, key, rule, values, evidence, extra = {}) {
  return { list, kind, key, ...extra, trigger: { rule, values }, evidence, usedForScoring: false };
}

/** 同族(段/鏈/產品族)鄰居 LOO 超額均值（≥3 檔鄰居才算）；取最強者。 */
function neighborLeadGap(s, wiki, univ, mkt) {
  const w = wiki?.stocks.get(s.code);
  if (!w) return null;
  const wk = wikiKeys(w);
  let best = null;
  for (const [t, keys] of [['seg', wk.seg], ['chain', wk.chain], ['fam', wk.fam]]) {
    for (const k of keys) {
      const m = wikiMembers(wiki, univ, t, k).filter(x => x.code !== s.code);
      if (m.length < NB_MIN) continue;
      const mean_ = mean(m.map(x => x.ret - mkt.ew));
      if (!best || mean_ > best.mean) best = { mean: mean_, via: `${t}:${k}${t === 'fam' ? '（AI待驗）' : ''}`, n: m.length };
    }
  }
  return best;
}

const memberCache = new WeakMap();
function wikiMembers(wiki, univ, t, k) {
  let c = memberCache.get(univ);
  if (!c) {
    c = new Map();
    for (const s of univ) {
      const wk = wikiKeys(wiki?.stocks.get(s.code));
      for (const tt of ['seg', 'chain', 'fam']) for (const kk of wk[tt]) bucket(c, `${tt}\u0000${kk}`, s);
    }
    memberCache.set(univ, c);
  }
  return c.get(`${t}\u0000${k}`) || [];
}
