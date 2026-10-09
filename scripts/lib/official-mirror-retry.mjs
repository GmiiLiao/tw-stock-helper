// ── 官方鏡像「被擋就隔一段時間再試」共用迴圈（2026-10-09 全站掃描第 1 項）──────────────────────────
// daily 被開跑閘門擋下的當晚重試、retry（06:45）被擋的 15 分鐘重試、daily／retry 拿不到鏡像鎖的 5 分鐘等鎖，三者共用這一個流程；
// 純流程（sleep／stopReason／now 皆可注入），單元測試見 official-mirror-retry.test.mjs。

/** 各指令被擋時的重試參數（gapMs＝每輪間隔、maxRounds＝最多「再試」幾輪，不含第一次）。 */
export const GATE_RETRY = {
  daily: { gapMs: 30 * 60 * 1000, maxRounds: 5 },   // 22:40 起每 30 分鐘、最多 5 輪（2026-10-09 已上線的當晚重試，參數不變）
  retry: { gapMs: 15 * 60 * 1000, maxRounds: 3 },   // 06:45 起每 15 分鐘、最多 3 輪；07:30 禁跑窗（平日）即停
};
/** 拿不到鏡像鎖時的等鎖參數：每 5 分鐘再試一次，最多等 maxWaitMs（也受禁跑窗限制）。 */
export const LOCK_WAIT = {
  daily: { gapMs: 5 * 60 * 1000, maxWaitMs: 2 * 3600 * 1000 },   // 22:40 起最多等 2 小時（日期已釘住，跨午夜不會改抓隔日）
  retry: { gapMs: 5 * 60 * 1000, maxWaitMs: 45 * 60 * 1000 },    // 06:45 起最多等到約 07:30
};
/** 拿不到鎖時只讓路、不等待的指令（只記 log）。 */
export const LOCK_YIELD_CMDS = ['backfill', 'ticks', 'verify', 'migrate'];

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * attempt(round) 回傳 true＝完成（不需再試）、false＝被擋。round 從 0 起算；最多再試 maxRounds 輪（總嘗試 maxRounds+1 次）。
 * 每次等待 gapMs 之後先問 stopReason()：真值（禁跑窗等）就停、不再嘗試；beforeRetry(round) 在每次再試前呼叫（例如重置佇列）。
 * 回傳 { done, attempts, stopped }：stopped＝null（完成）｜'max'（達上限）｜stopReason 的回傳值。
 */
export async function retryWhileBlocked({ attempt, gapMs, maxRounds, stopReason = () => null, sleep = defaultSleep, beforeRetry = () => {} }) {
  if (!(Number.isFinite(gapMs) && gapMs >= 0 && Number.isInteger(maxRounds) && maxRounds >= 0)) throw new Error('retryWhileBlocked：gapMs／maxRounds 不合法');
  for (let round = 0; ; round++) {
    if (await attempt(round)) return { done: true, attempts: round + 1, stopped: null };
    if (round >= maxRounds) return { done: false, attempts: round + 1, stopped: 'max' };
    await sleep(gapMs);
    const why = stopReason();
    if (why) return { done: false, attempts: round + 1, stopped: why };
    await beforeRetry(round + 1);
  }
}

/** 等鎖最多幾輪：maxWaitMs／gapMs 取整（至少 0）。 */
export const lockWaitRounds = ({ gapMs, maxWaitMs }) => Math.max(0, Math.floor(maxWaitMs / gapMs));
