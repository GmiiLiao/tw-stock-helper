// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊：事後對答案的純函式（規格 04 §1.5）。只記錄、不得進任何模型分數、排序、濾網、門檻。
//   只評 kind:'watch'（明日卡）；在資料日 +1／+5 個交易日的收盤都到齊後才評該期。
//   報酬一律用官方參考價日報酬連乘（熱力定版檔 stocks 的 ret 欄＝close/參考價−1，除權息日也正確）、未扣成本；
//   基準＝同一批日子的同日等權（熱力 market.ew 連乘）。命中與漏網兩份記錄（逐件列特徵與有無相關消息，供迭代查漏網原因）。
//   本檔無 IO（讀寫在 scripts/verify-daily-analyst.mjs）；不 import firebase、不 import 任何 daemon／計分模組。
// ─────────────────────────────────────────────────────────────────────────────

/** 口徑在這裡寫死，事後不得換（輸出檔 reviewSpec 逐字帶出）。 */
export const REVIEW_SPEC = Object.freeze({
  kinds: Object.freeze(['watch']),
  refBasis: '資料日收盤',
  horizons: Object.freeze([1, 5]),
  returnBasis: '官方參考價日報酬連乘，未扣交易成本',
  benchmark: '同一批日子的同日等權（熱力 market.ew 連乘）',
  missLimit: 10,
  minSampleDays: 20,
});

export const REVIEW_SCHEMA = 1;
export const REVIEW_NATURE = '事後記錄：描述資料日觀察名單在其後 1／5 個交易日的表現；不是績效、不計分、不得進任何模型、排序或濾網；事後挑選，不代表可交易績效';

const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const arr = x => (Array.isArray(x) ? x : []);

/** 連乘：日報酬（%）陣列 → 累積報酬（%）；任何一日缺值（null）→ null（不捏造 0）。 */
export function compound(retsPct) {
  let f = 1;
  for (const r of retsPct) { if (r == null || !Number.isFinite(r)) return null; f *= 1 + r / 100; }
  return (f - 1) * 100;
}

/** 熱力 payload → Map<code, ret%>（stocks 為緊湊陣列 [code, ret, valM, flags, resonance, industry]）。 */
export const retMapOf = hm => new Map(arr(hm?.stocks).map(s => [s[0], s[1]]));

/** 該資料日之後的前 h 個交易日（取自鏡像交易日清單，不用日曆加減）。 */
export const laterDays = (tradingDays, day, h) => tradingDays.filter(d => d > day).slice(0, h);

/**
 * 單一期（h）的結果。heatmapOf(day)→熱力 payload｜null。
 * 回傳 { status:'ready'|'pending', reason?, days, benchPct?, picks? }
 */
export function evaluateHorizon({ stocks, tradingDays, day, h, heatmapOf }) {
  const days = laterDays(tradingDays, day, h);
  if (days.length < h) return { status: 'pending', reason: `資料日後尚不足 ${h} 個交易日（目前 ${days.length}）`, days };
  const hms = days.map(d => [d, heatmapOf(d)]);
  const missing = hms.filter(([, p]) => !p).map(([d]) => d);
  if (missing.length) return { status: 'pending', reason: `缺熱力定版檔（收盤未到齊）：${missing.join('、')}`, days };
  const maps = hms.map(([, p]) => retMapOf(p));
  const bench = compound(hms.map(([, p]) => p.market?.ew ?? null));
  const picks = stocks.map(st => {
    const perDay = maps.map(m => (m.has(st.code) ? m.get(st.code) : null));
    const ret = compound(perDay);
    const gaps = days.filter((_, i) => perDay[i] == null);
    return {
      code: st.code, name: st.name || '', market: st.market || '', industry: st.industry || '',
      sponsors: arr(st.sponsors), thesis: st.thesis || '', evidence: arr(st.evidence).map(e => e.ref), adverse: arr(st.adverse),
      retPct: r2(ret), exPp: ret == null || bench == null ? null : r2(ret - bench),
      hit: ret == null || bench == null ? null : ret > bench,
      ...(gaps.length ? { note: `無成交／停牌日：${gaps.join('、')}（不補 0，該檔不計命中）` } : {}),
    };
  });
  return { status: 'ready', days, benchPct: r2(bench), picks };
}

