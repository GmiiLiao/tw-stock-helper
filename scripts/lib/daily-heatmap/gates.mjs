// 定版閘門（SKILL §6）：看資料不看時鐘。硬閘門任一不過 ⇒ 不定版（寧缺勿空）；軟警告只記 degraded。
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

export const HARD_BP = 50;
export const SOFT_BP = 5;
export const MIN_TSE = 900;
export const MIN_OTC = 700;
export const COVERAGE_VS_MEDIAN = 0.97;

/**
 * @param {object} p
 *   date、datasets：{mi,ref,qfiis,tpex}→{final,echo}|null、parsed：{mi,ref,qfiis,tpex}、
 *   result：computeHeatmap 結果、prevCounts：前 20 個交易日 {tse:[],otc:[]}（可空）
 * @returns {{pass:boolean, hard:string[], soft:string[], coverage:object}}
 */
export function evaluateGates({ date, datasets, parsed, result, prevCounts = { tse: [], otc: [] }, hasWiki }) {
  const hard = [], soft = [];
  for (const k of ['mi', 'ref', 'qfiis', 'tpex']) {
    const d = datasets[k];
    if (!d) { hard.push(`缺輸入：${k}`); continue; }
    if (!d.final) hard.push(`${k} 鏡像未 final`);
    if (d.echo !== date) hard.push(`${k} 回聲日 ${d.echo} ≠ ${date}`);
  }
  // 鏡像只驗頂層 date，title 的民國日期要自己再驗
  const titles = { mi: parsed.mi?.titleDay, ref: parsed.ref?.titleDay, qfiis: parsed.qfiis?.titleDay, tpex: parsed.tpex?.titleDay };
  for (const [k, v] of Object.entries(titles)) if (parsed[k] && v !== date) hard.push(`${k} 表內日期 ${v} ≠ ${date}`);

  const u = result.universe;
  const tse = result.market.tse;
  const otc = result.market.otc;
  const need = (arr, floor) => Math.max(floor, Math.floor(COVERAGE_VS_MEDIAN * median(arr)));
  const needTse = need(prevCounts.tse, MIN_TSE), needOtc = need(prevCounts.otc, MIN_OTC);
  if (tse < needTse) hard.push(`上市有效個股 ${tse} < ${needTse}`);
  if (otc < needOtc) hard.push(`上櫃有效個股 ${otc} < ${needOtc}（殘缺宇宙）`);
  if (u.traded && u.noRef / u.traded > 0.005) hard.push(`參考價缺 ${u.noRef}/${u.traded} > 0.5%`);

  const idx = result.index;
  if (!idx) hard.push('官方加權指數或貢獻無法計算');
  else {
    const bp = Math.abs(idx.residualBp);
    if (bp > HARD_BP) hard.push(`指數貢獻殘差 ${idx.residualBp}bp > ${HARD_BP}bp（單位或宇宙錯誤）`);
    else if (bp > SOFT_BP) soft.push(`指數貢獻殘差 ${idx.residualBp}bp > ${SOFT_BP}bp`);
  }
  // 成交值對帳：4 碼上市成交值 ÷ 官方「一般股票」成交金額
  const off = parsed.mi?.officialStockValue;
  let valRatio = null;
  if (off) {
    let s = 0;
    for (const [code, x] of parsed.mi.rows) if (/^[1-9]\d{3}$/.test(code) && !code.startsWith('91')) s += x.val || 0;
    valRatio = s / off;
    if (valRatio < 0.99 || valRatio > 1.02) hard.push(`成交值對帳 ${valRatio.toFixed(4)} 超出 [0.99,1.02]（單位事故）`);
  } else soft.push('官方一般股票成交金額缺，成交值對帳略過');
  if (!hasWiki) soft.push('wiki stocks.json 缺，產業熱力不可用');
  if (result.sharesDisagree.length) soft.push(`發行股數兩來源差 >1%：${result.sharesDisagree.length} 檔（以 t187 優先）`);
  if (result.sharesCorrected?.length) soft.push(`發行股數已校正 ${result.sharesCorrected.length} 檔（分割／減資後 qfiis 仍舊股數）：${result.sharesCorrected.map(x => x.code).join('、')}`);
  if (u.refDisagree) soft.push(`上櫃參考價兩法不一致 ${u.refDisagree} 檔`);
  return {
    pass: hard.length === 0, hard, soft,
    coverage: { tse, otc, noRef: u.noRef, noIndustry: u.noIndustry, valRatio: valRatio == null ? null : +valRatio.toFixed(4), needTse, needOtc },
  };
}
