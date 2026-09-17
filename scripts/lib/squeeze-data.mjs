// ═══════════════════════════════════════════════════════════════════
// 軋空訓練資料層（第二大腦 · 2026-08-26 建置）
//
// 設計原則：
// ① **訓練資料不是從今天才開始累積**。台股個股面 chipArchive 已有 240+ 交易日，
//    缺的只有國際盤歷史，而那可以從 Yahoo 一次回填 ~250 日 ⇒ 開站即可訓練，
//    不必等半年。
// ② **PIT（Point-In-Time）鐵律**：決策時點＝台股 t 日收盤後、t+1 開盤前。
//    此刻「已知」的有：台股 t 日全量價籌碼、亞股 t 日收盤、**美股 t 日收盤**
//    （美股 t 日盤在台北時間 t 日晚間~t+1 凌晨，早於台股 t+1 開盤）。
//    「未知」的有：台股 t+1 的任何資料。任何特徵越線就是未來函數。
// ③ 標的（label）用**隔日開盤報酬**為主：使用者是隔日沖，收盤價報酬不是他
//    實際拿得到的東西。chipArchive 的 closeJson 帶開盤價，故可誠實計算。
// ═══════════════════════════════════════════════════════════════════

export const GLOBAL_SYMS = [
  ['^GSPC', 'sp500'], ['^IXIC', 'nasdaq'], ['^DJI', 'dow'], ['^SOX', 'sox'],
  ['^N225', 'n225'], ['^KS11', 'kospi'], ['^VIX', 'vix'],
  ['TWD=X', 'usdtwd'], ['^TWII', 'twii'],
];

/** 抓單一標的日線歷史 → { iso: {close, chg} }。range 例 '1y' / '2y'。 */
export async function fetchIndexHistory(sym, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${sym} status ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const ts = res?.timestamp || [];
  const cl = res?.indicators?.quote?.[0]?.close || [];
  const out = {};
  let prev = null;
  for (let i = 0; i < ts.length; i++) {
    const c = cl[i];
    if (c == null) continue;
    const iso = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    out[iso] = { close: +c.toFixed(2), chg: prev ? +(((c - prev) / prev) * 100).toFixed(2) : null };
    prev = c;
  }
  return out;
}

/** 全部指數歷史 → { key: { iso: {close,chg} } }，有 pacing。 */
export async function fetchAllGlobalHistory(range = '1y', sleepMs = 250) {
  const out = {};
  for (const [sym, key] of GLOBAL_SYMS) {
    try { out[key] = await fetchIndexHistory(sym, range); }
    catch { out[key] = {}; }
    await new Promise(r => setTimeout(r, sleepMs));
  }
  return out;
}

/**
 * 把國際盤歷史攤成「以台股交易日為索引」的特徵表。
 * ⚠ 對齊規則（PIT 核心）：台股 t 日收盤後做決策時，
 *   · 亞股（n225/kospi/twii）用 **t 日**（同日收盤，早於台股收盤或同時段）
 *   · 美股（sp500/nasdaq/dow/sox/vix）用 **t 日**那一根——美股 t 日盤在台北
 *     時間 t 日晚上開始，t+1 凌晨收，仍早於台股 t+1 開盤 ⇒ 可用且不是未來函數。
 *     Yahoo 的美股 t 日 K 線日期就是美東 t 日，與此一致。
 */
export function alignGlobal(hist, twDates) {
  const rows = {};
  for (const d of twDates) {
    const f = {};
    for (const [, key] of GLOBAL_SYMS) {
      const rec = hist[key]?.[d];
      f[`${key}_chg`] = rec?.chg ?? null;
      if (key === 'vix') f.vix_lvl = rec?.close ?? null;
    }
    rows[d] = f;
  }
  return rows;
}

// ── 個股特徵（PIT：只用 t 日與更早）─────────────────────────────────
// closeJson 列格式 [收, 量(張), 開, 高, 低]
export const C = 0, V = 1, O = 2, H = 3, L = 4;

