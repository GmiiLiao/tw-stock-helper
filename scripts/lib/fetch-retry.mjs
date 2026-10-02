// ─────────────────────────────────────────────────────────────────────────────
// 上游重試與連續失敗警示（2026-10-02 第三期）
//   使用者：「上市失敗時應重新取得資料補測試，多次未成功時出警示」。
//   實案：15:53 重啟與 17:40 手動執行時，STOCK_DAY_ALL（www）與 TPEx openapi 在程序啟動當下同時回 terminated，
//   舊版只試一次、且沒有逾時 ⇒ 上市失敗時上櫃後備拿不到日期，宇宙整批缺上櫃 11 分鐘。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 重新取得：fn(第幾次) 丟錯或回傳不符 isOk 都算失敗，依 delays 等待後重試。
 * @returns {Promise<{ok:boolean, value:any, tries:number, error?:Error}>}
 */
export async function withRetry(fn, { attempts = 3, delays = [2000, 5000], sleep = ms => new Promise(r => setTimeout(r, ms)), isOk = v => v != null } = {}) {
  let lastErr = null, v = null;
  for (let i = 0; i < attempts; i++) {
    try { v = await fn(i); if (isOk(v)) return { ok: true, value: v, tries: i + 1 }; lastErr = null; }
    catch (e) { lastErr = e; }
    if (i < attempts - 1) await sleep(delays[Math.min(i, delays.length - 1)]);
  }
  return { ok: false, value: v, tries: attempts, ...(lastErr ? { error: lastErr } : {}) };
}

/** 連續失敗計數：達門檻那一輪 alert=true（同一段連續失敗只警示一次）；成功歸零 */
export function failStreak(prev, ok, threshold = 3) {
  const n = ok ? 0 : (prev || 0) + 1;
  return { n, alert: !ok && n === threshold };
}

/**
 * 策略選股「連續鎖漲停天數」是否為同一資料日重算（是＝沿用前一日的連續數，不再 +1）。
 * 舊版用日曆日（prev.date === 今天）：週末／假日開機時資料日沒變、日曆日變了 ⇒ 每次開機再 +1（審查 2026-10-02）。
 * rowsDate＝本輪收盤資料日（YYYYMMDD）；舊文件沒有 lockDataDate、或本輪資料日不明時退回日曆日判斷。
 */
export function sameLockDay(prev, rowsDate, todayIso) {
  if (!prev) return false;
  if (prev.lockDataDate && rowsDate) return prev.lockDataDate === rowsDate;
  return prev.date === todayIso;
}
