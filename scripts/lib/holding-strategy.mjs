// ─────────────────────────────────────────────────────────────────────────
// 持股策略分析（隔日沖對照／持有日獲利／相似歷史波段）——共用純函式
//
// ⚠ 這是**唯一實作**：daemon（analyzeUser → portfolioAnalysis.strategy）與
//   web（/api/ai/stock-strategy，決策工作台用）都 import 這裡。
//   不要在任何一邊複製貼上——ledger-replay.mjs 的鏡像教訓同款。
//
// 三塊全部零 LLM、可驗證：
//   ① 隔日沖：今日型態對照撿尾盤定版濾網（破20日高×收位≥0.7×漲3~7%）。
//   ② 持有日獲利：該股全歷史逐日進場後第 1/2/3/5/10/20 日中位/勝率（描述統計）。
//   ③ 相似波段：近20日對數報酬÷自身波動 → 全市場歷史 20 日窗最近鄰 30 段，
//     後 5/10/20 日中位/勝率＋最大成長/最大回檔**成對**。
//     ⚠ 誠實揭露由 UI 承擔且不可省：相似度→未來報酬歷史檢定未通過。
//
// 記憶體：相似窗以 Float32Array 緊湊打包（~187k 窗 × 20 維 ≈ 15MB），
// web instance（1GiB）與 daemon 都負擔得起；物件陣列版會是 3 倍＋GC 壓力。
// ─────────────────────────────────────────────────────────────────────────

/** archDocsAsc：chipArchive 文件（**舊→新**、已濾空殼、closeJson 存在）。
 *  closeJson 形狀 {code: [收盤, 量張, 開, 高, 低]}（舊檔可能缺 3/4 → 以收盤代）。 */
export function buildStrategySeries(archDocsAsc) {
  const series = {};
  for (const day of archDocsAsc) {
    const m = JSON.parse(day.closeJson);
    for (const code in m) {
      const r = m[code]; if (!r || !(r[0] > 0)) continue;
      const st = (series[code] ??= { dates: [], c: [], h: [], l: [] });
      st.dates.push(day.date); st.c.push(r[0]); st.h.push(r[3] ?? r[0]); st.l.push(r[4] ?? r[0]);
    }
  }
  return series;
}

/** 相似波段索引（緊湊打包）。步長 2＝樣本減半、形狀覆蓋不變；留 20 日前瞻。 */
export function buildStrategyWindows(series) {
  const codes = [], idx = [];
  const vecList = [];
  for (const code in series) {
    const st = series[code]; const n = st.c.length;
    if (n < 45) continue;
    for (let i = 20; i + 20 < n; i += 2) {
      const rets = []; let sum = 0, sum2 = 0; let ok = true;
      for (let k = i - 19; k <= i; k++) {
        if (!(st.c[k] > 0) || !(st.c[k - 1] > 0)) { ok = false; break; }
        const r = Math.log(st.c[k] / st.c[k - 1]); rets.push(r); sum += r; sum2 += r * r;
      }
      if (!ok) continue;
      const sd = Math.sqrt(Math.max(sum2 / 20 - (sum / 20) ** 2, 1e-8));
      codes.push(code); idx.push(i);
      for (let k = 0; k < 20; k++) vecList.push(rets[k] / sd);
    }
  }
  return { codes, idx: Int32Array.from(idx), vecs: Float32Array.from(vecList), count: codes.length };
}

