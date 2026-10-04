'use client';

import { Card, StockLink, amStyles, useApi } from '../shared';

// /api/ai/catalyst-calendar（catalystCalendar/latest）：daemon 每日彙整未來 35 天事件（≤300 筆，已依日期排序）。
interface CalEvent { date: string; type?: string; code?: string; name?: string; title?: string }
interface CalDoc { updatedAt?: number; from?: string; to?: string; events?: CalEvent[] }

const URL = '/api/ai/catalyst-calendar';
const HORIZON_DAYS = 14;
const SHOW = 15;
const DAY_MS = 86_400_000;
const TYPE_LABEL: Record<string, string> = {
  exdiv: '除權息', agm: '股東會', revenue: '月營收截止', earnings: '財報申報截止',
  macro: '總經', 'earnings-call': '法說會', recall: '停券起日',
};

/** 台北日曆今天（YYYY-MM-DD） */
const taipeiToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** 停券事件原文尾段帶評論語氣，只留事實前段 */
// 只留事實（去掉尾段預測語氣）；daemon 把「現金股利 0」的純除權也寫成「除權息（現金 0）」，顯示時改為「除權（現金股利 0）」
const factTitle = (e: CalEvent) => (e.title ?? '').split('—')[0].trim().replace('除權息（現金 0）', '除權（現金股利 0）') || '—';

export default function CatalystCalendarCard() {
  const { data, state } = useApi<CalDoc>(URL);
  const today = taipeiToday();
  const end = addDays(today, HORIZON_DAYS);
  const all = (data?.events ?? []).filter(e => e.date >= today && e.date <= end);
  const rows = all.slice(0, SHOW);
  return (
    <Card title="事件日曆（未來 14 天）" state={state} dataDate={data?.from}
      note={`依官方除權息預告、股東會、MOPS 法說會、停資停券預告與固定法定日期彙整；14 天內共 ${all.length} 筆，顯示最近 ${SHOW} 筆。日期為來源公告，可能變動。`}>
      {rows.length === 0 ? <p className={amStyles.note}>未來 14 天來源未列事件。</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>日期</th><th>類別</th><th>事件</th></tr></thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={`${e.date}-${e.type}-${e.code ?? i}-${i}`}>
                <td>{e.date.slice(5)}</td>
                <td>{TYPE_LABEL[e.type ?? ''] ?? e.type ?? '—'}</td>
                <td>{e.code ? <StockLink code={e.code} name={e.name} /> : factTitle(e)}{e.code ? ` ${factTitle(e).replace(e.name ?? '', '').trim()}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
