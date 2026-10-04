'use client';

import { Card, StockLink, amStyles, tone, useApi, useNameOf } from '../shared';

interface MarginRow {
  code: string; name?: string;
  marginBal: number; marginChg: number; // 融資餘額／較前日增減（張）
  shortBal: number; shortChg: number; // 融券餘額／較前日增減（張）
  shortRatio: number; // 券資比 %
}
interface MarginShort { date?: string; squeeze?: MarginRow[]; marginSurge?: MarginRow[] }

const URL = '/api/ai/margin-short';
const SHOW = 10;
const n = (x?: number | null) => (x == null || !Number.isFinite(x) ? '—' : x.toLocaleString());
const chg = (x?: number | null) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${x.toLocaleString()}`);

function MarginTable({ title, rows }: { title: string; rows?: MarginRow[] }) {
  const nameOf = useNameOf();
  const list = (rows ?? []).slice(0, SHOW);
  return (
    <>
      <h4>{title}</h4>
      {list.length === 0 ? <p className={amStyles.note}>來源未提供</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>個股</th><th>融資餘額（張）</th><th>融資增減（張）</th><th>融券餘額（張）</th><th>融券增減（張）</th><th>券資比（%）</th></tr></thead>
          <tbody>
            {list.map(r => (
              <tr key={r.code}>
                <td><StockLink code={r.code} name={r.name ?? nameOf(r.code)} /></td>
                <td>{n(r.marginBal)}</td>
                <td className={tone(r.marginChg)}>{chg(r.marginChg)}</td>
                <td>{n(r.shortBal)}</td>
                <td className={tone(r.shortChg)}>{chg(r.shortChg)}</td>
                <td>{r.shortRatio == null ? '—' : r.shortRatio.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export default function MarginShortCard() {
  const { data, state } = useApi<MarginShort>(URL);
  const note = '券資比＝融券餘額÷融資餘額。高券資比榜條件：券資比≥10% 且融券餘額>500 張；融資增加榜為融資較前日增加最多者。增減為較前一交易日。';
  return (
    <Card title="融資融券" state={state} dataDate={data?.date} note={note}>
      <MarginTable title="高券資比（依券資比排序）" rows={data?.squeeze} />
      <MarginTable title="融資增加最多" rows={data?.marginSurge} />
    </Card>
  );
}