/** 漏網表：D+1 熱力 board.gainers 前 N 檔中未入名單者，附「在池內？被排除原因？有無相關消息」。 */
export function buildMisses({ firstDayHeatmap, stocks, pack, topN = REVIEW_SPEC.missLimit }) {
  const named = new Set(stocks.map(s => s.code));
  const pool = new Map(arr(pack?.pools?.next).map(p => [p.code, p]));
  const excl = new Map(arr(pack?.excluded?.next).map(x => [x.code, x.reason]));
  const refIds = Object.keys(pack?.refs || {});
  return arr(firstDayHeatmap?.board?.gainers).slice(0, topN).filter(g => !named.has(g.code)).map(g => {
    const news = refIds.filter(id => id.startsWith(`nv.${g.code}.`) || id.startsWith(`mo.${g.code}.`));
    return {
      code: g.code, name: g.name || '', industry: g.industry || '', retPct: g.ret ?? null, valM: g.valM ?? null,
      inPool: pool.has(g.code), poolFrom: pool.get(g.code)?.from ?? [],
      excludedReason: excl.get(g.code) ?? null,
      relatedNews: news.length ? news : [],
      noteIfNone: !pool.has(g.code) && !excl.has(g.code) && !news.length ? '不在候選池、無排除記錄、資料包無相關消息' : '',
    };
  });
}

/**
 * 一份定版的完整對答案。existing＝既有 _review 檔（已 ready 的期原樣保留，不重算）。
 * 沒有 watch 名單回 { skip:true, reason }。
 */
export function buildReview({ issue, pack, tradingDays, heatmapOf, existing = null, now = Date.now() }) {
  const card = arr(issue?.cards).find(c => c.focus?.kind === 'watch');
  const stocks = arr(card?.focus?.stocks);
  if (!stocks.length) return { skip: true, reason: '無 watch 名單（明日卡未列名單或已退成純事實卡）' };
  const horizons = {};
  for (const h of REVIEW_SPEC.horizons) {
    const prev = existing?.horizons?.[h];
    if (prev?.status === 'ready') { horizons[h] = prev; continue; }
    const ev = evaluateHorizon({ stocks, tradingDays, day: issue.dataDate, h, heatmapOf });
    if (ev.status === 'ready' && h === REVIEW_SPEC.horizons[0]) {
      ev.misses = buildMisses({ firstDayHeatmap: heatmapOf(ev.days[0]), stocks, pack });
    }
    horizons[h] = ev;
  }
  return {
    skip: false,
    review: {
      schema: REVIEW_SCHEMA, kind: 'analystReview', dataDate: issue.dataDate, edition: issue.edition,
      usedForScoring: false, nature: REVIEW_NATURE, reviewSpec: REVIEW_SPEC,
      generatedAt: new Date(now).toISOString(), nominated: stocks.length, horizons,
    },
    complete: REVIEW_SPEC.horizons.every(h => horizons[h].status === 'ready'),
  };
}

/**
 * 跨日彙總（只在有效樣本交易日 ≥ minSampleDays 時輸出命中率；否則只回逐日）。
 * reviews＝已 ready 的 review 物件陣列。樣本日＝不同資料日數。
 */
export function aggregate(reviews, h, minDays = REVIEW_SPEC.minSampleDays) {
  const rows = reviews.map(r => ({ day: r.dataDate, edition: r.edition, hz: r.horizons?.[h] })).filter(x => x.hz?.status === 'ready');
  const perDay = rows.map(x => {
    const judged = x.hz.picks.filter(p => p.hit != null);
    return { day: x.day, edition: x.edition, n: judged.length, hits: judged.filter(p => p.hit).length, benchPct: x.hz.benchPct, avgRetPct: judged.length ? r2(judged.reduce((a, p) => a + p.retPct, 0) / judged.length) : null };
  });
  const days = new Set(rows.map(x => x.day)).size;
  if (days < minDays) return { horizon: h, sampleDays: days, perDay, note: `樣本 ${days} 個交易日 < ${minDays}，只列逐日、不輸出命中率彙總` };
  const n = perDay.reduce((a, x) => a + x.n, 0), hits = perDay.reduce((a, x) => a + x.hits, 0);
  return { horizon: h, sampleDays: days, perDay, pooledN: n, pooledHits: hits, hitRate: n ? r2((hits / n) * 100) : null, note: '事後挑選，不代表可交易績效；未扣成本' };
}
