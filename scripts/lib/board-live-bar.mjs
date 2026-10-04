// ─────────────────────────────────────────────────────────────────────────────
// 榜單的「今日快照偽 K」判定（2026-10-03）
//
//   波段起漲／話題×5日線／持股 RSI 高檔警示在「歸檔還沒有今天」時，把快照價接在歸檔收盤序列後面當今天的一根 K，
//   量比改用快照量÷歸檔最後一日量。舊判定只看「交易日 ∧ 歸檔末日≠日曆今天」——平日 00:00–09:00 也成立
//   （日曆已是 D+1、歸檔末日是 D、快照裡仍是 D 的收盤）⇒ D 的收盤被再接一次當 D+1、量比≈1 或 0，
//   量比>1.5 濾網幾乎全擋：sectorLoop 每 30 分鐘把 swingPicks/latest 蓋成空榜
//   （daemon log 2026-09-30T16:28Z 起整夜 ⭐0/⭐⭐0/⭐⭐⭐0，直到開盤）。
//   這裡是純函式；時鐘、休市日曆與歸檔在 ai-daemon.mjs 讀。
// ─────────────────────────────────────────────────────────────────────────────

/** 今日盤開始（台北·自午夜起的分鐘）——與 market-clock 的開盤同一刻；08:30–09:00 試撮沒有成交，不算 */
export const SESSION_OPEN_MIN = 9 * 60;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 是否要在歸檔收盤序列後面接「今日」快照偽 K：今天是交易日 ∧ 今日盤已開始（≥09:00）∧ 歸檔還沒有今天。
 *   09:00 起到收盤歸檔（約 15:10，晚到時更晚、最遲到當日 23:59）——今日的價量只在快照裡 ⇒ 接。
 *   00:00–09:00、非交易日 ⇒ 快照裡是最後一個交易日的收盤，歸檔也已有那一天 ⇒ 不接（否則同一天被算兩次）。
 *   歸檔晚到跨過午夜：午夜後改用歸檔最後一日（資料日標籤也同樣退回那一天，內容與標籤一致）。
 * ⚠ 這不是「盤中」：13:30 收盤後到歸檔前也成立。盤中與否看快照的 marketOpen。
 * @param {{ tradingDay: boolean, minutes: number, today: string, lastArchiveDay: string|null|undefined }} p
 *   minutes＝台北時間自午夜起的分鐘；today／lastArchiveDay＝YYYY-MM-DD
 */
export function needsLiveBar({ tradingDay, minutes, today, lastArchiveDay }) {
  return !!tradingDay && minutes >= SESSION_OPEN_MIN && ISO_DAY.test(lastArchiveDay ?? '') && lastArchiveDay < today;
}

/**
 * 這檔「現價」那根 K 在歸檔收盤序列（舊→新，末索引 lastIdx）裡的索引（WM-SCAN G2-35·2026-10-04）。
 *   現價取自快照即時報價（live）且今日盤尚未歸檔（liveDay＝needsLiveBar）⇒ 虛擬的 lastIdx+1；
 *   其餘（非盤中用歸檔收盤當現價、週末／開盤前、或今日已歸檔）⇒ lastIdx。
 * 舊寫法 `歸檔末日 === 日曆今天 ? L : L+1` 在週末與平日 00:00–09:00 會把 L 當成「昨天」，
 *   於是 5 日漲幅只算 4 日、昨日漲幅恆為 0（現價與前日價都取自歸檔 L／L-1 時）。
 * @param {{ liveDay: boolean, live: boolean, lastIdx: number }} p
 */
export function priceBarIndex({ liveDay, live, lastIdx }) {
  return live && liveDay ? lastIdx + 1 : lastIdx;
}

/**
 * 以現價那根 K 的索引 idx 算「5 日漲幅」與「昨日漲幅」。
 *   ret5＝現價 ÷ idx-5 收盤（滿 5 個交易日）；prevChg＝前日收盤 prev ÷ idx-2 收盤。
 * @param {{ closeMaps: Array<Record<string, number[]>>, code: string, idx: number, price: number, prev: number }} p
 * @returns {{ ret5: number|null, prevChg: number|null }}
 */
export function lookbackChanges({ closeMaps, code, idx, price, prev }) {
  const closeAt = (k) => closeMaps[k]?.[code]?.[0];
  const b5 = closeAt(idx - 5), pp = closeAt(idx - 2);
  return {
    ret5: b5 > 0 && price > 0 ? +((price / b5 - 1) * 100).toFixed(1) : null,
    prevChg: pp > 0 && prev > 0 ? +((prev / pp - 1) * 100).toFixed(2) : null,
  };
}
