'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import styles from './Backtest.module.css';
import CustomBacktest from './CustomBacktest';
import PageHelp from '@/components/Help/PageHelp';
import {
  fetchStockHistory,
  calculateSMA,
  calculateMACD,
  calculateRSI,
  calculateKD,
  CandleData,
} from '@/lib/twse-api';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type EntryStrategy =
  | 'ma_cross'
  | 'rsi_oversold'
  | 'macd_histogram'
  | 'kd_cross'
  | 'volume_breakout';

type ExitReason = 'take_profit' | 'stop_loss' | 'time_limit' | 'signal_reverse';

interface Trade {
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  exitReason: ExitReason;
  pnl: number;
  pnlPercent: number;
  holdingDays: number;
  shares: number;
}

interface BacktestResult {
  trades: Trade[];
  totalReturn: number;
  annualReturn: number;
  winRate: number;
  maxDrawdown: number;
  sharpeRatio: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgHoldingDays: number;
  finalCapital: number;
  equityCurve: Array<{ date: string; value: number }>;
}

interface Config {
  stockCode: string;
  period: '3m' | '6m' | '1y' | '2y';
  entryStrategy: EntryStrategy;
  exitTakeProfit: boolean;
  exitTakeProfitPct: number;
  exitStopLoss: boolean;
  exitStopLossPct: number;
  exitTimeLimit: boolean;
  exitTimeLimitDays: number;
  exitSignalReverse: boolean;
  initialCapital: number;
  feeRate: number;
  shareMode: 'fixed' | 'dynamic';
  dynamicPct: number;
}

type SortKey = keyof Trade;
type SortDir = 'asc' | 'desc';
type TableFilter = 'all' | 'win' | 'loss';

// ─────────────────────────────────────────────
// Backtest Engine
// ─────────────────────────────────────────────

