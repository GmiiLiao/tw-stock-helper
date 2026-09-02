'use client';

import { useState, useEffect, useRef } from 'react';
import { startLiveLoop, revealTick } from './market-clock';

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

// 節奏統一走 market-clock 的 liveQuoteInterval（2026-09-02 升格為全站標準件，
// 邏輯原封搬家：鎖相+盤前 15s+休市/背景 10 分鐘）。

export function useLiveQuotes(codes: string[], max = 60): Record<string, LiveQuote> {
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  // Stable key so the effect only re-subscribes when the code set changes.
  const key = [...new Set(codes.filter(Boolean))].sort().slice(0, max).join(',');
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!key) { setQuotes({}); return; }
    let alive = true;

    const fetchQuotes = async () => {
      try {
        // t=拍號：CDN 快取鍵按拍分開（見 market-clock revealTick）——同拍全球共享、換拍必回源
        const res = await fetch(`/api/twse/mis-quote?codes=${encodeURIComponent(key)}&t=${revealTick()}`);
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

    fetchQuotes();
    // startLiveLoop＝鎖相＋回前景立即恢復（2026-09-02「報價完全沒有變化」的修復：
    // 背景排的 10 分鐘計時器在回前景時不會自己縮短，必須 onVis 重排）。
    const stop = startLiveLoop(fetchQuotes);
    return () => { alive = false; stop(); };
  }, [key]);

  return quotes;
}
