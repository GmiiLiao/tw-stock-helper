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
// ============================================================

import { getAdminDb } from './firebase-admin';

const DOC = { col: 'marketSnapshot', id: 'liveRequests' };
const FLUSH_MS = 30_000;       // at most one write per instance per 30s
const MAX_AGE_MS = 15 * 60_000; // drop codes not viewed in 15 min

const pending = new Set<string>();
let lastFlush = 0;
let flushing = false;

/** Record codes a client is actively viewing. Fire-and-forget; throttled. */
export function recordLiveRequests(codes: string[]): void {
  for (const c of codes) if (/^\d{4,6}$/.test(c)) pending.add(c);
  const now = Date.now();
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
    const codes: Record<string, number> = (snap.exists ? (snap.data()?.codes ?? {}) : {});
    for (const c of batch) codes[c] = now;
    for (const k of Object.keys(codes)) if (now - codes[k] > MAX_AGE_MS) delete codes[k];
    await ref.set({ codes, updatedAt: now });
  } catch {
    // re-queue on failure so the next poll retries
    for (const c of batch) pending.add(c);
  }
}
