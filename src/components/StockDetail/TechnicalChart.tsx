'use client';

import { useEffect, useRef, useMemo } from 'react';
import { useAppStore } from '@/lib/store';
import {
  calculateSMA,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateKD,
  type CandleData,
  type StockInfo,
} from '@/lib/twse-api';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  LineChart,
  ReferenceLine,
} from 'recharts';
import { format } from 'date-fns';
import styles from './TechnicalChart.module.css';
import { useShallow } from 'zustand/react/shallow';

interface ChartData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  rsi5: number | null;
  rsi10: number | null;
  ma5?: number | null;
  ma20?: number | null;
  ma60?: number | null;
  macd?: number | null;
  macdSignal?: number | null;
  macdHist?: number | null;
  rsi?: number | null;
  k?: number | null;
  d?: number | null;
}

interface Props {
  candles: CandleData[];
  stock: StockInfo;
  loading: boolean;
}

// Custom Candlestick shape for Recharts
function CandleStick(props: {
  x?: number; y?: number; width?: number;
  open?: number; close?: number; high?: number; low?: number;
  payload?: ChartData;
}) {
  const { x = 0, y = 0, width = 0, payload } = props;
  if (!payload) return null;
  const { open, close, high, low } = payload;
  const isUp = close >= open;
  const color = isUp ? '#f03e3e' : '#2f9e44';  // 紅漲綠跌
  const bodyTop = Math.min(open, close);
  const bodyBot = Math.max(open, close);
  // These need to be in data coords, but Recharts CandleStick not built-in
  // We'll use a bar chart with error bars trick
  return null;
}

// Simple OHLC rendering using custom bars
function OHLCBar(props: { x?: number; y?: number; width?: number; height?: number; payload?: ChartData; yAxisMap?: Record<string, (v: number) => number> }) {
  return null; // Placeholder — actual chart below
}

