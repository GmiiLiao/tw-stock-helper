'use client';

// D1 快看抽屜的 1 分走勢（純 SVG，不另載圖表套件）：X 軸固定 09:00–13:30（還沒走完的時段留白），
// 昨收虛線、最新價圓點。顏色只用站上 token（紅漲綠跌灰平）。VWAP 線第一階段不畫（見 DrawerFeeds.ts 註解）。
import type { IntradayPoint } from './DrawerFeeds';
import { toneOf } from './parts/fmt';
import drawer from './QuickDrawer.module.css';

const W = 488;
const PAD_L = 4;
const PAD_R = 6;
const PAD_T = 8;
const PAD_B = 18;
const START_MIN = 9 * 60;
const SPAN_MIN = 270;   // 09:00–13:30
const TAIPEI_OFFSET_SEC = 8 * 3600;
const TIME_TICKS: ReadonlyArray<[number, string]> = [[0, '09:00'], [90, '10:30'], [180, '12:00'], [270, '13:30']];
const TONE_STROKE = { up: 'var(--color-up)', dn: 'var(--color-down)', flat: 'var(--color-flat)' } as const;

const minuteOf = (tSec: number) => (((tSec + TAIPEI_OFFSET_SEC) % 86_400) / 60) - START_MIN;

export interface DrawerChartProps {
  points: readonly IntradayPoint[];
  prevClose: number | null;
  height: number;
  /** 價格小數位數（依檔位） */
  digits: number;
}

export default function DrawerChart({ points, prevClose, height, digits }: DrawerChartProps) {
  if (points.length < 2) return null;
  const prices = points.map((p) => p.price);
  const refs = prevClose && prevClose > 0 ? [prevClose] : [];
  const lo0 = Math.min(...prices, ...refs);
  const hi0 = Math.max(...prices, ...refs);
  const pad = Math.max((hi0 - lo0) * 0.08, hi0 * 0.002);
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const plotW = W - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;
  const x = (tSec: number) => PAD_L + (Math.min(Math.max(minuteOf(tSec), 0), SPAN_MIN) / SPAN_MIN) * plotW;
  const y = (p: number) => PAD_T + (1 - (p - lo) / (hi - lo)) * plotH;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  const stroke = TONE_STROKE[toneOf(prevClose ? last.price - prevClose : 0)];
  const label = `1 分走勢：最新 ${last.price.toFixed(digits)}${prevClose ? `，昨收 ${prevClose.toFixed(digits)}` : ''}`;
  return (
    <svg className={drawer.chart} viewBox={`0 0 ${W} ${height}`} width="100%" height={height} role="img" aria-label={label}>
      {prevClose ? (
        <line x1={PAD_L} x2={W - PAD_R} y1={y(prevClose)} y2={y(prevClose)} className={drawer.prevLine} strokeDasharray="4 4" />
      ) : null}
      <path d={path} fill="none" style={{ stroke }} strokeWidth={2} strokeLinejoin="round" />
      <circle cx={x(last.t)} cy={y(last.price)} r={3.5} style={{ fill: stroke }} />
      <text x={W - PAD_R} y={PAD_T + 10} textAnchor="end" className={drawer.axisText}>{hi0.toFixed(digits)}</text>
      <text x={W - PAD_R} y={PAD_T + plotH} textAnchor="end" className={drawer.axisText}>{lo0.toFixed(digits)}</text>
      {TIME_TICKS.map(([m, t]) => (
        <text key={t} x={PAD_L + (m / SPAN_MIN) * plotW} y={height - 4}
          textAnchor={m === 0 ? 'start' : m === SPAN_MIN ? 'end' : 'middle'} className={drawer.axisText}>{t}</text>
      ))}
    </svg>
  );
}