function runBacktest(candles: CandleData[], config: Config): BacktestResult {
  if (candles.length < 40) {
    return emptyResult();
  }

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  // Pre-compute indicators
  const sma5  = calculateSMA(closes, 5);
  const sma20 = calculateSMA(closes, 20);
  const { histogram }       = calculateMACD(closes);
  const rsi                 = calculateRSI(closes, 14);
  const { k: kLine, d: dLine } = calculateKD(highs, lows, closes, 9);

  const avg20Vol = candles.map((_, i) => {
    if (i < 20) return null;
    const slice = volumes.slice(i - 20, i);
    return slice.reduce((a, b) => a + b, 0) / 20;
  });

  const trades: Trade[]   = [];
  let capital             = config.initialCapital;
  let inPosition          = false;
  let entryIdx            = 0;
  let entryPrice          = 0;
  let entryShares         = 0;
  let rsiWasBelow30       = false;

  const COMMISSION = config.feeRate / 100;
  const STAMP_TAX  = 0.003; // 賣方印花稅

  const equityMap: Array<{ date: string; value: number }> = [];

  function tsToDate(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }

  function checkEntry(i: number): boolean {
    if (i < 30) return false;
    switch (config.entryStrategy) {
      case 'ma_cross': {
        const prevS5  = sma5[i - 1];
        const prevS20 = sma20[i - 1];
        const curS5   = sma5[i];
        const curS20  = sma20[i];
        if (!prevS5 || !prevS20 || !curS5 || !curS20) return false;
        return prevS5 <= prevS20 && curS5 > curS20;
      }
      case 'rsi_oversold': {
        const prevRsi = rsi[i - 1];
        const curRsi  = rsi[i];
        if (prevRsi === null || curRsi === null) return false;
        if (prevRsi < 30) rsiWasBelow30 = true;
        return rsiWasBelow30 && curRsi > 35;
      }
      case 'macd_histogram': {
        const prev = histogram[i - 1];
        const cur  = histogram[i];
        if (prev === null || cur === null) return false;
        return prev < 0 && cur >= 0;
      }
      case 'kd_cross': {
        const prevK = kLine[i - 1];
        const prevD = dLine[i - 1];
        const curK  = kLine[i];
        const curD  = dLine[i];
        if (!prevK || !prevD || !curK || !curD) return false;
        return prevK <= prevD && curK > curD && curK < 80;
      }
      case 'volume_breakout': {
        const avVol = avg20Vol[i];
        if (avVol === null) return false;
        return volumes[i] >= avVol * 1.5 && closes[i] > (sma20[i] ?? 0);
      }
      default:
        return false;
    }
  }

  function checkReverseSignal(i: number): boolean {
    const prevS5  = sma5[i - 1];
    const prevS20 = sma20[i - 1];
    const curS5   = sma5[i];
    const curS20  = sma20[i];
    if (prevS5 && prevS20 && curS5 && curS20) {
      if (prevS5 >= prevS20 && curS5 < curS20) return true;
    }
    const rsiVal = rsi[i];
    if (rsiVal !== null && rsiVal > 70) return true;
    return false;
  }

  function closePosition(i: number, reason: ExitReason) {
    const exitPrice  = closes[i];
    const exitDate   = tsToDate(candles[i].time);
    const entryDate  = tsToDate(candles[entryIdx].time);
    const holdDays   = i - entryIdx;

    const buyFee     = entryPrice * entryShares * 1000 * COMMISSION;
    const sellFee    = exitPrice  * entryShares * 1000 * COMMISSION;
    const stampTax   = exitPrice  * entryShares * 1000 * STAMP_TAX;
    const grossPnl   = (exitPrice - entryPrice) * entryShares * 1000;
    const netPnl     = grossPnl - buyFee - sellFee - stampTax;
    const pnlPct     = (netPnl / (entryPrice * entryShares * 1000)) * 100;

    capital += exitPrice * entryShares * 1000 - sellFee - stampTax;

    trades.push({
      entryDate,
      entryPrice,
      exitDate,
      exitPrice,
      exitReason: reason,
      pnl: Math.round(netPnl),
      pnlPercent: parseFloat(pnlPct.toFixed(2)),
      holdingDays: holdDays,
      shares: entryShares,
    });

    inPosition     = false;
    rsiWasBelow30  = false;
  }

  for (let i = 1; i < candles.length; i++) {
    const date = tsToDate(candles[i].time);

    if (inPosition) {
      const price        = closes[i];
      const changeFromEntry = (price - entryPrice) / entryPrice * 100;
      const holdDays     = i - entryIdx;

      // Exit checks (priority: SL > TP > Time > Signal)
      if (config.exitStopLoss && changeFromEntry <= -config.exitStopLossPct) {
        closePosition(i, 'stop_loss');
      } else if (config.exitTakeProfit && changeFromEntry >= config.exitTakeProfitPct) {
        closePosition(i, 'take_profit');
      } else if (config.exitTimeLimit && holdDays >= config.exitTimeLimitDays) {
        closePosition(i, 'time_limit');
      } else if (config.exitSignalReverse && checkReverseSignal(i)) {
        closePosition(i, 'signal_reverse');
      }
    } else {
      // Entry check
      if (checkEntry(i)) {
        const price = closes[i];
        const cost  = config.shareMode === 'fixed'
          ? price * 1000
          : Math.floor((capital * (config.dynamicPct / 100)) / (price * 1000)) * price * 1000;

        if (capital >= cost && cost > 0) {
          entryShares = config.shareMode === 'fixed'
            ? 1
            : Math.floor((capital * (config.dynamicPct / 100)) / (price * 1000));

          if (entryShares < 1) entryShares = 1;

          const buyCost = price * entryShares * 1000;
          const buyFee  = buyCost * COMMISSION;
          if (capital >= buyCost + buyFee) {
            capital    -= buyCost + buyFee;
            entryPrice  = price;
            entryIdx    = i;
            inPosition  = true;
          }
        }
      }
    }

    // Record equity
    const currentValue = inPosition
      ? capital + closes[i] * entryShares * 1000
      : capital;
    equityMap.push({ date, value: Math.round(currentValue) });
  }

  // Force close at end
  if (inPosition) {
    closePosition(candles.length - 1, 'time_limit');
  }

  if (trades.length === 0) return emptyResult();

  // ── Stats ──
  const totalDays   = candles.length;
  const years       = totalDays / 252;
  const winTrades   = trades.filter(t => t.pnl > 0).length;
  const lossTrades  = trades.length - winTrades;
  const winRate     = (winTrades / trades.length) * 100;
  const totalReturn = ((equityMap[equityMap.length - 1].value - config.initialCapital) / config.initialCapital) * 100;
  const annualReturn = (Math.pow(1 + totalReturn / 100, 1 / Math.max(years, 0.1)) - 1) * 100;
  const avgHoldDays = trades.reduce((a, t) => a + t.holdingDays, 0) / trades.length;

  // Drawdown
  let peak         = config.initialCapital;
  let maxDrawdown  = 0;
  for (const pt of equityMap) {
    if (pt.value > peak) peak = pt.value;
    const dd = (peak - pt.value) / peak * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe (daily returns)
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityMap.length; i++) {
    const r = (equityMap[i].value - equityMap[i - 1].value) / equityMap[i - 1].value;
    dailyReturns.push(r);
  }
  const avgR  = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const stdR  = Math.sqrt(dailyReturns.reduce((a, b) => a + (b - avgR) ** 2, 0) / dailyReturns.length);
  const sharpe = stdR > 0 ? (avgR * 252) / (stdR * Math.sqrt(252)) : 0;

  // Consecutive wins/losses
  let maxW = 0, maxL = 0, curW = 0, curL = 0;
  for (const t of trades) {
    if (t.pnl > 0) { curW++; curL = 0; maxW = Math.max(maxW, curW); }
    else            { curL++; curW = 0; maxL = Math.max(maxL, curL); }
  }

  return {
    trades,
    totalReturn:  parseFloat(totalReturn.toFixed(2)),
    annualReturn: parseFloat(annualReturn.toFixed(2)),
    winRate:      parseFloat(winRate.toFixed(1)),
    maxDrawdown:  parseFloat(maxDrawdown.toFixed(2)),
    sharpeRatio:  parseFloat(sharpe.toFixed(2)),
    totalTrades:  trades.length,
    winTrades,
    lossTrades,
    maxConsecutiveWins:   maxW,
    maxConsecutiveLosses: maxL,
    avgHoldingDays: parseFloat(avgHoldDays.toFixed(1)),
    finalCapital: equityMap[equityMap.length - 1].value,
    equityCurve:  equityMap,
  };
}

