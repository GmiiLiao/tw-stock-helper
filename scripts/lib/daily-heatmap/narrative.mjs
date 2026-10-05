// ─────────────────────────────────────────────────────────────────────────────
// 盤後分析報告（文字版）：由定版 payload 依模板產生，純函式、零 LLM、零預測。
//   每個數字都來自 payload；方向詞只描述當日事實（強／弱、拖累／拉抬）；「歷史統計」句沿用技能 §3.3／§6 的實測口徑並標「描述」。
//   回傳 [{ key, title, paras: string[], bullets?: string[] }]，供頁面與 markdown 共用。
// ─────────────────────────────────────────────────────────────────────────────
const sg = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${(+x).toFixed(d)}`);
const pct0 = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
const nm = s => `${s.name}（${s.code}）`;

function tone(x, strong = 0.3) { return x > strong ? '偏強' : x < -strong ? '偏弱' : '持平'; }

export function buildReport(p, { dayLabel = '資料日' } = {}) {
  const m = p.market, ix = p.index, b = p.breadth;
  const out = [];

  // 1 盤勢總覽
  const ov = [];
  ov.push(`${dayLabel}（${p.dataDate}）兩市有效個股 ${m.n} 檔（上市 ${m.tse}／上櫃 ${m.otc}）：等權平均 ${sg(m.ew)}%、市值加權 ${sg(m.capW)}%；上漲 ${m.up}／下跌 ${m.dn}／平盤 ${m.flat}，漲停 ${m.luN} 檔（鎖死 ${m.lockU}）、跌停 ${m.ldN} 檔。`);
  if (ix) {
    const close = +(ix.prevIndex + ix.officialPts).toFixed(2);
    ov.push(`加權指數收 ${close.toLocaleString('en-US')} 點（${sg(ix.officialPts)} 點、${sg(b.indexRetPct)}%）；上市等權平均 ${sg(b.tseEwPct)}%，指數與等權相差 ${sg(b.gapPp)}pp，` +
      `${b.gapPp > 0.3 ? '權值股相對較強' : b.gapPp < -0.3 ? '權值股相對落後一般個股' : '權值股與一般個股表現相近'}。` +
      `上市漲／跌家數 ${b.up}／${b.dn}（上漲比 ${b.adr}）。`);
  }
  out.push({ key: 'overview', title: '盤勢總覽', paras: ov });

  // 2 權值股貢獻
  if (ix) {
    const t5 = ix.splits.find(x => x.n === 5), t10 = ix.splits.find(x => x.n === 10);
    const paras = [
      `官方未提供逐檔權重，權重以「收盤價×發行股數」自算。前 10 大權值股（開盤前權重合計 ${ix.w10}%，台積電 ${ix.w1}%）合計貢獻 ${sg(t10.pts, 1)} 點，其餘個股合計 ${sg(t10.restPts, 1)} 點；前 5 大合計 ${sg(t5.pts, 1)} 點。`,
      `${t10.pts < 0 && ix.officialPts > 0 ? '指數上漲主要來自中小型股，權值股合計是拖累。' : t10.pts > 0 && ix.officialPts < 0 ? '指數下跌時權值股合計仍是正貢獻，拖累來自其他個股。' : t10.pts * ix.officialPts > 0 ? '權值股與指數同方向，是當日指數變動的主要來源之一。' : ''}`,
    ].filter(Boolean);
    const bullets = [];
    if (ix.contributors.length) bullets.push(`拉抬最多：${ix.contributors.slice(0, 5).map(x => `${x.name} ${sg(x.pts, 1)} 點`).join('、')}`);
    if (ix.draggers.length) bullets.push(`拖累最多：${ix.draggers.slice(0, 5).map(x => `${x.name} ${sg(x.pts, 1)} 點`).join('、')}`);
    bullets.push(`隔日權重基準（收盤後，算術非預測）：${ix.nextBasis.slice(0, 5).map(x => `${x.name} ${x.wClose}%`).join('、')}`);
    if (ix.exDivFlag) paras.push(`⚠ 當日有除權息機械影響 ${sg(ix.exDivMechanicalPts, 1)} 點（指數不調整現金股利），指數下跌不等於賣壓${ix.exDivSplitN ? `；已拆分現金股利／配股 ${ix.exDivSplitN} 檔` : '；配股部分無法拆分，歸因可能偏負'}。`);
    if (ix.grade === '紅') paras.push('⛔ 殘差等級為紅，以上貢獻歸因不可靠，僅供對照。');
    out.push({ key: 'index', title: '權值股對加權指數的貢獻', paras, bullets });
  }

  // 3 族群熱力
  const ind = p.industries.filter(x => x.listable);
  if (ind.length) {
    const hot = ind.slice(0, 3), cold = [...ind].reverse().slice(0, 3);
    const d = x => `${x.key}（等權 ${sg(x.ew)}%、高出大盤 ${sg(x.exMkt)}pp、上漲比 ${pct0(x.upRatio)}、漲停 ${x.luN} 檔${x.shape ? `、${x.shape}` : ''}）`;
    const paras = [
      `官方產業別中熱度居前：${hot.map(d).join('；')}。`,
      `熱度居後：${cold.map(d).join('；')}。`,
    ];
    const broad = ind.filter(x => x.shape === '普遍型').map(x => x.key);
    const few = ind.filter(x => x.singleStockDriven).map(x => x.key);
    if (broad.length) paras.push(`上漲普遍（多數成員同步上漲）的產業：${broad.join('、')}。`);
    if (few.length) paras.push(`漲幅主要靠單一個股帶動的產業（去掉最強一檔後均值不到一半）：${few.join('、')}。`);
    const ch = (p.layers?.chains ?? []).filter(x => !x.lowN);
    const bullets = [];
    if (ch.length) {
      bullets.push(`主題鏈（站內整理）偏強：${ch.slice(0, 3).map(x => `${x.key} ${sg(x.ew)}%（${x.up}漲/${x.dn}跌）`).join('、')}`);
      bullets.push(`主題鏈（站內整理）偏弱：${[...ch].reverse().slice(0, 2).map(x => `${x.key} ${sg(x.ew)}%`).join('、')}`);
    }
    bullets.push('熱度＝0.5×Z(超額等權)＋0.5×Z(漲停占比)，僅 n≥8 的產業排序；歷史統計約 40% 的預測力來自漲停連板（買不到），此處只作描述。');
    out.push({ key: 'sectors', title: '族群熱力', paras, bullets });
  }

  // 4 個股焦點
  const g = p.board.gainers.slice(0, 5), l = p.board.losers.slice(0, 5), v = p.board.byValue.slice(0, 3);
  const f = s => `${nm(s)} ${sg(s.ret)}%${s.industry ? `（${s.industry}）` : ''}`;
  const res = (arr) => { const c = {}; for (const s of arr) c[s.resonanceName] = (c[s.resonanceName] || 0) + 1; return Object.entries(c).map(([k, n]) => `${k} ${n} 檔`).join('、'); };
  out.push({
    key: 'stocks', title: '個股焦點',
    paras: [
      `漲幅居前（成交 ≥1 億）：${g.map(f).join('；')}。其中${res(g) || '—'}。`,
      `跌幅居前（成交 ≥1 億）：${l.map(f).join('；')}。`,
      `成交金額最大：${v.map(s => `${nm(s)} ${sg(s.ret)}%、${(s.valM / 1000).toFixed(1)} 億`).join('；')}。`,
    ],
    bullets: ['共振標籤：族群共振＝同族群多數同伴同向、個股獨行＝有緊密族群連結但同伴沒同向、無緊密群連結＝wiki 查不到連結（不代表沒有關聯）。'],
  });

  // 5 次日觀察（描述）
  const w = p.watch, wp = [];
  if (w.continue.length) wp.push(`延續觀察的產業：${w.continue.map(x => x.key).join('、')}（今天明顯強於大盤且普遍上漲）。`);
  if (w.catchup.length) wp.push(`落後補漲觀察 ${w.catchup.length} 檔（同族同伴大漲、本檔未跟上）：${w.catchup.slice(0, 5).map(x => `${x.name ?? x.key}（${x.key}）`).join('、')}${w.catchup.length > 5 ? ' 等' : ''}。證據為「先驗·未驗證」，2022–2023 年無效果。`);
  if (w.risk.length) wp.push(`獨行大漲留意追價風險 ${w.risk.length} 檔：${w.risk.slice(0, 5).map(x => `${x.name ?? x.key}（${x.key}）`).join('、')}${w.risk.length > 5 ? ' 等' : ''}。歷史上這類個股隔日多半小幅回吐（約 0.1～0.3pp，個別日差異大）。`);
  if (!wp.length) wp.push('今天沒有符合觸發條件的觀察項目。');
  out.push({ key: 'watch', title: '次日觀察（只描述，不計分）', paras: wp });

  // 6 資料與口徑
  const u = p.universe;
  const dp = [
    `報酬以官方參考價計（上市 TWT84U、上櫃 close−漲跌或前日次日參考價），除權息日不是平盤；未扣成本。排除：無成交 ${u.noTrade}、無參考價 ${u.noRef}、|報酬|>10.5% ${u.unlimited.length} 檔。`,
  ];
  if (ix) dp.push(`指數貢獻重建與官方漲跌點的殘差 ${ix.residualBp}bp（${ix.grade}：${ix.grade === '綠' ? '可信' : ix.grade === '黃' ? '近似' : '不可靠'}）；發行股數兩來源差 >1% 共 ${p.sharesDisagree.length} 檔，以 t187 為主。`);
  if (p.sharesCorrected?.length) dp.push(`歷史重建日已校正發行股數 ${p.sharesCorrected.length} 檔（分割／減資後 MI_QFIIS 仍是舊股數）。`);
  dp.push('處置／注意股旗標在本報告來源未提供；本報告為資料日收盤事實的描述，不預測走勢、不進任何模型分數，非投資建議。');
  out.push({ key: 'basis', title: '資料與口徑', paras: dp });
  return out;
}

/** 純文字／Markdown（供本機報告檔使用）。 */
export function reportToMarkdown(sections) {
  const L = [];
  for (const s of sections) {
    L.push(`### ${s.title}`, '');
    for (const t of s.paras) L.push(t, '');
    for (const t of s.bullets ?? []) L.push(`- ${t}`);
    if (s.bullets?.length) L.push('');
  }
  return L.join('\n');
}
