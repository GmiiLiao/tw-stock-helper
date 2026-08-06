'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { shouldPollNow } from '@/lib/market-clock';
import { fmtQty } from '@/lib/tw-fee';
import { useAppStore } from '@/lib/store';
import { useLiveQuotes } from '@/lib/useLiveQuotes';
import {
  fetchStockHistory,
  fetchAllStocksDayData,
  detectSignal,
  calculateSMA,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateKD,
  formatVolume,
  formatChangeSign,
  formatChangePercentSign,
  formatValue,
  type CandleData,
  type StockInfo,
  type TradingSignal,
  marketBadge,
} from '@/lib/twse-api';
import { format, subMonths, subYears } from 'date-fns';
import styles from './StockDetail.module.css';
import SignalAnalysis from './SignalAnalysis';
import ChipDualCard from './ChipDualCard';
import EtfInfluence from '@/components/EtfInfluence/EtfInfluence';
import PeerComps from './PeerComps';
import FinHealth from './FinHealth';
import PeBand from './PeBand';
import PreTradeCheck from './PreTradeCheck';
import TechnicalChart from './TechnicalChart';
import StockTrendChart from '../WatchlistTracker/StockTrendChart';
import StockAsk from './StockAsk';
import RiskBadge from '@/components/shared/RiskBadge';
import { useChipVerdicts, VerdictStrip } from '@/components/shared/ChipVerdict';
import MarginSignals from '@/components/shared/MarginSignals';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import PageHelp from '@/components/Help/PageHelp';
import QuoteGrid from './QuoteGrid';
import { useShallow } from 'zustand/react/shallow';

// ─── Types ──────────────────────────────────────────────────────

interface TrendApiResponse {
  preMarketRecommendation: {
    todayClose: number;
    prevClose: number;
    todayChangePercent: number;
    expectedOpeningRange: { low: number; high: number };
    recommendation: 'strong_buy' | 'buy' | 'wait' | 'avoid';
    recommendationText: string;
    optimalOrderTime: string;
    orderLevels: Array<{ label: string; price: number; rationale: string; style: string; riskLevel: string }>;
    stopLossPrice: number;
    auctionStrategy: string;
    dayTradingNote: string;
  };
  companyProfile: {
    fullName: string;
    shortName: string;
    chairman: string;
    ceo: string;
    spokesperson: string;
    address: string;
    foundedDate: string;
    listedDate: string;
    capitalAmount: string;
    capitalBillion: number;
    industryCategory: string;
    mainBusiness: string;
    keyProducts: string[];
    companyScale: 'large' | 'mid' | 'small';
    ageYears: number;
    listingAgeYears: number;
  };
  pricePrediction: {
    nextDayHigh: { price: number; basis: string; confidence: number };
    nextDayLow: { price: number; basis: string; confidence: number };
    resistance: Array<{ price: number; label: string; strength: string }>;
    support: Array<{ price: number; label: string; strength: string }>;
    buyZoneHigh: number;
    buyZoneLow: number;
    targetZoneHigh: number;
    targetZoneLow: number;
    atr: number;
    atrPercent: number;
    pricePositionScore: number;
    positionDescription: string;
  };
  industry: { code: string; name: string; sector: string; emoji: string; description: string };
  industryOutlook: { institutionalSentiment: number; consensusRating: string; avgTargetUpside: string };
}

// ─── Constants ──────────────────────────────────────────────────

const PERIODS: Array<{ id: string; label: string; months: number }> = [
  { id: '1M', label: '1個月', months: 1 },
  { id: '3M', label: '3個月', months: 3 },
  { id: '6M', label: '半年', months: 6 },
  { id: '1Y', label: '1年', months: 12 },
];

const REC_CONFIG = {
  strong_buy: { label: '強力買進', bg: 'var(--color-up)', color: '#fff', emoji: '🚀' },
  buy:        { label: '建議買進', bg: 'rgba(var(--color-up-rgb,220,38,38),0.15)', color: 'var(--color-up)', emoji: '📈' },
  wait:       { label: '觀望等待', bg: 'rgba(245,158,11,0.15)', color: '#f59e0b', emoji: '⏳' },
  avoid:      { label: '暫緩進場', bg: 'rgba(var(--color-down-rgb,34,197,94),0.15)', color: 'var(--color-down)', emoji: '⚠️' },
};

const STRENGTH_COLOR: Record<string, string> = {
  strong: 'var(--color-up)',
  medium: '#f59e0b',
  weak:   'var(--color-down)',
};

// ─── Main Component ─────────────────────────────────────────────

