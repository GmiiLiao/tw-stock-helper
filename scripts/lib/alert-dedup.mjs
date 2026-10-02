// ─────────────────────────────────────────────────────────────────────────────
// 通知去重（持久化）——2026-10-02 第二期
//   舊版每個通知各有一組記憶體 Set（`_xAlerted`＋`_xDay` 每日清空）：daemon 一重啟就清空，開機重跑每日工作與盤中迴圈
//   會把當天已推過的 Web Push／Telegram 再推一次（ETF 折溢價、停損紀律、除權息、ADR、族群預警…；一天被重啟三次就三次）。
//   這裡把「已發過」寫進持久層：scope（通常是日期）換了才重新計算；重啟後先讀回再判斷。
//   store 介面（daemon 以 Firestore alertDedup/{name}_{scope} 實作）：
//     load(name, scope) → string[]；add(name, scope, key)（冪等）；replace(name, scope, keys)
//   失敗一律不擋通知：讀不到就退回記憶體（與舊行為相同），寫不進去也照發。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} name 通知種類（文件名前綴）
 * @param {{load:Function, add:Function, replace:Function}} store
 * @param {{ prune?: (key:string, today:string) => boolean }} [opts] 固定 scope 的跨日事件：載入時只保留 prune 為 true 的鍵
 */
export function createAlertDedup(name, store, { prune = null } = {}) {
  let scope = null, keys = new Set(), loadedOk = false;
  return {
    /** 每次使用前呼叫（取代舊的「換日清空」）；scope 相同且已讀成功時不重讀 */
    async ensure(sc, today = sc) {
      if (scope === sc && loadedOk) return;
      if (scope !== sc) keys = new Set();
      scope = sc;
      let arr;
      try { arr = await store.load(name, sc); loadedOk = true; } catch { loadedOk = false; return; }
      if (prune) {
        const kept = arr.filter(k => prune(k, today));
        if (kept.length !== arr.length) store.replace(name, sc, kept).catch(() => {});
        arr = kept;
      }
      for (const k of arr) keys.add(k);
    },
    has: k => keys.has(k),
    /** 記一筆；回傳 true＝第一次（呼叫端照發），false＝已發過 */
    add(k) {
      if (keys.has(k)) return false;
      keys.add(k);
      if (scope != null) Promise.resolve().then(() => store.add(name, scope, k)).catch(() => {});
      return true;
    },
  };
}