/** ctx = { series, windows, charMap }；buyDate 可為 null（非持股＝不算持有天數）。 */
export function computeHoldingStrategy(ctx, code, buyDate) {
  const st = ctx.series[code];
  if (!st || st.c.length < 25) return null;
  const n = st.c.length, c = st.c;
  const last = c[n - 1], prev = c[n - 2];
  const chg = prev > 0 ? (last / prev - 1) * 100 : 0;
  const hi = st.h[n - 1], lo = st.l[n - 1];
  const pos = hi > lo ? (last - lo) / (hi - lo) : null;
  const hi20 = Math.max(...c.slice(Math.max(0, n - 21), n - 1));
  const brk20 = last > hi20;
  const charLabel = ctx.charMap?.[code]?.label || null;

  // ① 隔日沖：對照定版濾網
  const passes = [], fails = [];
  (brk20 ? passes : fails).push('破20日新高');
  ((pos != null && pos >= 0.7) ? passes : fails).push('收位≥0.7');
  ((chg >= 3 && chg <= 7) ? passes : fails).push('漲3~7%');
  const filterPass = pos != null && fails.length === 0;

  // ② 持有日 profile：全歷史逐日進場
  const hold = [1, 2, 3, 5, 10, 20].map(hn => {
    const rets = [];
    for (let i = 0; i + hn < n; i++) if (c[i] > 0 && c[i + hn] > 0) rets.push(c[i + hn] / c[i] - 1);
    if (rets.length < 30) return null;
    rets.sort((a, b) => a - b);
    return { d: hn, med: +(rets[rets.length >> 1] * 100).toFixed(2), win: +(rets.filter(r => r > 0).length / rets.length * 100).toFixed(1), n: rets.length };
  }).filter(Boolean);

  let heldDays = null;
  if (buyDate) { const i2 = st.dates.findIndex(d => d >= buyDate); if (i2 >= 0) heldDays = n - 1 - i2; }

  // ③ 相似波段
  let analog = null;
  const W = ctx.windows;
  if (n >= 22 && W?.count) {
    const rets = []; let sum = 0, sum2 = 0;
    for (let k = n - 20; k < n; k++) { const r = Math.log(c[k] / c[k - 1]); rets.push(r); sum += r; sum2 += r * r; }
    const sd = Math.sqrt(Math.max(sum2 / 20 - (sum / 20) ** 2, 1e-8));
    const qv = new Float32Array(20);
    for (let k = 0; k < 20; k++) qv[k] = rets[k] / sd;
    // 全窗掃描（~187k × 20 乘加 ≈ 4M flops·<50ms）
    const scored = [];
    for (let w = 0; w < W.count; w++) {
      if (W.codes[w] === code && W.idx[w] > n - 40) continue;   // 排除自己最近重疊窗
      const base = w * 20; let d = 0;
      for (let k = 0; k < 20; k++) { const t = qv[k] - W.vecs[base + k]; d += t * t; }
      scored.push([d, w]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    const top = scored.slice(0, 30);
    if (top.length >= 10) {
      const fwd = (w, hn) => { const sc = ctx.series[W.codes[w]].c; const i2 = W.idx[w]; return i2 + hn < sc.length ? sc[i2 + hn] / sc[i2] - 1 : null; };
      const med = arr => { const s2 = arr.slice().sort((a, b) => a - b); return s2[s2.length >> 1]; };
      const stats = [5, 10, 20].map(hn => {
        const rs = top.map(([, w]) => fwd(w, hn)).filter(r => r != null && Number.isFinite(r));
        if (rs.length < 10) return null;
        return { d: hn, med: +(med(rs) * 100).toFixed(2), win: +(rs.filter(r => r > 0).length / rs.length * 100).toFixed(1) };
      }).filter(Boolean);
      const gd = top.map(([, w]) => {
        const sr = ctx.series[W.codes[w]]; const i2 = W.idx[w]; let mg = 0, md = 0;
        for (let k = i2 + 1; k <= Math.min(i2 + 20, sr.c.length - 1); k++) {
          mg = Math.max(mg, (sr.h[k] ?? sr.c[k]) / sr.c[i2] - 1);
          md = Math.min(md, (sr.l[k] ?? sr.c[k]) / sr.c[i2] - 1);
        }
        return { mg, md };
      });
      analog = {
        n: top.length, stats,
        grow: +(med(gd.map(x => x.mg)) * 100).toFixed(1),
        draw: +(med(gd.map(x => x.md)) * 100).toFixed(1),
        examples: top.slice(0, 3).map(([, w]) => ({
          code: W.codes[w], date: ctx.series[W.codes[w]].dates[W.idx[w]],
          ret5: (() => { const r = fwd(w, 5); return r != null ? +(r * 100).toFixed(1) : null; })(),
        })),
      };
    }
  }
  return { chg: +chg.toFixed(2), pos: pos != null ? +pos.toFixed(2) : null, brk20, charLabel, filterPass, passes, fails, hold, heldDays, holdN: n, analog };
}
