// 價格結構事件還原（除權息／減資／面額變更）——daemon 與獨立腳本共用（2026-09-30 自 ai-daemon.mjs 抽出，邏輯不變）。
//   factors：{ code: [{ date, factor }] }；事件日**之前**的價格乘係數，張數（index 1）不動；沒有係數的事件不動。

/** priceEvents/latest.items → factors */
export function factorsFromItems(items) {
  const out = {};
  for (const e of (items || [])) if (e.factor > 0 && e.code && e.date) (out[e.code] ||= []).push({ date: e.date, factor: e.factor });
  return out;
}

/** days＝[{date, m:{code:[收,量,開,高,低]}}]（任意順序）→ 還原後的新陣列（不改原物件） */
export function applyPriceFactors(days, factors) {
  const codes = Object.keys(factors || {});
  if (!codes.length) return days;
  return days.map(d => {
    let copy = null;
    for (const code of codes) {
      const row = d.m[code]; if (!row) continue;
      let f = 1; for (const ev of factors[code]) if (d.date < ev.date) f *= ev.factor;
      if (f === 1) continue;
      if (!copy) copy = { ...d.m };
      copy[code] = row.map((v, i) => (i === 1 ? v : (v > 0 ? +(v * f).toFixed(2) : v)));
    }
    return copy ? { ...d, m: copy } : d;
  });
}
