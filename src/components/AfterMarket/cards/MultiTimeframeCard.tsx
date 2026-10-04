'use client';

import { Card, StockLink, amStyles, useApi, useNameOf } from '../shared';

// 來源：multiTimeframe/latest。resonant＝日／週／月均線同時多頭排列的個股（daemon 最多寫 30 筆），本卡顯示前 12 筆。
interface MultiTimeframeDoc {
  date?: string; updatedAt?: number;
  resonant?: Array<{ code: string; name?: string }>;
}

const URL = '/api/ai/multi-timeframe';
const SHOW = 12;

export default function MultiTimeframeCard() {
  const { data, state } = useApi<MultiTimeframeDoc>(URL);
  const nameOf = useNameOf();
  const list = data?.resonant ?? [];
  return (
    <Card title="多週期共振" state={state} dataDate={data?.date}
      note={`條件：日、週、月線均線皆呈多頭排列。共 ${list.length} 檔入列（系統上限 30），僅列前 ${SHOW} 檔；為技術面現況描述。`}>
      {list.length === 0 ? <p className={amStyles.note}>來源未提供共振個股。</p> : (
        <ul className={amStyles.list}>
          {list.slice(0, SHOW).map(r => (
            <li key={r.code}><StockLink code={r.code} name={r.name || nameOf(r.code)} /></li>
          ))}
        </ul>
      )}
    </Card>
  );
}
