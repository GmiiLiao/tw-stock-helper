// 權值股對加權指數的貢獻（純函式）。口徑與驗證見 SKILL §4：
//   加權指數＝Σ(收盤價×發行股數)÷除數，價格指數、未做自由流通調整、無權重上限。
//   貢獻點 c_i = 指數前收 × 股數×(收盤−基期) ÷ Σ(股數×基期)；基期＝前一日實際收盤（現金股利不調整），
//   只有「參考價與前收相差 >10%」（分割、減資、大幅除權）才改用官方參考價。
import { r, sum } from './stats.mjs';

export const NEW_LISTING_DAYS = 25; // 經驗值：上市未滿 ~25 個交易日不納入（編製規則原文未驗，SKILL §4.3）
export const REF_JUMP = 0.10;
export const BREADTH_GUARD = 0.003; // |指數漲跌| < 0.3% 不輸出占比（分母太小）

/** 殘差分級（bp，÷前一日官方指數）：綠 ≤1／黃 ≤3／紅 >3（SKILL §4.5） */
export function residualGrade(bp) {
  const a = Math.abs(bp);
  return a <= 1 ? '綠' : a <= 3 ? '黃' : '紅';
}

/**
 * @param {object} p
 *   rows：上市個股列 [{code,name,close,pa(前收|null),ref(null|數),shares(null|數),sharesSrc,listDays(null|數)}]
 *   index：{close, change}（官方）
 *   inst：{code:[外資,投信]}|null
 */
export function computeIndexContribution({ rows, index, inst = null }) {
  const prevIdx = index.close - index.change;
  const included = [];
  const excluded = { noShares: 0, noBase: 0, newListing: 0 };
  for (const x of rows) {
    if (!(x.shares > 0)) { excluded.noShares++; continue; }
    if (x.listDays != null && x.listDays < NEW_LISTING_DAYS) { excluded.newListing++; continue; }
    if (!(x.pa > 0)) { excluded.noBase++; continue; }
    const switched = x.ref > 0 && Math.abs(x.ref / x.pa - 1) > REF_JUMP;
    const base = switched ? x.ref : x.pa;
    // 已驗證的除權息拆分（現金股利 c、配股率 g）：現金股利不調整、配股市值中性
    //   Δ = 股數 × [(收盤−參考價)×(1+g) − c]；除權息日無成交時指數以參考價為收盤
    const split = !switched && x.exDivSplit ? x.exDivSplit : null;
    const close = x.close > 0 ? x.close : split ? x.ref : base; // 其餘無成交＝貢獻 0
    included.push({ ...x, base, close, switched, traded: x.close > 0, split });
  }
  const denom = sum(included.map(x => x.shares * x.base));
  const capClose = sum(included.map(x => x.shares * (1 + (x.split?.g ?? 0)) * x.close));
  if (!denom || !capClose) return null;
  const divisor = denom / prevIdx;

  let exDivPts = 0, exSplitN = 0;
  const list = included.map(x => {
    const pts = x.split
      ? prevIdx * (x.shares * ((x.close - x.ref) * (1 + x.split.g) - x.split.c)) / denom
      : prevIdx * (x.shares * (x.close - x.base)) / denom;
    // 除息機械影響：已拆分者＝−現金股利×股數；未拆分者＝（參考價−前收）×股數（含配股成分，偏高估）
    if (x.split) { exDivPts += -prevIdx * (x.shares * x.split.c) / denom; exSplitN++; }
    else if (!x.switched && x.ref > 0 && x.traded) exDivPts += prevIdx * (x.shares * (x.ref - x.pa)) / denom;
    return {
      code: x.code, name: x.name, close: x.close, base: x.base,
      wPrev: x.shares * x.base / denom, wClose: x.shares * (1 + (x.split?.g ?? 0)) * x.close / capClose,
      ret: (x.close / x.base - 1) * 100, pts, shares: x.shares, sharesSrc: x.sharesSrc, switched: x.switched,
    };
  });
  const predPts = sum(list.map(x => x.pts));
  const residual = predPts - index.change;
  const residualBp = residual / prevIdx * 1e4;
  const exDivBp = Math.abs(exDivPts) / prevIdx * 1e4;

  // 「權值股」＝當日開盤前（前一日收盤）權重排序，才能解釋當日貢獻；收盤後權重另列為隔日基準
  const byWeight = [...list].sort((a, b) => b.wPrev - a.wPrev || a.code.localeCompare(b.code));
  const byNext = [...list].sort((a, b) => b.wClose - a.wClose || a.code.localeCompare(b.code));
  const guardOk = Math.abs(index.change / prevIdx) >= BREADTH_GUARD;
  const splitN = n => {
    const top = byWeight.slice(0, n);
    const pts = sum(top.map(x => x.pts));
    return {
      n, weight: r(sum(top.map(x => x.wPrev)) * 100, 2), pts: r(pts, 1), restPts: r(predPts - pts, 1),
      shareOfChange: guardOk ? r(pts / index.change * 100, 1) : null,
    };
  };
  const instOf = codes => {
    if (!inst) return null;
    let s = 0, k = 0;
    for (const x of codes) { const v = inst[x.code]; if (v) { s += (v[0] + v[1]) * 1000 * x.close; k++; } }
    return k ? Math.round(s) : null;
  };
  const top10 = byWeight.slice(0, 10);
  const absSum = sum(list.map(x => Math.abs(x.pts)));
  const fmt = x => ({
    code: x.code, name: x.name, close: x.close, wPrev: r(x.wPrev * 100, 2), wClose: r(x.wClose * 100, 2),
    ret: r(x.ret), pts: r(x.pts, 1), sens1pctPts: r(x.wClose * index.close * 0.01, 1),
    ...(x.switched ? { baseNote: '以官方參考價為基期（分割/減資/大幅除權）' } : {}),
  });
  const byPts = [...list].sort((a, b) => b.pts - a.pts || a.code.localeCompare(b.code));
  return {
    prevIndex: r(prevIdx, 2), divisor: r(divisor, 0), predPts: r(predPts, 2), officialPts: r(index.change, 2),
    residualPts: r(residual, 2), residualBp: r(residualBp, 2), grade: residualGrade(residualBp),
    exDivMechanicalPts: r(exDivPts, 1), exDivBp: r(exDivBp, 2), exDivFlag: exDivBp > 1, exDivSplitN: exSplitN,
    included: included.length, excluded,
    top: byWeight.slice(0, 20).map(fmt),
    splits: [5, 10, 20, 50].map(splitN),
    contributors: byPts.slice(0, 10).map(fmt),
    draggers: byPts.slice(-10).reverse().map(fmt),
    conc10: absSum ? r(sum(top10.map(x => Math.abs(x.pts))) / absSum * 100, 1) : null,
    w1: r(byWeight[0].wPrev * 100, 2), w10: r(sum(top10.map(x => x.wPrev)) * 100, 2),
    nextBasis: byNext.slice(0, 10).map(fmt),
    instTop10Ntd: instOf(top10), instRestNtd: instOf(byWeight.slice(10)),
    contribByCode: new Map(list.map(x => [x.code, x])),
  };
}
