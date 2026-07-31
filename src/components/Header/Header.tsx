'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '@/lib/store';
import { fetchAllStocksDayData } from '@/lib/twse-api';
import type { StockInfo } from '@/lib/twse-api';
import { getSession, isForeground } from '@/lib/market-clock';
import styles from './Header.module.css';
import { useShallow } from 'zustand/react/shallow';

/** Convert ROC date string '1150610' → '2026/06/10' */
function rocToWestern(roc: string): string {
  if (!roc || roc.length < 7) return roc;
  const year  = parseInt(roc.slice(0, 3)) + 1911;
  const month = roc.slice(3, 5);
  const day   = roc.slice(5, 7);
  return `${year}/${month}/${day}`;
}

// 時鐘拆成獨立葉節點：每秒重繪的範圍只有這一個 <span>，
// 而不是整個 Header（17KB、含大盤/美股/夜盤多個 widget）。
// 分頁在背景時停擺 —— 使用者看不到的時鐘不需要走。
function Clock({ className }: { className?: string }) {
  const [now, setNow] = useState('');
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    };
    tick();
    const id = setInterval(tick, 1000);
    const onVis = () => tick();
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  return <span className={className}>{now}</span>;
}

export default function Header() {
  const { setAllStocks, setLastFetchTime, navigateTo } = useAppStore(useShallow((s) => ({ setAllStocks: s.setAllStocks, setLastFetchTime: s.setLastFetchTime, navigateTo: s.navigateTo })));
  // 搜尋框為非受控（uncontrolled）。原因：Header 曾因每秒的時鐘而整個重渲染，
  // controlled value 回寫在手機 IME 下會把游標打回開頭（輸入 2527 變 7252）。
  // 時鐘已於 2026-07-30 拆成 <Clock /> 葉節點，這個成因消失了 ——
  // 但非受控本身沒有壞處，改回 controlled 只是徒增 IME 迴歸風險，故保留。
  // state 僅供搜尋邏輯使用。
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<StockInfo[]>([]);
  const [allStocksLocal, setAllStocksLocal] = useState<StockInfo[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dataDate, setDataDate] = useState('');    // e.g. '2026/06/10'
  const [dataSource, setDataSource] = useState(''); // 'mis_realtime' | 'mi_index' | etc.
  const [marketIndex, setMarketIndex] = useState({ weighted: 0, change: 0, changePercent: 0 });
  const [usMarket, setUsMarket] = useState<{
    nasdaqPrice: number;
    nasdaqChange: number;
    nasdaqChangePercent: number;
    dowPrice: number;
    dowChange: number;
    dowChangePercent: number;
    sp500Price: number;
    sp500Change: number;
    sp500ChangePercent: number;
    tsmcAdrPrice: number;
    tsmcAdrChange: number;
    tsmcAdrChangePercent: number;
    nasdaqFuturesPrice?: number;
    nasdaqFuturesChange?: number;
    nasdaqFuturesChangePercent?: number;
    msciTaiwanPrice?: number;
    msciTaiwanChange?: number;
    msciTaiwanChangePercent?: number;
  } | null>(null);
  const [twNight, setTwNight] = useState<{
    price: number;
    change: number;
    changePercent: number;
    tradeTime?: string;
  } | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  // ── Load market data ──────────────────────────────────────────
  const loadMarketIndex = useCallback(async () => {
    try {
      // cache-buster 會讓每次 URL 都不同 → CDN 100% miss。改吃 route 的 s-maxage=3。
      const res = await fetch('/api/twse/market-index');
      if (!res.ok) return;
      const indexData = await res.json();
      if (indexData) {
        setMarketIndex({
          weighted: indexData.weighted || 0,
          change: indexData.weightedChange || 0,
          changePercent: indexData.weightedChangePercent || 0,
        });
        if (indexData.usMarket) {
          setUsMarket(indexData.usMarket);
        }
        if (indexData.twNight) {
          setTwNight(indexData.twNight);
        }
        if (indexData.tradeDate) {
          const d = indexData.tradeDate;
          setDataDate(`${d.slice(0,4)}/${d.slice(4,6)}/${d.slice(6,8)}`);
        }
        setDataSource(indexData.source || '');
      }
    } catch (err) {
      console.error('[Header] Fetch market-index error:', err);
    }
  }, []);

  const loadAllStocks = useCallback(async () => {
    setLoading(true);
    try {
      console.log('[Header] Fetching stock-day-all starting...');
      const stocks = await fetchAllStocksDayData();
      console.log('[Header] Fetching stock-day-all completed. Count:', stocks.length);
      setAllStocks(stocks);
      setAllStocksLocal(stocks);
      setLastFetchTime(Date.now());
    } catch (err) {
      console.error('[Header] Fetch stock-day-all error:', err);
    } finally {
      setLoading(false);
    }
  }, [setAllStocks, setLastFetchTime]);

  const loadData = useCallback(async () => {
    loadMarketIndex();
    await loadAllStocks();
  }, [loadMarketIndex, loadAllStocks]);

  // Poll market index (lightweight) — dynamic interval recalculated each tick
  useEffect(() => {
    loadMarketIndex();
    let timeoutId: ReturnType<typeof setTimeout>;
    // market-index 同時含台股與美股/夜盤，所以台股休市不代表整支都不用更新。
    // 台股時段改吃 market-clock（會查國定假日，原本的 h>=9&&h<14 不會），
    // 美股時段保留；分頁在背景時全部降到 5 分鐘。
    const getInterval = () => {
      if (!isForeground()) return 300_000;
      const s = getSession();
      if (s === 'regular') return 5_000;
      if (s === 'pre-open') return 15_000;
      const h = new Date().getHours();
      if (h >= 21 || h < 5) return 30_000;   // 美股時段
      return 120_000;
    };
    const tick = () => {
      loadMarketIndex();
      timeoutId = setTimeout(tick, getInterval());
    };
    timeoutId = setTimeout(tick, getInterval());
    return () => clearTimeout(timeoutId);
  }, [loadMarketIndex]);

  // Poll full stock list (heavy) — dynamic interval recalculated each tick
  useEffect(() => {
    loadAllStocks();
    let timeoutId: ReturnType<typeof setTimeout>;
    // stock-day-all 是純台股資料（約 650KB），休市時完全不會變。
    const getInterval = () => {
      if (!isForeground()) return 900_000;
      return getSession() === 'regular' ? 120_000 : 900_000;
    };
    const tick = () => {
      loadAllStocks();
      timeoutId = setTimeout(tick, getInterval());
    };
    timeoutId = setTimeout(tick, getInterval());
    return () => clearTimeout(timeoutId);
  }, [loadAllStocks]);


  // ── Search ─────────────────────────────────────────────────────
  // 原本每一個按鍵都對 ~1,700 檔做 toLowerCase().includes() 全掃。
  // 150ms debounce：連續輸入時只在停頓後掃一次。
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 150);
    return () => clearTimeout(id);
  }, [searchQuery]);

  useEffect(() => {
    if (debouncedQuery.length < 1) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }
    const q = debouncedQuery.trim().toLowerCase();
    const results = allStocksLocal
      .filter(s => {
        if (!s) return false;
        const code = s.code ? String(s.code).toLowerCase() : '';
        const name = s.name ? String(s.name).toLowerCase() : '';
        return code.includes(q) || name.includes(q);
      })
      .slice(0, 8);
    // 後備：清單缺漏（如上櫃來源失敗/初次載入中）時，4~6 碼代號仍可直接開啟——
    // 個股頁會自行抓取該檔資料，不依賴這份清單。
    if (results.length === 0 && /^\d{4,6}[a-z]?$/.test(q)) {
      results.push({ code: q.toUpperCase(), name: allStocksLocal.length === 0 ? '（清單載入中）直接開啟' : '（不在清單）直接開啟', price: 0, change: 0, changePercent: 0, volume: 0 } as StockInfo);
    }
    setSearchResults(results);
    setShowDropdown(results.length > 0 || q.length >= 2);
  }, [debouncedQuery, allStocksLocal]);

  // ── Click outside ──────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelectStock = (stock: StockInfo) => {
    navigateTo('stock', stock.code);
    setSearchQuery('');
    if (searchInputRef.current) searchInputRef.current.value = '';   // 非受控：手動清空
    setShowDropdown(false);
  };

  const isMarketOpen = () => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
    const t = h * 60 + m;
    return t >= 9 * 60 && t < 13 * 60 + 30;
  };

  const isUsOpen = () => {
    const now = new Date();
    const h = now.getHours();
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
    // US regular hours in Taiwan time: ~21:30-04:00
    return h >= 21 || h < 5;
  };

  const marketOpen  = isMarketOpen();
  const usOpen = isUsOpen();
  const changeColor = marketIndex.change >= 0 ? 'var(--color-up)' : 'var(--color-down)';
  const isRealtime  = dataSource === 'mis_realtime';

  const hasNasdaqFutures = !!(usMarket && usMarket.nasdaqFuturesPrice && usMarket.nasdaqFuturesPrice > 0);
  const nasdaqFuturesPrice = usMarket?.nasdaqFuturesPrice ?? 0;
  const nasdaqFuturesChange = usMarket?.nasdaqFuturesChange ?? 0;
  const nasdaqFuturesChangePercent = usMarket?.nasdaqFuturesChangePercent ?? 0;

  return (
    <header className={styles.header}>
      {/* Market Index Bar */}
      <div className={styles.indexBar}>
        <div className={styles.indexItem}>
          <span className={styles.indexLabel}>加權指數</span>
          <span className={styles.indexValue} style={{ color: changeColor }}>
            {marketIndex.weighted > 0
              ? marketIndex.weighted.toLocaleString('zh-TW', { minimumFractionDigits: 2 })
              : '--'}
          </span>
          <span className={styles.indexChange} style={{ color: changeColor }}>
            {marketIndex.change >= 0 ? '+' : ''}{marketIndex.change.toFixed(2)}
            ({marketIndex.changePercent >= 0 ? '+' : ''}{marketIndex.changePercent.toFixed(2)}%)
          </span>

          {/* Data date + source badge */}
          {dataDate && (
            <span style={{
              fontSize: '12px',
              color: isRealtime ? '#22c55e' : 'var(--text-muted)',
              background: isRealtime ? 'rgba(34,197,94,0.1)' : 'rgba(148,163,184,0.08)',
              border: `1px solid ${isRealtime ? 'rgba(34,197,94,0.3)' : 'var(--border-primary)'}`,
              borderRadius: '4px',
              padding: '1px 6px',
              marginLeft: '6px',
              fontFamily: 'monospace',
            }}>
              {isRealtime ? '● 即時' : '📅'} {dataDate}
            </span>
          )}
        </div>

        {twNight && twNight.price > 0 && (
          <>
            <div className={styles.indexDivider} />
            <div className={styles.indexItem}>
              <span className={styles.indexLabel}>台股夜盤(EWT)</span>
              <span className={styles.indexValue} style={{ color: twNight.change >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                {twNight.price.toFixed(2)}
              </span>
              <span className={styles.indexChange} style={{ color: twNight.change >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                {twNight.change >= 0 ? '+' : ''}{twNight.change.toFixed(2)}
                ({twNight.changePercent >= 0 ? '+' : ''}{twNight.changePercent.toFixed(2)}%)
              </span>
            </div>
          </>
        )}

        {hasNasdaqFutures ? (
          <>
            <div className={styles.indexDivider} />
            <div className={styles.indexItem}>
              <span className={styles.indexLabel}>那指期貨</span>
              <span className={styles.indexValue} style={{ color: nasdaqFuturesChange >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                {nasdaqFuturesPrice.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
              </span>
              <span className={styles.indexChange} style={{ color: nasdaqFuturesChange >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                {nasdaqFuturesChange >= 0 ? '+' : ''}{Math.round(nasdaqFuturesChange)}
                ({nasdaqFuturesChangePercent >= 0 ? '+' : ''}{nasdaqFuturesChangePercent.toFixed(2)}%)
              </span>
            </div>
          </>
        ) : (
          usMarket && usMarket.nasdaqPrice > 0 && (
            <>
              <div className={styles.indexDivider} />
              <div className={styles.indexItem}>
                <span className={styles.indexLabel}>那斯達克</span>
                <span className={styles.indexValue} style={{ color: usMarket.nasdaqChange >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                  {usMarket.nasdaqPrice.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                </span>
                <span className={styles.indexChange} style={{ color: usMarket.nasdaqChange >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                  {usMarket.nasdaqChange >= 0 ? '+' : ''}{Math.round(usMarket.nasdaqChange)}
                  ({usMarket.nasdaqChangePercent >= 0 ? '+' : ''}{usMarket.nasdaqChangePercent.toFixed(2)}%)
                </span>
              </div>
            </>
          )
        )}

        {usMarket && usMarket.tsmcAdrPrice > 0 && (
          <>
            <div className={styles.indexDivider} />
            <div className={styles.indexItem}>
              <span className={styles.indexLabel}>台積電ADR</span>
              <span className={styles.indexValue} style={{ color: usMarket.tsmcAdrChange >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                {usMarket.tsmcAdrPrice.toFixed(2)}
              </span>
              <span className={styles.indexChange} style={{ color: usMarket.tsmcAdrChange >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                {usMarket.tsmcAdrChange >= 0 ? '+' : ''}{usMarket.tsmcAdrChange.toFixed(2)}
                ({usMarket.tsmcAdrChangePercent >= 0 ? '+' : ''}{usMarket.tsmcAdrChangePercent.toFixed(2)}%)
              </span>
            </div>
          </>
        )}

        <div className={styles.indexDivider} />

        <div className={styles.marketStatus}>
          <div className={`${styles.statusDot} ${(marketOpen || usOpen) ? styles.open : styles.closed}`} />
          <span>{marketOpen ? '台股盤中' : usOpen ? '美股盤中' : '收盤'}</span>
        </div>

        {/* Manual refresh button */}
        <button
          onClick={loadData}
          disabled={loading}
          title="立即更新資料"
          className={styles.refreshBtn}
        >
          <svg
            width="11" height="11" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5"
            style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}
          >
            <path d="M23 4v6h-6M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
          {loading ? '更新中…' : '更新'}
        </button>
      </div>

      {/* Search */}
      <div ref={searchRef} className={styles.searchWrapper}>
        <div className={styles.searchContainer}>
          <svg className={styles.searchIcon} width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
            <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <input
            id="stock-search"
            ref={searchInputRef}
            type="text"
            placeholder="搜尋股票代號或名稱..."
            defaultValue=""
            onChange={(e) => setSearchQuery(e.target.value)}
            className={styles.searchInput}
            autoComplete="off"
          />
          {loading && <div className={styles.searchSpinner}><div className="spinner" /></div>}
        </div>

        {showDropdown && (
          <div className={styles.searchDropdown} id="search-results">
            {searchResults.map(stock => (
              <button
                key={stock.code}
                id={`search-result-${stock.code}`}
                className={styles.searchItem}
                onClick={() => handleSelectStock(stock)}
              >
                <div className={styles.searchItemInfo}>
                  <span className={styles.searchCode}>{stock.code}</span>
                  <span className={styles.searchName}>{stock.name}</span>
                </div>
                <div className={styles.searchItemPrice}>
                  <span className={styles.searchPrice}>{stock.price.toFixed(2)}</span>
                  <span
                    className={styles.searchChange}
                    style={{ color: stock.change >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}
                  >
                    {stock.change >= 0 ? '+' : ''}{stock.change.toFixed(2)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Clock */}
      <div className={styles.clock} id="market-clock">
        <Clock className={styles.clockTime} />
        <span className={styles.clockLabel}>台北時間</span>
      </div>
    </header>
  );
}
