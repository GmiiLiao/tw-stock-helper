// ============================================================
// Live-requests store (server-only, admin).
//
// Any stock a user actively views polls /api/twse/mis-quote. We record those
// codes here so the resident daemon can fold them into its real-time priority
// set — i.e. opening ANY stock makes it realtime, not just watchlist/holdings.
//
// Doc: marketSnapshot/liveRequests = { codes: { "2330": <epochMs>, ... } }
// Codes age out by timestamp on the daemon side; we prune on write to bound size.
// Writes are throttled per server instance (≤1 / FLUSH_MS) to avoid amplifying
// the 5-second client polling into Firestore writes.
//
// 防擠占（WM-SCAN G1-21，2026-10-04）：這是匿名 GET 的副作用，快線 120 格裡「瀏覽中」與自選共用名額，
// 不設限的話單一來源每次登記 50 檔、反覆換代號就能把真實使用者正在看的股票擠出快線。
//   ① 只登記「已知代號」——呼叫端（mis-quote route）只傳有回報價的代號；
//   ② 每請求最多 MAX_PER_REQUEST 檔；
//   ③ 每個來源（client IP）15 分鐘內最多 MAX_DISTINCT_PER_CLIENT 個「不同」代號——
//      已登記過的代號照常續期（5 秒輪詢的正常使用者不受影響、也**不回 429**），超額的新代號只是不登記
//      （仍拿得到報價，只是回到主迴圈約 1 分鐘一輪）；
//   ④ pending 與文件代號數都有上限（文件保留最新的 MAX_DOC_CODES 檔），寫入失敗留 log。
// ============================================================

import { getAdminDb } from './firebase-admin';

const DOC = { col: 'marketSnapshot', id: 'liveRequests' };
const FLUSH_MS = 30_000;       // at most one write per instance per 30s
const MAX_AGE_MS = 15 * 60_000; // drop codes not viewed in 15 min（與 daemon VIEWED_MAX_AGE_MS 一致）

/** 每請求最多登記幾檔（DecisionDesk／WarRoom 一次 30 檔，自選批次 50 檔只登記前 30） */
export const MAX_PER_REQUEST = 30;
/** 每個來源 15 分鐘內最多登記幾個不同代號：自選 50 檔＋逛十來檔仍在額度內 */
const MAX_DISTINCT_PER_CLIENT = 60;
/** 追蹤的來源數上限（有界 Map，防偽造來源撐爆記憶體） */
const MAX_CLIENTS = 5_000;
/** 單一實例待寫入的代號上限（全市場約 1,900 檔；daemon 瀏覽中名額僅數十格） */
const MAX_PENDING = 500;
/** 文件內保留的代號上限（取最新），避免文件無限長大；遠大於 daemon 會用到的瀏覽中名額 */
const MAX_DOC_CODES = 300;
const FAIL_LOG_INTERVAL_MS = 60_000;

const CODE_RE = /^\d{4,6}$/;
const pending = new Set<string>();
const clients = new Map<string, Map<string, number>>();   // clientKey → (code → 最近登記時間)
let lastFlush = 0;
let flushing = false;
let lastFailLog = 0;

/** 依來源配額過濾：已在該來源集合內的代號一律放行（續期），新代號受 MAX_DISTINCT_PER_CLIENT 限制。 */
function admitForClient(clientKey: string, codes: string[], now: number): string[] {
  let seen = clients.get(clientKey);
  if (seen) {
    clients.delete(clientKey);   // 重新插入＝移到最新（Map 迭代序＝插入序，淘汰從最舊開始）
  } else {
    if (clients.size >= MAX_CLIENTS) {
      let n = Math.ceil(MAX_CLIENTS / 20);
      for (const k of clients.keys()) { clients.delete(k); if (--n <= 0) break; }
    }
    seen = new Map();
  }
  clients.set(clientKey, seen);
  for (const [c, at] of seen) if (now - at > MAX_AGE_MS) seen.delete(c);
  const admitted: string[] = [];
  for (const c of codes) {
    if (!seen.has(c) && seen.size >= MAX_DISTINCT_PER_CLIENT) continue;
    seen.set(c, now);
    admitted.push(c);
  }
  return admitted;
}

/**
 * Record codes a client is actively viewing. Fire-and-forget; throttled.
 * @param codes     已知代號（呼叫端只傳有回報價者）
 * @param clientKey 來源鍵（client IP）；用於每來源不同代號配額
 */
export function recordLiveRequests(codes: string[], clientKey = 'unknown'): void {
  const now = Date.now();
  const valid = [...new Set(codes.filter(c => CODE_RE.test(c)))].slice(0, MAX_PER_REQUEST);
  for (const c of admitForClient(clientKey, valid, now)) {
    if (pending.size >= MAX_PENDING && !pending.has(c)) break;
    pending.add(c);
  }
  if (flushing || now - lastFlush < FLUSH_MS || pending.size === 0) return;
  lastFlush = now;
  flushing = true;
  void flush().finally(() => { flushing = false; });
}

async function flush(): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  const batch = [...pending];
  pending.clear();
  try {
    const ref = db.collection(DOC.col).doc(DOC.id);
    const snap = await ref.get();
    const now = Date.now();
    const prev: Record<string, unknown> = (snap.exists ? (snap.data()?.codes ?? {}) : {});
    const merged: Record<string, number> = {};
    for (const [k, v] of Object.entries(prev)) {
      if (CODE_RE.test(k) && typeof v === 'number' && now - v <= MAX_AGE_MS) merged[k] = v;
    }
    for (const c of batch) merged[c] = now;
    const codes = Object.fromEntries(
      Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, MAX_DOC_CODES),
    );
    await ref.set({ codes, updatedAt: now });
  } catch (e) {
    // re-queue on failure so the next poll retries（不超過 pending 上限）
    for (const c of batch) { if (pending.size >= MAX_PENDING) break; pending.add(c); }
    const now = Date.now();
    if (now - lastFailLog > FAIL_LOG_INTERVAL_MS) {
      lastFailLog = now;
      console.warn('[live-requests] 瀏覽中登記寫入失敗，下次輪詢重試：', (e as Error)?.message ?? String(e));
    }
  }
}
