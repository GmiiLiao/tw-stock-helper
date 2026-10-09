// ─────────────────────────────────────────────────────────────────────────────
// daemon 跑舊碼的自動換碼判定（2026-10-09 使用者裁定「要標上，跑舊碼就修正它」·WM-SCAN G4-42／G4-43）
//   disk 即部署：launchd KeepAlive 會在 daemon 結束後拉起**磁碟上的版本**。所以「修正」＝在安全時刻自行結束、由 launchd 換碼。
//   純函式：不讀時鐘、不讀檔、不碰 Firestore；呼叫端給齊條件。五道條件全部成立才換碼，任一不成立就等下一輪：
//     ① 落後已持續 DRIFT_SETTLE_MIN 分鐘（磁碟正在被編輯時不要追著半成品跑）
//     ② 雜湊涵蓋的檔案在 git 都是乾淨的（只換到已 commit 的版本；pre-commit 擋語法）
//     ③ can-restart-daemon 放行（觀察窗、上游故障）
//     ④ 沒有進行中的工作（timedJob／execScript 計數為 0）
//     ⑤ 落在安全時段：交易日 10:10–13:15、14:00–15:00；非交易日 12:00–16:00（避開夜間新聞判別、訓練、備份與盤前窗）
//   開機後 MIN_UPTIME_MIN 分鐘內不換（剛啟動的開機補跑還在進行），且一次程序生命只換一次（換完就是新程序）。
// ─────────────────────────────────────────────────────────────────────────────

export const DRIFT_SETTLE_MIN = 30;
export const MIN_UPTIME_MIN = 20;
export const SAFE_SLOTS = Object.freeze({
  trading: Object.freeze([[10 * 60 + 10, 13 * 60 + 15], [14 * 60, 15 * 60]]),
  nonTrading: Object.freeze([[12 * 60, 16 * 60]]),
});

export const inSafeSlot = (mins, isTradingDay) =>
  (isTradingDay ? SAFE_SLOTS.trading : SAFE_SLOTS.nonTrading).some(([a, b]) => mins >= a && mins < b);

/**
 * @param {{ runningHash:string|null, diskHash:string|null, driftSinceMs:number|null, nowMs:number, startedAtMs:number,
 *           clean:boolean|null, canRestart:boolean|null, inflight:number, mins:number, isTradingDay:boolean }} p
 * @returns {{ restart:boolean, reason:string }}
 */
export function driftHealVerdict(p) {
  if (!p.runningHash || !p.diskHash) return { restart: false, reason: '雜湊未知' };
  if (p.runningHash === p.diskHash) return { restart: false, reason: '執行中＝磁碟' };
  if (p.driftSinceMs == null || p.nowMs - p.driftSinceMs < DRIFT_SETTLE_MIN * 60_000) return { restart: false, reason: `落後未滿 ${DRIFT_SETTLE_MIN} 分` };
  if (p.nowMs - p.startedAtMs < MIN_UPTIME_MIN * 60_000) return { restart: false, reason: `開機未滿 ${MIN_UPTIME_MIN} 分` };
  if (p.clean !== true) return { restart: false, reason: p.clean === false ? '磁碟有未 commit 的 daemon 程式' : 'git 狀態未知' };
  if (!inSafeSlot(p.mins, p.isTradingDay)) return { restart: false, reason: '不在安全時段' };
  if (p.inflight > 0) return { restart: false, reason: `有 ${p.inflight} 個工作進行中` };
  if (p.canRestart !== true) return { restart: false, reason: 'can-restart-daemon 不放行' };
  return { restart: true, reason: '跑舊碼且五道條件成立' };
}
