'use client';

import { useEffect, useRef, useMemo, useState } from 'react';
import { useAppStore } from '@/lib/store';
import {
  calculateSMA,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateKD,
  calculateBBands,
  calculateSAR,
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
  j?: number | null;          // J = 3K − 2D（券商「KD,J」的第三條）
  bbMid?: number | null;
  bbUp?: number | null;
  bbLow?: number | null;
  sar?: number | null;
  sarUp?: boolean;            // true=多頭段（SAR 在價格下方）
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

// ── 副圖（量能/籌碼）可切換比對 ──────────────────────────────────────────
// 2026-08-20 使用者需求：K 線圖下方要能切換「每日量 / 法人 / 千張大戶 / 融資券」
// 一起對照。資料一律走 /api/stock/chip-series（只讀 Firestore 歸檔，零上游請求）。
//
// ⚠ 三種資料的**時間尺度與語意都不同**，不能混為一談：
//   · 法人＝當日買賣超（張），有正負 → 柱狀
//   · 融資券＝**餘額**（張）不是買賣超 → 給「日增減」柱狀＋餘額線，兩者並列
//   · 千張大戶＝集保**週**資料（每週一次）→ 折線，且本站自歸檔首週起才有
type SubTab = 'vol' | 'inst' | 'margin' | 'holders';
const SUB_TABS: Array<{ id: SubTab; label: string }> = [
  { id: 'vol', label: '每日量' },
  { id: 'inst', label: '法人' },
  { id: 'margin', label: '融資券' },
  { id: 'holders', label: '千張大戶' },
];
interface ChipDaily { date: string; fgn: number | null; trust: number | null; inst: number | null; mgn: number | null; shrt: number | null; mgnChg?: number | null; shrtChg?: number | null }
interface ChipHolder { week: string; ratio: number }

export default function TechnicalChart({ candles, stock, loading }: Props) {
  const { activeIndicators, toggleIndicator } = useAppStore(useShallow((s) => ({ activeIndicators: s.activeIndicators, toggleIndicator: s.toggleIndicator })));
  const [subTab, setSubTab] = useState<SubTab>('vol');
  const [chip, setChip] = useState<{ daily: ChipDaily[]; holders: ChipHolder[]; holdersFrom: string | null } | null>(null);
  const [chipLoading, setChipLoading] = useState(false);

  useEffect(() => {
    if (!stock?.code) return;
    let live = true;
    setChipLoading(true);
    fetch(`/api/stock/chip-series?code=${stock.code}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (live && d && !d.error) setChip({ daily: d.daily || [], holders: d.holders || [], holdersFrom: d.holdersFrom ?? null }); })
      .catch(() => { /* 籌碼是加值資訊，失敗不影響 K 線 */ })
      .finally(() => { if (live) setChipLoading(false); });
    return () => { live = false; };
  }, [stock?.code]);

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
    const bb = calculateBBands(closes, 20, 2);
    const ps = calculateSAR(highs, lows);

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
      j: k[i] != null && d[i] != null ? 3 * (k[i] as number) - 2 * (d[i] as number) : null,
      bbMid: bb.mid[i] ?? null,
      bbUp: bb.upper[i] ?? null,
      bbLow: bb.lower[i] ?? null,
      sar: ps.sar[i] ?? null,
      sarUp: ps.rising[i],
    }));
  }, [candles]);

  // 籌碼副圖對齊 K 線：副圖要能跟上面的 K 線逐日對照，x 軸就必須是同一組日子。
  // ⚠ 只保留**歸檔真的涵蓋到**的區間——K 線可能比籌碼歸檔長，缺的日子若補 0，
  //   「沒有資料」會被畫成「法人買賣超 0 張」「融資餘額 0 張」，那是假訊息。
  const chipDaily = useMemo(() => {
    if (!chip?.daily?.length || candles.length === 0) return [];
    const byIso: Record<string, ChipDaily> = {};
    for (const d of chip.daily) byIso[d.date] = d;
    const firstIso = chip.daily[0].date;
    const out: Array<ChipDaily & { label: string }> = [];
    for (const c of candles) {
      const dt = new Date(c.time * 1000);
      const iso = format(dt, 'yyyy-MM-dd');
      if (iso < firstIso) continue;                 // 歸檔尚未涵蓋 → 不畫，不補 0
      const r = byIso[iso];
      if (!r) continue;                             // 該日無歸檔（休市/缺漏）→ 跳過
      out.push({ ...r, label: format(dt, 'MM/dd'), date: format(dt, 'MM/dd') });
    }
    return out;
  }, [chip, candles]);

  // 各副圖只吃「該欄位真的有歸檔」的日子——資券當日 21:45 才寫入，
  // 若把缺漏日一起丟給圖表，融資餘額線會在最後一天垂直掉到 0（假訊號）。
  const instSeries = useMemo(() => chipDaily.filter(d => d.fgn != null), [chipDaily]);
  const marginSeries = useMemo(() => chipDaily.filter(d => d.mgn != null), [chipDaily]);

  const INDICATOR_BTNS = [
    { id: 'MA5', label: 'MA5', color: '#f59e0b' },
    { id: 'MA20', label: 'MA20', color: '#3d8ef8' },
    { id: 'MA60', label: 'MA60', color: '#a78bfa' },
    { id: 'BBAND', label: 'BBAND 布林', color: '#38bdf8' },
    { id: 'SAR', label: 'SAR 轉向', color: '#fb7185' },
    { id: 'MACD', label: 'MACD', color: '#3d8ef8' },
    { id: 'RSI', label: 'RSI', color: '#a78bfa' },
    { id: 'KD', label: 'KD', color: '#22c55e' },
    { id: 'J', label: 'J 值', color: '#e879f9' },
  ];

  const showMACD = activeIndicators.includes('MACD');
  const showRSI = activeIndicators.includes('RSI');
  const showKD = activeIndicators.includes('KD');
  const showJ = activeIndicators.includes('J');
  const showBB = activeIndicators.includes('BBAND');
  const showSAR = activeIndicators.includes('SAR');

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
              tick={{ fill: '#b8c6e4', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v, i) => chartData.length > 60 && i % Math.floor(chartData.length / 8) !== 0 ? '' : v}
            />
            <YAxis
              domain={yDomain as [number, number]}
              tick={{ fill: '#b8c6e4', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              orientation="right"
              tickFormatter={v => v.toFixed(0)}
            />
            <Tooltip
              contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: 'calc(12.5px * var(--fz))' }}
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
            {/* 布林通道：上下軌用虛線、中軌實線；只在主圖，與 MA 同一個 Y 軸 */}
            {showBB && <>
              <Line type="monotone" dataKey="bbUp" dot={false} stroke="#38bdf8" strokeWidth={1} strokeDasharray="4 3" name="布林上軌" connectNulls />
              <Line type="monotone" dataKey="bbMid" dot={false} stroke="#38bdf8" strokeWidth={1} strokeOpacity={0.55} name="布林中軌(MA20)" connectNulls />
              <Line type="monotone" dataKey="bbLow" dot={false} stroke="#38bdf8" strokeWidth={1} strokeDasharray="4 3" name="布林下軌" connectNulls />
            </>}
            {/* SAR：逐點小圓，多頭段(價格上方為空)綠、空頭段紅——顏色即方向 */}
            {showSAR && (
              <Line type="monotone" dataKey="sar" stroke="none" name="SAR" connectNulls={false} isAnimationActive={false}
                dot={(p: { cx?: number; cy?: number; payload?: ChartData; index?: number }) => {
                  const { cx, cy, payload, index } = p;
                  if (cx == null || cy == null || payload?.sar == null) return <g key={`sar-${index}`} />;
                  return <circle key={`sar-${index}`} cx={cx} cy={cy} r={1.6} fill={payload.sarUp ? '#f03e3e' : '#2f9e44'} />;
                }} />
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

      {/* 副圖切換列：每日量 / 法人 / 融資券 / 千張大戶（2026-08-20） */}
      <div className={styles.indicatorBar} style={{ marginTop: 4 }}>
        <span className={styles.indicatorLabel}>副圖：</span>
        {SUB_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              padding: '3px 12px', marginRight: 6, borderRadius: 999, cursor: 'pointer',
              fontSize: 'calc(12.5px * var(--fz))', fontWeight: subTab === t.id ? 700 : 500,
              background: subTab === t.id ? 'rgba(61,142,248,0.18)' : 'transparent',
              color: subTab === t.id ? '#3d8ef8' : 'var(--text-muted)',
              border: `1px solid ${subTab === t.id ? 'rgba(61,142,248,0.5)' : 'var(--border-primary)'}`,
            }}
          >{t.label}</button>
        ))}
        {chipLoading && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>載入籌碼…</span>}
      </div>

      {/* ── 法人：外資／投信當日買賣超（張）──────────────────────────── */}
      {subTab === 'inst' && (
        <div className={styles.subChart}>
          <div className={styles.chartTitle}>
            三大法人買賣超（張）
            <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))', color: '#cbd5f5' }}>
              <span style={{ color: '#f59e0b' }}>▌</span>外資　<span style={{ color: '#a78bfa' }}>▌</span>投信
              <span style={{ marginLeft: 8, opacity: 0.75 }}>收盤後歸檔，非盤中即時</span>
            </span>
          </div>
          {instSeries.length === 0 ? (
            <div style={{ padding: '18px 4px', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
              {chipLoading ? '載入中…' : '此檔無法人歸檔資料（興櫃與部分新股不在三大法人統計內）'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={110}>
              <ComposedChart data={instSeries} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <XAxis dataKey="date" hide />
                <YAxis tick={{ fill: '#b8c6e4', fontSize: 12 }} axisLine={false} tickLine={false} orientation="right" />
                <ReferenceLine y={0} stroke="#64748b" strokeWidth={1} />
                <Bar dataKey="fgn" name="外資" fill="#f59e0b" fillOpacity={0.75} isAnimationActive={false} />
                <Bar dataKey="trust" name="投信" fill="#a78bfa" fillOpacity={0.75} isAnimationActive={false} />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                  contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: 'calc(12.5px * var(--fz))' }}
                  labelStyle={{ color: '#ffffff', fontWeight: 800, marginBottom: 2 }}
                  formatter={(v, n) => [`${(v as number).toLocaleString()} 張`, n as string]}
                />
                <Legend wrapperStyle={{ fontSize: 'calc(12.5px * var(--fz))' }} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── 融資券：餘額是「水位」，日增減才是「動作」──────────────── */}
      {subTab === 'margin' && (
        <div className={styles.subChart}>
          <div className={styles.chartTitle}>
            融資／融券
            <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))', color: '#cbd5f5' }}>
              <span style={{ color: '#f03e3e' }}>▌</span>融資日增減　<span style={{ color: '#22d3ee' }}>▌</span>融券日增減　
              <span style={{ color: '#f59e0b' }}>—</span>融資餘額（右軸·張）
            </span>
          </div>
          {marginSeries.length === 0 ? (
            <div style={{ padding: '18px 4px', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
              {chipLoading ? '載入中…' : '此檔無資券歸檔資料（未開放信用交易的個股沒有融資券）'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={110}>
              <ComposedChart data={marginSeries} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <XAxis dataKey="date" hide />
                <YAxis yAxisId="chg" tick={{ fill: '#b8c6e4', fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="bal" orientation="right" tick={{ fill: '#f59e0b', fontSize: 12 }} axisLine={false} tickLine={false} />
                <ReferenceLine yAxisId="chg" y={0} stroke="#64748b" strokeWidth={1} />
                <Bar yAxisId="chg" dataKey="mgnChg" name="融資日增減" fill="#f03e3e" fillOpacity={0.7} isAnimationActive={false} />
                <Bar yAxisId="chg" dataKey="shrtChg" name="融券日增減" fill="#22d3ee" fillOpacity={0.7} isAnimationActive={false} />
                <Line yAxisId="bal" type="monotone" dataKey="mgn" name="融資餘額" stroke="#f59e0b" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                  contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: 'calc(12.5px * var(--fz))' }}
                  labelStyle={{ color: '#ffffff', fontWeight: 800, marginBottom: 2 }}
                  formatter={(v, n) => [`${(v as number).toLocaleString()} 張`, n as string]}
                />
                <Legend wrapperStyle={{ fontSize: 'calc(12.5px * var(--fz))' }} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── 千張大戶：集保週資料，與日 K 不同尺度，故獨立畫且明說起算日 ── */}
      {subTab === 'holders' && (
        <div className={styles.subChart}>
          <div className={styles.chartTitle}>
            千張大戶持股比例（%）
            <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))', color: '#cbd5f5' }}>
              集保<b>週</b>資料 · 每週一次
              {chip?.holdersFrom ? ` · 本站自 ${chip.holdersFrom} 起累積` : ''}
            </span>
          </div>
          {(chip?.holders?.length ?? 0) === 0 ? (
            <div style={{ padding: '18px 4px', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
              {chipLoading ? '載入中…' : '尚無此檔集保週歸檔資料'}
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={chip!.holders} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
                  <XAxis dataKey="week" tick={{ fill: '#b8c6e4', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis domain={['dataMin - 0.5', 'dataMax + 0.5']} tick={{ fill: '#b8c6e4', fontSize: 12 }} axisLine={false} tickLine={false} orientation="right" tickFormatter={v => `${(v as number).toFixed(1)}%`} />
                  <Line type="monotone" dataKey="ratio" name="千張大戶" stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: 'calc(12.5px * var(--fz))' }}
                    labelStyle={{ color: '#ffffff', fontWeight: 800, marginBottom: 2 }}
                    formatter={(v) => [`${(v as number).toFixed(2)}%`, '千張大戶']}
                  />
                </LineChart>
              </ResponsiveContainer>
              {(chip?.holders?.length ?? 0) < 8 && (
                <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#f59e0b', marginTop: 4 }}>
                  ⚠ 目前僅 {chip!.holders.length} 週，趨勢判讀需要更多週數才有意義（每週新增一點）。
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Volume */}
      {subTab === 'vol' && (
      <div className={styles.subChart}>
        <div className={styles.chartTitle}>
          成交量
          <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))', color: '#cbd5f5' }}>
            <span style={{ color: '#f03e3e' }}>▌</span>收紅　<span style={{ color: '#2f9e44' }}>▌</span>收綠
            {(() => {
              const last = chartData[chartData.length - 1];
              return last?.volume != null ? `　最新 ${Math.round((last.volume as number) / 1000).toLocaleString()} 張` : '';
            })()}
          </span>
        </div>
        <ResponsiveContainer width="100%" height={80}>
          <BarChart data={chartData} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis tick={{ fill: '#b8c6e4', fontSize: 12 }} axisLine={false} tickLine={false} orientation="right" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
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
            {/* ⚠原本這張圖沒有 Tooltip——滑上去完全沒反應，看不到當日張數。
                單位換算：資料是「股」，台股習慣看「張」＝股/1000。 */}
            <Tooltip
              cursor={{ fill: 'rgba(148,163,184,0.12)' }}
              contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: 'calc(12.5px * var(--fz))' }}
                labelStyle={{ color: '#ffffff', fontWeight: 800, marginBottom: 2 }}
              itemStyle={{ color: '#fbbf24', fontWeight: 700 }}   // 2026-09-29 使用者：「成交量：N 張」改黃色（原本深色底上看不清）
              labelFormatter={(l) => String(l)}
              formatter={(v) => [`${Math.round((v as number) / 1000).toLocaleString()} 張`, '成交量']}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      )}

      {/* MACD */}
      {showMACD && (
        <div className={styles.subChart}>
          <div className={styles.chartTitle}>
            MACD (12, 26, 9)
            {(() => {
              const last = chartData[chartData.length - 1];
              const f = (x: unknown) => (typeof x === 'number' ? x.toFixed(2) : '—');
              return (
                <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))' }}>
                  <span style={{ color: '#3d8ef8' }}>— DIF {f(last?.macd)}</span>
                  <span style={{ color: '#f59e0b', marginLeft: 8 }}>— 訊號線 {f(last?.macdSignal)}</span>
                  <span style={{ color: '#cbd5f5', marginLeft: 8 }}>▌柱 {f(last?.macdHist)}（紅=正·綠=負）</span>
                </span>
              );
            })()}
          </div>
          <ResponsiveContainer width="100%" height={100}>
            <ComposedChart data={chartData} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
              <XAxis dataKey="date" hide />
              <YAxis tick={{ fill: '#b8c6e4', fontSize: 12 }} axisLine={false} tickLine={false} orientation="right" tickFormatter={v => v.toFixed(2)} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" />
              <Bar
                dataKey="macdHist"
                isAnimationActive={false}
                name="柱 (DIF−訊號)"
                // fill 只供 Tooltip 字色用（柱子本身由 shape 畫紅/綠）；未設時 recharts 預設 #000，深色提示框上看不見（2026-09-29 使用者）
                fill="#fbbf24"
                shape={(p: { x?: number; y?: number; width?: number; height?: number; payload?: ChartData }) => {
                  const { x = 0, y = 0, width = 0, height = 0, payload } = p;
                  const hist = payload?.macdHist ?? 0;
                  const color = hist >= 0 ? '#f03e3e' : '#2f9e44';
                  return <rect x={x} y={y} width={Math.max(width, 1)} height={Math.max(Math.abs(height), 1)} fill={color} fillOpacity={0.6} />;
                }}
              />
              <Line type="monotone" dataKey="macd" dot={false} stroke="#3d8ef8" strokeWidth={1.5} name="DIF" connectNulls />
              <Line type="monotone" dataKey="macdSignal" dot={false} stroke="#f59e0b" strokeWidth={1.5} name="訊號線" connectNulls />
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: 'calc(12.5px * var(--fz))' }}
                labelStyle={{ color: '#ffffff', fontWeight: 800, marginBottom: 2 }}
                formatter={(v, nm) => [(v as number)?.toFixed(2) ?? '--', String(nm)]}
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
              <YAxis domain={[0, 100]} tick={{ fill: '#b8c6e4', fontSize: 12 }} axisLine={false} tickLine={false} orientation="right" />
              <ReferenceLine y={90} stroke="rgba(239,68,68,0.35)" strokeDasharray="4 4" />
              <ReferenceLine y={50} stroke="rgba(255,255,255,0.08)" />
              <ReferenceLine y={10} stroke="rgba(251,191,36,0.35)" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="rsi5" dot={false} stroke="#fbbf24" strokeWidth={1.5} name="RSI5" connectNulls />
              <Line type="monotone" dataKey="rsi10" dot={false} stroke="#fb923c" strokeWidth={1.5} name="RSI10" connectNulls />
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: 'calc(12.5px * var(--fz))' }}
                labelStyle={{ color: '#ffffff', fontWeight: 800, marginBottom: 2 }}
                formatter={(v, nm) => [(v as number)?.toFixed(2) ?? '--', String(nm)]}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* KD */}
      {showKD && (
        <div className={styles.subChart}>
          <div className={styles.chartTitle}>
            KD (9, 3, 3)
            {(() => {
              const last = chartData[chartData.length - 1];
              const f = (x: unknown) => (typeof x === 'number' ? x.toFixed(1) : '—');
              return (
                <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))' }}>
                  <span style={{ color: '#22c55e' }}>— K {f(last?.k)}</span>
                  <span style={{ color: '#f97316', marginLeft: 8 }}>— D {f(last?.d)}</span>
                  {showJ && <span style={{ color: '#e879f9', marginLeft: 8 }}>— J {f(last?.j)}</span>}
                </span>
              );
            })()}
          </div>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={chartData} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
              <XAxis dataKey="date" hide />
              {/* 開了 J 就不能鎖 0~100——J=3K−2D 會衝出區間，鎖死會被截斷成一條直線 */}
              <YAxis domain={showJ ? ['auto', 'auto'] : [0, 100]} tick={{ fill: '#b8c6e4', fontSize: 12 }} axisLine={false} tickLine={false} orientation="right" />
              <ReferenceLine y={80} stroke="rgba(239,68,68,0.2)" strokeDasharray="4 4" />
              <ReferenceLine y={20} stroke="rgba(34,197,94,0.2)" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="k" dot={false} stroke="#22c55e" strokeWidth={1.5} name="K值" connectNulls />
              <Line type="monotone" dataKey="d" dot={false} stroke="#f97316" strokeWidth={1.5} name="D值" connectNulls />
              {showJ && <Line type="monotone" dataKey="j" dot={false} stroke="#e879f9" strokeWidth={1.2} name="J值" connectNulls />}
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: 'calc(12.5px * var(--fz))' }}
                labelStyle={{ color: '#ffffff', fontWeight: 800, marginBottom: 2 }}
                formatter={(v, nm) => [(v as number)?.toFixed(2) ?? '--', String(nm)]}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