function emptyResult(): BacktestResult {
  return {
    trades: [], totalReturn: 0, annualReturn: 0, winRate: 0,
    maxDrawdown: 0, sharpeRatio: 0, totalTrades: 0, winTrades: 0,
    lossTrades: 0, maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
    avgHoldingDays: 0, finalCapital: 0, equityCurve: [],
  };
}

// ─────────────────────────────────────────────
// Data Fetcher: get N months of history
// ─────────────────────────────────────────────

async function fetchMonthsHistory(code: string, months: number): Promise<CandleData[]> {
  const allCandles: CandleData[] = [];
  const now = new Date();

  for (let m = months - 1; m >= 0; m--) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
    const batch = await fetchStockHistory(code, dateStr);
    allCandles.push(...batch);
  }

  // Deduplicate by time and sort
  const seen = new Set<number>();
  const deduped = allCandles.filter(c => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });
  deduped.sort((a, b) => a.time - b.time);
  return deduped;
}

// ─────────────────────────────────────────────
// Equity Curve SVG Chart
// ─────────────────────────────────────────────

function EquityChart({
  equityCurve,
  trades,
  initialCapital,
}: {
  equityCurve: Array<{ date: string; value: number }>;
  trades: Trade[];
  initialCapital: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string } | null>(null);

  const W = 900, H = 200, padL = 56, padR = 16, padT = 10, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const values = equityCurve.map(p => p.value);
  const minV   = Math.min(...values);
  const maxV   = Math.max(...values);
  const range  = maxV - minV || 1;

  function xOf(i: number) { return padL + (i / (equityCurve.length - 1)) * innerW; }
  function yOf(v: number) { return padT + ((maxV - v) / range) * innerH; }

  // Build path
  const points = equityCurve.map((p, i) => `${xOf(i)},${yOf(p.value)}`).join(' ');
  const linePath = `M ${points.split(' ').join(' L ')}`;

  // Fill area (above/below initial capital)
  const baseline = yOf(initialCapital);
  const areaPath = `M ${xOf(0)},${baseline} ` +
    equityCurve.map((p, i) => `L ${xOf(i)},${yOf(p.value)}`).join(' ') +
    ` L ${xOf(equityCurve.length - 1)},${baseline} Z`;

  // X-axis labels (evenly spaced)
  const xLabels: Array<{ i: number; label: string }> = [];
  const step = Math.max(1, Math.floor(equityCurve.length / 6));
  for (let i = 0; i < equityCurve.length; i += step) {
    xLabels.push({ i, label: equityCurve[i].date.slice(5) });
  }

  // Y-axis labels
  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = minV + (i / yTicks) * range;
    return { y: yOf(v), label: `${(v / 10000).toFixed(0)}萬` };
  });

  // Trade entry/exit markers
  const tradeMarkers: Array<{ x: number; y: number; type: 'entry' | 'exit'; win: boolean }> = [];
  const dateIndex = new Map(equityCurve.map((p, i) => [p.date, i]));
  for (const t of trades) {
    const ei = dateIndex.get(t.entryDate);
    const xi = dateIndex.get(t.exitDate);
    if (ei !== undefined) {
      tradeMarkers.push({ x: xOf(ei), y: yOf(equityCurve[ei].value), type: 'entry', win: t.pnl > 0 });
    }
    if (xi !== undefined) {
      tradeMarkers.push({ x: xOf(xi), y: yOf(equityCurve[xi].value), type: 'exit', win: t.pnl > 0 });
    }
  }

  const aboveBaseline = yOf(equityCurve[equityCurve.length - 1].value) < baseline;

  return (
    <div className={styles.chartWrapper}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={styles.svgChart}
        onMouseMove={(e) => {
          const rect = svgRef.current!.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * W;
          const dataX = Math.max(0, relX - padL);
          const idx   = Math.round((dataX / innerW) * (equityCurve.length - 1));
          const clamped = Math.max(0, Math.min(idx, equityCurve.length - 1));
          const pt = equityCurve[clamped];
          setTooltip({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top - 40,
            label: `${pt.date}  ${ (pt.value / 10000).toFixed(1)}萬`,
          });
        }}
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Grid */}
        {yLabels.map((yl, i) => (
          <g key={i}>
            <line x1={padL} y1={yl.y} x2={W - padR} y2={yl.y} className={styles.chartGrid} />
            <text x={padL - 4} y={yl.y + 3} textAnchor="end" className={styles.axisLabel}>{yl.label}</text>
          </g>
        ))}

        {/* Baseline */}
        <line
          x1={padL} y1={baseline} x2={W - padR} y2={baseline}
          stroke="rgba(255,255,255,0.12)" strokeWidth={1} strokeDasharray="4,4"
        />

        {/* Fill area */}
        <defs>
          <linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={aboveBaseline ? '#f03e3e' : '#2f9e44'} stopOpacity="0.25" />
            <stop offset="100%" stopColor={aboveBaseline ? '#f03e3e' : '#2f9e44'} stopOpacity="0.02" />
          </linearGradient>
          <clipPath id="aboveClip">
            <rect x={padL} y={padT} width={innerW} height={Math.max(0, baseline - padT)} />
          </clipPath>
          <clipPath id="belowClip">
            <rect x={padL} y={baseline} width={innerW} height={innerH - (baseline - padT)} />
          </clipPath>
        </defs>

        <path d={areaPath} fill="url(#fillGrad)" opacity={0.9} />

        {/* Main line */}
        <path
          d={linePath}
          fill="none"
          stroke={aboveBaseline ? '#f03e3e' : '#2f9e44'}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Trade markers */}
        {tradeMarkers.map((m, i) => (
          <circle
            key={i}
            cx={m.x} cy={m.y} r={3.5}
            fill={m.type === 'entry' ? '#3d8ef8' : (m.win ? '#f03e3e' : '#2f9e44')}
            stroke="var(--bg-primary)"
            strokeWidth={1.5}
            opacity={0.9}
          />
        ))}

        {/* X-axis labels */}
        {xLabels.map((xl) => (
          <text
            key={xl.i}
            x={xOf(xl.i)} y={H - 6}
            textAnchor="middle"
            className={styles.axisLabel}
          >
            {xl.label}
          </text>
        ))}
      </svg>

      {tooltip && (
        <div
          className={styles.chartTooltip}
          style={{ left: tooltip.x + 12, top: tooltip.y, position: 'absolute', pointerEvents: 'none' }}
        >
          {tooltip.label}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Stat Card
// ─────────────────────────────────────────────

function StatCard({
  icon, label, value, sub, color, winRate,
}: {
  icon: string;
  label: string;
  value: string;
  sub?: string;
  color?: string;
  winRate?: number;
}) {
  const accentClass =
    color === 'red'    ? styles.accentRed   :
    color === 'green'  ? styles.accentGreen :
    color === 'yellow' ? styles.accentYellow:
    color === 'purple' ? styles.accentPurple:
    color === 'cyan'   ? styles.accentCyan  :
    styles.accentBlue;

  return (
    <div className={`${styles.statCard} ${accentClass}`}>
      <div className={styles.statHeader}>
        <span className={styles.statLabel}>{label}</span>
        <span className={styles.statIcon}>{icon}</span>
      </div>
      <div
        className={styles.statValue}
        style={{
          color:
            color === 'red'   ? 'var(--color-up)'   :
            color === 'green' ? 'var(--color-down)'  :
            color === 'yellow'? '#f59e0b'            :
            color === 'purple'? '#a855f7'            :
            color === 'cyan'  ? '#06b6d4'            :
            'var(--text-primary)',
        }}
      >
        {value}
      </div>
      {winRate !== undefined && (
        <div className={styles.winRateBar}>
          <div
            className={styles.winRateFill}
            style={{
              width: `${winRate}%`,
              background: winRate >= 50
                ? 'linear-gradient(90deg, var(--color-up), #f87171)'
                : 'linear-gradient(90deg, var(--color-down), #4ade80)',
            }}
          />
        </div>
      )}
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────
// Reason Badge
// ─────────────────────────────────────────────

function ReasonBadge({ reason }: { reason: ExitReason }) {
  const map: Record<ExitReason, { label: string; cls: string }> = {
    take_profit:    { label: '🎯 停利', cls: styles.reasonTP },
    stop_loss:      { label: '🛡️ 停損', cls: styles.reasonSL },
    time_limit:     { label: '⏱️ 時限', cls: styles.reasonTime },
    signal_reverse: { label: '↩️ 反訊', cls: styles.reasonSig },
  };
  const { label, cls } = map[reason];
  return <span className={`${styles.reasonBadge} ${cls}`}>{label}</span>;
}

// ─────────────────────────────────────────────
// Main Backtest Component
// ─────────────────────────────────────────────

const ENTRY_STRATEGIES: Array<{ id: EntryStrategy; label: string }> = [
  { id: 'ma_cross',        label: '📈 MA5穿越MA20（黃金交叉）' },
  { id: 'rsi_oversold',    label: '📉 RSI跌破30後回升>35（超賣反彈）' },
  { id: 'macd_histogram',  label: '⚡ MACD柱狀由負轉正（動能翻多）' },
  { id: 'kd_cross',        label: '🔀 KD黃金交叉（K上穿D）' },
  { id: 'volume_breakout', label: '📊 突破20日均量1.5倍（量能突破）' },
];

const PERIODS: Array<{ id: Config['period']; label: string; months: number }> = [
  { id: '3m', label: '3 個月', months: 3 },
  { id: '6m', label: '6 個月', months: 6 },
  { id: '1y', label: '1 年',   months: 12 },
  { id: '2y', label: '2 年',   months: 24 },
];

export default function Backtest() {
  const [config, setConfig] = useState<Config>({
    stockCode:          '2330',
    period:             '1y',
    entryStrategy:      'ma_cross',
    exitTakeProfit:     true,
    exitTakeProfitPct:  10,
    exitStopLoss:       true,
    exitStopLossPct:    5,
    exitTimeLimit:      true,
    exitTimeLimitDays:  20,
    exitSignalReverse:  false,
    initialCapital:     1000000,
    feeRate:            0.1425,
    shareMode:          'fixed',
    dynamicPct:         20,
  });

  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [result,   setResult]   = useState<BacktestResult | null>(null);

  // Trades table state
  const [sortKey,   setSortKey]   = useState<SortKey>('entryDate');
  const [sortDir,   setSortDir]   = useState<SortDir>('asc');
  const [tableFilter, setTableFilter] = useState<TableFilter>('all');

  function setField<K extends keyof Config>(key: K, val: Config[K]) {
    setConfig(prev => ({ ...prev, [key]: val }));
  }

  const handleRun = useCallback(async () => {
    if (!config.stockCode.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const periodMonths = PERIODS.find(p => p.id === config.period)!.months;
      const candles = await fetchMonthsHistory(config.stockCode.trim(), periodMonths);

      if (candles.length < 30) {
        setError(`無法取得足夠歷史資料（${config.stockCode}）。請確認股票代號正確且有充足歷史資料。`);
        return;
      }

      const res = runBacktest(candles, config);
      if (res.trades.length === 0) {
        setError('此期間內未找到任何符合進場條件的交易訊號。請嘗試更長的回測期間或不同的策略。');
        return;
      }

      setResult(res);
    } catch (e) {
      setError('取得資料時發生錯誤，請稍後再試。');
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [config]);

  // Sorted + filtered trades
  const displayTrades = useMemo(() => {
    if (!result) return [];
    let list = result.trades;
    if (tableFilter === 'win')  list = list.filter(t => t.pnl > 0);
    if (tableFilter === 'loss') list = list.filter(t => t.pnl <= 0);
    return [...list].sort((a, b) => {
      const av = a[sortKey] as number | string;
      const bv = b[sortKey] as number | string;
      if (av < bv) return sortDir === 'asc' ? -1 :  1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }, [result, sortKey, sortDir, tableFilter]);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  function sortIcon(key: SortKey) {
    if (sortKey !== key) return <span className={styles.sortIcon}>↕</span>;
    return <span className={styles.sortIcon}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  const formatMoney = (n: number) =>
    n >= 1000000 ? `${(n / 10000).toFixed(0)}萬` : n.toLocaleString();
  const sign = (n: number) => n >= 0 ? `+${n}` : `${n}`;

  return (
    <div className={styles.container}>
      <PageHelp id="backtest" />
      {/* Page Header */}
      <div className={styles.pageHeader}>
        <span className={styles.pageIcon}>🧪</span>
        <div>
          <div className={styles.pageTitle}>策略回測引擎</div>
          <div className={styles.pageSubtitle}>使用歷史K線資料驗證交易策略績效</div>
        </div>
      </div>

      {/* 自訂策略回測（全市場，daemon 執行） */}
      <CustomBacktest />

      <div className={styles.layout}>
        {/* ── Config Panel ── */}
        <div className={styles.configPanel}>
          {/* Stock Code */}
          <div>
            <div className={styles.sectionTitle}>股票代號</div>
            <input
              className={styles.stockInput}
              value={config.stockCode}
              onChange={e => setField('stockCode', e.target.value.toUpperCase())}
              placeholder="例：2330"
              maxLength={6}
            />
          </div>

          {/* Period */}
          <div>
            <div className={styles.sectionTitle}>回測期間</div>
            <div className={styles.periodGroup}>
              {PERIODS.map(p => (
                <button
                  key={p.id}
                  className={`${styles.periodBtn} ${config.period === p.id ? styles.active : ''}`}
                  onClick={() => setField('period', p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Entry Strategy */}
          <div>
            <div className={styles.sectionTitle}>進場策略</div>
            <div className={styles.strategyList}>
              {ENTRY_STRATEGIES.map(s => (
                <label
                  key={s.id}
                  className={`${styles.strategyOption} ${config.entryStrategy === s.id ? styles.active : ''}`}
                >
                  <input
                    type="radio"
                    name="entryStrategy"
                    value={s.id}
                    checked={config.entryStrategy === s.id}
                    onChange={() => setField('entryStrategy', s.id)}
                  />
                  <span className={styles.strategyDot} />
                  <span className={styles.strategyLabel}>{s.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Exit Strategy */}
          <div>
            <div className={styles.sectionTitle}>出場條件</div>
            <div className={styles.exitList}>
              {/* Take Profit */}
              <label
                className={`${styles.exitOption} ${config.exitTakeProfit ? styles.active : ''}`}
              >
                <span className={styles.exitCheckbox}>{config.exitTakeProfit ? '✓' : ''}</span>
                <input
                  type="checkbox"
                  style={{ display: 'none' }}
                  checked={config.exitTakeProfit}
                  onChange={e => setField('exitTakeProfit', e.target.checked)}
                />
                <span className={styles.exitLabel}>🎯 停利</span>
                <input
                  className={styles.exitInput}
                  type="number"
                  min={1} max={100} step={0.5}
                  value={config.exitTakeProfitPct}
                  onChange={e => setField('exitTakeProfitPct', parseFloat(e.target.value) || 10)}
                  onClick={e => e.stopPropagation()}
                />
                <span style={{ fontSize: 'calc(0.75rem * var(--fz))', color: 'var(--text-muted)' }}>%</span>
              </label>

              {/* Stop Loss */}
              <label
                className={`${styles.exitOption} ${config.exitStopLoss ? styles.active : ''}`}
              >
                <span className={styles.exitCheckbox}>{config.exitStopLoss ? '✓' : ''}</span>
                <input
                  type="checkbox"
                  style={{ display: 'none' }}
                  checked={config.exitStopLoss}
                  onChange={e => setField('exitStopLoss', e.target.checked)}
                />
                <span className={styles.exitLabel}>🛡️ 停損</span>
                <input
                  className={styles.exitInput}
                  type="number"
                  min={1} max={50} step={0.5}
                  value={config.exitStopLossPct}
                  onChange={e => setField('exitStopLossPct', parseFloat(e.target.value) || 5)}
                  onClick={e => e.stopPropagation()}
                />
                <span style={{ fontSize: 'calc(0.75rem * var(--fz))', color: 'var(--text-muted)' }}>%</span>
              </label>

              {/* Time Limit */}
              <label
                className={`${styles.exitOption} ${config.exitTimeLimit ? styles.active : ''}`}
              >
                <span className={styles.exitCheckbox}>{config.exitTimeLimit ? '✓' : ''}</span>
                <input
                  type="checkbox"
                  style={{ display: 'none' }}
                  checked={config.exitTimeLimit}
                  onChange={e => setField('exitTimeLimit', e.target.checked)}
                />
                <span className={styles.exitLabel}>⏱️ 持有天數</span>
                <input
                  className={styles.exitInput}
                  type="number"
                  min={1} max={365}
                  value={config.exitTimeLimitDays}
                  onChange={e => setField('exitTimeLimitDays', parseInt(e.target.value) || 20)}
                  onClick={e => e.stopPropagation()}
                />
                <span style={{ fontSize: 'calc(0.75rem * var(--fz))', color: 'var(--text-muted)' }}>日</span>
              </label>

              {/* Signal Reverse */}
              <label
                className={`${styles.exitOption} ${config.exitSignalReverse ? styles.active : ''}`}
              >
                <span className={styles.exitCheckbox}>{config.exitSignalReverse ? '✓' : ''}</span>
                <input
                  type="checkbox"
                  style={{ display: 'none' }}
                  checked={config.exitSignalReverse}
                  onChange={e => setField('exitSignalReverse', e.target.checked)}
                />
                <span className={styles.exitLabel}>↩️ 反向訊號出場</span>
              </label>
            </div>
          </div>

          {/* Capital & Fee */}
          <div>
            <div className={styles.sectionTitle}>資金設定</div>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>初始資金（元）</label>
              <input
                className={styles.numberField}
                type="number"
                min={100000}
                step={100000}
                value={config.initialCapital}
                onChange={e => setField('initialCapital', parseInt(e.target.value) || 1000000)}
              />
            </div>
            <div className={styles.twoCol} style={{ marginTop: 10 }}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>手續費率（%）</label>
                <input
                  className={styles.numberField}
                  type="number"
                  min={0} max={1} step={0.01}
                  value={config.feeRate}
                  onChange={e => setField('feeRate', parseFloat(e.target.value) || 0.1425)}
                />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>交易股數</label>
                <select
                  className={styles.selectField}
                  value={config.shareMode}
                  onChange={e => setField('shareMode', e.target.value as 'fixed' | 'dynamic')}
                >
                  <option value="fixed">固定1張</option>
                  <option value="dynamic">動態%</option>
                </select>
              </div>
            </div>
            {config.shareMode === 'dynamic' && (
              <div className={styles.fieldGroup} style={{ marginTop: 10 }}>
                <label className={styles.fieldLabel}>每次投入資金比例（%）</label>
                <input
                  className={styles.numberField}
                  type="number"
                  min={1} max={100}
                  value={config.dynamicPct}
                  onChange={e => setField('dynamicPct', parseInt(e.target.value) || 20)}
                />
              </div>
            )}
          </div>

          {/* Run Button */}
          <button
            className={`${styles.runBtn} ${loading ? styles.loading : ''}`}
            onClick={handleRun}
            disabled={loading || !config.stockCode.trim()}
          >
            {loading ? (
              <>
                <div className={styles.loadingSpinner} style={{ width: 18, height: 18, borderWidth: 2 }} />
                計算中…
              </>
            ) : (
              <>⚡ 開始回測</>
            )}
          </button>
        </div>

        {/* ── Results Area ── */}
        <div>
          {loading && (
            <div className={styles.loadingOverlay}>
              <div className={styles.loadingSpinner} />
              <div className={styles.loadingText}>正在取得歷史資料並運算策略…</div>
              <div className={styles.loadingBar}>
                <div className={styles.loadingBarFill} />
              </div>
            </div>
          )}

          {!loading && error && (
            <div className={styles.errorCard}>
              ⚠️ {error}
            </div>
          )}

          {!loading && !error && !result && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>📊</div>
              <div className={styles.emptyTitle}>設定策略，開始回測</div>
              <div className={styles.emptyDesc}>
                在左側選擇股票代號、回測期間與進出場策略，<br />
                點擊「⚡ 開始回測」即可查看歷史績效報告。
              </div>
            </div>
          )}

          {!loading && result && (
            <div className={styles.resultsPanel}>
              {/* Summary Bar */}
              <div className={styles.summaryBar}>
                <div className={styles.summaryItem}>
                  <span className={styles.summaryDot} style={{ background: 'var(--accent-blue)' }} />
                  <span className={styles.summaryLabel}>股票</span>
                  <span className={styles.summaryValue}>{config.stockCode}</span>
                </div>
                <div className={styles.summaryDivider} />
                <div className={styles.summaryItem}>
                  <span className={styles.summaryLabel}>初始資金</span>
                  <span className={styles.summaryValue}>{formatMoney(config.initialCapital)}</span>
                </div>
                <div className={styles.summaryDivider} />
                <div className={styles.summaryItem}>
                  <span className={styles.summaryLabel}>最終資金</span>
                  <span className={styles.summaryValue}
                    style={{ color: result.finalCapital >= config.initialCapital ? 'var(--color-up)' : 'var(--color-down)' }}
                  >
                    {formatMoney(result.finalCapital)}
                  </span>
                </div>
                <div className={styles.summaryDivider} />
                <div className={styles.summaryItem}>
                  <span className={styles.summaryLabel}>策略</span>
                  <span className={styles.summaryValue}>
                    {ENTRY_STRATEGIES.find(s => s.id === config.entryStrategy)?.label.slice(3).split('（')[0]}
                  </span>
                </div>
              </div>

              {/* Stats Grid */}
              <div className={styles.statsGrid}>
                <StatCard
                  icon="🏆" label="總報酬率"
                  value={`${sign(result.totalReturn)}%`}
                  sub={`年化 ${sign(result.annualReturn)}%`}
                  color={result.totalReturn >= 0 ? 'red' : 'green'}
                />
                <StatCard
                  icon="📈" label="年化報酬率"
                  value={`${sign(result.annualReturn)}%`}
                  color={result.annualReturn >= 0 ? 'red' : 'green'}
                />
                <StatCard
                  icon="🎯" label="勝率"
                  value={`${result.winRate}%`}
                  sub={`${result.winTrades}勝 / ${result.lossTrades}敗`}
                  winRate={result.winRate}
                  color={result.winRate >= 50 ? 'cyan' : 'yellow'}
                />
                <StatCard
                  icon="📉" label="最大回撤"
                  value={`-${result.maxDrawdown}%`}
                  sub={`夏普比率 ${result.sharpeRatio}`}
                  color="green"
                />
                <StatCard
                  icon="🔢" label="交易次數"
                  value={`${result.totalTrades}`}
                  sub={`最高連勝 ${result.maxConsecutiveWins} / 最高連敗 ${result.maxConsecutiveLosses}`}
                  color="purple"
                />
                <StatCard
                  icon="⏱️" label="平均持有天數"
                  value={`${result.avgHoldingDays}`}
                  sub="交易日"
                  color="blue"
                />
              </div>

              {/* Equity Curve */}
              <div className={styles.chartCard}>
                <div className={styles.chartHeader}>
                  <div className={styles.chartTitle}>
                    📈 資產曲線
                    <span style={{ fontSize: 'calc(0.75rem * var(--fz))', fontWeight: 400, color: 'var(--text-muted)' }}>
                      · 藍點=進場 · 彩點=出場
                    </span>
                  </div>
                  <div className={styles.chartMeta}>
                    {result.equityCurve.length > 0 && (
                      <>
                        {result.equityCurve[0].date} → {result.equityCurve[result.equityCurve.length - 1].date}
                      </>
                    )}
                  </div>
                </div>
                <EquityChart
                  equityCurve={result.equityCurve}
                  trades={result.trades}
                  initialCapital={config.initialCapital}
                />
              </div>

              {/* Trades Table */}
              <div className={styles.tableCard}>
                <div className={styles.tableHeader}>
                  <div className={styles.tableTitle}>
                    📋 交易明細
                    <span style={{ fontSize: 'calc(0.75rem * var(--fz))', fontWeight: 400, color: 'var(--text-muted)' }}>
                      {displayTrades.length} 筆
                    </span>
                  </div>
                  <div className={styles.tableFilter}>
                    {(['all', 'win', 'loss'] as TableFilter[]).map(f => (
                      <button
                        key={f}
                        className={`${styles.filterBtn} ${tableFilter === f ? styles.active : ''}`}
                        onClick={() => setTableFilter(f)}
                      >
                        {f === 'all' ? '全部' : f === 'win' ? '獲利' : '虧損'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.tableScroll}>
                  <table className={styles.tradesTable}>
                    <thead>
                      <tr>
                        <th onClick={() => handleSort('entryDate')}>進場日期{sortIcon('entryDate')}</th>
                        <th onClick={() => handleSort('exitDate')}>出場日期{sortIcon('exitDate')}</th>
                        <th onClick={() => handleSort('holdingDays')}>持有天數{sortIcon('holdingDays')}</th>
                        <th onClick={() => handleSort('entryPrice')}>進場價{sortIcon('entryPrice')}</th>
                        <th onClick={() => handleSort('exitPrice')}>出場價{sortIcon('exitPrice')}</th>
                        <th>出場原因</th>
                        <th onClick={() => handleSort('pnl')}>損益(元){sortIcon('pnl')}</th>
                        <th onClick={() => handleSort('pnlPercent')}>損益%{sortIcon('pnlPercent')}</th>
                        <th>張數</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayTrades.map((t, i) => (
                        <tr
                          key={i}
                          className={t.pnl > 0 ? styles.tradeWin : styles.tradeLoss}
                        >
                          <td>{t.entryDate}</td>
                          <td>{t.exitDate}</td>
                          <td>{t.holdingDays}</td>
                          <td>{t.entryPrice.toFixed(2)}</td>
                          <td>{t.exitPrice.toFixed(2)}</td>
                          <td><ReasonBadge reason={t.exitReason} /></td>
                          <td className={t.pnl > 0 ? styles.pnlWin : styles.pnlLoss}>
                            {t.pnl > 0 ? '+' : ''}{t.pnl.toLocaleString()}
                          </td>
                          <td className={t.pnlPercent > 0 ? styles.pnlWin : styles.pnlLoss}>
                            {t.pnlPercent > 0 ? '+' : ''}{t.pnlPercent.toFixed(2)}%
                          </td>
                          <td>{t.shares}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
