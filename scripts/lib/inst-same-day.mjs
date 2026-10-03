// ─────────────────────────────────────────────────────────────────────────────
// 三重確認的法人口徑：法人資料（chipDaily 最新一筆）是否與榜單價格同一天——純函式
//
//   714ca08a（2026-07-27「三重確認 PIT 口徑分歧」）的設計：盤中法人＝t-1（與回測同口徑）→ 對應「今日收盤買」；
//   16:30 T86 公布後法人＝t → 對應「明日買進」。computeTopicPicks 的 evidence／UI 標示、computeSwingPicks 的
//   「當日法人」caveat 都依此切換。
//   舊判定 `instDate === 歸檔末日`：盤中歸檔末日是昨天、最新法人也是昨天 ⇒ 盤中恆為 true，與設計相反
//   （話題榜整個盤中標「含今日T86 → 明日買進」、波段起漲榜整個盤中掛「今日採用的是『當日』法人」）。
//   正解是比「價格代表哪一天」：快照模式（liveDay，歸檔還沒有今天）＝今天，歸檔模式＝歸檔末日。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ instDate: string|null|undefined, liveDay: boolean, today: string, lastArchiveDay: string }} p
 *   instDate＝chipDaily 最新一筆的日期；liveDay＝榜單序列末端接了今日快照偽 K（ai-daemon.mjs boardLiveBar）；
 *   today＝台北日曆今天；lastArchiveDay＝歸檔收盤序列的最後一天（YYYY-MM-DD）
 * @returns {boolean} true＝法人與價格同一天（盤後 T86 已含價格日）
 */
export function instIsSameDay({ instDate, liveDay, today, lastArchiveDay }) {
  const priceDay = liveDay ? today : lastArchiveDay;
  return !!instDate && instDate === priceDay;
}
