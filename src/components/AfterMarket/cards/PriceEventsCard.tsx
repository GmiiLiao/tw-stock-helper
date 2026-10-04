'use client';

import { Card, StockLink, amStyles, tone, useApi, useNameOf } from '../shared';

// /api/ai/price-events（priceEvents/latest）：近 90 日窗內「相鄰有收盤日比值超出 ±20%」的價格結構事件
// （減資／面額變更／分割／大額除權或資料錯誤）。只記錄；0 件是合法狀態。
interface PriceEvt { date: string; code: string; name?: string; prev?: number | null; close?: number | null; ratio?: number | null; kind?: string; ref?: number | null }
interface PriceEvtDoc { dataDate?: string; n?: number; items?: PriceEvt[]; window?: { from?: string; to?: string; days?: number } }

const URL = '/api/ai/price-events';
const SHOW = 10;

export default function PriceEventsCard() {
  const { data, state } = useApi<PriceEvtDoc>(URL);
  const nameOf = useNameOf();
  const items = data?.items ?? [];
  const w = data?.window;
  return (
    <Card title="價格結構事件（減資／分割等）" state={state} dataDate={data?.dataDate}
      note={`相鄰兩個有收盤日的價格比值超出 ±20% 者${w?.from ? `（視窗 ${w.from} ~ ${w.to ?? '—'}）` : ''}。比值＝事後收盤÷事前收盤；上市減資的「恢復買賣參考價」來自證交所，來源未提供者顯示「—」。僅為記錄，非投資建議。`}>
      {items.length === 0 ? <p className={amStyles.note}>近期無事件（視窗內沒有符合條件的價格結構變動）。</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>個股</th><th>日期</th><th>類型</th><th>前收→收盤</th><th>比值</th><th>參考價</th></tr></thead>
          <tbody>
            {items.slice(0, SHOW).map(e => (
              <tr key={`${e.date}-${e.code}`}>
                <td><StockLink code={e.code} name={e.name ?? nameOf(e.code)} /></td>
                <td>{e.date.slice(5)}</td>
                <td>{e.kind ?? '—'}</td>
                <td>{e.prev ?? '—'} → {e.close ?? '—'}</td>
                <td className={tone(e.ratio != null ? e.ratio - 1 : null)}>{e.ratio ?? '—'}</td>
                <td>{e.ref ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {items.length > SHOW && <p className={amStyles.note}>共 {data?.n ?? items.length} 件，僅顯示最近 {SHOW} 件。</p>}
    </Card>
  );
}
