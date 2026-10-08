// ─────────────────────────────────────────────────────────────────────────
// 上櫃收盤讀者端的小工具（2026-10-08；從 ai-daemon.mjs 抽出，讓 daemon 的接線有自動測試——審查 LOW）
//   raceWithin：熱路徑／串行班車最多等 ms，下載不中止（背景繼續、完成後寫共用快取，下一輪 0 請求命中）。
//   createSharesCache：發行股數表（上市 t187ap03_L＋上櫃 Capitals）——兩市都到才算當日完整；
//     不完整時疊在上一份完整表上回傳（股數是慢變數），retryMs 後再試。
//   只用語言內建功能；不碰網路與檔案（fetch 由呼叫端注入）。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 等 promise 最多 ms：先完成就回它的結果；逾時回 onSlow()（promise 照跑，不中止）；promise 丟錯回 { status:'failed', reason }。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => any} onSlow
 */
export async function raceWithin(promise, ms, onSlow) {
  promise.catch(() => {});   // 逾時後才丟錯也不可變成 unhandled rejection
  let timer = null;
  const slow = new Promise(res => { timer = setTimeout(() => res(onSlow()), ms); });
  try { return await Promise.race([promise, slow]); }
  catch (e) { return { status: 'failed', rows: null, reason: String(e?.message || e || '').slice(0, 80) }; }
  finally { clearTimeout(timer); }
}

/**
 * 發行股數快取。
 * @param {{ fetchTse: () => Promise<Record<string, number>>, fetchOtc: () => Promise<Record<string, number>>,
 *           today: () => string, now?: () => number, retryMs?: number, minTse?: number, minOtc?: number, log?: Function }} deps
 *   fetchTse／fetchOtc：回 {代號: 股數}；丟錯視為該市場缺。today()：台北日曆日（當日完整快取的鍵）。
 */
export function createSharesCache({ fetchTse, fetchOtc, today, now = Date.now, retryMs = 10 * 60_000, minTse = 500, minOtc = 300, log = () => {} }) {
  let full = { day: '', map: null };          // 最近一份兩市都到的表
  let partial = { map: null, nextTry: 0 };    // 不完整時疊好的表與下次重試時刻
  return async function getShares() {
    const day = today();
    if (full.day === day && full.map) return full.map;
    if (partial.map && now() < partial.nextTry) return partial.map;
    const map = {}; let nTse = 0, nOtc = 0;
    try { for (const [c, n] of Object.entries((await fetchTse()) || {})) if (n > 0) { map[c] = n; nTse++; } } catch { /* 上市缺→僅上櫃 */ }
    try { for (const [c, n] of Object.entries((await fetchOtc()) || {})) if (n > 0 && !map[c]) { map[c] = n; nOtc++; } } catch { /* 上櫃缺 */ }
    if (nTse > minTse && nOtc > minOtc) { full = { day, map }; partial = { map: null, nextTry: 0 }; return map; }
    const merged = { ...(full.map || {}), ...map };
    partial = { map: merged, nextTry: now() + retryMs };
    log(`  ⚠ 發行股數表不完整（上市 ${nTse}／上櫃 ${nOtc}）${full.map ? `，疊在 ${full.day} 的完整表上` : ''}；${Math.round(retryMs / 60_000)} 分鐘後重試`);
    return merged;
  };
}
