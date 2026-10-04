'use client';

import { Card, amStyles, tone, useApi } from '../shared';

// 來源：marketHealth/latest（daemon computeMarketHealth）。欄位如實顯示，缺值顯示「—」。
interface MarketHealthDoc {
  dataDate?: string; date?: string; updatedAt?: number;
  health?: number; mood?: string;
  up?: number; down?: number; flat?: number;
  limitUp?: number; limitDown?: number; upRatio?: number; newHigh?: number;
}

const URL = '/api/ai/market-health';
const n = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '—' : x.toLocaleString());

export default function MarketHealthCard() {
  const { data, state } = useApi<MarketHealthDoc>(URL);
  const d = data;
  const rows: Array<[string, string, string]> = d ? [
    ['上漲家數', n(d.up), tone(d.up ? 1 : 0)],
    ['下跌家數', n(d.down), tone(d.down ? -1 : 0)],
    ['持平家數', n(d.flat), ''],
    ['漲停（≥9.5%）', n(d.limitUp), tone(d.limitUp ? 1 : 0)],
    ['跌停（≤-9.5%）', n(d.limitDown), tone(d.limitDown ? -1 : 0)],
    ['上漲佔比', d.upRatio == null ? '—' : `${d.upRatio}%`, ''],
    ['52 週新高家數', n(d.newHigh), ''],
  ] : [];
  return (
    <Card title="大盤健康度" state={state} dataDate={d?.dataDate ?? d?.date}
      note="依全市場快照統計；健康度分數與氛圍標籤為系統既有欄位，僅描述當日廣度，非預測。">
      <p style={{ margin: '4px 0 8px' }}>
        <strong style={{ fontSize: '1.4em' }}>{n(d?.health)}</strong>
        <span className={amStyles.note}> ／100　{d?.mood ?? '—'}</span>
      </p>
      <table className={amStyles.tbl}>
        <tbody>
          {rows.map(([k, v, t]) => (
            <tr key={k}><td>{k}</td><td className={t}>{v}</td></tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
