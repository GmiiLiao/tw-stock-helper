'use client';

import { Card, StockLink, amStyles, sg, tone, useApi } from '../shared';

interface EtfRow { code: string; name?: string; nav: number; price: number; premium: number }
interface EtfPremium {
  dataDate?: string; // YYYY-MM-DD
  date?: string; // 寫入日
  count?: number; // 有淨值與價格的 ETF 檔數
  premiumTop?: EtfRow[];
  discountTop?: EtfRow[];
}

const URL = '/api/ai/etf-premium';
const SHOW = 5;
const px = (x?: number | null) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(2));

function EtfTable({ title, rows }: { title: string; rows?: EtfRow[] }) {
  const list = (rows ?? []).slice(0, SHOW);
  return (
    <>
      <h4>{title}</h4>
      {list.length === 0 ? <p className={amStyles.note}>來源未提供</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>ETF</th><th>淨值（元）</th><th>市價（元）</th><th>折溢價（%）</th></tr></thead>
          <tbody>
            {list.map(r => (
              <tr key={r.code}>
                <td><StockLink code={r.code} name={r.name} /></td>
                <td>{px(r.nav)}</td>
                <td>{px(r.price)}</td>
                <td className={tone(r.premium)}>{sg(r.premium)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export default function EtfPremiumCard() {
  const { data, state } = useApi<EtfPremium>(URL);
  const note = `折溢價＝(市價－淨值)÷淨值，來源為證交所 MIS ETF 淨值快照${data?.count != null ? `，共 ${data.count} 檔有效` : ''}；僅為價差描述。`;
  return (
    <Card title="ETF 折溢價" state={state} dataDate={data?.dataDate ?? data?.date} note={note}>
      <EtfTable title="溢價最高" rows={data?.premiumTop} />
      <EtfTable title="折價最深" rows={data?.discountTop} />
    </Card>
  );
}
