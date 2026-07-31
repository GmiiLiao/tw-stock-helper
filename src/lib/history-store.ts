// ============================================================
// History Store — the cloud tier of the "second brain".  SERVER-ONLY.
// Persists ~3 years of daily bars per stock in Firestore so that
// indicator/scoring/after-close analysis can read history without
// re-hitting TWSE/Yahoo every time.
//
// Schema:  collection `stockHistory` / doc `{code}`
//   { code, name, market, bars: DailyBar[], firstDate, lastDate, updatedAt }
//
// One doc per stock holds the full 3y array (~730 bars ≈ 40-60 KB,
// well under Firestore's 1 MB document limit).
//
// Writes use the Admin SDK (bypasses security rules); see firebase-admin.ts.
// Reads/writes degrade to no-ops when admin credentials are unavailable.
// ============================================================

import { getAdminDb } from './firebase-admin';

/** One trading day. `d` is ISO 'YYYY-MM-DD' (Taipei date) for lexicographic sort. */
export interface DailyBar {
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface StockHistoryDoc {
  code: string;
  name: string;
  market: 'tse' | 'otc' | 'unknown';
  bars: DailyBar[];
  firstDate: string;
  lastDate: string;
  updatedAt: number; // epoch ms
}

const COLLECTION = 'stockHistory';

/** Read one stock's stored history, or null if absent / Firestore unavailable. */
export async function readHistory(code: string): Promise<StockHistoryDoc | null> {
  const db = getAdminDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COLLECTION).doc(code).get();
    return snap.exists ? (snap.data() as StockHistoryDoc) : null;
  } catch (e) {
    console.warn('[history-store] readHistory failed', code, e);
    return null;
  }
}

/** Overwrite one stock's history document. Throws if admin DB unavailable. */
export async function writeHistory(input: {
  code: string;
  name: string;
  market?: 'tse' | 'otc' | 'unknown';
  bars: DailyBar[];
}): Promise<void> {
  const db = getAdminDb();
  if (!db) throw new Error('Admin Firestore unavailable (no credentials)');
  const bars = dedupeSortBars(input.bars);
  const docData: StockHistoryDoc = {
    code: input.code,
    name: input.name,
    market: input.market ?? 'unknown',
    bars,
    firstDate: bars[0]?.d ?? '',
    lastDate: bars[bars.length - 1]?.d ?? '',
    updatedAt: Date.now(),
  };
  await db.collection(COLLECTION).doc(input.code).set(docData);
}

/**
 * Merge new bars into an existing doc (idempotent — dedupes by date).
 * Used by the daily incremental updater after market close.
 */
export async function appendBars(
  code: string,
  name: string,
  newBars: DailyBar[],
  market?: 'tse' | 'otc' | 'unknown',
): Promise<StockHistoryDoc> {
  const db = getAdminDb();
  if (!db) throw new Error('Admin Firestore unavailable (no credentials)');
  const existing = await readHistory(code);
  const merged = dedupeSortBars([...(existing?.bars ?? []), ...newBars]);
  const docData: StockHistoryDoc = {
    code,
    name: name || existing?.name || '',
    market: market ?? existing?.market ?? 'unknown',
    bars: merged,
    firstDate: merged[0]?.d ?? '',
    lastDate: merged[merged.length - 1]?.d ?? '',
    updatedAt: Date.now(),
  };
  await db.collection(COLLECTION).doc(code).set(docData);
  return docData;
}

/** Batch-read many history docs (chunked getAll under the hood). */
export async function readHistories(codes: string[]): Promise<Map<string, StockHistoryDoc>> {
  const out = new Map<string, StockHistoryDoc>();
  const db = getAdminDb();
  if (!db || codes.length === 0) return out;
  const col = db.collection(COLLECTION);
  for (let i = 0; i < codes.length; i += 300) {
    const chunk = codes.slice(i, i + 300);
    const refs = chunk.map(c => col.doc(c));
    const snaps = await db.getAll(...refs);
    for (const s of snaps) {
      if (s.exists) out.set(s.id, s.data() as StockHistoryDoc);
    }
  }
  return out;
}

/**
 * Daily incremental update: append one fresh bar to each ALREADY-STORED stock
 * (idempotent by date). Codes without an existing doc are skipped — the
 * backfill script seeds them first. Returns how many docs were updated.
 */
export async function appendTodayBars(
  entries: Array<{ code: string; name: string; bar: DailyBar }>,
): Promise<{ updated: number; skipped: number }> {
  const db = getAdminDb();
  if (!db || entries.length === 0) return { updated: 0, skipped: entries.length };

  const existing = await readHistories(entries.map(e => e.code));
  const writer = db.bulkWriter();
  let updated = 0, skipped = 0;

  for (const { code, name, bar } of entries) {
    const cur = existing.get(code);
    if (!cur) { skipped++; continue; }            // not backfilled yet
    if (cur.lastDate >= bar.d) { skipped++; continue; } // already have this day
    const bars = dedupeSortBars([...cur.bars, bar]).slice(-800); // cap retained length
    writer.set(db.collection(COLLECTION).doc(code), {
      ...cur,
      name: name || cur.name,
      bars,
      firstDate: bars[0]?.d ?? cur.firstDate,
      lastDate: bars[bars.length - 1]?.d ?? bar.d,
      updatedAt: Date.now(),
    });
    updated++;
  }
  await writer.close();
  return { updated, skipped };
}

/** List which codes already have stored history (sampled up to `max`). */
export async function listStoredCodes(max = 5000): Promise<string[]> {
  const db = getAdminDb();
  if (!db) return [];
  try {
    const snap = await db.collection(COLLECTION).limit(max).get();
    return snap.docs.map(d => d.id);
  } catch (e) {
    console.warn('[history-store] listStoredCodes failed', e);
    return [];
  }
}

/** Dedupe by date (last write wins) and sort ascending by date. */
export function dedupeSortBars(bars: DailyBar[]): DailyBar[] {
  const map = new Map<string, DailyBar>();
  for (const b of bars) {
    if (b && b.d && Number.isFinite(b.c)) map.set(b.d, b);
  }
  return [...map.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}
