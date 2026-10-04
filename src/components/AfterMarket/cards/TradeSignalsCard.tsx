'use client';

import { Card, StockLink, amStyles, sg, tone, useApi, useNameOf } from '../shared';

// /api/ai/trade-signals（tradeSignals/latest）：成交值 >0.5 億者，當沖＝振幅≥3%；隔日沖＝漲 1.5–8.5% 且收盤位置≥0.8（已剔除漲停）。
interface SigRow { code: string; name?: string; close?: number | null; changePct?: number | null; amplitude?: number | null; closePos?: number | null; value?: number | null }
interface SigDoc { date?: string; dayTrade?: SigRow[]; overnight?: SigRow[]; observe?: boolean; observeWhy?: string }

const URL = '/api/ai/trade-signals';
const SHOW = 10;
const yi = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : (v / 1e8).toFixed(1));

function SigTable({ rows, nameOf }: { rows: SigRow[]; nameOf: (c: string) => string }) {
  if (rows.length === 0) return <p className={amStyles.note}>當日無符合者。</p>;
  return (
    <table className={amStyles.tbl}>
      <thead><tr><th>個股</th><th>收盤</th><th>漲跌%</th><th>振幅%</th><th>收盤位置</th><th>成交值(億)</th></tr></thead>
      <tbody>
        {rows.slice(0, SHOW).map(r => (
          <tr key={r.code}>
            <td><StockLink code={r.code} name={r.name ?? nameOf(r.code)} /></td>
            <td>{r.close ?? '—'}</td>
            <td className={tone(r.changePct)}>{sg(r.changePct)}</td>
            <td>{r.amplitude ?? '—'}</td>
            <td>{r.closePos ?? '—'}</td>
            <td>{yi(r.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function TradeSignalsCard() {
  const { data, state } = useApi<SigDoc>(URL);
  const nameOf = useNameOf();
  return (
    <Card title="當沖／隔日沖候選" tier="站內既有榜單，非本頁預測" state={state} dataDate={data?.date}
      note="收盤位置＝(收盤−最低)/(最高−最低)，1 表示收在最高。兩榜皆為條件篩出的當日描述，各顯示前 10 檔；非投資建議。">
      {data?.observe && data.observeWhy && <p className={amStyles.note}>站內標註（原文）：{data.observeWhy}</p>}
      <h4>隔日沖候選（漲 1.5–8.5%、收盤位置 ≥0.8，已剔除漲停）</h4>
      <SigTable rows={data?.overnight ?? []} nameOf={nameOf} />
      <h4>當沖（日內振幅 ≥3%）</h4>
      <SigTable rows={data?.dayTrade ?? []} nameOf={nameOf} />
    </Card>
  );
}
