'use client';

import { Card, amStyles, sg, tone, useApi } from '../shared';

// /api/ai/sector-spot（sectorSpot/latest）：Yahoo 期貨連續合約（原油／布蘭特／天然氣／銅／鋁／金／銀）＋DRAMeXchange 公開 DRAM 現貨。
// 注意：文件的 date／dataDate 是 daemon 抓取日（可為休市日／週末），真正的報價所屬日在各 item.asOf。
interface SpotItem { key: string; name: string; unit?: string; price?: number | null; chgPct?: number | null; asOf?: string | null; source?: string; sectors?: string[] }
interface SpotDoc { items?: SpotItem[] }

const URL = '/api/ai/sector-spot';
const SRC_LABEL: Record<string, string> = { yahoo: 'Yahoo 期貨', dramexchange: 'DRAMeXchange' };

export default function SectorSpotCard() {
  const { data, state } = useApi<SpotDoc>(URL);
  const items = data?.items ?? [];
  const dates = items.map(i => i.asOf).filter((d): d is string => !!d).sort();
  const latest = dates.length ? dates[dates.length - 1] : null;
  return (
    <Card title="原物料／DRAM 現貨報價" state={state} dataDate={latest}
      note="資料日取各項報價所屬日的最新者；各列「報價日」若不同代表來源更新時點不同。漲跌為來源相對前一報價日。免費來源、只存檔不評分，非投資建議。">
      {items.length === 0 ? <p className={amStyles.note}>來源未提供報價。</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>品項</th><th>報價</th><th>漲跌%</th><th>報價日</th><th>來源</th></tr></thead>
          <tbody>
            {items.map(i => (
              <tr key={i.key}>
                <td>{i.name}</td>
                <td>{i.price ?? '—'} {i.unit ?? ''}</td>
                <td className={tone(i.chgPct)}>{sg(i.chgPct)}</td>
                <td>{i.asOf?.slice(5) ?? '—'}</td>
                <td>{SRC_LABEL[i.source ?? ''] ?? i.source ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
