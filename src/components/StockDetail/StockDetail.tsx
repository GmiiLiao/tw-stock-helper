'use client';

import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react';
import { shouldPollNow, getSession, isTradingDay } from '@/lib/market-clock';
import { fmtQty, calcFee } from '@/lib/tw-fee';
import { useBrokerSettings } from '@/lib/useBrokerSettings';
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
  getChangeColor,
  formatValue,
  type CandleData,
  type StockInfo,
  type TradingSignal,
  marketBadge,
  tickSize,
} from '@/lib/twse-api';
import {
  todayMoveOf, closePosOf, industryLineOf, industryFactsText, limitKindOf, etfTickSize, stopRefCellText, sessionStartMsOf,
  type Reading, type ReadingKey, type QuotePhase, type TodayMove, type StopRef,
} from '@/lib/stock-readings';
import ReadingRow from '@/components/shared/ReadingRow';
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
import ThirdPartyNote from '@/components/shared/ThirdPartyNote';
import { otcSourceOfStocks, readOtcSource, type OtcSource } from '@/lib/otc-source';
import DayTradeBadge from '@/components/shared/DayTradeBadge';
import { useChipVerdicts, VerdictStrip } from '@/components/shared/ChipVerdict';
import MarginSignals from '@/components/shared/MarginSignals';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import PageHelp from '@/components/Help/PageHelp';
import QuoteGrid from './QuoteGrid';
import { useShallow } from 'zustand/react/shallow';

// ─── Types ──────────────────────────────────────────────────────

// 2026-10-08（hardcoded-to-real-spec §1.6）：新前端只讀新欄位（readings／todayMove／dataDate／phase／quoteAsOfMs／
// stopRef／expectedOpeningRange.basis／companyProfile.scale）；新欄位不存在（舊 JSON）一律顯示「暫時無法取得」，
// 不退回讀 legacy 鍵（legacy 鍵只為舊分頁保留一個部署週期，標為選填）。
interface TrendApiResponse {
  dataDate?: string | null;
  phase?: QuotePhase;
  quoteAsOfMs?: number | null;
  /** 「明日」或過期時的明確日期（「10-12 」）；舊 JSON 沒有＝明日 */
  nextDayWord?: string;
  generatedAt?: string;
  todayMove?: TodayMove | null;
  readings?: Partial<Record<ReadingKey, Reading>>;
  /** 上櫃第三方後備來源註記（2026-10-09）：這一檔用到後備列才有 */
  otcSource?: OtcSource;
  preMarketRecommendation: {
    todayClose: number;
    prevClose: number;
    todayChangePercent: number;
    expectedOpeningRange: { low: number; high: number; basis?: string };
    recommendation?: 'strong_buy' | 'buy' | 'wait' | 'avoid';
    recommendationText?: string;
    optimalOrderTime?: string;
    orderLevels: Array<{ label: string; price: number; rationale: string; style: string; riskLevel: string }>;
    stopLossPrice?: number;
    stopRef?: StopRef;
    auctionStrategy?: string;
    dayTradingNote?: string;
    riskWarning?: string;
  };
  companyProfile: {
    fullName: string;
    shortName: string;
    chairman: string;
    ceo: string;
    spokesperson: string;
    address: string;
    phone: string;
    website: string;
    email: string;
    fax: string;
    spokespersonTitle: string;
    deputySpokesperson: string;
    englishName: string;
    taxId: string;
    transferAgent: string;
    transferAgentPhone: string;
    accountingFirm: string;
    foundedDate: string;
    listedDate: string;
    capitalAmount: string;
    capitalBillion: number;
    industryCategory: string;
    mainBusiness: string;
    keyProducts: string[];
    keyProductsSource?: string | null;
    officialIndustry?: string | null;
    industryFacts?: { name: string; count: number | null; pe: number | null; pb: number | null; yield: number | null; revYoY: number | null; chains: string[]; source: string } | null;
    companyScale?: 'large' | 'mid' | 'small';
    scale?: 'large' | 'mid' | 'small' | null;
    dataSource?: string;
    ageYears: number;
    listingAgeYears: number;
  };
  pricePrediction: {
    nextDayHigh: { price: number; basis: string; confidence?: number | null };
    nextDayLow: { price: number; basis: string; confidence?: number | null };
    resistance: Array<{ price: number; label: string; strength: string }>;
    support: Array<{ price: number; label: string; strength: string }>;
    buyZoneHigh: number;
    buyZoneLow: number;
    targetZoneHigh?: number;
    targetZoneLow?: number;
    atr: number;
    atrPercent: number;
    pricePositionScore: number | null;
    positionDescription: string;
  };
  industry: { code: string; name: string; sector: string; emoji: string; description: string };
}

// ─── Constants ──────────────────────────────────────────────────

const PERIODS: Array<{ id: string; label: string; months: number }> = [
  { id: '1M', label: '1個月', months: 1 },
  { id: '3M', label: '3個月', months: 3 },
  { id: '6M', label: '半年', months: 6 },
  { id: '1Y', label: '1年', months: 12 },
];

/** 今日走勢的色調（當日事實：紅漲綠跌） */
const MOVE_TONE_COLOR: Record<TodayMove['tone'], string> = {
  up: 'var(--color-up)',
  down: 'var(--color-down)',
  flat: 'var(--text-muted)',
};
const MOVE_TONE_BG: Record<TodayMove['tone'], string> = {
  up: 'rgba(240,62,62,0.1)',
  down: 'rgba(47,158,68,0.1)',
  flat: 'rgba(100,116,139,0.08)',
};

