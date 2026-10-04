'use client';

import { Card, amStyles, tone, useApi } from '../shared';

// 來源：taifexPositions/latest（daemon trackTaifex，解析期交所網頁，屬 best-effort）。
// 實際只有兩個欄位：foreignTxfNetOI（外資台指期淨未平倉口數）、putCallRatio。date 為 YYYYMMDD。
interface TaifexDoc {
  date?: string; updatedAt?: number;
  foreignTxfNetOI?: number | null; putCallRatio?: number | null;
}

const URL = '/api/ai/taifex';
const isoOf = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);

export default function TaifexCard() {
  const { data, state } = useApi<TaifexDoc>(URL);
  const oi = data?.foreignTxfNetOI;
  const pc = data?.putCallRatio;
  return (
    <Card title="外資期貨／選擇權留倉" state={state} dataDate={isoOf(data?.date)}
      note="外資淨未平倉口數：正為淨多、負為淨空。P/C 取期交所 pcRatio 頁最後一欄＝「買賣權未平倉量比率」（賣權未平倉量÷買權未平倉量，2026-10-04 對照表頭確認；不是成交量比率）。數值由網頁解析而來，解析失敗時該欄位來源未提供。">
      <table className={amStyles.tbl}>
        <tbody>
          <tr><td>外資台指期淨未平倉（口）</td>
            <td className={tone(oi)}>{oi == null ? '來源未提供' : `${oi > 0 ? '+' : ''}${oi.toLocaleString()}`}</td></tr>
          <tr><td>選擇權 Put/Call 未平倉量比率（%）</td>
            <td>{pc == null ? '來源未提供' : pc.toFixed(2)}</td></tr>
        </tbody>
      </table>
    </Card>
  );
}
