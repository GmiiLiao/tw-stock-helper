'use client';

import { Card, StockLink, amStyles, sg, tone, useApi, useNameOf } from '../shared';

// 來源：marketReports/latest（report-store 的 MarketReport）。topPicks 只取前 10 檔，不顯示買點／目標／停損。
interface Pick { code: string; name?: string; score?: number; grade?: string; signal?: string; price?: number; changePercent?: number }
interface MarketReportDoc {
  date?: string; generatedAt?: number;
  breadth?: { up?: number; down?: number; flat?: number; total?: number; advancePct?: number };
  topPicks?: Pick[]; riskHighlights?: string[]; summary?: string;
  meta?: { totalAnalyzed?: number };
}

const URL = '/api/market-report';
const SHOW = 10;
const n = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString());

export default function MarketReportCard() {
  const { data, state } = useApi<MarketReportDoc>(URL);
  const nameOf = useNameOf();
  const b = data?.breadth;
  const picks = (data?.topPicks ?? []).slice(0, SHOW);
  return (
    <Card title="盤勢分析報告" state={state} dataDate={data?.date}>
      {data?.summary && <p style={{ margin: '4px 0 8px', lineHeight: 1.7 }}>{data.summary}</p>}
      <p className={amStyles.note}>
        漲 <span className={amStyles.up}>{n(b?.up)}</span>／跌 <span className={amStyles.dn}>{n(b?.down)}</span>／平 {n(b?.flat)}，
        共 {n(b?.total)} 檔，漲家數佔 {b?.advancePct == null ? '—' : `${b.advancePct}%`}。
      </p>
      {data?.riskHighlights && data.riskHighlights.length > 0 && (
        <ul className={amStyles.list}>{data.riskHighlights.map(t => <li key={t}>{t}</li>)}</ul>
      )}
      {picks.length > 0 && (
        <>
          <h4>站內既有盤後推薦（前 {picks.length} 檔）</h4>
          <p className={amStyles.note}>非本頁預測，為站內盤後報告既有輸出。</p>
          <table className={amStyles.tbl}>
            <thead><tr><th>個股</th><th>收盤</th><th>漲跌%</th><th>評級</th></tr></thead>
            <tbody>
              {picks.map(p => (
                <tr key={p.code}>
                  <td><StockLink code={p.code} name={p.name || nameOf(p.code)} /></td>
                  <td>{p.price == null ? '—' : p.price}</td>
                  <td className={tone(p.changePercent)}>{sg(p.changePercent)}%</td>
                  <td>{p.grade ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
