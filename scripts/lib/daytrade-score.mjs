// ─────────────────────────────────────────────────────────────────────────────
// 當沖工作台：Market 20 + Stock 50 + Entry 30 規則符合度（唯一實作；daemon 算、前端顯示）
//
// ⚠ 分數是**規則符合度**，不是上漲機率；門檻（75／60）是流程起點，不是已驗證的優勢。
// ⚠ 缺資料一律 score=null（未知）：不當 0、不把已知分數等比放大成滿分。
//   有任何未知時不給分級，只給「已知分／已知滿分」與缺項清單（技巧原文規定）。
// 做空為鏡像：大盤弱、族群弱且領跌、相對弱勢、跌破關鍵位、利空＝高分（本站延伸，未驗證）。
// ─────────────────────────────────────────────────────────────────────────────

const item = (key, label, max, score, evidence) => ({ key, label, max, score: score == null ? null : Math.max(0, Math.min(max, Math.round(score))), evidence });
const pct = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

/**
 * @param {object} x
 *   side: 'long'|'short'
 *   index: { tse: {chg, slope15}|null, otc: {chg, slope15}|null }   slope15＝近 15 分鐘指數變化 %
 *   regime: string|null        大盤風向標籤（全面多頭／結構行情／多空拉鋸／偏空…）
 *   breadth: { up, down }|null
 *   sector: { name, n, upRatio, avgChg, rank }|null     rank：本檔在同族群依漲幅（空：跌幅）排名
 *   stock: { market, price, chg, valueTwd, bid1, ask1, tick, pace, prevHigh, prevLow }
 *   news: { label, certainty, priced, at }|null
 *   scan: scanDesk() 結果；bars：1 分 K；vwap：當下 VWAP
 */
