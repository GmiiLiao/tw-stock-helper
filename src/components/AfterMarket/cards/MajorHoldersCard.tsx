'use client';

import { Card, StockLink, amStyles, sg, tone, useApi, useNameOf } from '../shared';

interface HolderTop { code: string; ratio: number } // ratio：千張以上大戶占集保庫存 %
interface HolderRising extends HolderTop { change: number } // change：較上週增加的百分點
interface MajorHolders {
  date?: string; // YYYYMMDD（集保週資料日）
  weekDate?: string;
  lastWeekDate?: string | null;
  top?: HolderTop[];
  rising?: HolderRising[];
}

const URL = '/api/ai/major-holders';
const SHOW = 10;
const fmtDate = (d?: string | null) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d ?? null);
const pct = (x?: number | null) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(2));

export default function MajorHoldersCard() {
  const { data, state } = useApi<MajorHolders>(URL);
  const nameOf = useNameOf();
  const top = (data?.top ?? []).slice(0, SHOW);
  const rising = (data?.rising ?? []).slice(0, SHOW);
  const last = fmtDate(data?.lastWeekDate);
  return (
    <Card
      title="千張大戶持股"
      state={state}
      dataDate={fmtDate(data?.date ?? data?.weekDate)}
      note="來源為集保結算所週資料（週頻），大戶＝持股 1,000 張以上級距，比例為占集保庫存百分比；週增榜僅列較上週增加逾 0.3 個百分點者。"
    >
      <h4>大戶持股比例最高</h4>
      {top.length === 0 ? <p className={amStyles.note}>來源未提供</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>個股</th><th>大戶持股（%）</th></tr></thead>
          <tbody>
            {top.map(r => (
              <tr key={r.code}><td><StockLink code={r.code} name={nameOf(r.code)} /></td><td>{pct(r.ratio)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>大戶持股週增最多{last ? `（對照 ${last}）` : ''}</h4>
      {rising.length === 0 ? <p className={amStyles.note}>來源未提供</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>個股</th><th>大戶持股（%）</th><th>週增（百分點）</th></tr></thead>
          <tbody>
            {rising.map(r => (
              <tr key={r.code}>
                <td><StockLink code={r.code} name={nameOf(r.code)} /></td>
                <td>{pct(r.ratio)}</td>
                <td className={tone(r.change)}>{sg(r.change)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