/** 新回應形狀（含 readings）才渲染公式與判讀區塊；舊 JSON 顯示「暫時無法取得」（§1.6） */
const hasReadings = (d: TrendApiResponse): boolean => !!d.readings;

function StaleShapeNote() {
  return (
    <div style={{ padding: '14px 16px', borderRadius: '10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>
      暫時無法取得，請重新整理。
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────

export default function StockDetail() {
  const [broker] = useBrokerSettings();   // 預估成本依使用者自己的券商折讓（2026-10-01 使用者「手續費為使用者的折扣非統一使用2.8折」）
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
  const [activeTab, setActiveTab] = useState<'intraday' | 'chart' | 'signal' | 'peers' | 'fin' | 'portfolio' | 'company' | 'strategy' | 'news' | 'ask'>('intraday');

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
  // 本拍即時報價的來源（'mis_realtime'＝本拍有即時成交；'stock_day_all'＝快照非即時列；沿用上一拍或還沒拿到＝null）。
  // 當日策略的「今日走勢」據此決定盤中位置能不能算、要不要寫「尚未取得今日成交」（2026-10-08 審查 HIGH）。
  const liveQ = selectedStock ? liveQuotes[selectedStock] : undefined;
  const liveSource = liveQ && !liveQ.stale ? liveQ.source : null;

  // ── Load trend analysis for company / premarket tabs ─────────
  useEffect(() => {
    if (!selectedStock) return;
    // strategy 分頁現在同時含原本的 premarket 內容，兩者共用 trendData
    if (activeTab !== 'company' && activeTab !== 'strategy' && activeTab !== 'news') return;
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
    // 「當日行情」與「開盤策略」合併（2026-08-11 使用者指出內容大量重複）：
    // 兩者都在講同一天的開盤區間、前日收盤、預期跳空——分成兩個分頁只是讓人來回切。
    // 名稱由使用者定為「當日策略」（合併後的長名字在手機分頁列上太佔位）。
    { id: 'strategy',  label: '⏰ 當日策略' },
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
            {(() => { const b = marketBadge(stock); return b ? <span style={{ marginLeft: 6, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, verticalAlign: 'middle', color: b.c, border: `1px solid ${b.c}66`, borderRadius: 5, padding: '0 5px' }}>{b.t === '市' ? '上市' : b.t === '櫃' ? '上櫃' : b.t === '創' ? '創新板' : b.t}</span> : null; })()}
            <span style={{ marginLeft: 6, verticalAlign: 'middle' }}><RiskBadge code={stock.code} /></span>
            <span style={{ marginLeft: 6, verticalAlign: 'middle' }}><DayTradeBadge code={stock.code} /></span>
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
          <AddCandidateButton code={stock.code} variant="icon" />
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
      {/* 上櫃第三方後備來源註記（只在這一檔用到後備時出現）：報價取自 allStocks 那一列（otcGrade 隨 stock 一起存），判讀取自 trend-analysis */}
      <ThirdPartyNote source={otcSourceOfStocks([stock]) ?? readOtcSource(trendData)} />

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
        {/* ⚠ maxWidth 不可省：只寫 width:'fit-content' 時它會長成內容寬（884px），
            捲動殼就形同虛設，整頁還是會被撐開。 */}
        <div className="tabs" style={{ width: 'fit-content', maxWidth: '100%' }}>
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
                const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;   // buyPrice=0 的壞資料不要印 NaN%
                return (
                  <div key={h.id} className={styles.holdingItem}>
                    <div className={styles.holdingInfo}>
                      <span className={styles.holdingDate}>{h.buyDate}</span>
                      {/* 在投資組合以「股(零股)」建立的部位，這裡也要維持股為單位 */}
                      <span className={styles.holdingQty}>{fmtQty(h.quantity, h.unit)}</span>
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
          <CompanyTab trendData={trendData} loading={trendLoading} stockName={stock.name} stockCode={stock.code}
            instFlowNote={verdicts[stock.code] ? '當日籌碼判讀見頁首。' : undefined} />
        )}

        {/* ── 當日行情與開盤策略（原本是兩個分頁，2026-08-11 合併）──────
            兩邊都在講同一天的開盤區間／前日收盤／預期跳空，分開只是讓人來回切。
            順序＝先「今天實際發生什麼」（當日行情），再「所以明天怎麼下單」（開盤策略）。 */}
        {activeTab === 'strategy' && (
          <>
            <PremarketTab trendData={trendData} loading={trendLoading} stockName={stock.name} stock={stock} liveSource={liveSource} />
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
                  <div style={{ fontSize: 'calc(12.5px * var(--fz))', marginBottom: '4px', opacity: 0.8 }}>
                    計算公式：單價 ({parseFloat(holdingForm.buyPrice).toLocaleString()} 元) × {fmtQty(parseFloat(holdingForm.quantity) || 0)}（{Math.round((parseFloat(holdingForm.quantity) || 0) * 1000).toLocaleString()} 股）
                  </div>
                  <div>
                    預估成本（含手續費 0.1425%{broker.discount < 1 ? `×你的券商 ${+(broker.discount * 10).toFixed(2)} 折` : '，未設定折讓＝全額'}）：
                    <strong>
                      {(() => { const px = parseFloat(holdingForm.buyPrice) || 0, q = parseFloat(holdingForm.quantity) || 0; return Math.round(px * q * 1000 + calcFee(px, q, broker)); })().toLocaleString('zh-TW')} 元
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

/** 中性但空方點數較多的文字門檻（與 detectSignal「≥10 觀察」對稱；只改文字、不改判定） */
const SIGNAL_LEAN_GAP = 10;

// 2026-10-08（F21）：強度是 MA／MACD／RSI／KD／量的點數差，不是機率——不畫進度條、不加「%」，
// 改顯示多空點數；「買進訊號／賣出警示」改「規則計分偏多／偏空」。
function SignalBadge({ signal }: { signal: TradingSignal }) {
  const config = {
    BUY:     { label: '規則計分偏多', bg: 'var(--color-up-bg)',               color: 'var(--color-up)',   border: 'var(--color-up)' },
    SELL:    { label: '規則計分偏空', bg: 'var(--color-down-bg)',             color: 'var(--color-down)', border: 'var(--color-down)' },
    WATCH:   { label: '觀察中',       bg: 'rgba(245,158,11,0.1)',             color: '#f59e0b',            border: '#f59e0b' },
    NEUTRAL: { label: '中性',         bg: 'rgba(100,116,139,0.1)',            color: 'var(--text-muted)', border: 'var(--border-primary)' },
  };
  const cfg = config[signal.type];
  const hasScores = typeof signal.bullScore === 'number' && typeof signal.bearScore === 'number';
  // 判定門檻不對稱（多空差 ≥30 偏多、≤−30 偏空、≥10 觀察，其餘中性；判定不動）：點數攤開後「中性」配上空方明顯占優
  // 讀起來像矛盾 ⇒ 只改文字，中性且空方多 ≥10 點時寫明（2026-10-08 審查 LOW）
  const net = hasScores ? (signal.bullScore as number) - (signal.bearScore as number) : 0;
  const label = signal.type === 'NEUTRAL' && net <= -SIGNAL_LEAN_GAP ? '中性（空方點數較多）' : cfg.label;
  return (
    <div className={styles.signalBadge} style={{ background: cfg.bg, color: cfg.color, borderColor: cfg.border, flexWrap: 'wrap' }}
      title="規則計分：多空點數差 ≥30 偏多、≤−30 偏空、≥10 觀察中，其餘中性（不是機率）">
      <span>{signal.type === 'BUY' ? '🟢' : signal.type === 'SELL' ? '🔴' : signal.type === 'WATCH' ? '🟡' : '⚪'}</span>
      <span className={styles.signalBadgeLabel}>{label}</span>
      {hasScores && (
        <span className={styles.signalStrengthText}>多 {signal.bullScore}：空 {signal.bearScore}（規則計分，非機率）</span>
      )}
    </div>
  );
}

// ─── Loading / Error skeleton ───────────────────────────────────

function LoadingCard() {
  return (
    <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: 'calc(32px * var(--fz))', marginBottom: '12px', animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>⏳</div>
      <div style={{ fontSize: 'calc(14px * var(--fz))' }}>資料載入中，請稍後…</div>
    </div>
  );
}

// ─── Company Info Tab ───────────────────────────────────────────

function CompanyTab({ trendData, loading, stockName, stockCode, instFlowNote }: {
  trendData: TrendApiResponse | null;
  loading: boolean;
  stockName: string;
  stockCode: string;
  /** 頁首有當日籌碼判讀（VerdictStrip）時才附註「見頁首」 */
  instFlowNote?: string;
}) {
  if (loading) return <LoadingCard />;
  if (!trendData) return (
    <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
      無法載入公司資訊，請稍後重試
    </div>
  );

  const cp = trendData.companyProfile;
  const ind = trendData.industry;
  const rd = trendData.readings;

  const scaleLabel = { large: '大型股', mid: '中型股', small: '小型股' };
  const scaleColor = { large: '#6366f1', mid: '#f59e0b', small: 'var(--text-muted)' };
  // 規模徽章只依新鍵 scale（沒有資本額時 null＝不顯示；舊 JSON 沒有此鍵也不顯示——不再預設「中型股」，F27）
  const scale = cp.scale ?? null;

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
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(28px * var(--fz))',
          }}>
            {ind.emoji}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.3 }}>
              {cp.fullName || stockName}
            </div>
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginTop: '3px' }}>
              {stockCode} · {cp.industryCategory}
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
              {scale && (
                <span title="依實收資本額分級（本站規則：≥500 億大型、≥50 億中型）" style={{
                  fontSize: 'calc(13px * var(--fz))', padding: '2px 8px', borderRadius: '999px',
                  background: `${scaleColor[scale]}22`,
                  color: scaleColor[scale], border: `1px solid ${scaleColor[scale]}55`,
                }}>{scaleLabel[scale]}</span>
              )}
              {cp.capitalAmount && cp.capitalAmount !== '--' && (
                <span style={{
                  fontSize: 'calc(13px * var(--fz))', padding: '2px 8px', borderRadius: '999px',
                  background: 'rgba(99,102,241,0.1)', color: '#818cf8',
                  border: '1px solid rgba(99,102,241,0.3)',
                }}>資本額 {cp.capitalAmount}</span>
              )}
              {cp.ageYears > 0 && (
                <span style={{
                  fontSize: 'calc(13px * var(--fz))', padding: '2px 8px', borderRadius: '999px',
                  background: 'rgba(100,116,139,0.1)', color: 'var(--text-muted)',
                  border: '1px solid var(--border-primary)',
                }}>成立 {cp.ageYears} 年</span>
              )}
            </div>
          </div>
        </div>

        {/* Main business：官方業務欄位第二批接入（L13）；空值據實說明，不套模板（F27） */}
        <div style={{
          marginTop: '16px', padding: '12px 14px',
          background: 'rgba(99,102,241,0.06)', borderRadius: '8px',
          borderLeft: '3px solid #6366f1',
          fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.6, color: cp.mainBusiness ? 'var(--text-secondary)' : 'var(--text-muted)',
        }}>
          {cp.mainBusiness || '主要業務：來源未提供（公開資訊觀測站查無此公司登記資料）'}
        </div>

        {/* Key products（L13：只列出自 2025 年報的產品，AI 知識補的不列） */}
        {cp.keyProducts && cp.keyProducts.length > 0 && (
          <div style={{ marginTop: '12px', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
            <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>核心產品{cp.keyProductsSource ? `（${cp.keyProductsSource}）` : ''}：</span>
            {cp.keyProducts.map((p, i) => (
              <span key={i} style={{
                fontSize: 'calc(12.5px * var(--fz))', padding: '4px 10px', borderRadius: '6px',
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
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</div>
            <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* 聯絡與登記資料（2026-08-27 使用者要求「公司資料處理完整」）
          交易所 t187ap03 本來就有這些欄位，過去整批沒被帶進來，個股頁只有半套。
          ⚠ 一律「有值才渲染」——來源沒有就不要顯示佔位符，更不要編造。 */}
      {(() => {
        const rows: Array<[string, React.ReactNode]> = [];
        if (cp.address && cp.address !== '--') rows.push(['公司地址', cp.address]);
        if (cp.phone && cp.phone !== '--') rows.push(['總機電話', <a key="p" href={`tel:${cp.phone.replace(/[^\d+]/g, '')}`} style={{ color: '#7dd3fc' }}>{cp.phone}</a>]);
        if (cp.fax) rows.push(['傳真', cp.fax]);
        if (cp.website) rows.push(['公司網址', <a key="w" href={cp.website} target="_blank" rel="noopener noreferrer" style={{ color: '#7dd3fc', wordBreak: 'break-all' }}>{cp.website.replace(/^https?:\/\//, '').replace(/\/$/, '')} ↗</a>]);
        if (cp.email) rows.push(['電子信箱', <a key="e" href={`mailto:${cp.email}`} style={{ color: '#7dd3fc', wordBreak: 'break-all' }}>{cp.email}</a>]);
        const spk = [cp.spokesperson !== '未知' && cp.spokesperson !== '--' ? cp.spokesperson : '', cp.spokespersonTitle].filter(Boolean).join('・');
        if (spk) rows.push(['發言人', cp.deputySpokesperson ? `${spk}（代理：${cp.deputySpokesperson}）` : spk]);
        if (cp.englishName) rows.push(['英文簡稱', cp.englishName]);
        if (cp.taxId) rows.push(['統一編號', cp.taxId]);
        if (cp.transferAgent) rows.push(['股票過戶機構', cp.transferAgentPhone ? `${cp.transferAgent}（${cp.transferAgentPhone}）` : cp.transferAgent]);
        if (cp.accountingFirm) rows.push(['簽證會計師', cp.accountingFirm]);
        if (!rows.length) return null;
        return (
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: '10px', padding: '12px 14px' }}>
            {/* 區塊標題 12.5→14px、去字距（2026-10-01）：內文已是 13～13.5px，標題須比內文大一級 */}
            <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>
              📍 聯絡與登記資料
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '5px 12px', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.5 }}>
              {rows.map(([k, v]) => (
                <Fragment key={k}>
                  <div style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{k}</div>
                  <div style={{ color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }}>{v}</div>
                </Fragment>
              ))}
            </div>
          </div>
        );
      })()}

      {/* 產業別（F14）＋產業說明（L13：官方產業別的事實——檔數、站內同業表中位數、相關產業鏈；不含展望） */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
        borderRadius: '10px', padding: '14px 16px',
      }}>
        <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
          {industryLineOf(ind, cp)}
        </div>
        <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
          {industryFactsText(cp.industryFacts)}
        </div>
      </div>

      {/* 📊 判讀結果（F1–F3）：舊版「法人看好度／共識評等／目標上漲」是依產業寫死的數字，已移除 */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
        borderRadius: '10px', padding: '6px 16px',
      }}>
        <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 600, color: 'var(--text-muted)', padding: '8px 0 2px' }}>
          📊 判讀結果
        </div>
        <ReadingRow reading={rd?.instFlow} fallbackLabel="法人籌碼動向（描述）" note={instFlowNote} />
        <ReadingRow reading={rd?.model20} fallbackLabel="模型評等（20 日）" />
        <ReadingRow reading={rd?.dist20} fallbackLabel="歷史同條件 20 日報酬分布" last />
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
      <div style={{ fontWeight: 800, fontSize: 'calc(14px * var(--fz))', marginBottom: 6 }}>🎤 法說會前瞻 <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', fontWeight: 400 }}>（{d.date} 召開 · AI 質化推測，非數字預測）</span></div>
      <div style={{ fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.6, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{d.preview}</div>
    </div>
  );
}

function PremarketTab({ trendData, loading, stockName, stock, liveSource }: {
  trendData: TrendApiResponse | null;
  loading: boolean;
  stockName: string;
  stock: StockInfo;
  /** 本拍即時報價來源：'mis_realtime'＝本拍有即時成交、'stock_day_all'＝快照非即時列、null＝沒有本拍資料 */
  liveSource: string | null;
}) {
  if (loading) return <LoadingCard />;
  if (!trendData) return (
    <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
      無法載入行情分析，請稍後重試
    </div>
  );

  const pm  = trendData.preMarketRecommendation;
  const pp  = trendData.pricePrediction;
  const rd  = trendData.readings;
  const isNew = hasReadings(trendData);

  // Use live data — use stock.change directly (same data source as stock.price)
  const price = stock.price;
  const change = stock.change;
  const changePct = stock.changePercent;
  const prevClose = price - change;
  // ⚠ 不可以用現價補開高低（2026-08-29 修）：舊版 `stock.high > 0 ? stock.high : price`
  //   在快照缺 OHLC 時把三者都填成現價 ⇒ 振幅**恆為 0.0%**、收盤位置**恆為 50%**，
  //   而這兩個數字直接印在下面的分析文字裡——等於對每一檔股票說一句捏造的話。
  //   （快照缺 OHLC 那個根因已修，但這裡的 fallback 本身就是藏住它的東西：
  //     資料再壞一次，畫面又會安靜地說 0.0%。）
  const hasOhlc = stock.high > 0 && stock.low > 0 && stock.high >= stock.low;
  const todayOpen = stock.open > 0 ? stock.open : null;
  const todayHigh = hasOhlc ? stock.high : null;
  const todayLow = hasOhlc ? stock.low : null;
  const amplitude = hasOhlc && prevClose > 0 ? ((stock.high - stock.low) / prevClose) * 100 : null;
  // 開/高/低依「相對昨收」著色（台股報價慣例）；toFixed(2) 去掉 price−change 的浮點尾差，避免平盤被染色
  const vsPrevColor = (p: number | null) => p == null ? 'var(--text-muted)' : getChangeColor(+(p - prevClose).toFixed(2));

  // 今日走勢（描述，F26）：與 trend-analysis 共用同一支純函式 todayMoveOf（分段門檻一致）；
  // 漲跌停用檔位精確判定（ETF 用 ETF 檔位）、興櫃不判（舊版的固定百分比近似會把興櫃漲 12% 寫成漲停）；
  // 位置一律經 closePosOf（缺資料寫「資料不足」，不以 0 或 50 代替）。只描述事實，不寫「明日」「建議」。
  // 2026-10-08 審查 HIGH：個股頁的 stock 只有在本拍拿到即時成交時，開高低才確定是今天的（非即時列的開高低、
  //   清單上的成交值可能是前一交易日的）⇒ 盤中位置只在本拍即時成交時算、成交值不寫數字（MIS 不給成交金額）；
  //   收盤後若 trend-analysis 是本交易時段開始後載入的收盤口徑，直接用 server 的 todayMove（開高低與成交值已過資料日閘門）。
  const isEsb = stock.market === 'esb';
  const phase: QuotePhase = isEsb ? 'quote' : getSession() === 'regular' ? 'intraday' : 'close';
  const tick = stock.code.startsWith('00') ? etfTickSize : tickSize;
  const limit = isEsb ? null : limitKindOf(price, change, tick);
  const nowMs = Date.now();
  const sessionStartMs = sessionStartMsOf(nowMs, isTradingDay(new Date(nowMs)));
  const generatedMs = Date.parse(trendData.generatedAt ?? '');
  // trendData 每檔只載一次：本交易時段開始前載入的（例 08:45 開頁、13:30 後仍開著），它的資料日已不是畫面數字的日期
  const trendCurrent = sessionStartMs == null || generatedMs >= sessionStartMs;
  const serverMove = phase === 'close' && trendData.phase === 'close' && trendCurrent ? trendData.todayMove ?? null : null;
  const liveTick = liveSource === 'mis_realtime';
  const noTradeToday = phase === 'intraday' && liveSource === 'stock_day_all';
  const clientPos = phase === 'quote' || (phase === 'intraday' && liveTick)
    ? closePosOf(price, stock.high, stock.low, prevClose, limit)
    : null;
  const move = serverMove ?? todayMoveOf(changePct, {
    limit, phase, closePos: clientPos, noTradeToday, quoteAsOfMs: null,
    // 成交值：盤中只有累計量、沒有可確認是今天的成交金額 ⇒ 不寫數字；興櫃來源本來就沒有
    tradeValue: null,
    dataDate: trendCurrent ? trendData.dataDate ?? null : null,
    todayHead: !trendCurrent,
  });
  // 頂條、圖示、文字三者都依 move.tone（|漲跌| ≤0.5% 寫「平盤」就是中性色）
  const isUp = move.tone === 'up';
  const isDown = move.tone === 'down';
  const priceWord = phase === 'intraday' ? '目前價' : phase === 'quote' ? '最新價' : '收盤';
  // 高低點事實句只在位置是用同一份即時開高低算的時候寫（server 版走勢不配用戶端的開高低，兩者可能不同時點）
  const hlFact = clientPos != null && todayHigh != null && todayLow != null
    ? `${priceWord}${price < todayHigh ? `低於今日高點 ${todayHigh.toFixed(2)}` : `等於今日高點 ${todayHigh.toFixed(2)}`}、`
      + `${price > todayLow ? `高於今日低點 ${todayLow.toFixed(2)}` : `等於今日低點 ${todayLow.toFixed(2)}`}。`
    : '';
  const analysisText = `${stockName} ${move.text}${hlFact ? ` ${hlFact}` : ''}`;
  const anchor = trendData.phase === 'intraday' ? '目前價' : trendData.phase === 'quote' ? '最新價' : '今收';
  const rangeKnown = rd?.closePos?.value != null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' }}>

      {/* 今日走勢（描述） */}
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
            : 'linear-gradient(90deg, #94a3b8, #64748b)',
        }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'calc(28px * var(--fz))' }}>{move.tone === 'up' ? '📈' : move.tone === 'down' ? '📉' : '➡️'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginBottom: '2px' }}>今日走勢（描述）</div>
            <div style={{
              display: 'inline-block', fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800, padding: '4px 14px',
              borderRadius: '8px', background: MOVE_TONE_BG[move.tone], color: MOVE_TONE_COLOR[move.tone],
            }}>{move.label}</div>
          </div>
          <div style={{
            fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800,
            color: getChangeColor(changePct),
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {changePct > 0 ? '+' : ''}{changePct.toFixed(2)}%
          </div>
        </div>
        <div style={{ marginTop: '12px', fontSize: 'calc(13.5px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {analysisText}
        </div>
      </div>

      {/* Today's OHLC boxes */}
      {/* 同上：內聯樣式沒有 media query 可救，寫死四欄在手機必爆 → auto-fit */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: '10px' }}>
        {[
          { label: '今日開盤', value: todayOpen == null ? '—' : todayOpen.toFixed(2), color: vsPrevColor(todayOpen), emoji: '🔔' },
          { label: '今日最高', value: todayHigh == null ? '—' : todayHigh.toFixed(2), color: vsPrevColor(todayHigh), emoji: '📈' },
          { label: '今日最低', value: todayLow == null ? '—' : todayLow.toFixed(2), color: vsPrevColor(todayLow), emoji: '📉' },
          { label: '昨收', value: prevClose.toFixed(2), color: 'var(--text-muted)', emoji: '📌' },
        ].map(({ label, value, color, emoji }) => (
          <div key={label} style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            borderRadius: '10px', padding: '12px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 'calc(16px * var(--fz))', marginBottom: '4px' }}>{emoji}</div>
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginBottom: '4px', lineHeight: 1.3 }}>{label}</div>
            <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Volume and amplitude analysis（振幅＝高低差 ÷ 昨收，台股慣例） */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
        <div style={{
          background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)',
          borderRadius: '10px', padding: '14px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#818cf8', fontWeight: 600, marginBottom: '6px' }}>📊 振幅</div>
          <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: '#a5b4fc' }}>{amplitude == null ? '—' : `${amplitude.toFixed(2)}%`}</div>
        </div>
        <div style={{
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
          borderRadius: '10px', padding: '14px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#fbbf24', fontWeight: 600, marginBottom: '6px' }}>📦 成交量</div>
          <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: '#fbbf24' }}>{(stock.volume / 1000).toFixed(0)} 張</div>
        </div>
        <div style={{
          background: change > 0 ? 'rgba(220,38,38,0.08)' : change < 0 ? 'rgba(34,197,94,0.08)' : 'rgba(148,163,184,0.08)',
          border: `1px solid ${change > 0 ? 'rgba(220,38,38,0.25)' : change < 0 ? 'rgba(34,197,94,0.25)' : 'rgba(148,163,184,0.25)'}`,
          borderRadius: '10px', padding: '14px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 'calc(13px * var(--fz))', color: getChangeColor(change), fontWeight: 600, marginBottom: '6px' }}>💰 漲跌</div>
          <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: getChangeColor(change) }}>
            {change > 0 ? '+' : ''}{change.toFixed(2)}
          </div>
        </div>
      </div>

      {/* 以下公式與判讀區塊只讀新回應欄位；舊 JSON（部署切換期間）顯示「暫時無法取得」 */}
      {!isNew && <StaleShapeNote />}

      {/* 價格參考（公式試算，非買賣建議）：與當日策略分頁同一份 orderLevels */}
      {isNew && pm.orderLevels.length > 0 && (
        <OrderLevelsCard levels={pm.orderLevels} />
      )}

      {/* 價格參考帶（F10）：全部是今收 × 固定倍數或明日漲跌停檔位，不是支撐壓力判讀 */}
      {isNew && pp && pp.nextDayHigh.price > 0 && (
        <>
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            borderRadius: '10px', padding: '14px 16px',
          }}>
            <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>
              📊 價格參考帶（{anchor} ±%，公式）
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {[...pp.resistance, ...pp.support].map((b, i) => (
                <span key={i} style={{
                  fontSize: 'calc(12.5px * var(--fz))', padding: '4px 10px', borderRadius: '6px',
                  background: 'rgba(148,163,184,0.1)', color: 'var(--text-secondary)',
                  border: '1px solid rgba(148,163,184,0.3)', fontWeight: 600,
                }}>
                  {b.label} {b.price.toFixed(2)}
                </span>
              ))}
            </div>
            <div style={{ marginTop: '8px', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {trendData.phase === 'intraday'
                ? '明日漲跌停價：收盤後提供（今收未定）。'
                : trendData.phase === 'quote'
                ? '興櫃沒有漲跌幅限制，不列漲跌停價。'
                : stock.code.startsWith('00')
                ? '漲跌停價：ETF 不列（部分 ETF 沒有漲跌幅限制，本站未接入名單）。'
                : '漲跌停價為今收 ×1.1／×0.9 取合法檔位的試算；未計除權息等參考價調整，新上市初期等無漲跌幅限制的標的不適用。'}
            </div>
          </div>

          {/* 參考帶與高低差（舊版的目標價類區塊依裁定 1 不渲染） */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: '10px' }}>
            <div style={{
              background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)',
              borderRadius: '10px', padding: '14px',
            }}>
              <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#818cf8', fontWeight: 600, marginBottom: '6px' }}>💰 {anchor} −2%～0% 參考帶（公式）</div>
              <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 700, color: '#a5b4fc' }}>
                {pp.buyZoneLow.toFixed(2)} – {pp.buyZoneHigh.toFixed(2)}
              </div>
            </div>
            <div style={{
              background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.25)',
              borderRadius: '10px', padding: '14px',
            }}>
              <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px' }}>📡 高低差（佔{anchor}）</div>
              <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 700, color: 'var(--text-secondary)' }}>
                {rangeKnown
                  ? <>{pp.atr.toFixed(2)} <span style={{ fontSize: 'calc(13px * var(--fz))', opacity: 0.8 }}>({pp.atrPercent.toFixed(1)}%)</span></>
                  : '來源未提供'}
              </div>
            </div>
          </div>

          {/* 收盤位置（描述，F7）：中性色，不把位置讀成多空 */}
          <div style={{
            padding: '12px 16px', borderRadius: '10px',
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            display: 'flex', gap: '12px', alignItems: 'flex-start',
          }}>
            <div style={{ position: 'relative', width: '48px', height: '48px', flexShrink: 0, marginTop: '8px' }}>
              <svg width="48" height="48" viewBox="0 0 48 48">
                <circle cx="24" cy="24" r="20" fill="none" stroke="var(--bg-tertiary)" strokeWidth="4" />
                {pp.pricePositionScore != null && (
                  <circle
                    cx="24" cy="24" r="20" fill="none"
                    stroke="#94a3b8"
                    strokeWidth="4" strokeLinecap="round"
                    strokeDasharray={`${(pp.pricePositionScore / 100) * 125.6} 125.6`}
                    transform="rotate(-90 24 24)"
                  />
                )}
              </svg>
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'calc(13px * var(--fz))', fontWeight: 700, color: '#94a3b8',
              }}>{pp.pricePositionScore ?? '—'}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ReadingRow reading={rd?.closePos} fallbackLabel="收盤位置（描述）" last />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 價格參考（公式試算，非買賣建議）——兩個分頁共用；不顯示積極／保守徽章與風險圖示（F11） */