export function scoreDesk(x) {
  const L = x.side === 'long'; const s = L ? 1 : -1;
  const st = x.stock; const scan = x.scan; const bars = x.bars || []; const last = bars[bars.length - 1];
  const idxOwn = st.market === 'otc' ? x.index?.otc : x.index?.tse;

  // ── Market 20 ──
  let m1 = null, m1e = '指數資料缺';
  const t = x.index?.tse, o = x.index?.otc;
  if (t && o) {
    const dirOk = s * t.chg > 0 && s * o.chg > 0, slopeOk = s * (t.slope15 ?? 0) >= 0 && s * (o.slope15 ?? 0) >= 0;
    m1 = dirOk && slopeOk ? 10 : dirOk ? 7 : (s * t.chg > 0 || s * o.chg > 0) ? 4 : 1;
    m1e = `加權 ${pct(t.chg)}（15分 ${pct(t.slope15 ?? 0)}）·櫃買 ${pct(o.chg)}（15分 ${pct(o.slope15 ?? 0)}）·台指期：盤中無資料來源`;
  }
  let m2 = null, m2e = '大盤風向缺';
  if (x.regime) {
    const r = x.regime;
    const bull = /全面多頭/.test(r) ? 5 : /結構/.test(r) ? 4 : /多空|拉鋸|震盪/.test(r) ? 2 : /偏空|空頭/.test(r) ? 0 : 2;
    m2 = L ? bull : 5 - bull; m2e = `風向：${r}`;
  }
  let m3 = null, m3e = '全市場漲跌家數缺';
  if (x.breadth && x.breadth.up + x.breadth.down > 0) {
    const ur = x.breadth.up / (x.breadth.up + x.breadth.down) * 100; const v = L ? ur : 100 - ur;
    m3 = v >= 60 ? 5 : v >= 50 ? 4 : v >= 40 ? 2 : 0;
    m3e = `上漲 ${x.breadth.up}／下跌 ${x.breadth.down}（${ur.toFixed(0)}%）·全市場同時段成交額比較：未取得`;
  }
  const market = [
    item('m1', '加權、櫃買、台指期方向與同步性', 10, m1, m1e),
    item('m2', '市場狀態', 5, m2, m2e),
    item('m3', '市場廣度／流動性', 5, m3, m3e),
  ];

  // ── Stock 50 ──
  let s1 = null, s1e = '族群對照不足（產業別缺或同族群可比 < 3 檔）';
  if (x.sector && x.sector.n >= 3) {
    const lead = x.sector.rank === 1 ? 5 : x.sector.rank === 2 ? 4 : x.sector.rank <= 3 ? 3 : 1;
    const ur = L ? x.sector.upRatio : 1 - x.sector.upRatio;
    s1 = lead + (ur >= 0.6 ? 5 : ur >= 0.5 ? 3 : 1);
    s1e = `${x.sector.name}：${x.sector.n} 檔中${L ? '漲' : '跌'}幅第 ${x.sector.rank}${x.sector.rank <= 2 ? `（龍${x.sector.rank === 1 ? '一' : '二'}）` : ''}·族群上漲 ${(x.sector.upRatio * 100).toFixed(0)}%`;
  }
  let s2 = null, s2e = '大盤或族群對照缺';
  if (idxOwn && x.sector && x.sector.n >= 3) {
    const rm = s * (st.chg - idxOwn.chg), rs = s * (st.chg - x.sector.avgChg);
    s2 = (rm >= 3 ? 5 : rm >= 1.5 ? 3 : rm >= 0 ? 1 : 0) + (rs >= 3 ? 5 : rs >= 1.5 ? 3 : rs >= 0 ? 1 : 0);
    s2e = `相對${st.market === 'otc' ? '櫃買' : '加權'} ${pct(st.chg - idxOwn.chg)}·相對族群均 ${pct(st.chg - x.sector.avgChg)}`;
  }
  let s3 = null, s3e = '五檔價差缺（不在 5 秒快線）';
  if (st.bid1 > 0 && st.ask1 > 0 && st.tick > 0) {
    const yi = st.valueTwd / 1e8; const spreadTicks = Math.round((st.ask1 - st.bid1) / st.tick);
    s3 = (yi >= 10 ? 5 : yi >= 3 ? 4 : yi >= 1 ? 2 : 0) + (spreadTicks <= 1 ? 5 : spreadTicks === 2 ? 3 : 0);
    s3e = `成交額約 ${yi.toFixed(1)} 億·買賣價差 ${spreadTicks} 檔（${st.bid1}／${st.ask1}）`;
  }
  let s4 = null, s4e = '昨高低或開盤區間未形成';
  const key = L ? st.prevHigh : st.prevLow;
  if (key > 0 && scan?.orb) {
    const dk = s * (st.price / key - 1) * 100;
    const a = dk >= 0 && dk <= 3 ? 5 : dk > 3 ? 3 : dk >= -1 ? 3 : 1;
    const oh = L ? scan.orb.H : scan.orb.L, ol = L ? scan.orb.L : scan.orb.H;
    const b = s * (st.price - oh) > 0 ? 5 : s * (st.price - ol) >= 0 ? 2 : 0;
    s4 = a + b;
    s4e = `距${L ? '昨高' : '昨低'} ${key}：${pct(dk * s)}·開盤區間 ${scan.orb.L}～${scan.orb.H}，現價${s * (st.price - oh) > 0 ? (L ? '在上方' : '在下方') : s * (st.price - ol) >= 0 ? '在區間內' : (L ? '跌破下緣' : '站上上緣')}`;
  }
  let s5 = null, s5e = '1 分 K 不足 10 根';
  if (bars.length >= 10) {
    let hh = 0, hl = 0; for (let k = bars.length - 9; k < bars.length; k++) { if (s * (bars[k].h - bars[k - 1].h) > 0 || s * (bars[k].l - bars[k - 1].l) > 0) { hh += s * (bars[k].h - bars[k - 1].h) > 0 ? 1 : 0; hl += s * (bars[k].l - bars[k - 1].l) > 0 ? 1 : 0; } }
    const pace = st.pace ?? null;
    s5 = (pace == null ? 0 : pace >= 2 ? 2 : pace >= 1 ? 1 : 0) + (hh >= 5 && hl >= 4 ? 3 : hh >= 4 ? 2 : 1);
    s5e = `量能節奏 ${pace == null ? '—' : pace.toFixed(1) + 'x'}（今日量÷20日均量÷已過時段）·近 9 根${L ? '高點墊高' : '低點下移'} ${hh} 次、${L ? '低點墊高' : '高點下移'} ${hl} 次`;
  }
  let s6 = null, s6e = '無新聞判讀（未知，不當 0）';
  if (x.news?.label) {
    const n = x.news; const bull = /利多|看多|正面/.test(n.label), bear = /利空|看空|負面/.test(n.label);
    const fav = L ? bull : bear, unfav = L ? bear : bull;
    s6 = fav ? (n.priced === '已反映' || n.certainty === '傳聞' ? 3 : 5) : unfav ? 0 : 2;
    s6e = `${n.label}${n.certainty ? `·${n.certainty}` : ''}${n.priced ? `·${n.priced}` : ''}${n.at ? `·${new Date(n.at + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ')}` : ''}`;
  }
  const stock = [
    item('s1', '族群廣度與領先性', 10, s1, s1e),
    item('s2', '個股相對強度', 10, s2, s2e),
    item('s3', '流動性與交易成本', 10, s3, s3e),
    item('s4', '技術位置與關鍵價', 10, s4, s4e),
    item('s5', '量價與趨勢結構', 5, s5, s5e),
    item('s6', '新聞催化品質', 5, s6, s6e),
  ];

  // ── Entry 30（setup 形成前一律「待確認」）──
  const tr = scan?.active || null; const w = scan?.watch?.[0] || null;
  let e1 = null, e1e = '尚無 setup（待確認）';
  if (tr) { e1 = 10; e1e = `${tr.type} 已觸發：${tr.why}`; }
  else if (w) { e1 = /等站穩|等再攻|回測守住/.test(w.note) ? 5 : 2; e1e = `${w.type}：${w.note}`; }
  let e2 = null, e2e = 'VWAP 缺';
  if (x.vwap > 0 && last) {
    let vs = 0; if (bars.length >= 11) vs = s * (x.vwapPrev10 > 0 ? x.vwap - x.vwapPrev10 : 0);
    const vol = tr ? bars[tr.idx]?.v : last.v; let va = 0, vn = 0; for (let k = Math.max(0, bars.length - 11); k < bars.length - 1; k++) { va += bars[k].v; vn++; }
    const vx = vn && va > 0 ? vol / (va / vn) : 0;
    e2 = (s * (st.price - x.vwap) > 0 ? 3 : 0) + (vs > 0 ? 2 : 0) + (vx >= 1.5 ? 3 : vx >= 1 ? 1 : 0);
    e2e = `現價${s * (st.price - x.vwap) > 0 ? '在' : '不在'} VWAP ${x.vwap.toFixed(2)} ${L ? '上方' : '下方'}·VWAP 斜率${vs > 0 ? '順勢' : '不順'}·${tr ? '觸發' : '最近一根'}量 ${vx.toFixed(1)}x`;
  }
  const warn = x.warnings || [];
  const e3 = last ? 6 - 2 * warn.length : null;
  const e3e = warn.length ? `警訊：${warn.join('、')}` : '無假突破／轉弱警訊';
  let e4 = null, e4e = '尚無明確失效點（未觸發、等待中的計畫也還沒有結構停損）';
  // 已觸發用實際計畫；等待中但已寫定觸發價與結構停損者，用事前計畫算（技巧：事前寫明價格與失效點）
  const plan = tr ? { stop: tr.stop, d: tr.d, costR: tr.costR, pre: false }
    : w && w.stop != null && w.trigger != null ? (() => { const d = s * (w.trigger - w.stop); return d > 0 ? { stop: w.stop, d: +d.toFixed(3), costR: (w.trigger * (x.costPct ?? 0.435) / 100) / d, pre: true } : null; })() : null;
  if (plan) {
    const n2 = 2 - plan.costR;
    e4 = n2 >= 1.8 ? 6 : n2 >= 1.5 ? 4 : n2 >= 1.2 ? 2 : 0;
    e4e = `${plan.pre ? '事前計畫·' : ''}結構停損 ${plan.stop}·1R＝${plan.d}·2R 扣成本淨 ${n2.toFixed(2)}R`;
  }
  const entry = [
    item('e1', 'Setup 品質', 10, e1, e1e),
    item('e2', 'VWAP 與量價確認', 8, e2, e2e),
    item('e3', '假突破／轉弱風險', 6, e3, e3e),
    item('e4', '停損與淨風險報酬', 6, e4, e4e),
  ];

  const all = [...market, ...stock, ...entry];
  const known = all.filter(i => i.score != null);
  const total = known.reduce((a, i) => a + i.score, 0);
  const knownMax = known.reduce((a, i) => a + i.max, 0);
  const missing = all.filter(i => i.score == null).map(i => i.label);
  const tier = missing.length ? null : total >= 75 ? '優先觀察' : total >= 60 ? '等待' : '低優先';
  const sum = arr => ({ score: arr.filter(i => i.score != null).reduce((a, i) => a + i.score, 0), knownMax: arr.filter(i => i.score != null).reduce((a, i) => a + i.max, 0), max: arr.reduce((a, i) => a + i.max, 0) });
  return { market, stock, entry, total, knownMax, missing, tier, parts: { market: sum(market), stock: sum(stock), entry: sum(entry) } };
}

/** 假突破／轉弱警訊（技巧原文清單中可由 1 分 K 判定者） */
export function deskWarnings(bars, side, scan, vwap, idxSlope15) {
  const L = side === 'long'; const s = L ? 1 : -1; const out = [];
  const b = bars[bars.length - 1]; if (!b) return out;
  const range = b.h - b.l;
  if (range > 0 && (L ? (b.h - Math.max(b.o, b.c)) : (Math.min(b.o, b.c) - b.l)) / range >= 0.6) out.push(L ? '長上影' : '長下影');
  let va = 0, vn = 0; for (let k = Math.max(0, bars.length - 11); k < bars.length - 1; k++) { va += bars[k].v; vn++; }
  if (vn && b.v >= 3 * (va / vn) && Math.abs(b.c - b.o) / b.o * 100 < 0.2) out.push('爆量滯漲');
  if (scan?.falseBreaks?.length && bars[bars.length - 1].t - scan.falseBreaks[scan.falseBreaks.length - 1].t <= 10 * 60000) out.push(`${scan.falseBreaks[scan.falseBreaks.length - 1].type} 剛假突破`);
  if (idxSlope15 != null && s * idxSlope15 < -0.3) out.push(L ? '大盤 15 分鐘轉弱' : '大盤 15 分鐘轉強');
  if (vwap > 0 && s * (b.c / vwap - 1) * 100 > 3) out.push('距 VWAP 過遠');
  return out;
}
