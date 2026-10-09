// ─────────────────────────────────────────────────────────────────────────────
// 榜單用的官方除權息係數（2026-10-09 移植 claude/exright-consumers ad5a3be 的意圖；實作改為重用 main 既有來源）
//   起因：priceEvents/latest 只收相鄰收盤 ±20% 的結構事件，一般除權息（1~6%）從未還原 ⇒ 做空候選／dailySeq／波段持有
//   在除權息日呈假跌幅（量測：docs/EXRIGHT-IMPACT-2026-09-30.md）。
//   來源與合併一律重用既有函式，不另做第三份：
//     · scripts/data/exright-history.json（backfill-exright-history.mjs 回補檔）＋檔尾隔日到資料日的官方區間（fetchExright：
//       上市 TWT49U＋上櫃 exDailyQ 各 1 次）——與停損影子（stop-shadow-runner）同一套 exFetchRange／exItemsMerge。
//     · 不寫 Firestore、不新增集合：結果只在 daemon 記憶體，依資料日快取。上游請求＝每個資料日成功一次（2 個請求），
//       與線上人數無關；失敗 retryMs 內不重打（呼叫端以 ok=false 揭露、照算）。
//   fetch（記憶化的 fetchExright）可注入給其他同口徑的呼叫端（停損影子），同區間不重複打上游。
//   純邏輯在 adjustItemsFor（無 I/O，可單元測試）。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { exFetchRange, exItemsMerge } from './stop-shadow-core.mjs';

export const EXRIGHT_RETRY_MS = 10 * 60_000;
// 成功結果保留 24 小時：區間終點 ≤ 資料日的除權息官方前一晚就公布，事後不會再長出列（隔日盤中的做空候選仍用昨日區間 ⇒ 不重打）
export const EXRIGHT_MEMO_MS = 24 * 3600_000;

/**
 * 合併後的係數清單（factorsFromItems 可吃）＋揭露用 meta。只收事件日 ≤ asOf：
 *   官方前一晚就公布隔日的除權息，未來事件乘進去會把最新收盤改成參考價（ad5a3be 的 asOf 規矩）。
 *   events 落在 (−∞, from] 的對 [from, asOf] 這段日線沒有作用，保留無害；meta 只數 (from, asOf] 內的。
 * @param {{history:object|null, recent:Array|null, recentRange:object|null, priceFactors:object|null, from:string, asOf:string}} p
 * @returns {{ items:Array<{date,code,factor}>, meta:{ exright:number, exrightOk:boolean, exrightTo:string|null } }}
 */
export function adjustItemsFor({ history, recent = null, recentRange = null, priceFactors = null, from, asOf }) {
  const merged = exItemsMerge({ history, recent, recentRange, priceFactors });
  if (!merged) {
    // 歷史檔讀不到 ⇒ 只剩 priceEvents（與舊行為相同），揭露 exrightOk=false
    const pe = [];
    for (const [code, evs] of Object.entries(priceFactors || {})) for (const e of evs || []) if (e?.factor > 0 && e.date <= asOf) pe.push({ date: e.date, code, factor: e.factor });
    return { items: pe, meta: { exright: 0, exrightOk: false, exrightTo: null } };
  }
  const exOnly = exItemsMerge({ history, recent, recentRange, priceFactors: null });
  const exCodes = new Set(exOnly.items.filter(e => e.date > from && e.date <= asOf).map(e => e.code));
  return {
    items: merged.items.filter(e => e.date <= asOf),
    meta: { exright: exCodes.size, exrightOk: merged.cover.from <= from && merged.cover.to >= asOf, exrightTo: merged.cover.to },
  };
}

/**
 * daemon 用：讀歷史檔（一次）＋依資料日補抓檔尾之後的官方區間。
 * @param {{ readHistory:()=>object, fetchExright:(from,to)=>Promise<{items:Array}>, log?:Function, now?:()=>number }} deps
 */
export function createExrightCover({ readHistory, fetchExright, log = () => {}, now = () => Date.now(), retryMs = EXRIGHT_RETRY_MS, memoMs = EXRIGHT_MEMO_MS }) {
  let history; // undefined＝未讀；null＝讀取失敗（不重讀，daemon 重啟才重讀——檔案隨程式碼部署）
  const memo = new Map();       // `${from}:${to}` → { at, value }
  const failAt = new Map();     // `${from}:${to}` → 失敗時間
  const inflight = new Map();

  function getHistory() {
    if (history === undefined) {
      try { history = readHistory(); } catch (e) { history = null; log(`⚠ 官方除權息歷史檔讀不到（榜單只用 priceEvents 還原並揭露）：${(e?.message || '').slice(0, 80)}`); }
    }
    return history;
  }

  /** 記憶化的 fetchExright：成功結果保留 memoMs；失敗 retryMs 內同區間直接丟錯、不打上游 */
  async function fetch(from, to) {
    const k = `${from}:${to}`;
    const hit = memo.get(k);
    if (hit && now() - hit.at < memoMs) return hit.value;
    if (failAt.has(k) && now() - failAt.get(k) < retryMs) throw new Error(`官方除權息 ${from}~${to} 稍早取不到（${Math.round(retryMs / 60000)} 分鐘內不重打）`);
    if (inflight.has(k)) return inflight.get(k);
    const p = (async () => {
      try {
        const value = await fetchExright(from, to);
        for (const [mk, mv] of memo) if (now() - mv.at >= memoMs) memo.delete(mk);
        memo.set(k, { at: now(), value }); failAt.delete(k);
        return value;
      } catch (e) { failAt.set(k, now()); throw e; } finally { inflight.delete(k); }
    })();
    inflight.set(k, p);
    return p;
  }

  /** (history, recent, recentRange)：recent 取不到時為 null（exItemsMerge 會把涵蓋停在歷史檔尾＝fail-closed 揭露） */
  async function sourcesFor(asOf) {
    const h = getHistory();
    if (!h) return { history: null, recent: null, recentRange: null, error: '歷史檔讀不到' };
    const range = exFetchRange(h, asOf);
    if (!range) return { history: h, recent: null, recentRange: null, error: null };
    try { return { history: h, recent: (await fetch(range.from, range.to))?.items ?? null, recentRange: range, error: null }; }
    catch (e) { return { history: h, recent: null, recentRange: null, error: (e?.message || String(e)).slice(0, 80) }; }
  }

  return { fetch, sourcesFor, getHistory };
}
