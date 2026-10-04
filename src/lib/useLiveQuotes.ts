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

/** 缺席代號沿用上一拍的上限（約 3 拍）——短暫缺漏不閃爍，持續缺席不顯示凍結價 */
const STALE_MAX_MS = 15_000;

export interface LiveQuote {
  code: string; name: string;
  price: number; change: number; changePercent: number;
  prevClose: number; open: number; high: number; low: number; volume: number;
  source: string;
  tradeTime?: string;          // ISO；揭示時戳優先（見 twse-api-server R7 口徑）
  revealAt?: number | null;    // MIS tlong；null＝來源未提供
  /** true＝本拍回應沒帶到這檔、沿用上一拍值（G3-17）。判斷「這一拍是否即時」的地方要排除 */
  stale?: boolean;
  /** 開始沿用舊值的時刻（ms）；超過 STALE_MAX_MS 不再沿用 */
  staleSince?: number;
}

// 節奏統一走 market-clock 的 liveQuoteInterval（2026-09-02 升格為全站標準件，
// 邏輯原封搬家：鎖相+盤前 15s+休市/背景 10 分鐘）。

export function useLiveQuotes(codes: string[], max = 60, opts: { register?: boolean } = {}): Record<string, LiveQuote> {
  // register:false ＝ 榜單整張列表用：只讀價、不把 25～60 檔登記成「瀏覽中」搶快線名額（見 mis-quote route nv=1）
  const nv = opts.register === false ? '&nv=1' : '';
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  // Stable key so the effect only re-subscribes when the code set changes.
  const key = [...new Set(codes.filter(Boolean))].sort().slice(0, max).join(',');
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!key) { setQuotes({}); return; }
    let alive = true;

    const want = key.split(',');
    const fetchQuotes = async (signal?: AbortSignal) => {
      // t=拍號：CDN 快取鍵按拍分開（見 market-clock revealTick）——同拍全球共享、換拍必回源
      const res = await fetch(`/api/twse/mis-quote?codes=${encodeURIComponent(key)}&t=${revealTick()}${nv}`, { signal });
      if (!res.ok) throw new Error(`mis-quote ${res.status}`);   // 讓 startLiveLoop 退避；畫面保留舊值
      const data = await res.json();
      if (!alive || !Array.isArray(data.quotes)) return;
      const fresh: Record<string, LiveQuote> = {};
      for (const q of data.quotes) {
        fresh[q.code] = {
          code: q.code, name: q.name,
          price: q.price, change: q.change, changePercent: q.changePercent,
          prevClose: q.prevClose, open: q.open, high: q.high, low: q.low, volume: q.volume,
          source: q.source, tradeTime: q.tradeTime || '', revealAt: q.revealAt ?? null,
        };
      }
      // G3-17（2026-10-04）：2xx 但缺部分代號時，缺的那幾檔沿用上一拍值，不讓它從畫面消失再出現。
      // 只保留「目前 key 內」的代號——換組後舊代號自然淘汰，map 不無限長大。
      // 消費端多以 quotes[code] 查值；唯一列舉整張 map 的是 Portfolio「即時」徽章（source==='mis_realtime'），
      // 沿用值標 stale:true，徽章判斷已排除（2026-10-04 grep 確認 11 個呼叫點）。
      setQuotes(prev => {
        const next: Record<string, LiveQuote> = {};
        for (const c of want) {
          if (fresh[c]) next[c] = fresh[c];
          // 沿用最多 STALE_MAX_MS（審查 M1）：超過就讓它消失，各面板退回收盤價的誠實標示，不顯示凍結價
          else if (prev[c]) {
            const since = prev[c].staleSince ?? Date.now();
            if (Date.now() - since <= STALE_MAX_MS) next[c] = { ...prev[c], stale: true, staleSince: since };
          }
        }
        return next;
      });
    };

    fetchQuotes().catch(() => { /* keep previous quotes */ });
    // startLiveLoop＝鎖相＋回前景立即恢復（2026-09-02「報價完全沒有變化」的修復：
    // 背景排的 10 分鐘計時器在回前景時不會自己縮短，必須 onVis 重排）。
    // 在途不疊打、失敗退避、卸載 abort 都由標準件處理（G3-20）。
    const stop = startLiveLoop(signal => fetchQuotes(signal));
    return () => { alive = false; stop(); };
  }, [key, nv]);

  return quotes;
}