export default function TechnicalChart({ candles, stock, loading }: Props) {
  const { activeIndicators, toggleIndicator } = useAppStore(useShallow((s) => ({ activeIndicators: s.activeIndicators, toggleIndicator: s.toggleIndicator })));

  const chartData: ChartData[] = useMemo(() => {
    if (candles.length === 0) return [];

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    const ma5 = calculateSMA(closes, 5);
    const ma20 = calculateSMA(closes, 20);
    const ma60 = calculateSMA(closes, 60);
    const { macd, signal: macdSig, histogram } = calculateMACD(closes);
    const rsi = calculateRSI(closes);
    // 犀利媽法（2026-07-24 使用者指定）：RSI(5)/RSI(10) 雙線——雙90+勿接刀、雙<10超跌
    const rsi5 = calculateRSI(closes, 5);
    const rsi10 = calculateRSI(closes, 10);
    const { k, d } = calculateKD(highs, lows, closes);

    return candles.map((c, i) => ({
      date: format(new Date(c.time * 1000), 'MM/dd'),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      ma5: ma5[i] ?? null,
      ma20: ma20[i] ?? null,
      ma60: ma60[i] ?? null,
      macd: macd[i] ?? null,
      macdSignal: macdSig[i] ?? null,
      macdHist: histogram[i] ?? null,
      rsi: rsi[i] ?? null,
      rsi5: rsi5[i] ?? null,
      rsi10: rsi10[i] ?? null,
      k: k[i] ?? null,
      d: d[i] ?? null,
    }));
  }, [candles]);

  const INDICATOR_BTNS = [
    { id: 'MA5', label: 'MA5', color: '#f59e0b' },
    { id: 'MA20', label: 'MA20', color: '#3d8ef8' },
    { id: 'MA60', label: 'MA60', color: '#a78bfa' },
    { id: 'MACD', label: 'MACD', color: '#3d8ef8' },
    { id: 'RSI', label: 'RSI', color: '#a78bfa' },
    { id: 'KD', label: 'KD', color: '#22c55e' },
  ];

  const showMACD = activeIndicators.includes('MACD');
  const showRSI = activeIndicators.includes('RSI');
  const showKD = activeIndicators.includes('KD');

  const formatTooltip = (value: number, name: string) => {
    if (!value) return ['--', name];
    return [typeof value === 'number' ? value.toFixed(2) : value, name];
  };

  const formatXAxis = (tick: string, index: number) => {
    if (chartData.length <= 30) return tick;
    if (index % Math.floor(chartData.length / 8) === 0) return tick;
    return '';
  };

  const yDomain = useMemo(() => {
    if (chartData.length === 0) return ['auto', 'auto'];
    const all = chartData.flatMap(d => [d.high, d.low]);
    const min = Math.min(...all);
    const max = Math.max(...all);
    const pad = (max - min) * 0.05;
    return [Math.floor((min - pad) * 10) / 10, Math.ceil((max + pad) * 10) / 10];
  }, [chartData]);

  if (loading && candles.length === 0) {
    return (
      <div className={styles.loadingState}>
        <div className="spinner" />
        <p>載入 K 線資料中...</p>
      </div>
    );
  }

  if (candles.length === 0) {
    return (
      <div className={styles.emptyState}>
        <p>暫無歷史資料</p>
      </div>
    );
  }

  // Build candlestick using stacked bars trick (high-low as stem, open-close as body)
  const barData = chartData.map(d => {
    const isUp = d.close >= d.open;
    return {
      ...d,
      // For the wick: low to high
      stem: [d.low, d.high - d.low],
      // For the body
      bodyBase: Math.min(d.open, d.close),
      bodyHeight: Math.abs(d.close - d.open) || 0.01,
      isUp,
      // Reference for invisible fill
      lowRef: d.low,
    };
  });

  return (
    <div className={styles.chartContainer}>
      {/* Indicator Toggles */}
      <div className={styles.indicatorBar}>
        <span className={styles.indicatorLabel}>指標：</span>
        {INDICATOR_BTNS.map(ind => (
          <button
            key={ind.id}
            id={`indicator-${ind.id}`}
            className={`chip ${activeIndicators.includes(ind.id) ? 'active' : ''}`}
            style={activeIndicators.includes(ind.id) ? { color: ind.color, borderColor: ind.color, background: `${ind.color}15` } : {}}
            onClick={() => toggleIndicator(ind.id)}
          >
            {ind.label}
          </button>
        ))}
      </div>

      {/* Main Price Chart */}
      <div className={styles.mainChart}>
        <div className={styles.chartTitle}>K 線圖 & 均線</div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={barData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: '#8b9bb8', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v, i) => chartData.length > 60 && i % Math.floor(chartData.length / 8) !== 0 ? '' : v}
            />
            <YAxis
              domain={yDomain as [number, number]}
              tick={{ fill: '#8b9bb8', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              orientation="right"
              tickFormatter={v => v.toFixed(0)}
            />
            <Tooltip
              contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: '12px' }}
              labelStyle={{ color: 'var(--text-secondary)', marginBottom: 4 }}
              itemStyle={{ padding: '2px 0' }}
              formatter={(value, name) => {
                const n = value as number;
                return [n?.toFixed(2) ?? '--', name];
              }}
            />
            {/* Candle wicks - transparent base then high-low */}
            <Bar dataKey="lowRef" stackId="candle" fill="transparent" isAnimationActive={false} />
            <Bar
              dataKey="bodyHeight"
              stackId="body"
              isAnimationActive={false}
              fill="transparent"
              shape={(shapeProps: { x?: number; y?: number; width?: number; height?: number; payload?: typeof barData[0] }) => {
                const { x = 0, y = 0, width = 0, height = 0, payload } = shapeProps;
                if (!payload || width === 0) return <g />;
                const { isUp, high, low, bodyBase, bodyHeight } = payload as typeof barData[0];
                const color = isUp ? '#f03e3e' : '#2f9e44';
                const fillOpacity = isUp ? 0.15 : 0.9;
                // Need chart's y-scale — skip wicks in recharts, draw body only
                const bodyW = Math.max(width * 0.7, 1);
                const xCenter = x + width / 2;
                return (
                  <rect
                    x={xCenter - bodyW / 2}
                    y={y}
                    width={bodyW}
                    height={Math.max(height, 1)}
                    fill={color}
                    fillOpacity={isUp ? 0.8 : 0.9}
                    stroke={color}
                    strokeWidth={1}
                  />
                );
              }}
            />
            {/* MA Lines */}
            {activeIndicators.includes('MA5') && (
              <Line type="monotone" dataKey="ma5" dot={false} stroke="#f59e0b" strokeWidth={1.5} name="MA5" connectNulls />
            )}
            {activeIndicators.includes('MA20') && (
              <Line type="monotone" dataKey="ma20" dot={false} stroke="#3d8ef8" strokeWidth={1.5} name="MA20" connectNulls />
            )}
            {activeIndicators.includes('MA60') && (
              <Line type="monotone" dataKey="ma60" dot={false} stroke="#a78bfa" strokeWidth={1.5} name="MA60" connectNulls />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Volume */}
      <div className={styles.subChart}>
        <div className={styles.chartTitle}>成交量</div>
        <ResponsiveContainer width="100%" height={80}>
          <BarChart data={chartData} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis tick={{ fill: '#8b9bb8', fontSize: 10 }} axisLine={false} tickLine={false} orientation="right" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
            <Bar
              dataKey="volume"
              isAnimationActive={false}
              name="成交量"
              shape={(p: { x?: number; y?: number; width?: number; height?: number; payload?: ChartData }) => {
                const { x = 0, y = 0, width = 0, height = 0, payload } = p;
                const color = (payload?.close ?? 0) >= (payload?.open ?? 0) ? '#f03e3e' : '#2f9e44';
                return <rect x={x} y={y} width={width} height={height} fill={color} fillOpacity={0.5} />;
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* MACD */}
      {showMACD && (
        <div className={styles.subChart}>
          <div className={styles.chartTitle}>MACD (12, 26, 9)</div>
          <ResponsiveContainer width="100%" height={100}>
            <ComposedChart data={chartData} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
              <XAxis dataKey="date" hide />
              <YAxis tick={{ fill: '#8b9bb8', fontSize: 10 }} axisLine={false} tickLine={false} orientation="right" tickFormatter={v => v.toFixed(2)} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" />
              <Bar
                dataKey="macdHist"
                isAnimationActive={false}
                name="柱狀"
                shape={(p: { x?: number; y?: number; width?: number; height?: number; payload?: ChartData }) => {
                  const { x = 0, y = 0, width = 0, height = 0, payload } = p;
                  const hist = payload?.macdHist ?? 0;
                  const color = hist >= 0 ? '#f03e3e' : '#2f9e44';
                  return <rect x={x} y={y} width={Math.max(width, 1)} height={Math.max(Math.abs(height), 1)} fill={color} fillOpacity={0.6} />;
                }}
              />
              <Line type="monotone" dataKey="macd" dot={false} stroke="#3d8ef8" strokeWidth={1.5} name="MACD" connectNulls />
              <Line type="monotone" dataKey="macdSignal" dot={false} stroke="#f59e0b" strokeWidth={1.5} name="Signal" connectNulls />
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: '12px' }}
                formatter={(v) => [(v as number)?.toFixed(4) ?? '--']}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* RSI(5/10)：犀利媽法雙線——90 線=高檔警戒、10 線=極端超跌 */}
      {showRSI && (
        <div className={styles.subChart}>
          <div className={styles.chartTitle}>
            RSI (5/10)
            {(() => {
              const last = chartData[chartData.length - 1];
              if (!last || last.rsi5 == null) return null;
              const hot = (last.rsi5 as number) >= 90 && (last.rsi10 as number ?? 0) >= 90;
              const cold = (last.rsi5 as number) < 12;
              return (
                <span style={{ marginLeft: 8, fontWeight: 400 }}>
                  <span style={{ color: '#fbbf24' }}>RSI5 {(last.rsi5 as number).toFixed(1)}</span>
                  <span style={{ color: '#fb923c', marginLeft: 6 }}>RSI10 {last.rsi10 != null ? (last.rsi10 as number).toFixed(1) : '—'}</span>
                  {hot && <span style={{ color: '#f03e3e', marginLeft: 6, fontWeight: 800 }}>💣 雙90+ 高檔勿接刀·持有者準備分批出貨</span>}
                  {cold && <span style={{ color: '#fbbf24', marginLeft: 6, fontWeight: 800 }}>⚡ RSI≈10 極端超跌</span>}
                </span>
              );
            })()}
          </div>
          <ResponsiveContainer width="100%" height={80}>
            <ComposedChart data={chartData} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
              <XAxis dataKey="date" hide />
              <YAxis domain={[0, 100]} tick={{ fill: '#8b9bb8', fontSize: 10 }} axisLine={false} tickLine={false} orientation="right" />
              <ReferenceLine y={90} stroke="rgba(239,68,68,0.35)" strokeDasharray="4 4" />
              <ReferenceLine y={50} stroke="rgba(255,255,255,0.08)" />
              <ReferenceLine y={10} stroke="rgba(251,191,36,0.35)" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="rsi5" dot={false} stroke="#fbbf24" strokeWidth={1.5} name="RSI5" connectNulls />
              <Line type="monotone" dataKey="rsi10" dot={false} stroke="#fb923c" strokeWidth={1.5} name="RSI10" connectNulls />
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: '12px' }}
                formatter={(v, nm) => [(v as number)?.toFixed(2) ?? '--', String(nm)]}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* KD */}
      {showKD && (
        <div className={styles.subChart}>
          <div className={styles.chartTitle}>KD (9, 3, 3)</div>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={chartData} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
              <XAxis dataKey="date" hide />
              <YAxis domain={[0, 100]} tick={{ fill: '#8b9bb8', fontSize: 10 }} axisLine={false} tickLine={false} orientation="right" />
              <ReferenceLine y={80} stroke="rgba(239,68,68,0.2)" strokeDasharray="4 4" />
              <ReferenceLine y={20} stroke="rgba(34,197,94,0.2)" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="k" dot={false} stroke="#22c55e" strokeWidth={1.5} name="K值" connectNulls />
              <Line type="monotone" dataKey="d" dot={false} stroke="#f97316" strokeWidth={1.5} name="D值" connectNulls />
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: '12px' }}
                formatter={(v) => [(v as number)?.toFixed(2) ?? '--']}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