export default function StockDetail() {
  const {
    selectedStock,
    allStocks,
    setAllStocks,
    addToWatchlist,
    removeFromWatchlist,
    isInWatchlist,
    holdings,
    addHolding,
    chartPeriod,
    setChartPeriod,
    navigateBack,
    pageHistory
  } = useAppStore(useShallow((s) => ({
    selectedStock: s.selectedStock,
    allStocks: s.allStocks,
    setAllStocks: s.setAllStocks,
    addToWatchlist: s.addToWatchlist,
    removeFromWatchlist: s.removeFromWatchlist,
    isInWatchlist: s.isInWatchlist,
    holdings: s.holdings,
    addHolding: s.addHolding,
    chartPeriod: s.chartPeriod,
    setChartPeriod: s.setChartPeriod,
    navigateBack: s.navigateBack,
    pageHistory: s.pageHistory,
  })));

  const [stock, setStock] = useState<StockInfo | null>(null);
  const verdicts = useChipVerdicts(stock?.code ? [stock.code] : []);
  const [candles, setCandles] = useState<CandleData[]>([]);
  const [signal, setSignal] = useState<TradingSignal | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'intraday' | 'chart' | 'signal' | 'peers' | 'fin' | 'portfolio' | 'company' | 'premarket' | 'strategy' | 'news' | 'ask'>('intraday');

  const [trendData, setTrendData] = useState<TrendApiResponse | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const [allTimeHigh, setAllTimeHigh] = useState<{ high: number; date: string } | null>(null);

  // 歷史最高價（上市至今月線最高），變動極少 → 換股才抓一次
  useEffect(() => {
    if (!selectedStock) { setAllTimeHigh(null); return; }
    let live = true;
    setAllTimeHigh(null);
    fetch(`/api/twse/all-time-high?code=${selectedStock}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (live && d?.high) setAllTimeHigh({ high: d.high, date: d.date }); })
      .catch(() => {});
    return () => { live = false; };
  }, [selectedStock]);

  const [showAddHolding, setShowAddHolding] = useState(false);
  const [holdingForm, setHoldingForm] = useState({
    buyPrice: '', quantity: '',
    buyDate: format(new Date(), 'yyyy-MM-dd'), note: '',
  });

  const inWatchlist = selectedStock ? isInWatchlist(selectedStock) : false;

  // RSI(5)/RSI(10)（犀利媽法·2026-07-24）：日K收盤序列計算，顯示於頂列統計
  const rsiPair = useMemo(() => {
    if (candles.length < 12) return null;
    const closes = candles.map(c => c.close);
    const r5 = calculateRSI(closes, 5).at(-1), r10 = calculateRSI(closes, 10).at(-1);
    if (r5 == null || r10 == null) return null;
    return { r5, r10, hot: r5 >= 90 && r10 >= 90, cold: r5 < 12 };
  }, [candles]);

  // ── Load chart / signal data ──────────────────────────────────
  // allStocks 只在這裡當「已經抓過的清單」讀一次，不是重跑的觸發條件。
  // 放在 deps 裡會讓 Header 每 2 分鐘的 setAllStocks() 把整個載入流程重跑一遍。
  const allStocksRef = useRef(allStocks);
  allStocksRef.current = allStocks;
  // 換股/換週期時作廢上一輪 —— 那個 for 迴圈是串行 + 每次 sleep 300ms，
  // 沒有這道 guard 的話舊的 12 次抓取會繼續跑完，還會把結果寫回畫面。
  const runIdRef = useRef(0);

  const loadStockData = useCallback(async () => {
    if (!selectedStock) return;
    const myRun = ++runIdRef.current;
    setLoading(true);
    try {
      let stocks = allStocksRef.current;
      if (stocks.length === 0) {
        stocks = await fetchAllStocksDayData();
        setAllStocks(stocks);
      }
      let stockInfo = stocks.find(s => s.code === selectedStock);
      if (!stockInfo) {
        // 清單缺漏後備（上櫃段偶發缺檔/清單尚在載入）：單檔報價直查——
        // 個股頁與 K 線不因全市場清單不完整而整頁空白（例：6488 環球晶）。
        try {
          const j = await fetch(`/api/twse/yahoo-quote?codes=${selectedStock}`).then(r => (r.ok ? r.json() : null));
          const q = j?.quotes?.[0];
          if (q && q.price > 0) {
            stockInfo = {
              code: q.code, name: q.name || q.code, price: q.price,
              open: q.open || 0, high: q.high || 0, low: q.low || 0, close: q.price,
              change: q.change || 0, changePercent: q.changePercent || 0,
              volume: q.volume || 0, value: 0, transactions: 0,
            } as StockInfo;
          }
        } catch { /* 後備失敗維持原提示 */ }
      }
      if (stockInfo) setStock(stockInfo);

      const period = PERIODS.find(p => p.id === chartPeriod) || PERIODS[1];
      const allCandles: CandleData[] = [];
      for (let m = period.months - 1; m >= 0; m--) {
        const date = subMonths(new Date(), m);
        const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}01`;
        if (runIdRef.current !== myRun) return;   // 已換股，放棄這一輪
        const monthData = await fetchStockHistory(selectedStock, dateStr);
        allCandles.push(...monthData);
        await new Promise(r => setTimeout(r, 300));
      }
      const seen = new Set<number>();
      const unique = allCandles.filter(c => {
        if (seen.has(c.time)) return false;
        seen.add(c.time);
        return true;
      }).sort((a, b) => a.time - b.time);
      if (runIdRef.current !== myRun) return;   // 別把舊股票的 K 線寫進畫面
      setCandles(unique);
      if (unique.length >= 26 && stockInfo) {
        const sig = detectSignal(unique, stockInfo);
        setSignal(sig);
      }
    } catch (err) {
      console.error('Error loading stock data:', err);
    } finally {
      if (runIdRef.current === myRun) setLoading(false);
    }
  }, [selectedStock, chartPeriod]);

  useEffect(() => { loadStockData(); }, [loadStockData]);

  // ── Live MIS quote — keep the displayed price/change real-time ──
  const liveQuotes = useLiveQuotes(selectedStock ? [selectedStock] : []);
  useEffect(() => {
    const q = selectedStock ? liveQuotes[selectedStock] : null;
    if (!q || q.price <= 0) return;
    // 盤中才用即時報價覆蓋開高低(盤中 high/low 為當日即時極值)；收盤後 MIS 常把
    // 開高低回成收盤價，會蓋掉正確的當日 OHLC(來自 STOCK_DAY_ALL)，故收盤後只更新價/量。
    const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const mins = tw.getHours() * 60 + tw.getMinutes();
    const marketOpen = tw.getDay() >= 1 && tw.getDay() <= 5 && mins >= 9 * 60 && mins < 13 * 60 + 35;
    setStock(prev => (prev && prev.code === q.code)
      ? { ...prev, price: q.price, change: q.change, changePercent: q.changePercent,
          ...(marketOpen ? { open: q.open || prev.open, high: q.high || prev.high, low: q.low || prev.low } : {}),
          volume: q.volume || prev.volume }
      : prev);
  }, [liveQuotes, selectedStock]);

  // ── Load trend analysis for company / premarket tabs ─────────
  useEffect(() => {
    if (!selectedStock) return;
    if (activeTab !== 'company' && activeTab !== 'premarket' && activeTab !== 'news') return;
    if (trendData) return; // already loaded for this stock

    setTrendLoading(true);
    fetch(`/api/twse/trend-analysis?code=${selectedStock}`)
      .then(r => r.json())
      .then((data: TrendApiResponse) => setTrendData(data))
      .catch(err => console.error('Trend fetch error:', err))
      .finally(() => setTrendLoading(false));
  }, [activeTab, selectedStock]);

  // Reset trendData when stock changes
  useEffect(() => { setTrendData(null); }, [selectedStock]);

  // ── Holding helpers ───────────────────────────────────────────
  // 五檔委託簿（買量/賣量·委買賣力道）——daemon 優先集掃描寫入，非優先集個股會是 null
  const [book, setBook] = useState<{ bid: [number, number][]; ask: [number, number][] } | null>(null);
  useEffect(() => {
    if (!selectedStock) { setBook(null); return; }
    let live = true;
    const load = () => fetch(`/api/twse/depth?code=${selectedStock}`)
      .then(r => (r.ok ? r.json() : null))
      // ⚠回傳是 { found, at, row: { bid, ask } }——資料在 row 底下，不是頂層
      .then(j => { const r = j?.row; if (live) setBook(r?.bid?.length || r?.ask?.length ? { bid: r.bid ?? [], ask: r.ask ?? [] } : null); })
      .catch(() => {});
    load();
    const id = setInterval(() => { if (shouldPollNow()) load(); }, 30000);   // 休市/背景分頁不發請求
    return () => { live = false; clearInterval(id); };
  }, [selectedStock]);

  const handleAddHolding = () => {
    if (!stock || !holdingForm.buyPrice || !holdingForm.quantity) return;
    addHolding({
      code: stock.code,
      name: stock.name,
      buyPrice: parseFloat(holdingForm.buyPrice),
      quantity: parseFloat(holdingForm.quantity),
      buyDate: holdingForm.buyDate,
      note: holdingForm.note,
    });
    setShowAddHolding(false);
    setHoldingForm({ buyPrice: '', quantity: '', buyDate: format(new Date(), 'yyyy-MM-dd'), note: '' });
    setActiveTab('portfolio');
  };

  const myHoldings = holdings.filter(h => h.code === selectedStock);
  const totalCost  = myHoldings.reduce((sum, h) => sum + h.buyPrice * h.quantity * 1000, 0);
  const totalValue = stock ? myHoldings.reduce((sum, h) => sum + stock.price * h.quantity * 1000, 0) : 0;
  const totalPnL   = totalValue - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

  if (!selectedStock || !stock) {
    return (
      <div className={styles.placeholder}>
        <div className={styles.placeholderIcon}>📈</div>
        <div className={styles.placeholderText}>請從搜尋欄或排行榜選擇股票</div>
      </div>
    );
  }

  const isUp = stock.change >= 0;
  const changeColor = stock.change === 0 ? 'var(--color-flat)' : isUp ? 'var(--color-up)' : 'var(--color-down)';

  const TABS = [
    { id: 'intraday',  label: '📈 即時走勢' },
    { id: 'ask',       label: '🧠 問 AI' },
    { id: 'chart',     label: '📊 K線圖表' },
    { id: 'signal',    label: '🎯 訊號分析' },
    { id: 'peers',     label: '🏭 同業比較' },
    { id: 'fin',       label: '💰 財務體檢' },
    { id: 'portfolio', label: `💼 持倉 ${myHoldings.length > 0 ? `(${myHoldings.length})` : ''}` },
    { id: 'company',   label: '🏢 公司資訊' },
    { id: 'premarket', label: '📋 當日行情' },
    { id: 'strategy',  label: '⏰ 開盤策略' },
    { id: 'news',      label: '📰 產業新聞' },
  ];

  return (
    <div className={styles.container}>
      {/* Stock Header */}
      <div className={styles.stockHeader}>
        {pageHistory.length > 0 && (
          <button
            id="stock-header-back"
            className={styles.backBtn}
            onClick={navigateBack}
            title="返回上一頁"
            aria-label="返回"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}

        <div className={styles.stockId}>
          <div className={styles.stockCode}>{stock.code}</div>
          <div className={styles.stockName}>
            {stock.name}
            {(() => { const b = marketBadge(stock); return b ? <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 800, verticalAlign: 'middle', color: b.c, border: `1px solid ${b.c}66`, borderRadius: 5, padding: '0 5px' }}>{b.t === '市' ? '上市' : b.t === '櫃' ? '上櫃' : b.t}</span> : null; })()}
            <span style={{ marginLeft: 6, verticalAlign: 'middle' }}><RiskBadge code={stock.code} /></span>
          </div>
        </div>

        <div className={styles.priceBlock}>
          <div className={styles.currentPrice} style={{ color: changeColor }}>
            {stock.price.toFixed(2)}
          </div>
          <div className={styles.priceChange} style={{ color: changeColor }}>
            {formatChangeSign(stock.change)} ({formatChangePercentSign(stock.changePercent)})
          </div>
        </div>

        {/* 報價總覽：改為券商式三欄格子（2026-08-06 依使用者提供的版面）——
            大數字、漲跌用顏色講完、含漲跌停價與日內位階條，不必逐行讀。 */}
        <div className={styles.headerActions}>
          <button
            id={`watchlist-toggle-${stock.code}`}
            className={`btn ${inWatchlist ? 'btn-ghost' : 'btn-ghost'}`}
            style={inWatchlist ? { color: '#f59e0b', borderColor: '#f59e0b' } : {}}
            onClick={() => inWatchlist ? removeFromWatchlist(stock.code) : addToWatchlist(stock)}
          >
            {inWatchlist ? '★ 已追蹤' : '☆ 加入自選'}
          </button>
          <AddCandidateButton code={stock.code} variant="full" />
          <button
            id={`add-holding-btn-${stock.code}`}
            className="btn btn-buy"
            onClick={() => setShowAddHolding(true)}
          >
            + 記錄持倉
          </button>
        </div>
      </div>

      {/* ⚠必須放在 stockHeader **之外**：stockHeader 是橫向 flex，
          放進去會被壓成一個窄欄（手機實測只剩 180px → 格子只能排 1 欄、位階條被壓扁）。
          搬出來拿到整行寬度後，手機 2 欄、桌機一次排完。 */}
      <QuoteGrid stock={stock} allTimeHigh={allTimeHigh} rsi={rsiPair} book={book} />

      {/* 三條判讀併排（買進訊號／籌碼判讀／模型判讀）
          ——原本各佔一列，桌機上吃掉約 130px 高度，把下方 K 線圖擠到要捲動才看得全。
          改為自適應欄位：寬螢幕三欄、中等兩欄、窄螢幕仍自動堆疊（各條內部本來就會換行）。 */}
      <div className={styles.verdictColumns}>
        {signal && (
          <div className={styles.signalBadgeRow}>
            <SignalBadge signal={signal} />
            {loading && <span className={styles.loadingText}>⏳ 載入中…</span>}
          </div>
        )}
        {verdicts[stock.code] && <VerdictStrip v={verdicts[stock.code]} />}
        <MarginSignals code={stock.code} price={stock.price} changePercent={stock.changePercent} high={stock.high} low={stock.low} volume={stock.volume} />
      </div>

      {/* Tabs */}
      <div className={styles.tabsRow}>
        <div className="tabs" style={{ width: 'fit-content' }}>
          {TABS.map(t => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              className={`tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id as typeof activeTab)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'chart' && (
          <div className={styles.periodSelector}>
            {PERIODS.map(p => (
              <button
                key={p.id}
                id={`period-${p.id}`}
                className={`btn btn-sm ${chartPeriod === p.id ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setChartPeriod(p.id as typeof chartPeriod)}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content Area */}
      <div className={styles.content}>
        {activeTab === 'intraday' && (
          <StockTrendChart code={stock.code} name={stock.name} closePrice={stock.price} livePrice={stock.price} changePercent={stock.changePercent} volume={stock.volume} />
        )}

        {activeTab === 'ask' && (
          <StockAsk code={stock.code} name={stock.name} />
        )}

        {activeTab === 'chart' && (
          <TechnicalChart candles={candles} stock={stock} loading={loading} />
        )}

        {activeTab === 'signal' && (
          <>
            <ChipDualCard code={stock.code} />
            <EtfInfluence code={stock.code} />
            <SignalAnalysis code={stock.code} name={stock.name} price={stock.price} />
          </>
        )}

        {activeTab === 'fin' && <FinHealth code={stock.code} price={stock.price} />}

        {activeTab === 'peers' && (
          <>
            <PeerComps code={stock.code} />
            <PeBand code={stock.code} />
          </>
        )}

        {activeTab === 'portfolio' && (
          <div className={styles.portfolioTab}>
            {myHoldings.length > 0 && (
              <div className={styles.portfolioSummary}>
                <div className={styles.pnlCard}>
                  <div className={styles.pnlLabel}>總損益</div>
                  <div className={styles.pnlValue} style={{ color: totalPnL >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                    {totalPnL >= 0 ? '+' : ''}{totalPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                    <span className={styles.pnlPct}>
                      ({totalPnLPct >= 0 ? '+' : ''}{totalPnLPct.toFixed(2)}%)
                    </span>
                  </div>
                  <div className={styles.pnlSub}>
                    成本 {totalCost.toLocaleString('zh-TW', { maximumFractionDigits: 0 })} / 現值 {totalValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                  </div>
                </div>
              </div>
            )}
            <div className={styles.holdingsList}>
              {myHoldings.map(h => {
                const value = stock.price * h.quantity * 1000;
                const cost  = h.buyPrice * h.quantity * 1000;
                const pnl   = value - cost;
                const pnlPct = (pnl / cost) * 100;
                return (
                  <div key={h.id} className={styles.holdingItem}>
                    <div className={styles.holdingInfo}>
                      <span className={styles.holdingDate}>{h.buyDate}</span>
                      <span className={styles.holdingQty}>{fmtQty(h.quantity)}</span>
                      <span className={styles.holdingBuyPrice}>成本 ${h.buyPrice.toFixed(2)}</span>
                      {h.note && <span className={styles.holdingNote}>{h.note}</span>}
                    </div>
                    <div className={styles.holdingPnl} style={{ color: pnl >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                      {pnl >= 0 ? '+' : ''}{pnl.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                      <span className={styles.holdingPnlPct}>({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              id="add-holding-form-btn"
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => setShowAddHolding(true)}
            >
              + 新增持倉記錄
            </button>
          </div>
        )}

        {/* ── 公司資訊分頁 ───────────────────────────────────── */}
        {activeTab === 'company' && (
          <CompanyTab trendData={trendData} loading={trendLoading} stockName={stock.name} stockCode={stock.code} />
        )}

        {/* ── 開盤策略分頁 ───────────────────────────────────── */}
        {activeTab === 'premarket' && (
          <PremarketTab trendData={trendData} loading={trendLoading} stockName={stock.name} stock={stock} />
        )}

        {/* ── 開盤策略分頁 ───────────────────────────────────── */}
        {activeTab === 'strategy' && (
          <>
            <EarningsCallCard code={stock.code} />
            <StrategyTab trendData={trendData} loading={trendLoading} stockName={stock.name} />
          </>
        )}

        {/* ── 產業新聞分頁 ───────────────────────────────────── */}
        {activeTab === 'news' && (
          <NewsTab
            stockCode={stock.code}
            stockName={stock.name}
            industry={trendData?.industry?.name || trendData?.companyProfile?.industryCategory || ''}
            industryEmoji={trendData?.industry?.emoji || '📰'}
          />
        )}
      </div>

      {/* Add Holding Modal */}
      {showAddHolding && (
        <div className={styles.modalOverlay} onClick={() => setShowAddHolding(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>記錄持倉 — {stock.code} {stock.name}</h3>
              <button className={styles.modalClose} onClick={() => setShowAddHolding(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.formGroup}>
                <label>買進單價 (每股)</label>
                <input id="holding-buy-price" type="number" step="0.01" placeholder={stock.price.toFixed(2)}
                  value={holdingForm.buyPrice} onChange={e => setHoldingForm(f => ({ ...f, buyPrice: e.target.value }))} className="input" />
                <span className={styles.inputHelper}>請以「每股單價」輸入，如台積電輸入 600、大立光輸入 2500，而非整張數百萬元。</span>
              </div>
              <div className={styles.formGroup}>
                <label>買進張數</label>
                <input id="holding-quantity" type="number" min="0.001" step="0.001" placeholder="張數（可含零股：0.35=350股）"
                  value={holdingForm.quantity} onChange={e => setHoldingForm(f => ({ ...f, quantity: e.target.value }))} className="input" />
              </div>
              <div className={styles.formGroup}>
                <label>買進日期</label>
                <input id="holding-buy-date" type="date" value={holdingForm.buyDate}
                  onChange={e => setHoldingForm(f => ({ ...f, buyDate: e.target.value }))} className="input" />
              </div>
              <div className={styles.formGroup}>
                <label>買進理由</label>
                <input id="holding-note" type="text" placeholder="建議填寫——會寫入論點卡，跌破停損時提醒你面對它"
                  value={holdingForm.note} onChange={e => setHoldingForm(f => ({ ...f, note: e.target.value }))} className="input" />
              </div>
              <PreTradeCheck code={stock.code} price={parseFloat(holdingForm.buyPrice) || stock.price} qty={parseFloat(holdingForm.quantity || '0')} />
              {holdingForm.buyPrice && holdingForm.quantity && (
                <div className={styles.costPreview}>
                  <div style={{ fontSize: '0.75rem', marginBottom: '4px', opacity: 0.8 }}>
                    計算公式：單價 ({parseFloat(holdingForm.buyPrice).toLocaleString()} 元) × {fmtQty(parseFloat(holdingForm.quantity) || 0)}（{Math.round((parseFloat(holdingForm.quantity) || 0) * 1000).toLocaleString()} 股）
                  </div>
                  <div>
                    預估成本 (含 0.1425% 手續費)：
                    <strong>
                      {(parseFloat(holdingForm.buyPrice) * parseFloat(holdingForm.quantity || '0') * 1000 * 1.001425).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元
                    </strong>
                  </div>
                </div>
              )}
            </div>
            <div className={styles.modalFooter}>
              <button className="btn btn-ghost" onClick={() => setShowAddHolding(false)}>取消</button>
              <button id="submit-holding" className="btn btn-buy" onClick={handleAddHolding}>確認記錄</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SignalBadge ────────────────────────────────────────────────

function SignalBadge({ signal }: { signal: TradingSignal }) {
  const config = {
    BUY:     { label: '買進訊號', bg: 'var(--color-up-bg)',               color: 'var(--color-up)',   border: 'var(--color-up)' },
    SELL:    { label: '賣出警示', bg: 'var(--color-down-bg)',             color: 'var(--color-down)', border: 'var(--color-down)' },
    WATCH:   { label: '觀察中',   bg: 'rgba(245,158,11,0.1)',             color: '#f59e0b',            border: '#f59e0b' },
    NEUTRAL: { label: '中性',     bg: 'rgba(100,116,139,0.1)',            color: 'var(--text-muted)', border: 'var(--border-primary)' },
  };
  const cfg = config[signal.type];
  return (
    <div className={styles.signalBadge} style={{ background: cfg.bg, color: cfg.color, borderColor: cfg.border }}>
      <span>{signal.type === 'BUY' ? '🟢' : signal.type === 'SELL' ? '🔴' : signal.type === 'WATCH' ? '🟡' : '⚪'}</span>
      <span className={styles.signalBadgeLabel}>{cfg.label}</span>
      <div className={styles.signalStrengthBar}>
        <div className={styles.signalStrengthFill} style={{ width: `${signal.strength}%`, background: cfg.color }} />
      </div>
      <span className={styles.signalStrengthText}>{signal.strength.toFixed(0)}%</span>
    </div>
  );
}

// ─── Loading / Error skeleton ───────────────────────────────────

function LoadingCard() {
  return (
    <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: '32px', marginBottom: '12px', animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>⏳</div>
      <div style={{ fontSize: '14px' }}>資料載入中，請稍後…</div>
    </div>
  );
}

// ─── Company Info Tab ───────────────────────────────────────────

function CompanyTab({ trendData, loading, stockName, stockCode }: {
  trendData: TrendApiResponse | null;
  loading: boolean;
  stockName: string;
  stockCode: string;
}) {
  if (loading) return <LoadingCard />;
  if (!trendData) return (
    <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
      無法載入公司資訊，請稍後重試
    </div>
  );

  const cp = trendData.companyProfile;
  const io = trendData.industryOutlook;
  const ind = trendData.industry;

  const scaleLabel = { large: '大型股', mid: '中型股', small: '小型股' };
  const scaleColor = { large: '#6366f1', mid: '#f59e0b', small: 'var(--text-muted)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' }}>

      {/* Header card */}
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: '12px',
        padding: '20px',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Decorative gradient strip */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
          background: 'linear-gradient(90deg, #6366f1, #a855f7, #ec4899)',
        }} />

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px', marginTop: '8px' }}>
          {/* Industry emoji badge */}
          <div style={{
            width: '56px', height: '56px', borderRadius: '14px', flexShrink: 0,
            background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(168,85,247,0.2))',
            border: '1px solid rgba(99,102,241,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px',
          }}>
            {ind.emoji}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.3 }}>
              {cp.fullName || stockName}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '3px' }}>
              {stockCode} · {cp.industryCategory}
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
              <span style={{
                fontSize: '13px', padding: '2px 8px', borderRadius: '999px',
                background: `${scaleColor[cp.companyScale]}22`,
                color: scaleColor[cp.companyScale], border: `1px solid ${scaleColor[cp.companyScale]}55`,
              }}>{scaleLabel[cp.companyScale]}</span>
              {cp.capitalAmount && cp.capitalAmount !== '--' && (
                <span style={{
                  fontSize: '13px', padding: '2px 8px', borderRadius: '999px',
                  background: 'rgba(99,102,241,0.1)', color: '#818cf8',
                  border: '1px solid rgba(99,102,241,0.3)',
                }}>資本額 {cp.capitalAmount}</span>
              )}
              {cp.ageYears > 0 && (
                <span style={{
                  fontSize: '13px', padding: '2px 8px', borderRadius: '999px',
                  background: 'rgba(100,116,139,0.1)', color: 'var(--text-muted)',
                  border: '1px solid var(--border-primary)',
                }}>成立 {cp.ageYears} 年</span>
              )}
            </div>
          </div>
        </div>

        {/* Main business */}
        {cp.mainBusiness && (
          <div style={{
            marginTop: '16px', padding: '12px 14px',
            background: 'rgba(99,102,241,0.06)', borderRadius: '8px',
            borderLeft: '3px solid #6366f1',
            fontSize: '13px', lineHeight: 1.65, color: 'var(--text-secondary)',
          }}>
            {cp.mainBusiness}
          </div>
        )}

        {/* Key products */}
        {cp.keyProducts && cp.keyProducts.length > 0 && (
          <div style={{ marginTop: '12px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {cp.keyProducts.map((p, i) => (
              <span key={i} style={{
                fontSize: '12px', padding: '4px 10px', borderRadius: '6px',
                background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                border: '1px solid var(--border-primary)',
              }}>{p}</span>
            ))}
          </div>
        )}
      </div>

      {/* Info grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        gap: '10px',
      }}>
        {[
          { label: '董事長',   value: cp.chairman },
          { label: '總經理',   value: cp.ceo },
          { label: '成立日期', value: cp.foundedDate },
          { label: '上市日期', value: cp.listedDate },
        ].map(({ label, value }) => value && value !== '--' && (
          <div key={label} style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            borderRadius: '10px', padding: '12px 14px',
          }}>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Address */}
      {cp.address && cp.address !== '--' && (
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
          borderRadius: '10px', padding: '12px 14px',
          display: 'flex', gap: '10px', alignItems: 'flex-start',
        }}>
          <span style={{ fontSize: '18px', flexShrink: 0 }}>📍</span>
          <div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '4px' }}>公司地址</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.5 }}>{cp.address}</div>
          </div>
        </div>
      )}

      {/* Industry description */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
        borderRadius: '10px', padding: '14px 16px',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          {ind.emoji} 產業說明
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
          {ind.description}
        </div>
      </div>

      {/* Institutional sentiment bar */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
        borderRadius: '10px', padding: '14px 16px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            🏦 法人看好度
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{
              fontSize: '13px', padding: '2px 8px', borderRadius: '999px',
              background: 'rgba(99,102,241,0.15)', color: '#818cf8',
            }}>{io.consensusRating}</span>
            <span style={{ fontSize: '13px', fontWeight: 700, color: '#6ee7b7' }}>
              {io.avgTargetUpside}
            </span>
          </div>
        </div>
        <div style={{ height: '10px', borderRadius: '999px', background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${io.institutionalSentiment}%`,
            borderRadius: '999px',
            background: io.institutionalSentiment >= 70
              ? 'linear-gradient(90deg, #6366f1, #a855f7)'
              : io.institutionalSentiment >= 50
              ? 'linear-gradient(90deg, #f59e0b, #fbbf24)'
              : 'linear-gradient(90deg, #8b9bb8, #94a3b8)',
            transition: 'width 0.8s ease',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '13px', color: 'var(--text-muted)' }}>
          <span>偏空</span>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{io.institutionalSentiment}/100</span>
          <span>偏多</span>
        </div>
      </div>
    </div>
  );
}

// ─── Premarket Strategy Tab ─────────────────────────────────────

// ── 法說會前瞻（daemon 質化生成；7日內有法說會的關注股才有） ──
function EarningsCallCard({ code }: { code: string }) {
  const [d, setD] = useState<{ date: string; preview: string; model: string } | null>(null);
  useEffect(() => {
    let live = true;
    setD(null);
    fetch(`/api/ai/earnings-preview?code=${code}`).then(r => (r.ok ? r.json() : null))
      .then(x => { if (live && x?.preview) setD(x); }).catch(() => {});
    return () => { live = false; };
  }, [code]);
  if (!d) return null;
  return (
    <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'rgba(125,211,252,0.06)', border: '1px solid rgba(125,211,252,0.3)' }}>
      <div style={{ fontWeight: 800, fontSize: '0.95rem', marginBottom: 6 }}>🎤 法說會前瞻 <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>（{d.date} 召開 · AI 質化推測，非數字預測）</span></div>
      <div style={{ fontSize: 13.5, lineHeight: 1.9, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{d.preview}</div>
    </div>
  );
}

function PremarketTab({ trendData, loading, stockName, stock }: {
  trendData: TrendApiResponse | null;
  loading: boolean;
  stockName: string;
  stock: StockInfo;
}) {
  if (loading) return <LoadingCard />;
  if (!trendData) return (
    <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
      無法載入行情分析，請稍後重試
    </div>
  );

  const pm  = trendData.preMarketRecommendation;
  const pp  = trendData.pricePrediction;
  const rec = REC_CONFIG[pm.recommendation];

  // Use live data — use stock.change directly (same data source as stock.price)
  const price = stock.price;
  const change = stock.change;
  const changePct = stock.changePercent;
  const prevClose = price - change;
  const todayOpen = stock.open > 0 ? stock.open : price;
  const todayHigh = stock.high > 0 ? stock.high : price;
  const todayLow  = stock.low > 0 ? stock.low : price;
  const amplitude = prevClose > 0 ? ((todayHigh - todayLow) / prevClose) * 100 : 0;
  const closePos = (todayHigh - todayLow) > 0 ? (price - todayLow) / (todayHigh - todayLow) : 0.5;

  // Determine today's trend
  const isUp = changePct > 0.5;
  const isDown = changePct < -0.5;
  const isFlat = !isUp && !isDown;
  const isLimitUp = changePct >= 9.5;
  const isLimitDown = changePct <= -9.5;

  // Today's analysis text
  let analysisEmoji = '📊';
  let analysisLabel = '盤整觀望';
  let analysisColor = '#f59e0b';
  let analysisBg = 'rgba(245,158,11,0.1)';
  let analysisText = '';

  if (isLimitUp) {
    analysisEmoji = '🔴'; analysisLabel = '漲停鎖板';
    analysisColor = 'var(--color-up)'; analysisBg = 'rgba(240,62,62,0.1)';
    analysisText = `${stockName} 今日漲停鎖板，成交量 ${(stock.volume / 1000).toFixed(0)} 張。強勢封板表示買盤力道強勁，短線動能持續。`;
  } else if (isLimitDown) {
    analysisEmoji = '🟢'; analysisLabel = '跌停';
    analysisColor = 'var(--color-down)'; analysisBg = 'rgba(47,158,68,0.1)';
    analysisText = `${stockName} 今日跌停，成交量 ${(stock.volume / 1000).toFixed(0)} 張。建議觀望等待止跌訊號。`;
  } else if (changePct >= 5) {
    analysisEmoji = '🚀'; analysisLabel = '強勢上攻';
    analysisColor = 'var(--color-up)'; analysisBg = 'rgba(240,62,62,0.1)';
    analysisText = `${stockName} 今日大漲 ${changePct.toFixed(2)}%，漲幅超過 5%，盤中振幅 ${amplitude.toFixed(1)}%。收盤位置在日內 ${(closePos * 100).toFixed(0)}% 水位，${closePos > 0.7 ? '接近高點收盤，多方力道強勁' : '雖然漲幅大但未站穩高點，需注意回落風險'}。`;
  } else if (changePct >= 2) {
    analysisEmoji = '📈'; analysisLabel = '偏多走勢';
    analysisColor = 'var(--color-up)'; analysisBg = 'rgba(240,62,62,0.08)';
    analysisText = `${stockName} 今日上漲 ${changePct.toFixed(2)}%，走勢偏多。${closePos > 0.6 ? '收在日內高位區，明日有機會延續漲勢' : '盤中高點未能守住，需觀察明日能否突破今日高點 ' + todayHigh.toFixed(2)}。`;
  } else if (changePct > 0.5) {
    analysisEmoji = '↗️'; analysisLabel = '小幅上漲';
    analysisColor = '#818cf8'; analysisBg = 'rgba(99,102,241,0.08)';
    analysisText = `${stockName} 今日微漲 ${changePct.toFixed(2)}%，振幅 ${amplitude.toFixed(1)}%，整體走勢平穩。`;
  } else if (changePct <= -5) {
    analysisEmoji = '⚠️'; analysisLabel = '大幅下跌';
    analysisColor = 'var(--color-down)'; analysisBg = 'rgba(47,158,68,0.1)';
    analysisText = `${stockName} 今日重挫 ${changePct.toFixed(2)}%，跌幅超過 5%。${closePos < 0.3 ? '收在日內低檔，空方完全主導' : '盤中有反彈跡象，但整體弱勢未改'}。建議嚴格遵守停損紀律。`;
  } else if (changePct <= -2) {
    analysisEmoji = '📉'; analysisLabel = '偏空走勢';
    analysisColor = 'var(--color-down)'; analysisBg = 'rgba(47,158,68,0.08)';
    analysisText = `${stockName} 今日下跌 ${changePct.toFixed(2)}%，走勢偏空。${closePos < 0.3 ? '收在日內低點附近，短線不宜搶反彈' : '盤中有企穩跡象，可觀察明日是否止跌'}。`;
  } else if (changePct < -0.5) {
    analysisEmoji = '↘️'; analysisLabel = '小幅下跌';
    analysisColor = '#f59e0b'; analysisBg = 'rgba(245,158,11,0.08)';
    analysisText = `${stockName} 今日微跌 ${changePct.toFixed(2)}%，振幅 ${amplitude.toFixed(1)}%，波動不大。`;
  } else {
    analysisEmoji = '➡️'; analysisLabel = '平盤整理';
    analysisColor = 'var(--text-muted)'; analysisBg = 'rgba(100,116,139,0.08)';
    analysisText = `${stockName} 今日平盤整理，漲跌幅 ${changePct.toFixed(2)}%，振幅僅 ${amplitude.toFixed(1)}%。市場觀望氣氛濃，等待方向選擇。`;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' }}>

      {/* Today's analysis header */}
      <div style={{
        borderRadius: '12px', padding: '18px 20px', position: 'relative', overflow: 'hidden',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
      }}>
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
          background: isUp
            ? 'linear-gradient(90deg, var(--color-up), #f97316)'
            : isDown
            ? 'linear-gradient(90deg, var(--color-down), #4ade80)'
            : 'linear-gradient(90deg, #f59e0b, #d97706)',
        }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px' }}>
          <span style={{ fontSize: '28px' }}>{analysisEmoji}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '2px' }}>當日行情評估</div>
            <div style={{
              display: 'inline-block', fontSize: '15px', fontWeight: 800, padding: '4px 14px',
              borderRadius: '8px', background: analysisBg, color: analysisColor,
            }}>{analysisLabel}</div>
          </div>
          <div style={{
            fontSize: '20px', fontWeight: 800,
            color: changePct >= 0 ? 'var(--color-up)' : 'var(--color-down)',
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
          </div>
        </div>
        <div style={{ marginTop: '12px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
          {analysisText}
        </div>
      </div>

      {/* Today's OHLC boxes */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
        {[
          { label: '今日開盤', value: todayOpen.toFixed(2), color: todayOpen >= prevClose ? 'var(--color-up)' : 'var(--color-down)', emoji: '🔔' },
          { label: '今日最高', value: todayHigh.toFixed(2), color: 'var(--color-up)', emoji: '📈' },
          { label: '今日最低', value: todayLow.toFixed(2), color: 'var(--color-down)', emoji: '📉' },
          { label: '昨日收盤', value: prevClose.toFixed(2), color: 'var(--text-muted)', emoji: '📌' },
        ].map(({ label, value, color, emoji }) => (
          <div key={label} style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            borderRadius: '10px', padding: '12px', textAlign: 'center',
          }}>
            <div style={{ fontSize: '16px', marginBottom: '4px' }}>{emoji}</div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '4px', lineHeight: 1.3 }}>{label}</div>
            <div style={{ fontSize: '15px', fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Volume and amplitude analysis */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
        <div style={{
          background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)',
          borderRadius: '10px', padding: '14px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '13px', color: '#818cf8', fontWeight: 600, marginBottom: '6px' }}>📊 振幅</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#a5b4fc' }}>{amplitude.toFixed(2)}%</div>
        </div>
        <div style={{
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
          borderRadius: '10px', padding: '14px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '13px', color: '#fbbf24', fontWeight: 600, marginBottom: '6px' }}>📦 成交量</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#fbbf24' }}>{(stock.volume / 1000).toFixed(0)} 張</div>
        </div>
        <div style={{
          background: changePct >= 0 ? 'rgba(220,38,38,0.08)' : 'rgba(34,197,94,0.08)',
          border: `1px solid ${changePct >= 0 ? 'rgba(220,38,38,0.25)' : 'rgba(34,197,94,0.25)'}`,
          borderRadius: '10px', padding: '14px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '13px', color: changePct >= 0 ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 600, marginBottom: '6px' }}>💰 漲跌</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: changePct >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
            {change >= 0 ? '+' : ''}{change.toFixed(2)}
          </div>
        </div>
      </div>

      {/* AI order levels (委買策略) - still useful */}
      {pm.orderLevels.length > 0 && (
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
          borderRadius: '12px', overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid var(--border-primary)',
            fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em',
          }}>
            📋 關鍵價位參考
          </div>
          {pm.orderLevels.map((level, i) => {
            const st = { standard: { bg: 'rgba(99,102,241,0.1)', color: '#818cf8' }, aggressive: { bg: 'rgba(220,38,38,0.1)', color: 'var(--color-up)' }, conservative: { bg: 'rgba(245,158,11,0.1)', color: '#f59e0b' }, limit: { bg: 'rgba(100,116,139,0.1)', color: 'var(--text-muted)' } }[level.style] || { bg: 'rgba(99,102,241,0.1)', color: '#818cf8' };
            return (
              <div key={i} style={{
                padding: '14px 16px',
                borderBottom: i < pm.orderLevels.length - 1 ? '1px solid var(--border-primary)' : 'none',
                display: 'flex', gap: '12px', alignItems: 'flex-start',
              }}>
                <div style={{
                  minWidth: '80px', textAlign: 'center', padding: '4px 8px',
                  borderRadius: '6px', background: st.bg, color: st.color,
                  fontSize: '12px', fontWeight: 600, flexShrink: 0,
                }}>
                  {level.label}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '15px', fontWeight: 700, color: st.color, marginBottom: '4px' }}>
                    {level.price.toFixed(2)} 元
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    {level.rationale}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Resistance / Support from AI */}
      {pp && pp.nextDayHigh.price > 0 && (
        <>
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            borderRadius: '10px', padding: '14px 16px',
          }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>
              📊 技術面支撐 / 壓力位
            </div>
            <div style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '6px' }}>壓力位</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {pp.resistance.map((r, i) => (
                  <span key={i} style={{
                    fontSize: '12px', padding: '4px 10px', borderRadius: '6px',
                    background: `${STRENGTH_COLOR[r.strength]}18`,
                    color: STRENGTH_COLOR[r.strength],
                    border: `1px solid ${STRENGTH_COLOR[r.strength]}44`,
                    fontWeight: 600,
                  }}>
                    {r.label} {r.price.toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '6px' }}>支撐位</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {pp.support.map((s, i) => (
                  <span key={i} style={{
                    fontSize: '12px', padding: '4px 10px', borderRadius: '6px',
                    background: `${STRENGTH_COLOR[s.strength]}18`,
                    color: STRENGTH_COLOR[s.strength],
                    border: `1px solid ${STRENGTH_COLOR[s.strength]}44`,
                    fontWeight: 600,
                  }}>
                    {s.label} {s.price.toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Buy zone + Target zone + ATR */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
            <div style={{
              background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)',
              borderRadius: '10px', padding: '14px',
            }}>
              <div style={{ fontSize: '13px', color: '#818cf8', fontWeight: 600, marginBottom: '6px' }}>💰 買入區間</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#a5b4fc' }}>
                {pp.buyZoneLow.toFixed(2)} – {pp.buyZoneHigh.toFixed(2)}
              </div>
            </div>
            <div style={{
              background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)',
              borderRadius: '10px', padding: '14px',
            }}>
              <div style={{ fontSize: '13px', color: 'var(--color-down)', fontWeight: 600, marginBottom: '6px' }}>🎯 目標區間</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--color-down)' }}>
                {pp.targetZoneLow.toFixed(2)} – {pp.targetZoneHigh.toFixed(2)}
              </div>
            </div>
            <div style={{
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
              borderRadius: '10px', padding: '14px',
            }}>
              <div style={{ fontSize: '13px', color: '#fbbf24', fontWeight: 600, marginBottom: '6px' }}>📡 ATR 波動率</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#fbbf24' }}>
                {pp.atr.toFixed(2)} <span style={{ fontSize: '13px', opacity: 0.8 }}>({pp.atrPercent.toFixed(1)}%)</span>
              </div>
            </div>
          </div>

          {/* Price position score */}
          <div style={{
            padding: '12px 16px', borderRadius: '10px',
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            display: 'flex', gap: '12px', alignItems: 'center',
          }}>
            <div style={{ position: 'relative', width: '48px', height: '48px', flexShrink: 0 }}>
              <svg width="48" height="48" viewBox="0 0 48 48">
                <circle cx="24" cy="24" r="20" fill="none" stroke="var(--bg-tertiary)" strokeWidth="4" />
                <circle
                  cx="24" cy="24" r="20" fill="none"
                  stroke={pp.pricePositionScore >= 60 ? 'var(--color-up)' : pp.pricePositionScore >= 40 ? '#f59e0b' : 'var(--color-down)'}
                  strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={`${(pp.pricePositionScore / 100) * 125.6} 125.6`}
                  transform="rotate(-90 24 24)"
                />
              </svg>
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '13px', fontWeight: 700,
                color: pp.pricePositionScore >= 60 ? 'var(--color-up)' : pp.pricePositionScore >= 40 ? '#f59e0b' : 'var(--color-down)',
              }}>{pp.pricePositionScore}</div>
            </div>
            <div>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '3px' }}>今日價格位置評估</div>
              <div style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                {pp.positionDescription}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Opening Strategy Tab (Original) ────────────────────────────

function StrategyTab({ trendData, loading, stockName }: {
  trendData: TrendApiResponse | null;
  loading: boolean;
  stockName: string;
}) {
  if (loading) return <LoadingCard />;
  if (!trendData) return (
    <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
      無法載入開盤策略，請稍後重試
    </div>
  );

  const pm  = trendData.preMarketRecommendation;
  const pp  = trendData.pricePrediction;
  const rec = REC_CONFIG[pm.recommendation];

  const styleMap: Record<string, { bg: string; color: string }> = {
    aggressive:   { bg: 'rgba(220,38,38,0.1)',   color: 'var(--color-up)' },
    standard:     { bg: 'rgba(99,102,241,0.1)',   color: '#818cf8' },
    conservative: { bg: 'rgba(245,158,11,0.1)',   color: '#f59e0b' },
    limit:        { bg: 'rgba(100,116,139,0.1)',  color: 'var(--text-muted)' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' }}>

      {/* Recommendation header */}
      <div style={{
        borderRadius: '12px', padding: '18px 20px', position: 'relative', overflow: 'hidden',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
      }}>
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
          background: pm.recommendation === 'strong_buy'
            ? 'linear-gradient(90deg, var(--color-up), #f97316)'
            : pm.recommendation === 'buy'
            ? 'linear-gradient(90deg, #f97316, #fbbf24)'
            : pm.recommendation === 'wait'
            ? 'linear-gradient(90deg, #f59e0b, #d97706)'
            : 'linear-gradient(90deg, var(--color-down), #8b9bb8)',
        }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px' }}>
          <span style={{ fontSize: '28px' }}>{rec.emoji}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '2px' }}>明日開盤建議</div>
            <div style={{
              display: 'inline-block', fontSize: '15px', fontWeight: 800, padding: '4px 14px',
              borderRadius: '8px', background: rec.bg, color: rec.color,
            }}>{rec.label}</div>
          </div>
          <div style={{
            fontSize: '12px', padding: '6px 12px', borderRadius: '999px',
            background: 'rgba(251,146,60,0.15)', color: '#fb923c',
            border: '1px solid rgba(251,146,60,0.3)', fontWeight: 600, whiteSpace: 'nowrap',
          }}>
            ⏰ {pm.optimalOrderTime}
          </div>
        </div>
        <div style={{ marginTop: '12px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
          {pm.recommendationText}
        </div>
      </div>

      {/* Price boxes */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
        {[
          { label: '預期開盤低點', value: pm.expectedOpeningRange.low.toFixed(2), color: 'var(--color-down)', emoji: '📉' },
          { label: '預期開盤高點', value: pm.expectedOpeningRange.high.toFixed(2), color: 'var(--color-up)', emoji: '📈' },
          { label: '前日收盤',     value: pm.prevClose.toFixed(2),                color: 'var(--text-muted)', emoji: '📌' },
          { label: '建議停損價',   value: pm.stopLossPrice.toFixed(2),            color: '#f97316', emoji: '🛡️' },
        ].map(({ label, value, color, emoji }) => (
          <div key={label} style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            borderRadius: '10px', padding: '12px', textAlign: 'center',
          }}>
            <div style={{ fontSize: '16px', marginBottom: '4px' }}>{emoji}</div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '4px', lineHeight: 1.3 }}>{label}</div>
            <div style={{ fontSize: '15px', fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Order levels */}
      {pm.orderLevels.length > 0 && (
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
          borderRadius: '12px', overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid var(--border-primary)',
            fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em',
          }}>
            📋 委買掛單策略
          </div>
          {pm.orderLevels.map((level, i) => {
            const st = styleMap[level.style] || styleMap.standard;
            return (
              <div key={i} style={{
                padding: '14px 16px',
                borderBottom: i < pm.orderLevels.length - 1 ? '1px solid var(--border-primary)' : 'none',
                display: 'flex', gap: '12px', alignItems: 'flex-start',
              }}>
                <div style={{
                  minWidth: '80px', textAlign: 'center', padding: '4px 8px',
                  borderRadius: '6px', background: st.bg, color: st.color,
                  fontSize: '12px', fontWeight: 600, flexShrink: 0,
                }}>
                  {level.label}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '15px', fontWeight: 700, color: st.color, marginBottom: '4px' }}>
                    {level.price.toFixed(2)} 元
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    {level.rationale}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Auction strategy */}
      {pm.auctionStrategy && (
        <div style={{
          background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)',
          borderRadius: '10px', padding: '14px 16px',
          borderLeft: '3px solid #6366f1',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#818cf8', marginBottom: '6px' }}>
            🔔 競價策略
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
            {pm.auctionStrategy}
          </div>
        </div>
      )}

      {/* Price Prediction */}
      {pp && pp.nextDayHigh.price > 0 && (
        <>
          <div style={{
            fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)',
            letterSpacing: '0.08em', padding: '4px 0 0',
            borderTop: '1px solid var(--border-primary)', paddingTop: '12px',
          }}>
            🎯 高低點預測 · AI 計算
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            {[
              {
                label: '明日預期高點', price: pp.nextDayHigh.price, basis: pp.nextDayHigh.basis,
                confidence: pp.nextDayHigh.confidence, color: 'var(--color-up)',
                bg: 'rgba(220,38,38,0.06)', border: 'rgba(220,38,38,0.2)', icon: '📈',
              },
              {
                label: '明日預期低點', price: pp.nextDayLow.price, basis: pp.nextDayLow.basis,
                confidence: pp.nextDayLow.confidence, color: 'var(--color-down)',
                bg: 'rgba(34,197,94,0.06)', border: 'rgba(34,197,94,0.2)', icon: '📉',
              },
            ].map(({ label, price, basis, confidence, color, bg, border, icon }) => (
              <div key={label} style={{
                background: bg, border: `1px solid ${border}`, borderRadius: '10px', padding: '14px',
              }}>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>{icon} {label}</div>
                <div style={{ fontSize: '22px', fontWeight: 800, color, marginBottom: '6px' }}>{price.toFixed(2)}</div>
                <div style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.4, marginBottom: '8px' }}>{basis}</div>
                <div style={{ height: '4px', borderRadius: '999px', background: 'var(--bg-tertiary)' }}>
                  <div style={{ height: '100%', width: `${confidence}%`, borderRadius: '999px', background: color }} />
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '3px' }}>信心度 {confidence}%</div>
              </div>
            ))}
          </div>

          {/* Resistance / Support */}
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            borderRadius: '10px', padding: '14px 16px',
          }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>
              📊 支撐 / 壓力位
            </div>
            <div style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '6px' }}>壓力位</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {pp.resistance.map((r, i) => (
                  <span key={i} style={{
                    fontSize: '12px', padding: '4px 10px', borderRadius: '6px',
                    background: `${STRENGTH_COLOR[r.strength]}18`,
                    color: STRENGTH_COLOR[r.strength],
                    border: `1px solid ${STRENGTH_COLOR[r.strength]}44`,
                    fontWeight: 600,
                  }}>
                    {r.label} {r.price.toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '6px' }}>支撐位</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {pp.support.map((s, i) => (
                  <span key={i} style={{
                    fontSize: '12px', padding: '4px 10px', borderRadius: '6px',
                    background: `${STRENGTH_COLOR[s.strength]}18`,
                    color: STRENGTH_COLOR[s.strength],
                    border: `1px solid ${STRENGTH_COLOR[s.strength]}44`,
                    fontWeight: 600,
                  }}>
                    {s.label} {s.price.toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── News Tab ─────────────────────────────────────────────────────

interface StockNewsItem {
  id: string;
  title: string;
  source: string;
  time: string;
  url: string;
  category: 'company' | 'industry' | 'policy' | 'market';
  snippet?: string;
}

function NewsTab({ stockCode, stockName, industry, industryEmoji }: {
  stockCode: string;
  stockName: string;
  industry: string;
  industryEmoji: string;
}) {
  const [news, setNews] = useState<StockNewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'company' | 'industry' | 'policy'>('all');
  const [sources, setSources] = useState<string[]>([]);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/twse/stock-news?code=${stockCode}&name=${encodeURIComponent(stockName)}&industry=${encodeURIComponent(industry)}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (data.news && Array.isArray(data.news)) {
          setNews(data.news);
        }
        if (data.sources && Array.isArray(data.sources)) {
          setSources(data.sources);
        }
      })
      .catch(err => console.error('[NewsTab] fetch error:', err))
      .finally(() => setLoading(false));
  }, [stockCode, stockName, industry]);

  const filtered = filter === 'all' ? news : news.filter(n => n.category === filter);

  const CATEGORY_CONFIG: Record<string, { label: string; emoji: string; color: string; bg: string }> = {
    company: { label: '公司公告', emoji: '🏢', color: '#6366f1', bg: 'rgba(99,102,241,0.1)' },
    industry: { label: '產業動態', emoji: industryEmoji, color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
    policy: { label: '政策消息', emoji: '🏦', color: '#06b6d4', bg: 'rgba(6,182,212,0.1)' },
    market: { label: '市場資訊', emoji: '📊', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  };

  const formatTimeAgo = (timeStr: string) => {
    const diff = Date.now() - new Date(timeStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '剛剛';
    if (mins < 60) return `${mins} 分鐘前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小時前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前`;
    return new Date(timeStr).toLocaleDateString('zh-TW');
  };

  if (loading) {
    return (
      <div style={{ padding: '60px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: '40px', marginBottom: '12px', animation: 'pulse 1.5s infinite' }}>📰</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>載入 {stockName} 相關新聞中...</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <PageHelp id="stock" />
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px',
      }}>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
            {industryEmoji} {stockName} ({stockCode}) 相關新聞
          </div>
          {industry && (
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
              產業：{industry} · 共 {news.length} 則新聞
            </div>
          )}
          {sources.length > 0 && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              來源：{sources.join('、')}
            </div>
          )}
        </div>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: '6px' }}>
        {([
          { id: 'all', label: '全部', count: news.length },
          { id: 'company', label: '🏢 公司', count: news.filter(n => n.category === 'company').length },
          { id: 'industry', label: `${industryEmoji} 產業`, count: news.filter(n => n.category === 'industry').length },
          { id: 'policy', label: '🏦 政策', count: news.filter(n => n.category === 'policy').length },
        ] as const).map(f => (
          f.count > 0 || f.id === 'all' ? (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              padding: '6px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 600,
              background: filter === f.id ? 'var(--accent-purple, #7c3aed)' : 'var(--bg-tertiary)',
              color: filter === f.id ? '#fff' : 'var(--text-secondary)',
              border: 'none', cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            {f.label} ({f.count})
          </button>
          ) : null
        ))}
      </div>

      {/* News List */}
      {filtered.length === 0 ? (
        <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>📭</div>
          <div style={{ fontSize: '15px', marginBottom: '6px' }}>暫無相關新聞</div>
          <div style={{ fontSize: '13px', opacity: 0.7 }}>
            目前無法取得 {stockName} 的{filter === 'industry' ? '產業' : ''}新聞資料
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {filtered.map((item) => {
            const cfg = CATEGORY_CONFIG[item.category];
            return (
              <div
                key={item.id}
                onClick={() => item.url && window.open(item.url, '_blank', 'noopener,noreferrer')}
                style={{
                  padding: '14px 16px',
                  borderRadius: '10px',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-primary)',
                  cursor: item.url ? 'pointer' : 'default',
                  transition: 'all 0.15s',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = cfg.color;
                  e.currentTarget.style.transform = 'translateX(4px)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = 'var(--border-primary)';
                  e.currentTarget.style.transform = 'translateX(0)';
                }}
              >
                {/* Top Row: Category + Time */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{
                    fontSize: '12px', padding: '2px 8px', borderRadius: '4px',
                    background: cfg.bg, color: cfg.color, fontWeight: 600,
                  }}>
                    {cfg.emoji} {cfg.label}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {formatTimeAgo(item.time)}
                  </span>
                </div>

                {/* Title */}
                <div style={{
                  fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)',
                  lineHeight: '1.5',
                }}>
                  {item.title}
                </div>

                {/* Snippet (if available) */}
                {item.snippet && (
                  <div style={{
                    fontSize: '13px', color: 'var(--text-muted)',
                    lineHeight: '1.4', display: '-webkit-box',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {item.snippet}
                  </div>
                )}

                {/* Source + Link */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    📡 {item.source}
                  </span>
                  {item.url && (
                    <span style={{ fontSize: '12px', color: cfg.color, fontWeight: 600 }}>
                      閱讀全文 →
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