function OrderLevelsCard({ levels }: { levels: Array<{ label: string; price: number; rationale: string }> }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
      borderRadius: '12px', overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border-primary)',
        fontSize: 'calc(14px * var(--fz))', fontWeight: 700, color: 'var(--text-muted)',
      }}>
        📋 價格參考（公式試算，非買賣建議）
      </div>
      {levels.map((level, i) => (
        <div key={i} style={{
          padding: '14px 16px',
          borderBottom: i < levels.length - 1 ? '1px solid var(--border-primary)' : 'none',
          display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap',
        }}>
          <div style={{
            minWidth: '80px', textAlign: 'center', padding: '4px 8px',
            borderRadius: '6px', background: 'rgba(148,163,184,0.12)', color: 'var(--text-secondary)',
            fontSize: 'calc(12.5px * var(--fz))', fontWeight: 600, flexShrink: 0,
          }}>
            {level.label}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              {level.price.toFixed(2)} 元
            </div>
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {level.rationale}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── 當日策略分頁：今日走勢（描述）＋明日方向＋公式價位 ─────────────────────

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
  // 舊 JSON（部署切換期間）沒有新欄位：不退回讀 legacy 的「明日開盤建議」（§1.6）
  if (!hasReadings(trendData)) return <StaleShapeNote />;

  const pm  = trendData.preMarketRecommendation;
  const pp  = trendData.pricePrediction;
  const rd  = trendData.readings;
  const move = trendData.todayMove ?? null;
  const tone: TodayMove['tone'] = move?.tone ?? 'flat';
  const stopRef = pm.stopRef ?? null;
  // 過期（落後 ≥2 個交易日）時 server 給明確日期（「10-12 」），否則「明日」（§1.1）
  const dayWord = trendData.nextDayWord ?? '明日';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' }}>

      {/* 今日走勢（描述）＋明日方向（F9）：舊版「明日開盤建議」回測 buy 組隔日表現反而低於 avoid 組，已移除 */}
      <div style={{
        borderRadius: '12px', padding: '18px 20px', position: 'relative', overflow: 'hidden',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
      }}>
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
          background: tone === 'up'
            ? 'linear-gradient(90deg, var(--color-up), #f97316)'
            : tone === 'down'
            ? 'linear-gradient(90deg, var(--color-down), #4ade80)'
            : 'linear-gradient(90deg, #94a3b8, #64748b)',
        }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'calc(28px * var(--fz))' }}>{tone === 'up' ? '📈' : tone === 'down' ? '📉' : '➡️'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginBottom: '2px' }}>今日走勢（描述）</div>
            <div style={{
              display: 'inline-block', fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800, padding: '4px 14px',
              borderRadius: '8px', background: MOVE_TONE_BG[tone], color: MOVE_TONE_COLOR[tone],
            }}>{move?.label ?? '暫時無法取得'}</div>
          </div>
        </div>
        <div style={{ marginTop: '12px', fontSize: 'calc(13.5px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {move ? `${stockName} ${move.text}` : '暫時無法取得當日行情，請重新整理。'}
        </div>
        <div style={{ marginTop: '8px' }}>
          <ReadingRow reading={rd?.nextDayDir} fallbackLabel="明日方向" last />
        </div>
      </div>

      {/* 開盤參考區間（公式，F8）與參考停損（進場前，F11） */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: '10px' }}>
        {[
          { label: '開盤參考低（公式）', value: pm.expectedOpeningRange.low > 0 ? pm.expectedOpeningRange.low.toFixed(2) : '—', emoji: '📉' },
          { label: '開盤參考高（公式）', value: pm.expectedOpeningRange.high > 0 ? pm.expectedOpeningRange.high.toFixed(2) : '—', emoji: '📈' },
          { label: '昨收',               value: pm.prevClose > 0 ? pm.prevClose.toFixed(2) : '—', emoji: '📌' },
          { label: stopRef?.label ?? '參考停損（進場前）', value: stopRefCellText(stopRef), emoji: '🛡️' },
        ].map(({ label, value, emoji }) => (
          <div key={label} style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            borderRadius: '10px', padding: '12px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 'calc(16px * var(--fz))', marginBottom: '4px' }}>{emoji}</div>
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginBottom: '4px', lineHeight: 1.3 }}>{label}</div>
            <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: 'var(--text-secondary)' }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: '10px', padding: '6px 16px' }}>
        <div style={{ padding: '8px 0 4px', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.55, overflowWrap: 'anywhere' }}>
          開盤參考區間：{pm.expectedOpeningRange.basis ?? '—'}
          <br />
          {stopRef?.label ?? '參考停損（進場前）'}：{stopRef?.basis ?? '—'}{stopRef?.note ? `；${stopRef.note}` : ''}
        </div>
        <ReadingRow reading={rd?.openRange} fallbackLabel="歷史落入率" last />
      </div>

      {/* 價格參考（公式試算，非買賣建議） */}
      {pm.orderLevels.length > 0 && <OrderLevelsCard levels={pm.orderLevels} />}

      {/* 明日高低點參考（公式試算，F6）：舊版寫死的百分比沒有依據，已移除；觸及率表發佈前不給比例 */}
      {pp && pp.nextDayHigh.price > 0 && (
        <>
          <div style={{
            fontSize: 'calc(14px * var(--fz))', fontWeight: 700, color: 'var(--text-muted)',
            borderTop: '1px solid var(--border-primary)', paddingTop: '12px',
          }}>
            🎯 {dayWord}高低點參考（公式試算）
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: '10px' }}>
            {[
              { label: `${dayWord}高點參考（公式）`, price: pp.nextDayHigh.price, basis: pp.nextDayHigh.basis, reading: rd?.hitHigh, fallback: '歷史觸及率（明日高點參考）', icon: '📈' },
              { label: `${dayWord}低點參考（公式）`, price: pp.nextDayLow.price, basis: pp.nextDayLow.basis, reading: rd?.hitLow, fallback: '歷史觸及率（明日低點參考）', icon: '📉' },
            ].map(({ label, price, basis, reading, fallback, icon }) => (
              <div key={label} style={{
                background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: '10px', padding: '14px',
              }}>
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: '8px' }}>{icon} {label}</div>
                <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>{price.toFixed(2)}</div>
                <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.4, marginBottom: '4px', overflowWrap: 'anywhere' }}>{basis}</div>
                <ReadingRow reading={reading} fallbackLabel={fallback} last />
              </div>
            ))}
          </div>
        </>
      )}

      {pm.riskWarning && (
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.5 }}>{pm.riskWarning}</div>
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
        <div style={{ fontSize: 'calc(40px * var(--fz))', marginBottom: '12px', animation: 'pulse 1.5s infinite' }}>📰</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'calc(14px * var(--fz))' }}>載入 {stockName} 相關新聞中...</div>
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
          <div style={{ fontSize: 'calc(16px * var(--fz))', fontWeight: 700, color: 'var(--text-primary)' }}>
            {industryEmoji} {stockName} ({stockCode}) 相關新聞
          </div>
          {industry && (
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginTop: '4px' }}>
              產業：{industry} · 共 {news.length} 則新聞
            </div>
          )}
          {sources.length > 0 && (
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: '2px' }}>
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
              padding: '6px 14px', borderRadius: '20px', fontSize: 'calc(13px * var(--fz))', fontWeight: 600,
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
          <div style={{ fontSize: 'calc(48px * var(--fz))', marginBottom: '12px' }}>📭</div>
          <div style={{ fontSize: 'calc(14.5px * var(--fz))', marginBottom: '6px' }}>暫無相關新聞</div>
          <div style={{ fontSize: 'calc(13px * var(--fz))', opacity: 0.7 }}>
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
                    fontSize: 'calc(12.5px * var(--fz))', padding: '2px 8px', borderRadius: '4px',
                    background: cfg.bg, color: cfg.color, fontWeight: 600,
                  }}>
                    {cfg.emoji} {cfg.label}
                  </span>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                    {formatTimeAgo(item.time)}
                  </span>
                </div>

                {/* Title */}
                <div style={{
                  fontSize: 'calc(14px * var(--fz))', fontWeight: 600, color: 'var(--text-primary)',
                  lineHeight: '1.5',
                }}>
                  {item.title}
                </div>

                {/* Snippet (if available) */}
                {item.snippet && (
                  <div style={{
                    fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)',
                    lineHeight: '1.4', display: '-webkit-box',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {item.snippet}
                  </div>
                )}

                {/* Source + Link */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                    📡 {item.source}
                  </span>
                  {item.url && (
                    <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: cfg.color, fontWeight: 600 }}>
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
