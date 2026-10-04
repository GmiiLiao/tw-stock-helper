'use client';

import { Card, StockLink, amStyles, sg, tone, useApi, useNameOf } from '../shared';

// /api/ai/rs-ranking（rsRanking/latest）：成交值前 300 大中有 ≥65 根日K者，60 日報酬百分位 → RS(1–99)，取前 30。
interface RsRow { code: string; name?: string; ret60?: number | null; rs?: number | null }
interface RsDoc { date?: string; universe?: number; top?: RsRow[] }

const URL = '/api/ai/rs-ranking';
const SHOW = 10;

export default function RsRankingCard() {
  const { data, state } = useApi<RsDoc>(URL);
  const nameOf = useNameOf();
  const rows = (data?.top ?? []).slice(0, SHOW);
  return (
    <Card title="相對強度排行（60 日）" tier="站內既有榜單，非本頁預測" state={state} dataDate={data?.date}
      note={`RS＝60 日報酬在宇宙內的百分位（1–99）；宇宙為成交值前 300 大中歷史足夠者${data?.universe != null ? `，本次 ${data.universe} 檔` : ''}，僅顯示前 ${SHOW} 名。為既有榜單，非投資建議。`}>
      {rows.length === 0 ? <p className={amStyles.note}>來源未提供排行資料。</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>個股</th><th>RS</th><th>60 日報酬%</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.code}>
                <td><StockLink code={r.code} name={r.name ?? nameOf(r.code)} /></td>
                <td>{r.rs ?? '—'}</td>
                <td className={tone(r.ret60)}>{sg(r.ret60, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
