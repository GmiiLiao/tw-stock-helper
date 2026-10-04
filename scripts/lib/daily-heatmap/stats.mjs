// 熱力的純統計：群統計、熱度（描述性 z 組合）、取整。全部純函式、無 IO。
//   報酬單位一律是「%」（3.99＝漲 3.99%），超額單位 pp。

/** 取整到 d 位；null/NaN 保持 null（缺值＝來源未提供，不補 0）。 */
export const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

export const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export const sum = a => a.reduce((s, x) => s + x, 0);

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 截尾均值：兩端各去 p（0.1＝10%）。成員少於 5 檔不截。 */
export function trimmedMean(a, p = 0.1) {
  if (a.length < 5) return mean(a);
  const s = [...a].sort((x, y) => x - y);
  const k = Math.floor(s.length * p);
  return mean(s.slice(k, s.length - k));
}

export function std(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1));
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 橫斷面標準化（截尾 ±3）；標準差為 0 時全部 0。 */
export function zscores(values) {
  const m = mean(values), s = std(values);
  return values.map(v => (s ? clamp((v - m) / s, -3, 3) : 0));
}

/** 最小成員數門檻（SKILL §3.2：隨機群 EW 標準差在 n=5 約 1.15pp、n=8 約 0.9pp） */
export const MIN_SHOW = 5;
export const MIN_LIST = 8;

/**
 * 群統計。members＝已通過宇宙篩選（有報酬、非 unlimited）的個股列：
 *   { code, ret(%), val(元), cap(元|null), lu, ld, lockU, inst(張|null) }
 * mkt＝{ ew, sigma, cap(全市場市值), val(全市場成交值) }
 */
export function groupStats(members, mkt) {
  const n = members.length;
  const rets = members.map(m => m.ret);
  const ew = mean(rets);
  const sorted = [...members].sort((a, b) => b.ret - a.ret);
  const pos = rets.filter(x => x > 0);
  const posSum = sum(pos);
  const top3 = sorted.slice(0, 3);
  const top3Sum = sum(top3.filter(m => m.ret > 0).map(m => m.ret));
  const exTop3 = n > 3 ? mean(sorted.slice(3).map(m => m.ret)) : null;
  const ex1 = n > 1 ? mean(sorted.slice(1).map(m => m.ret)) : null;
  const up = members.filter(m => m.ret > 0).length;
  const dn = members.filter(m => m.ret < 0).length;
  const luN = members.filter(m => m.lu).length;
  const withCap = members.filter(m => m.cap != null);
  const capSum = sum(withCap.map(m => m.cap));
  const valSum = sum(members.map(m => m.val || 0));
  const instRows = members.filter(m => m.inst != null);
  const exMkt = ew - mkt.ew;
  const top3Share = posSum > 0 ? top3Sum / posSum : null;
  let shape = null;
  if (ew > 0 && n >= MIN_SHOW) {
    const upRatio = dn + up ? up / (up + dn) : 0;
    if (upRatio >= 0.65 && exTop3 != null && exTop3 >= 0.6 * ew) shape = '普遍型';
    else if ((top3Share != null && top3Share >= 0.45) || (exTop3 != null && exTop3 < 0.5 * ew)) shape = '少數帶動型';
    else shape = '一般';
  }
  return {
    n,
    ew, exMkt, med: median(rets), trim10: trimmedMean(rets, 0.1),
    z: mkt.sigma ? exMkt / (mkt.sigma / Math.sqrt(n)) : null,
    up, dn, upRatio: up + dn ? up / (up + dn) : null,
    luN, ldN: members.filter(m => m.ld).length, lockU: members.filter(m => m.lockU).length,
    luRatio: n ? luN / n : null,
    capW: capSum ? sum(withCap.map(m => m.cap * m.ret)) / capSum : null,
    capShare: mkt.cap ? capSum / mkt.cap : null,
    capContribPp: mkt.cap ? sum(withCap.map(m => m.cap * m.ret)) / mkt.cap : null,
    valW: valSum ? sum(members.map(m => (m.val || 0) * m.ret)) / valSum : null,
    valShare: mkt.val ? valSum / mkt.val : null,
    netInstNtd: instRows.length ? sum(instRows.map(m => m.inst * 1000 * m.close)) : null,
    instCover: n ? instRows.length / n : null,
    top3Share, exTop3, shape,
    singleStockDriven: ew > 0 && ex1 != null ? ex1 < 0.5 * ew : false,
  };
}

/** 取整輸出（欄位固定、順序固定，確保重跑逐位元組相同）。 */
export function roundGroup(g, extra = {}) {
  return {
    ...extra,
    n: g.n,
    ew: r(g.ew), exMkt: r(g.exMkt), med: r(g.med), trim10: r(g.trim10), z: r(g.z, 1),
    up: g.up, dn: g.dn, upRatio: r(g.upRatio, 3),
    luN: g.luN, ldN: g.ldN, lockU: g.lockU, luRatio: r(g.luRatio, 3),
    capW: r(g.capW), capShare: r(g.capShare, 4), capContribPp: r(g.capContribPp, 3),
    valW: r(g.valW), valShare: r(g.valShare, 4),
    netInstNtd: g.netInstNtd == null ? null : Math.round(g.netInstNtd), instCover: r(g.instCover, 2),
    top3Share: r(g.top3Share, 3), exTop3: r(g.exTop3), shape: g.shape, singleStockDriven: g.singleStockDriven,
  };
}
