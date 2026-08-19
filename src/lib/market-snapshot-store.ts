// ============================================================
// Market snapshot store (server-only, admin). The second brain's
// always-fresh FULL-MARKET quote snapshot, maintained by the resident
// daemon (continuous MIS sweep intraday + TWSE close after-hours).
//
// Replaces the old hard-coded "top-100" MIS merge: the whole market now
// carries real TWSE quotes, and all computation/statistics (rankings,
// breadth, scoring) read this snapshot instead of partial data.
//
// Doc: marketSnapshot/latest  ≈ 1900 × small object (~150 KB < 1 MB).
// ============================================================

import { getAdminDb } from './firebase-admin';

export interface SnapQuote {
  code: string; name: string;
  price: number; change: number; changePercent: number;
  volume: number; value: number;
  open: number; high: number; low: number;
  // live = this quote carries a REAL-TIME MIS tick this cycle. When false the
  // quote is the latest TWSE close (seed) — NEVER present it as 即時.
  live?: boolean;
  liveAt?: number;       // epoch ms of the MIS tick (only when live)
}

export interface MarketSnapshot {
  quotes: Record<string, SnapQuote>;
  count: number;
  liveCount?: number;    // how many quotes carry a real-time MIS tick
  sweepAt: number;       // epoch ms of last full/partial sweep write
  marketOpen: boolean;
  sweeping?: boolean;    // daemon 掃描窗內（盤中+收盤後至15:00）
  source: 'mis_sweep' | 'stock_day_all' | 'mixed';
}

const COLLECTION = 'marketSnapshot';

// Quotes are stored as a JSON STRING (not a nested map): a 1900-key map blows
// Firestore's 20k per-document index-entry limit. A string is indexed once.
export async function writeMarketSnapshot(snap: MarketSnapshot): Promise<void> {
  const db = getAdminDb();
  if (!db) throw new Error('Admin Firestore unavailable');
  await db.collection(COLLECTION).doc('latest').set({
    quotesJson: JSON.stringify(snap.quotes),
    count: snap.count, liveCount: snap.liveCount ?? 0,
    sweepAt: snap.sweepAt, marketOpen: snap.marketOpen, source: snap.source,
  });
}

// 實例內記憶體快取 5 秒：mis-quote/stock-day-all/intraday 被前端 5 秒輪詢，
// 原本每個請求都讀一次 Firestore 造成讀取暴量——快照本身 ~10 秒才更新，
// 5 秒快取無損即時性，同實例內所有請求共享。
let _snapCache: { at: number; snap: MarketSnapshot | null } = { at: 0, snap: null };

export async function readMarketSnapshot(): Promise<MarketSnapshot | null> {
  if (Date.now() - _snapCache.at < 3000) return _snapCache.snap;
  const db = getAdminDb();
  if (!db) return null;
  try {
    const s = await db.collection(COLLECTION).doc('latest').get();
    if (!s.exists) return null;
    const d = s.data() as { quotesJson?: string; quotes?: Record<string, SnapQuote>; count: number; liveCount?: number; sweepAt: number; marketOpen: boolean; sweeping?: boolean; source: MarketSnapshot['source'] };
    const quotes: Record<string, SnapQuote> = d.quotesJson ? JSON.parse(d.quotesJson) : (d.quotes || {});
    // 5 秒快線覆蓋（在 reader 統一做）：所有讀快照的 API（mis-quote、market-snapshot、
    // stock-day-all…）都自動吃到「使用者正在看的股票」的 5 秒級報價，liveAt 較新者勝。
    try {
      const hot = await readHotQuotes();
      if (hot && Date.now() - hot.at < 30_000) {
        for (const code in hot.quotes) {
          const hq = hot.quotes[code];
          if ((hq.liveAt || 0) > (quotes[code]?.liveAt || 0)) quotes[code] = hq;
        }
      }
    } catch { /* hot lane optional */ }
    const snap = { quotes, count: d.count, liveCount: d.liveCount ?? 0, sweepAt: d.sweepAt, marketOpen: d.marketOpen, sweeping: d.sweeping, source: d.source };
    _snapCache = { at: Date.now(), snap };
    return snap;
  } catch (e) {
    console.warn('[market-snapshot] read failed', e);
    return null;
  }
}

// ── 5 秒快線（marketSnapshot/hot）：daemon 對「使用者正在看的股票」每 5 秒
// 寫一份小型報價（~120 檔）。讀取端 2 秒實例快取——文件本身 5 秒才更新，
// 2 秒快取無損即時性，同實例內所有 5 秒輪詢共享一次 Firestore 讀。
export interface HotQuotes { quotes: Record<string, SnapQuote>; at: number }
let _hotCache: { at: number; hot: HotQuotes | null } = { at: 0, hot: null };

export async function readHotQuotes(): Promise<HotQuotes | null> {
  if (Date.now() - _hotCache.at < 2000) return _hotCache.hot;
  const db = getAdminDb();
  if (!db) return null;
  try {
    const s = await db.collection(COLLECTION).doc('hot').get();
    const d = s.exists ? (s.data() as { quotesJson?: string; at?: number }) : null;
    const hot = d?.quotesJson ? { quotes: JSON.parse(d.quotesJson) as Record<string, SnapQuote>, at: d.at || 0 } : null;
    _hotCache = { at: Date.now(), hot };
    return hot;
  } catch {
    return null;
  }
}

// ── 興櫃（ESB）─────────────────────────────────────────────────────────
// 由 daemon 寫入 marketSnapshot/emerging，**與主宇宙分開**：興櫃沒有漲跌停、
// 撮合是議價、參考價是前一日均價，混進主快照會污染所有選股與榜單。
// 這裡只供「搜尋得到、點得進個股頁」使用（2026-08-19 使用者實報 7924 搜不到）。
export interface EmergingQuote {
  code: string; name: string; price: number; prev: number; change: number;
  changePercent: number; high: number; low: number; avg: number;
  volume: number; bid: number; ask: number; market: 'esb';
}
let _esbCache: { at: number; data: Record<string, EmergingQuote> | null } = { at: 0, data: null };

export async function readEmergingQuotes(): Promise<Record<string, EmergingQuote> | null> {
  if (Date.now() - _esbCache.at < 60_000) return _esbCache.data;   // 興櫃 3 分鐘才更新，60 秒快取無損
  const db = getAdminDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COLLECTION).doc('emerging').get();
    const d = snap.exists ? (snap.data() as { quotesJson?: string }) : null;
    const data = d?.quotesJson ? (JSON.parse(d.quotesJson) as Record<string, EmergingQuote>) : null;
    _esbCache = { at: Date.now(), data };
    return data;
  } catch {
    return _esbCache.data;   // stale-if-error：寧可給舊的興櫃清單，也不要讓它從搜尋消失
  }
}

/** Fresh = written within `maxAgeMs` (default 5 min) — used to decide overlay. */
export function isSnapshotFresh(snap: MarketSnapshot | null, maxAgeMs = 5 * 60 * 1000): boolean {
  return !!snap && Date.now() - (snap.sweepAt || 0) < maxAgeMs && Object.keys(snap.quotes || {}).length > 0;
}
