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
      const st = (series[code] ??= { dates: [], c: [], h: [], l: [], o: [] });
      st.dates.push(day.date); st.c.push(r[0]); st.h.push(r[3] ?? r[0]); st.l.push(r[4] ?? r[0]); st.o.push(r[2] ?? r[0]);
    }
  }
  return series;
}

/** 相似波段索引（緊湊打包）。步長 2＝樣本減半、形狀覆蓋不變；留 20 日前瞻。
 *
 *  ⚠ 相似的定義（2026-08-12 使用者看圖打槍後定案）：**振幅也要像**。
 *  第一版在「除以自身波動」的歸一空間比形狀——劇烈 V 與溫和 V 歸一後相同，
 *  畫回實際 % 完全不像（使用者截圖實證：本檔 -8% 深 V 配三條近乎水平線）。
 *  改為直接在「實際累計%（錨=窗終點=0）」空間比對——比什麼就畫什麼，
 *  圖上的相似是構造保證，不是巧合。 */
export function buildStrategyWindows(series) {
  const codes = [], idx = [];
  const vecList = [];
  for (const code in series) {
    const st = series[code]; const n = st.c.length;
    if (n < 45) continue;
    for (let i = 20; i + 20 < n; i += 2) {
      if (!(st.c[i] > 0)) continue;
      let ok = true; const vec = [];
      for (let k = i - 19; k <= i; k++) {
        if (!(st.c[k] > 0)) { ok = false; break; }
        vec.push((st.c[k] / st.c[i] - 1) * 100);   // 實際累計%，最後一點恆為 0
      }
      if (!ok) continue;
      codes.push(code); idx.push(i);
      for (let k = 0; k < 20; k++) vecList.push(vec[k]);
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
  // 近 20 日累計%（錨=今日=0）＋20日高相對位置——隔日沖「走勢與突破位」圖的素材，
  // 與 analog 是否成立無關，一律提供。
  const selfPath = [];
  for (let k = Math.max(0, n - 20); k < n; k++) selfPath.push(+(((c[k] / last) - 1) * 100).toFixed(2));
  const hi20Rel = +(((hi20 / last) - 1) * 100).toFixed(2);   // >0＝突破線在上方（未破）；<0＝已站上

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

  // ③ 相似波段（形狀＋振幅雙重相似；±5pp 管狀硬約束＝使用者定案）
  let analog = null;
  let analogNote = null;
  // 帶寬分級（使用者定案 ±5% 為準）：±5 找不到 ≥5 段才放寬到 ±8、±12，
  // **用了哪個帶寬據實寫在卡上**（極端走勢如 +40% 瘋漲，歷史上就是沒有 ±5% 內的同類，
  // 硬湊會回到「看起來不像」的原問題；放寬＋標示是誠實的折衷）。
  const TUBES = [5, 8, 12];
  const W = ctx.windows;
  if (n >= 22 && W?.count) {
    const qv = new Float32Array(20);
    for (let k = 0; k < 20; k++) qv[k] = (c[n - 20 + k] / last - 1) * 100;   // 與窗向量同空間
    // 逐點貼合鐵則（2026-08-12 使用者二度看圖收緊）：
    // 「不重合的點在 ±3% 內、超過 3% 的天數 >5 日就不採用」——
    // 20 個點裡至少 15 點必須貼在 ±3pp 內；其餘至多 5 點也不得超出外層管
    // （±5，極端走勢分級放寬 ±8/±12 並據實標示）。
    const INNER_PP = 3, MAX_OUT_DAYS = 5;
    let top = [], usedTube = TUBES[0];
    for (const tube of TUBES) {
      const scored = [];
      for (let w = 0; w < W.count; w++) {
        if (W.codes[w] === code && W.idx[w] > n - 40) continue;   // 排除自己最近重疊窗
        const base = w * 20; let d = 0; let ok = true; let outDays = 0;
        for (let k = 0; k < 20; k++) {
          const t = qv[k] - W.vecs[base + k];
          const a = t < 0 ? -t : t;
          if (a > tube) { ok = false; break; }                      // 離群上限（分級管）
          if (a > INNER_PP && ++outDays > MAX_OUT_DAYS) { ok = false; break; }  // 鐵則
          d += t * t;
        }
        if (ok) scored.push([d, w]);
      }
      scored.sort((a, b) => a[0] - b[0]);
      top = scored.slice(0, 30); usedTube = tube;
      if (top.length >= 5) break;
    }
    if (top.length < 5) {
      analogNote = `全市場歷史中，符合「逐點 ±3% 內（容許 ≤5 日例外、例外不超過 ±${usedTube}%）」的相似波段僅 ${top.length} 段——樣本不足，不硬湊統計。`;
    }
    if (top.length >= 5) {
      const fwd = (w, hn) => { const sc = ctx.series[W.codes[w]].c; const i2 = W.idx[w]; return i2 + hn < sc.length ? sc[i2 + hn] / sc[i2] - 1 : null; };
      const med = arr => { const s2 = arr.slice().sort((a, b) => a - b); return s2[s2.length >> 1]; };
      const stats = [5, 10, 20].map(hn => {
        const rs = top.map(([, w]) => fwd(w, hn)).filter(r => r != null && Number.isFinite(r));
        if (rs.length < 5) return null;   // n 一律隨卡揭露，小樣本由讀者自行折價
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
      // 比較線圖用路徑：以「相似點」（20日窗的終點）為 0% 錨——
      // 這樣四條線在錨點交會，之後的分岔就是「長得像的走勢後來怎麼走」，
      // 視覺可直接比。窗內段（-19..0）顯示形狀、窗後段（+1..+20）顯示結局。
      const pathOf = (sr, i2) => {
        const out = [];
        for (let k = Math.max(0, i2 - 19); k <= Math.min(i2 + 20, sr.c.length - 1); k++) {
          out.push(+(((sr.c[k] / sr.c[i2]) - 1) * 100).toFixed(2));
        }
        return out;
      };
      // 例子挑選（2026-08-12 使用者定案）：**同族群（相近話題/上下游，以同業表為代理）優先**。
      // 統計池（top 30）仍按距離排——族群偏好只影響「秀哪 3 個例子」，不污染統計。
      const myInd = ctx.indMap?.[code] || null;
      const pickExamples = (pool, k) => {
        if (!myInd) return pool.slice(0, k);
        const same = pool.filter(([, w]) => ctx.indMap?.[W.codes[w]] === myInd);
        const rest = pool.filter(([, w]) => ctx.indMap?.[W.codes[w]] !== myInd);
        return [...same, ...rest].slice(0, k);
      };
      analog = {
        n: top.length, tube: usedTube, stats,
        selfPath,   // 相容欄位：舊 bundle 的 AnalogChart 讀這裡；新 UI 讀根層（下版可移除）
        grow: +(med(gd.map(x => x.mg)) * 100).toFixed(1),
        draw: +(med(gd.map(x => x.md)) * 100).toFixed(1),
        selfPath,
        examples: pickExamples(top, 3).map(([, w]) => ({
          code: W.codes[w], name: ctx.nameMap?.[W.codes[w]] || '',
          ind: ctx.indMap?.[W.codes[w]] || null, sameInd: myInd != null && ctx.indMap?.[W.codes[w]] === myInd,
          date: ctx.series[W.codes[w]].dates[W.idx[w]],
          ret5: (() => { const r = fwd(w, 5); return r != null ? +(r * 100).toFixed(1) : null; })(),
          path: pathOf(ctx.series[W.codes[w]], W.idx[w]),   // 窗內20＋窗後至多20，錨=相似點
          winLen: Math.min(20, W.idx[w]),                    // 窗內段實際長度（對齊繪圖用）
        })),
      };
    }
  }
  // ── 隔日沖相似日（2026-08-12 使用者需求：4 組取樣＋後續 5 日）────────
  // 取樣空間：近 5 日累計%（錨=今日=0）——正是既有 20 維窗向量的**末 5 維**，
  // 零額外記憶體。鐵則按比例收斂：逐點 ±3%、例外 ≤1 日（20點:5日 → 5點:1日）。
  // 出場統計用**隔日開盤價**（歸檔 r[2]）＝與「明早開盤賣」鐵律同口徑，不拿收盤充數。
  let nextAnalog = null;
  let selfPath5 = null;
  if (n >= 6 && W?.count) {
    selfPath5 = [];
    for (let k = n - 5; k < n; k++) selfPath5.push(+(((c[k] / last) - 1) * 100).toFixed(2));
    const qv5 = selfPath5;
    const myInd = ctx.indMap?.[code] || null;
    const TUBES5 = [5, 8, 12];
    let top5 = [], usedTube5 = TUBES5[0];
    for (const tube of TUBES5) {
      const scored = [];
      for (let w = 0; w < W.count; w++) {
        if (W.codes[w] === code && W.idx[w] > n - 15) continue;
        const base = w * 20 + 15;   // 末 5 維＝該窗近 5 日
        let d = 0, ok = true, outDays = 0;
        for (let k = 0; k < 5; k++) {
          const t = qv5[k] - W.vecs[base + k];
          const a2 = t < 0 ? -t : t;
          if (a2 > tube) { ok = false; break; }
          if (a2 > 3 && ++outDays > 1) { ok = false; break; }
          d += t * t;
        }
        if (ok) scored.push([d, w]);
      }
      scored.sort((a, b) => a[0] - b[0]);
      top5 = scored.slice(0, 30); usedTube5 = tube;
      if (top5.length >= 5) break;
    }
    if (top5.length >= 5) {
      const med = arr => { const s2 = arr.slice().sort((a, b) => a - b); return s2[s2.length >> 1]; };
      // 隔日開盤賣（鐵律口徑）與後5日收盤
      const openRets = [], c5Rets = [];
      for (const [, w] of top5) {
        const sr = ctx.series[W.codes[w]]; const i2 = W.idx[w];
        if (i2 + 1 < sr.o.length && sr.o[i2 + 1] > 0) openRets.push(sr.o[i2 + 1] / sr.c[i2] - 1);
        if (i2 + 5 < sr.c.length) c5Rets.push(sr.c[i2 + 5] / sr.c[i2] - 1);
      }
      const same = top5.filter(([, w]) => myInd && ctx.indMap?.[W.codes[w]] === myInd);
      const rest = top5.filter(([, w]) => !(myInd && ctx.indMap?.[W.codes[w]] === myInd));
      const picked = [...same, ...rest].slice(0, 3);
      nextAnalog = {
        n: top5.length, tube: usedTube5,
        openMed: openRets.length >= 5 ? +(med(openRets) * 100).toFixed(2) : null,
        openWin: openRets.length >= 5 ? +(openRets.filter(r => r > 0).length / openRets.length * 100).toFixed(1) : null,
        d5Med: c5Rets.length >= 5 ? +(med(c5Rets) * 100).toFixed(2) : null,
        d5Win: c5Rets.length >= 5 ? +(c5Rets.filter(r => r > 0).length / c5Rets.length * 100).toFixed(1) : null,
        examples: picked.map(([, w]) => {
          const sr = ctx.series[W.codes[w]]; const i2 = W.idx[w];
          const path5 = [];
          for (let k = Math.max(0, i2 - 4); k <= Math.min(i2 + 5, sr.c.length - 1); k++) path5.push(+(((sr.c[k] / sr.c[i2]) - 1) * 100).toFixed(2));
          return {
            code: W.codes[w], name: ctx.nameMap?.[W.codes[w]] || '',
            ind: ctx.indMap?.[W.codes[w]] || null, sameInd: myInd != null && ctx.indMap?.[W.codes[w]] === myInd,
            date: sr.dates[i2],
            openRet: (i2 + 1 < sr.o.length && sr.o[i2 + 1] > 0) ? +(((sr.o[i2 + 1] / sr.c[i2]) - 1) * 100).toFixed(2) : null,
            path5, winLen5: Math.min(5, i2) + 0,
          };
        }),
      };
    }
  }

  return { chg: +chg.toFixed(2), pos: pos != null ? +pos.toFixed(2) : null, brk20, charLabel, selfPath, selfPath5, hi20Rel, filterPass, passes, fails, hold, heldDays, holdN: n, analog, analogNote, nextAnalog };
}
