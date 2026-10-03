// ─────────────────────────────────────────────────────────────────────────────
// 波段起漲空頭日 gate 的市場寬度（上漲家數比）——純函式，ai-daemon.mjs computeSwingPicks 使用
//
//   口徑與回測同（scripts/audit-regime.mjs）：4 碼普通股（00 開頭 ETF 除外）中「今日收盤 > 前一交易日收盤」的比例；
//   今日或前日缺價者不計，平盤計入分母、不算上漲；有效家數 < 500 ⇒ 寬度不足。<50% ＝空頭日。
//   「今日／前日」隨模式不同：
//     歸檔模式（liveDay=false，arch[L]＝最後一個已收盤歸檔的交易日）：今日＝arch[L]、前日＝arch[L-1]
//     快照模式（liveDay=true，今日盤已開始而歸檔還沒有今天，arch[L] 是前一交易日）：今日＝快照價、前日＝arch[L]
//   2026-10-03 修：舊版快照模式仍取 arch[L-1]（前天）當前日 ⇒ 盤中寬度其實是「即時價對前天」。
//     2026-10-01 實案：09-30 是 68.9% 上漲日，盤中各輪算出 61.7–66.8%（多頭日⚠），收盤後才是 38.7%（空頭日）
//     ⇒ 整個盤中 gate 寫「今日為多頭日…本日不建議進場」、13:08 行動窗也照推，⭐⭐⭐（需空頭日）盤中全被壓掉。
//   ⚠ liveDay 的前提：快照確實是 arch[L] 之後的交易時段——由 ai-daemon.mjs 的 boardLiveBar（lib/board-live-bar.mjs
//     needsLiveBar：交易日∧≥09:00∧歸檔無今天）判定。若快照仍是 arch[L] 那天的收盤卻當成快照模式，
//     今日與前日是同一份 ⇒ 寬度≈0%、誤判空頭日（2026-10-03 前的 liveDay 在 00:00–09:00 就會這樣）。
// ─────────────────────────────────────────────────────────────────────────────

/** 有效家數下限：不足就不判多空（回測同門檻） */
export const BREADTH_MIN_TOTAL = 500;

const isCommonStock = code => /^\d{4}$/.test(code) && !code.startsWith('00');

/**
 * @param {{ arch: Array<{ date: string, close: Record<string, number[]> }>,
 *           quotes?: Record<string, { price?: number|null }>, liveDay: boolean }} p
 *   arch＝舊→新的歸檔收盤（close[code][0]＝收盤價）；quotes＝快照報價（只在 liveDay 時使用）
 * @returns {{ breadth: number|null, bearDay: boolean|null, up: number, tot: number }}
 *   breadth＝上漲家數比 %（一位小數）；bearDay＝breadth < 50
 */
export function swingBreadth({ arch, quotes = {}, liveDay }) {
  const L = arch.length - 1;
  const last = arch[L]?.close || {};
  const prev = arch[liveDay ? L : L - 1]?.close || {};
  let up = 0, tot = 0;
  for (const code in last) {
    if (!isCommonStock(code)) continue;
    const cPrev = prev[code]?.[0];
    const cNow = liveDay ? (quotes[code]?.price ?? null) : last[code]?.[0];
    if (cNow > 0 && cPrev > 0) { tot++; if (cNow > cPrev) up++; }
  }
  const breadth = tot >= BREADTH_MIN_TOTAL ? +(up / tot * 100).toFixed(1) : null;
  return { breadth, bearDay: breadth != null ? breadth < 50 : null, up, tot };
}
