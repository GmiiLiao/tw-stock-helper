// ─────────────────────────────────────────────────────────────────────────────
// 推薦成績記分板彙總（daemon trackPicks 與 backfill-picks-scoreboard 共用；2026-09-30 自 ai-daemon.mjs 抽出並修正）
//   picksHistory/{進場日}：{ calib, <榜>:[…], eval5/10/20: { <榜>: { all, tradable }, base: [同期可交易宇宙報酬] } }
//   ⚠ 修正（使用者 2026-09-30「這頁的資料是不是要修正」）：舊版每個榜的基準都取「全部日子」的宇宙報酬，
//     但多數榜 08-05 才開始有推薦 ⇒ 拿 v2 期間的榜單報酬去比含 7 月偏空期的全期間基準，超額被灌水
//     （實例：成長潛力 10 日 +2.70pp，同期對齊後為 +0.38pp）。
//     現在每榜每窗的基準只取「該榜當窗有推薦的進場日」——同一批日子才能比。
//   全部未扣成本（使用者規則：不以扣成本方式比對，成本依持有方式另計）。
// ─────────────────────────────────────────────────────────────────────────────

export const PICK_HORIZONS = [5, 10, 20];

/** 報酬陣列 → 樣本數、勝率、平均、中位數（%） */
export function aggRets(rets) {
  if (!rets.length) return null;
  const s = [...rets].sort((a, b) => a - b);
  return {
    n: rets.length,
    winRate: Math.round(rets.filter(v => v > 0).length / rets.length * 100),
    avgRet: +(rets.reduce((a, v) => a + v, 0) / rets.length).toFixed(2),
    medRet: +s[s.length >> 1].toFixed(2),
  };
}

/** 一組進場日 → { 榜: { d5, d10, d20 } }；基準與榜單取同一批進場日 */
export function aggregatePicks(docs, lists) {
  const out = {};
  for (const h of PICK_HORIZONS) {
    const key = `eval${h}`;
    for (const k of lists) {
      const days = docs.filter(d => d[key]?.[k]?.all?.length);
      const a = aggRets(days.flatMap(d => d[key][k].all)); if (!a) continue;
      const t = aggRets(days.flatMap(d => d[key][k].tradable || []));
      const base = aggRets(days.flatMap(d => d[key].base || []));
      (out[k] ||= {})[`d${h}`] = {
        ...a,
        tradableN: t?.n ?? 0, tradableAvg: t?.avgRet ?? null, tradableWin: t?.winRate ?? null,
        skipped: a.n - (t?.n ?? 0),                            // 進場日漲停·買不到
        base: base ? { n: base.n, winRate: base.winRate, avgRet: base.avgRet, medRet: base.medRet } : null,
        // 超額＝選股能力（同一批進場日的推薦均報 − 可交易宇宙均報）；絕對報酬主要由市況決定
        excess: base ? +(a.avgRet - base.avgRet).toFixed(2) : null,
        excessTradable: base && t ? +(t.avgRet - base.avgRet).toFixed(2) : null,
        entryDays: days.length,
      };
    }
  }
  return out;
}

/** 記分板文件：全歷史、現行口徑、舊口徑三份（舊口徑＝已汰換系統的成績，只供對照） */
export function scoreboardDoc(docs, lists, calib) {
  const cur = docs.filter(d => d.calib === calib), legacy = docs.filter(d => d.calib !== calib);
  return {
    updatedAt: Date.now(), from: docs[0]?.date || null, records: docs.length, agg: aggregatePicks(docs, lists),
    calib, calibFrom: cur[0]?.date || null, recordsV2: cur.length, aggV2: aggregatePicks(cur, lists),
    legacyFrom: legacy[0]?.date || null, legacyTo: legacy.at(-1)?.date || null, recordsLegacy: legacy.length, aggLegacy: aggregatePicks(legacy, lists),
    baseline: 'matched-days',   // 基準與榜單取同一批進場日（2026-09-30 起）
    note: '超額＝同一批進場日的推薦均報 − 可交易宇宙等權均報，是「選股能力」；絕對報酬主要由市況決定。tradable 為剔除進場日漲停（收盤價買不到）後的口徑。全部未扣成本（成本依持有方式另計）。',
  };
}

/**
 * 推選個股追蹤（2026-09-30 使用者「要能追蹤推選個股的絕對報酬、勝率／平均報酬」）：
 *   最近 days 個進場日的榜單個股，逐檔列推薦價與 5／10／20 個交易日後、以及到最新收盤的報酬 %（官方收盤·未扣成本）。
 *   closeOf(date, code)＝該日官方收盤（無則 null）；dates＝交易日（舊→新，須含各進場日）。未到期＝null。
 */
export function recentPicks(docs, closeOf, dates, { list = 'top20', days = 15 } = {}) {
  const idx = new Map(dates.map((d, i) => [d, i])), last = dates.length - 1;
  const r = (px, x) => (px > 0 && x > 0 ? +((x / px - 1) * 100).toFixed(2) : null);
  return docs.filter(d => Array.isArray(d[list]) && d[list].length && idx.has(d.date)).slice(-days).reverse().map(d => {
    const i = idx.get(d.date);
    const at = (h, code) => (i + h <= last ? closeOf(dates[i + h], code) : null);
    const picks = d[list].map(p => ({
      code: p.code, name: p.name || p.code, price: p.price ?? null, chg: p.chg ?? null,
      r5: r(p.price, at(5, p.code)), r10: r(p.price, at(10, p.code)), r20: r(p.price, at(20, p.code)),
      rNow: i < last ? r(p.price, closeOf(dates[last], p.code)) : null,
    }));
    return { date: d.date, asOf: dates[last], picks };
  });
}