export function buildStockFeatures(days, t, code) {
  const row = days[t].close[code];
  const p1 = days[t - 1]?.close[code];
  if (!row || !p1) return null;
  const close = row[C], vol = row[V], high = row[H], low = row[L];
  const prevClose = p1[C];
  if (!(close > 0) || !(prevClose > 0)) return null;

  const chg = ((close - prevClose) / prevClose) * 100;
  const chg1 = p1 && days[t - 2]?.close[code]?.[C] > 0
    ? ((prevClose - days[t - 2].close[code][C]) / days[t - 2].close[code][C]) * 100 : null;
  const pos = high > low ? (close - low) / (high - low) : null;

  let vs = 0, vn = 0;
  for (let i = Math.max(0, t - 19); i <= t; i++) { const v = days[i].close[code]?.[V] ?? 0; if (v > 0) { vs += v; vn++; } }
  const avgVol = vn ? vs / vn : 0;

  let hi20 = 0;
  for (let k = 1; k <= 20; k++) { const v = days[t - k]?.close[code]?.[C] ?? 0; if (v > hi20) hi20 = v; }

  const c5 = days[t - 5]?.close[code]?.[C] ?? 0;

  // 籌碼：取「最近一個有該欄位」的日子，且不得晚於 t
  const mgAt = (i) => { for (let k = i; k >= 0 && k > i - 6; k--) if (days[k].margin) return k; return -1; };
  const m1 = mgAt(t), m2 = m1 > 0 ? mgAt(m1 - 1) : -1;
  const mg = m1 >= 0 ? days[m1].margin[code] : null;
  const mgP = m2 >= 0 ? days[m2].margin[code] : null;

  const inAt = (i) => { for (let k = i; k >= 0 && k > i - 6; k--) if (days[k].inst) return k; return -1; };
  const i1 = inAt(t);
  const inst = i1 >= 0 ? days[i1].inst[code] : null;

  const lnAt = (i) => { for (let k = i; k >= 0 && k > i - 6; k--) if (days[k].lend) return k; return -1; };
  const l1 = lnAt(t), l2 = l1 > 0 ? lnAt(l1 - 1) : -1;
  const ln = l1 >= 0 ? days[l1].lend[code] : null;
  const lnP = l2 >= 0 ? days[l2].lend[code] : null;

  const f = {
    close, vol, chg: +chg.toFixed(2), chg1: chg1 != null ? +chg1.toFixed(2) : null,
    pos: pos != null ? +pos.toFixed(3) : null,
    volX: avgVol > 0 ? +(vol / avgVol).toFixed(2) : null,
    avgVol: Math.round(avgVol),
    brk20: hi20 > 0 ? (close > hi20 ? 1 : 0) : null,
    distHi20: hi20 > 0 ? +(((close / hi20) - 1) * 100).toFixed(2) : null,
    ret5: c5 > 0 ? +(((close / c5) - 1) * 100).toFixed(2) : null,
    amp: high > 0 && low > 0 ? +(((high - low) / prevClose) * 100).toFixed(2) : null,
    gapOpen: row[O] > 0 ? +(((row[O] - prevClose) / prevClose) * 100).toFixed(2) : null,
  };
  if (mg) {
    f.mgn = mg[0]; f.shrt = mg[1];
    f.ratio = mg[0] > 0 ? +((mg[1] / mg[0]) * 100).toFixed(2) : null;
    if (mgP) {
      f.mgnChg = mg[0] - mgP[0];
      f.shrtChg = mg[1] - mgP[1];
      f.shGrow = mgP[1] > 0 ? +(((mg[1] - mgP[1]) / mgP[1]) * 100).toFixed(1) : null;
      f.shVsVol = avgVol > 0 ? +(((mg[1] - mgP[1]) / avgVol) * 100).toFixed(2) : null;
      f.ratioPrev = mgP[0] > 0 ? +((mgP[1] / mgP[0]) * 100).toFixed(2) : null;
    }
  }
  if (inst) {
    f.foreign = inst[0]; f.trust = inst[1];
    f.instNet = (inst[0] || 0) + (inst[1] || 0);
    f.instVsVol = avgVol > 0 ? +((f.instNet / avgVol) * 100).toFixed(2) : null;
  }
  if (ln != null) { f.lend = ln; if (lnP != null) f.lendChg = ln - lnP; }
  // E 段（2026-09-18）：借券
  //   ① lend＝TWT96U「當日可借券賣出股數」（可借額度，不是借券餘額）——當代理：可借供給／均量、額度變化／均量
  //   ② sblJson＝TWT93U／tpex_margin_sbl「借券賣出餘額」（真正的借券餘額，2026-09-18 起逐日歸檔）：餘額／均量、餘額變化／均量
  //   兩者都是 t 日 21:30 後公布 ⇒ 對「t 收買」不是 PIT（只有 t-1 的可用）；這裡一律取 ≤t-1 的最近一筆。
  if (avgVol > 0) {
    const lnAt1 = (i) => { for (let k = i; k >= 0 && k > i - 6; k--) if (days[k].lend) return k; return -1; };
    const a1 = lnAt1(t - 1), a2 = a1 > 0 ? lnAt1(a1 - 1) : -1;
    const q1 = a1 >= 0 ? days[a1].lend[code] : null, q2 = a2 >= 0 ? days[a2].lend[code] : null;
    if (q1 != null) { f.lendVsVol = +((q1 / 1000) / avgVol).toFixed(4); if (q2 != null) f.lendChgVsVol = +(((q1 - q2) / 1000) / avgVol).toFixed(4); }
    const sbAt = (i) => { for (let k = i; k >= 0 && k > i - 6; k--) if (days[k].sbl) return k; return -1; };
    const b1 = sbAt(t - 1), b2 = b1 > 0 ? sbAt(b1 - 1) : -1;
    const s1 = b1 >= 0 ? days[b1].sbl[code]?.[0] : null, s2 = b2 >= 0 ? days[b2].sbl[code]?.[0] : null;
    if (s1 != null) { f.sblVsVol = +(s1 / avgVol).toFixed(4); if (s2 != null) f.sblChgVsVol = +((s1 - s2) / avgVol).toFixed(4); }
  }
  return f;
}

