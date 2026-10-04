'use client';

import { Card, StockLink, amStyles, useApi, useNameOf } from '../shared';

interface LendingRow { code: string; avail: number } // avail：可借券賣出股數（股）
interface Lending { date?: string; top?: LendingRow[] }

const URL = '/api/ai/lending';
const SHOW = 10;
const sharesToLots = (x?: number | null) => (x == null || !Number.isFinite(x) ? '—' : Math.round(x / 1000).toLocaleString());

export default function LendingCard() {
  const { data, state } = useApi<Lending>(URL);
  const nameOf = useNameOf();
  const list = (data?.top ?? []).slice(0, SHOW);
  return (
    <Card
      title="借券可賣量"
      state={state}
      dataDate={data?.date}
      note="來源為證交所「當日可借券賣出股數」，依可借量由大到小排序（上市＋上櫃）；可借量為借券額度描述，非實際賣出量。換算張＝股數÷1000。"
    >
      {list.length === 0 ? <p className={amStyles.note}>來源未提供</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>個股</th><th>可借券賣出（股）</th><th>約合（張）</th></tr></thead>
          <tbody>
            {list.map(r => (
              <tr key={r.code}>
                <td><StockLink code={r.code} name={nameOf(r.code)} /></td>
                <td>{r.avail == null ? '—' : r.avail.toLocaleString()}</td>
                <td>{sharesToLots(r.avail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
