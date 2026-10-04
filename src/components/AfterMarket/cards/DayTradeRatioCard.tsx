'use client';

import { Card, StockLink, amStyles, useApi, useNameOf } from '../shared';

// 來源：dayTradeRatio/latest。ratio＝當沖成交量／當日總成交量（%）；daemon 只存 ratio≥40% 的前 50 檔。
interface DayTradeRatioDoc {
  date?: string; updatedAt?: number;
  count?: number;
  high?: Array<{ code: string; name?: string; ratio?: number }>;
}

const URL = '/api/ai/daytrade-ratio';
const SHOW = 15;

export default function DayTradeRatioCard() {
  const { data, state } = useApi<DayTradeRatioDoc>(URL);
  const nameOf = useNameOf();
  const high = data?.high ?? [];
  return (
    <Card title="高當沖比重警示" state={state} dataDate={data?.date}
      note="當沖比重＝當沖成交量佔該股當日總成交量；僅收錄 ≥40% 者。比重高代表當日短線換手集中，為事實統計。">
      <p className={amStyles.note}>
        統計 {data?.count == null ? '—' : data.count.toLocaleString()} 檔，其中 ≥40% 共 {high.length} 檔（來源最多保留 50 檔），下表列前 {Math.min(SHOW, high.length)} 檔。
      </p>
      {high.length > 0 && (
        <table className={amStyles.tbl}>
          <thead><tr><th>個股</th><th>當沖比重</th></tr></thead>
          <tbody>
            {high.slice(0, SHOW).map(r => (
              <tr key={r.code}>
                <td><StockLink code={r.code} name={r.name || nameOf(r.code)} /></td>
                <td>{r.ratio == null ? '—' : `${r.ratio.toFixed(1)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
