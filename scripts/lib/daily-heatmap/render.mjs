// 給人看的 Markdown 報告（純函式）。只描述資料日收盤事實，不寫預測語氣；每段標等級與限制。
const sg = x => (x == null ? '—' : (x > 0 ? '+' : '') + x);
const pct = x => (x == null ? '—' : `${sg(x)}%`);
const n0 = x => (x == null ? '—' : Math.round(x).toLocaleString('en-US'));
const ntd = x => (x == null ? '—（來源未提供）' : `${sg(+(x / 1e8).toFixed(1))} 億（估）`);

export function renderMarkdown(p, meta = {}) {
  const L = [];
  const m = p.market, ix = p.index, b = p.breadth;
  L.push(`# 台股每日熱力分析｜資料日 ${p.dataDate}`, '');
  L.push(`> 描述 ${p.dataDate} 收盤事實，**非投資建議**，不預測之後走勢；熱度是當日統計量，不是動能或買賣訊號。比對未扣成本。`);
  if (meta.degraded?.length) L.push(`> ⚠ 降級／警告：${meta.degraded.join('；')}`);
  L.push('', '## 1. 一頁摘要', '');
  L.push(`- 兩市有效個股 ${m.n}（上市 ${m.tse}／上櫃 ${m.otc}）；等權 ${pct(m.ew)}、市值加權 ${pct(m.capW)}；上漲 ${m.up}／下跌 ${m.dn}／平盤 ${m.flat}；漲停 ${m.luN}（鎖死 ${m.lockU}）／跌停 ${m.ldN}。`);
  if (ix) L.push(`- 加權指數 ${sg(ix.officialPts)} 點（${pct(b.indexRetPct)}）；權重貢獻重建 ${sg(ix.predPts)} 點，殘差 ${sg(ix.residualPts)} 點（${ix.residualBp}bp，**${ix.grade}**）。`);
  const hot = p.industries.filter(x => x.listable).slice(0, 5).map(x => `${x.key} ${pct(x.ew)}`).join('、');
  const cold = p.industries.filter(x => x.listable).slice(-5).reverse().map(x => `${x.key} ${pct(x.ew)}`).join('、');
  L.push(`- 熱度前 5 產業：${hot || '—'}；後 5：${cold || '—'}（官方產業別、n≥8、等權）。`);
  if (ix) {
    const t10 = ix.splits.find(s => s.n === 10);
    L.push(`- 前 10 大權值股（前一日權重）${t10.weight}%（台積電 ${ix.w1}%），合計貢獻 ${sg(t10.pts)} 點，其餘 ${sg(t10.restPts)} 點。`);
  }

  if (ix) {
    L.push('', '## 2. 權值股對大盤的漲跌貢獻（上市，自算：收盤×發行股數）', '');
    L.push(`> 官方沒有逐檔權重，權重由「收盤價×發行股數」自算，不新增網域。價格指數不調整現金股利，貢獻以前一日實際收盤為基期。`);
    L.push(`> 前一日指數 ${ix.prevIndex}；殘差等級 ${ix.grade}${ix.exDivFlag ? `；⚠ 除權息機械影響 ${sg(ix.exDivMechanicalPts)} 點（${ix.exDivBp}bp），指數下跌不等於賣壓` : ''}。納入 ${ix.included} 檔，排除：無股數 ${ix.excluded.noShares}／無基期 ${ix.excluded.noBase}／新上市 ${ix.excluded.newListing}。`);
    if (ix.grade === '紅') L.push('> ⛔ 殘差等級為紅：歸因不可靠，以下占比與拆解僅供對照，不作結論。');
    L.push('', '| # | 代號 | 名稱 | 前日權重%（排序依據） | 收盤後權重% | 漲跌% | 貢獻(點) | 隔日 1% 敏感度(點) |', '|---|---|---|---|---|---|---|---|');
    ix.top.slice(0, 10).forEach((x, i) => L.push(`| ${i + 1} | ${x.code} | ${x.name} | ${x.wPrev} | ${x.wClose} | ${pct(x.ret)} | ${sg(x.pts)} | ${x.sens1pctPts} |`));
    L.push('', '| 前 N 大 | 權重% | 貢獻(點) | 其餘(點) | 占指數漲跌 |', '|---|---|---|---|---|');
    for (const s of ix.splits) L.push(`| ${s.n} | ${s.weight} | ${sg(s.pts)} | ${sg(s.restPts)} | ${s.shareOfChange == null ? '（|漲跌|<0.3% 不輸出）' : s.shareOfChange + '%'} |`);
    L.push('', `隔日權重基準（收盤後權重，前 10）：${ix.nextBasis.map(x => `${x.name} ${x.wClose}%`).join('、')}（算術，不是預測）`);
    L.push('', `拉抬最多：${ix.contributors.slice(0, 5).map(x => `${x.name} ${sg(x.pts)}`).join('、')}`, `拖累最多：${ix.draggers.slice(0, 5).map(x => `${x.name} ${sg(x.pts)}`).join('、')}`);
    L.push('', `廣度：上漲 ${b.up}／下跌 ${b.dn}（adr ${b.adr}，net ${b.net}）；指數 ${pct(b.indexRetPct)} 對上市等權 ${pct(b.tseEwPct)}，差 ${sg(b.gapPp)}pp（>0＝權值較強）；前 10 大貢獻集中度 ${ix.conc10}%。`);
    L.push(`法人（外資＋投信，張×收盤，估）：前 10 大 ${ntd(ix.instTop10Ntd)}、其餘 ${ntd(ix.instRestNtd)}。`);
  }

  L.push('', '## 3. 產業熱力（官方產業別）', '', '| 產業 | n | 等權% | 超額pp | 中位% | z | 上漲比 | 漲停 | 市值權% | 形態 | heat |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of p.industries) L.push(`| ${x.key}${x.listable ? '' : '（n<8 不排名）'} | ${x.n} | ${sg(x.ew)} | ${sg(x.exMkt)} | ${sg(x.med)} | ${x.z ?? '—'} | ${x.upRatio ?? '—'} | ${x.luN} | ${sg(x.capW)} | ${x.shape ?? '—'}${x.singleStockDriven ? '・單檔帶動' : ''} | ${x.heat ?? '—'} |`);
  L.push('', '> heat＝0.5·Z(超額等權)＋0.5·Z(漲停占比)，僅 n≥8 的群橫斷面標準化；其餘欄位只描述。歷史統計約 40% 預測力來自漲停連板（買不到）。');

  const layer = (title, a, tier) => {
    if (!a.length) return;
    L.push('', `## ${title}（${tier}）`, '', '| 名稱 | n | 等權% | 超額pp | z | 漲/跌 | 漲停 |', '|---|---|---|---|---|---|---|');
    for (const x of a.slice(0, 12)) L.push(`| ${x.key}${x.lowN ? '（僅觀察）' : ''} | ${x.n} | ${sg(x.ew)} | ${sg(x.exMkt)} | ${x.z ?? '—'} | ${x.up}/${x.dn} | ${x.luN} |`);
  };
  L.push('', '## 4. wiki 連動層（逐項標等級；n 小一律用 z，不可解讀為「其餘無關」）');
  layer('4.1 主題鏈', p.layers.chains, '站內整理');
  layer('4.2 鏈內段', p.layers.segments, '站內整理');
  layer('4.3 集團', p.layers.groups, '站內推導');
  layer('4.4 產品族', p.layers.families, 'AI待驗・只標註');

  const tbl = (title, a) => {
    L.push('', `### ${title}`, '', '| 代號 | 名稱 | 產業 | 漲跌% | 成交(百萬) | 共振 | wiki 連動 |', '|---|---|---|---|---|---|---|');
    for (const s of a.slice(0, 15)) {
      const k = s.links?.chains?.map(c => c.name).join('/') || '';
      L.push(`| ${s.code} | ${s.name} | ${s.industry ?? '—'} | ${sg(s.ret)} | ${n0(s.valM)} | ${s.resonanceName} | ${k}${s.links?.group ? (k ? '；' : '') + s.links.group.name : ''} |`);
    }
  };
  L.push('', '## 5. 個股榜（成交金額 ≥1 億才上榜漲跌幅榜）');
  tbl('漲幅榜', p.board.gainers); tbl('跌幅榜', p.board.losers); tbl('成交金額榜', p.board.byValue);

  L.push('', '## 6. 下一交易日觀察清單（只描述；`usedForScoring:false`）');
  for (const [k, name] of [['continue', '延續候選（群）'], ['catchup', '落後補漲候選（個股，先驗·未驗證）'], ['risk', '獨行大漲回吐風險（個股）']]) {
    L.push('', `### ${name}`);
    const a = p.watch[k];
    if (!a.length) { L.push('（無符合觸發條件者）'); continue; }
    for (const w of a.slice(0, 15)) L.push(`- **${w.key}**：${w.trigger.rule}｜${JSON.stringify(w.trigger.values)}｜證據：${w.evidence.level}｜${w.evidence.caveat}`);
  }

  L.push('', '## 7. 資料與口徑', '');
  L.push(`- 報酬＝收盤/官方參考價−1（上市 TWT84U、上櫃 close−漲跌或前日次日參考價）；除權息日不是平盤。排除：無成交 ${p.universe.noTrade}、無參考價 ${p.universe.noRef}、|報酬|>10.5% ${p.universe.unlimited.length}（${p.universe.unlimited.map(x => `${x.code} ${pct(x.ret)}`).join('、') || '無'}）。`);
  L.push(`- 處置／注意股旗標：來源未提供（鏡像歷史名單不足），不剔除、不扣分。`);
  L.push(`- 發行股數：上市以 t187ap03_L 為主、MI_QFIIS 備援；兩來源差 >1% 共 ${p.sharesDisagree.length} 檔${p.sharesDisagree.length ? '（' + p.sharesDisagree.slice(0, 8).map(x => x.code).join('、') + '…）' : ''}。`);
  if (p.sharesCorrected?.length) L.push(`- 發行股數校正（歷史日、分割／減資後 MI_QFIIS 仍舊股數）：${p.sharesCorrected.map(x => `${x.code}（${x.from.toLocaleString()}→${x.to.toLocaleString()}，事件日 ${x.eventDay}）`).join('、')}。`);
  if (meta.groupingAsOf) L.push(`- wiki 分組快照：${meta.groupingAsOf}（核心只用官方產業別 industry；站內整理／AI 待驗只標註）。`);
  L.push(`- 使用規範：${p.useRules.forbidden.join('；')}。`, `- ${p.useRules.disclaimer}`);
  return L.join('\n') + '\n';
}
