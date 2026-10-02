// ─────────────────────────────────────────────────────────────────────────────
// 通知去重（持久化）——2026-10-02 第二期
//   舊版每個通知各有一組記憶體 Set（`_xAlerted`＋`_xDay` 每日清空）：daemon 一重啟就清空，開機重跑每日工作與盤中迴圈
//   會把當天已推過的 Web Push／Telegram 再推一次（ETF 折溢價、停損紀律、除權息、ADR、族群預警…；一天被重啟三次就三次）。
//   這裡把「已發過」寫進持久層：scope（通常是日期）換了才重新計算；重啟後先讀回再判斷。
//   store 介面（daemon 以 Firestore alertDedup/{name}_{scope} 實作）：
//     load(name, scope) → string[]；addMany(name, scope, keys)（冪等）；replace(name, scope, keys)
//   寫入：add 先記在記憶體與暫存，flush 一次批次寫入（審查 M2：熱門文件不可每筆一寫）。
//     autoFlush（預設）＝add 後延遲 flushDelay 合併寫出；高價值通知用 autoFlush:false＋mark/rollback：
//     通知文件寫入成功才 flush，失敗 rollback（審查 M1：不可「還沒送出就記成已送」）。
//   失敗一律不擋通知：讀不到就退回記憶體（與舊行為相同），寫不進去也照發；以 onError 回報。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} name 通知種類（文件名前綴）
 * @param {{load:Function, addMany:Function, replace:Function}} store
 * @param {{ prune?: (key:string, today:string) => boolean, autoFlush?: boolean, flushDelay?: number,
 *           onError?: (op:string, e:Error) => void, timers?: {setTimeout:Function, clearTimeout:Function} }} [opts]
 *   prune：固定 scope 的跨日事件，每天（today 改變時）只保留 prune 為 true 的鍵並寫回
 */
export function createAlertDedup(name, store, { prune = null, autoFlush = true, flushDelay = 2000, onError = null,
  timers = { setTimeout, clearTimeout } } = {}) {
  let scope = null, keys = new Set(), loadedOk = false, pending = [], timer = null, prunedFor = null;
  const err = (op, e) => { try { onError?.(op, e); } catch { /* 回報失敗不影響 */ } };
  const flush = async () => {
    if (timer) { timers.clearTimeout(timer); timer = null; }
    if (!pending.length || scope == null) return;
    const batch = pending, sc = scope; pending = [];
    try { await store.addMany(name, sc, batch); }
    catch (e) { err('add', e); if (scope === sc) pending = batch.concat(pending); }   // 寫入失敗放回暫存，下次 flush 再寫（審查 LOW）
  };
  return {
    /** 每次使用前呼叫（取代舊的「換日清空」）；scope 相同且已讀成功時不重讀 */
    async ensure(sc, today = sc) {
      if (scope !== sc) {
        if (pending.length) await flush();   // 換日前的暫存先寫出（屬於舊 scope）
        scope = sc; keys = new Set(); loadedOk = false; prunedFor = null;
      }
      if (!loadedOk) {
        let arr;
        try { arr = await store.load(name, sc); } catch (e) { err('load', e); return; }
        loadedOk = true;
        for (const k of arr) keys.add(k);
      }
      if (prune && prunedFor !== today) {
        prunedFor = today;
        const kept = [...keys].filter(k => prune(k, today));
        if (kept.length !== keys.size) {
          keys = new Set(kept); pending = pending.filter(k => keys.has(k));
          try { await store.replace(name, sc, kept); } catch (e) { err('replace', e); }
        }
      }
    },
    has: k => keys.has(k),
    /** 記一筆；回傳 true＝第一次（呼叫端照發），false＝已發過 */
    add(k) {
      if (keys.has(k)) return false;
      keys.add(k); pending.push(k);
      if (autoFlush && !timer) { timer = timers.setTimeout(() => { timer = null; flush(); }, flushDelay); timer?.unref?.(); }
      return true;
    },
    /** 撤回點：之後 add 的鍵可用 rollback 取消（通知寫入失敗時） */
    mark: () => pending.length,
    rollback(tok) { for (const k of pending.splice(tok)) keys.delete(k); },
    flush,
    keys: () => [...keys],
  };
}
