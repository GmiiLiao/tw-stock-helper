'use client';

import { useState, useEffect, useRef } from 'react';

// ============================================================
// useLiveQuotes — shared real-time MIS quote poller.
// Polls /api/twse/mis-quote for the given codes on the same dynamic
// cadence as the 即時追蹤 page (5s intraday / 60s off-hours / 120s weekend),
// so every page can show live prices instead of stale STOCK_DAY_ALL data.
// Returns a map keyed by code. Pass a stable code list (it dedupes/caps).
// ============================================================

export interface LiveQuote {
  code: string; name: string;
  price: number; change: number; changePercent: number;
  prevClose: number; open: number; high: number; low: number; volume: number;
  source: string;
}

function marketInterval(): number {
  const now = new Date();
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = tw.getDay();
  const mins = tw.getHours() * 60 + tw.getMinutes();
  if (day === 0 || day === 6) return 120_000;            // weekend
  if (mins >= 9 * 60 && mins < 13 * 60 + 35) return 5_000; // TW session (+buffer)
  return 60_000;                                          // off-hours
}

export function useLiveQuotes(codes: string[], max = 60): Record<string, LiveQuote> {
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  // Stable key so the effect only re-subscribes when the code set changes.
  const key = [...new Set(codes.filter(Boolean))].sort().slice(0, max).join(',');
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!key) { setQuotes({}); return; }
    let alive = true;
    let timeoutId: ReturnType<typeof setTimeout>;

    const fetchQuotes = async () => {
      try {
        const res = await fetch(`/api/twse/mis-quote?codes=${encodeURIComponent(key)}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive || !Array.isArray(data.quotes)) return;
        const map: Record<string, LiveQuote> = {};
        for (const q of data.quotes) {
          map[q.code] = {
            code: q.code, name: q.name,
            price: q.price, change: q.change, changePercent: q.changePercent,
            prevClose: q.prevClose, open: q.open, high: q.high, low: q.low, volume: q.volume,
            source: q.source,
          };
        }
        setQuotes(map);
      } catch { /* keep previous quotes */ }
    };

    const tick = () => {
      fetchQuotes();
      timeoutId = setTimeout(tick, marketInterval());
    };
    fetchQuotes();
    timeoutId = setTimeout(tick, marketInterval());
    return () => { alive = false; clearTimeout(timeoutId); };
  }, [key]);

  return quotes;
}