/** 標的：隔日開盤/收盤/是否漲停/是否軋空。t+1 必須存在。 */
export function buildLabels(days, t, code) {
  const cur = days[t].close[code], nx = days[t + 1]?.close[code];
  if (!cur || !nx) return null;
  const c0 = cur[C], o1 = nx[O], c1 = nx[C];
  if (!(c0 > 0) || !(c1 > 0)) return null;
  const tick = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
  const lim = (() => { const raw = c0 * 1.1; const tk = tick(raw); return Math.floor(raw / tk + 1e-9) * tk; })();
  // 隔日融券是否下降（真軋空＝空單被迫回補，而不只是價格漲）
  const mgAt = (i) => { for (let k = i; k >= 0 && k > i - 6; k--) if (days[k].margin) return k; return -1; };
  const a = mgAt(t + 1), b = a > 0 ? mgAt(a - 1) : -1;
  const sNow = a >= 0 ? days[a].margin[code]?.[1] : null;
  const sPrev = b >= 0 ? days[b].margin[code]?.[1] : null;
  const covered = sNow != null && sPrev != null ? (sNow < sPrev ? 1 : 0) : null;
  const openRet = o1 > 0 ? +(((o1 - c0) / c0) * 100).toFixed(2) : null;
  const closeRet = +(((c1 - c0) / c0) * 100).toFixed(2);
  // ⚠ 可買性：隔日**開盤即漲停鎖死**就買不到，那筆報酬是紙上富貴。
  //   本站早有此教訓（漲停前夜解剖：43% 的前夜自己就是鎖死日、收盤買不到）。
  //   模型若不扣掉不可買的，會系統性高估——因為漲最兇的那些正好是買不到的。
  const buyable = o1 > 0 ? (o1 < lim - 1e-6 ? 1 : 0) : null;
  // ── v2（2026-09-17 規則重規畫 §2.1）：交易定義分兩套，各自的「進場可買」不同 ──
  //   隔日沖：t 收買→t+1 開賣。進場限制是 **t 日收盤是否鎖漲停**（鎖停買不到）；t+1 開盤鎖停是最佳出場，不剔除。
  //   當沖  ：t+1 開買→t+1 收賣。進場限制是 t+1 開盤未鎖停（＝既有 buyable）；報酬 dtRet。
  const p1 = days[t - 1]?.close[code];
  const limT = p1?.[C] > 0 ? (() => { const raw = p1[C] * 1.1; const tk = tick(raw); return Math.floor(raw / tk + 1e-9) * tk; })() : null;
  const entryLocked = limT != null ? (c0 >= limT - 1e-6 ? 1 : 0) : null;
  const dtRet = o1 > 0 ? +(((c1 - o1) / o1) * 100).toFixed(2) : null;
  // 波段持有（使用者 2026-09-17 加）：t 收買 → t+5 收賣；t+5 未到就 null（樣本尾端）
  const c5 = days[t + 5]?.close[code]?.[C];
  const hold5Ret = c5 > 0 ? +(((c5 - c0) / c0) * 100).toFixed(2) : null;
  return {
    openRet, closeRet, buyable,
    entryLocked,                       // 1＝t 日收盤鎖漲停（隔日沖／波段買不到）
    dtRet,                             // 當沖口徑：t+1 開→t+1 收
    hold5Ret,                          // 波段口徑：t 收→t+5 收
    openRetBuyable: buyable === 1 ? openRet : null,
    limitUp: c1 >= lim - 1e-6 ? 1 : 0,
    squeeze: closeRet >= 5 && covered === 1 ? 1 : 0,   // 漲≥5% 且融券真的減少
    covered,
  };
}
