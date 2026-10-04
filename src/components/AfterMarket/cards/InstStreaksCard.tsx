'use client';

import { Card, StockLink, amStyles, tone, useApi, useNameOf } from '../shared';

interface StreakRow { code: string; name?: string; days: number; lots: number }
interface InstStreaks {
  latestDate?: string; // YYYYMMDD
  daysCovered?: number; // 本次掃描涵蓋的交易日數
  foreign?: StreakRow[];
  trust?: StreakRow[];
}

const URL = '/api/ai/institutional-streaks';
const SHOW = 10;
const fmtDate = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d ?? null);

function StreakTable({ title, rows }: { title: string; rows?: StreakRow[] }) {
  const nameOf = useNameOf();
  const list = (rows ?? []).slice(0, SHOW);
  return (
    <>
      <h4>{title}</h4>
      {list.length === 0 ? <p className={amStyles.note}>來源未提供</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>個股</th><th>連買天數</th><th>期間累計買超（張）</th></tr></thead>
          <tbody>
            {list.map(r => (
              <tr key={r.code}>
                <td><StockLink code={r.code} name={r.name ?? nameOf(r.code)} /></td>
                <td>{r.days ?? '—'}</td>
                <td className={tone(r.lots)}>{r.lots == null ? '—' : r.lots.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export default function InstStreaksCard() {
  const { data, state } = useApi<InstStreaks>(URL);
  const note = data?.daysCovered != null
    ? `僅統計最近 ${data.daysCovered} 個交易日內連續買超 3 日以上者；天數上限即為涵蓋日數。外資含外資自營商，單位為張。`
    : '外資含外資自營商，單位為張。';
  return (
    <Card title="外資／投信連續買超" state={state} dataDate={fmtDate(data?.latestDate)} note={note}>
      <StreakTable title="外資連續買超" rows={data?.foreign} />
      <StreakTable title="投信連續買超" rows={data?.trust} />
    </Card>
  );
}
