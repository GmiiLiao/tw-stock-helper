'use client';

import { Card, StockLink, amStyles, useApi, useNameOf } from '../shared';

// /api/ai/dividend-calendar（dividendCalendar/latest）：TWSE TWT48U_ALL 除權息預告，date 為民國 YYYMMDD，最多 40 筆。
interface DivItem { code: string; name?: string; date?: string; type?: string; cash?: string; stockRatio?: string }
interface DivDoc { updatedAt?: number; upcoming?: DivItem[] }

const URL = '/api/ai/dividend-calendar';
const SHOW = 10;

/** 民國 1151006 → 2026-10-06；格式不符回 null */
function rocToIso(s?: string): string | null {
  const m = /^(\d{3})(\d{2})(\d{2})$/.exec(s ?? '');
  return m ? `${+m[1] + 1911}-${m[2]}-${m[3]}` : null;
}
/** 來源字串轉顯示：空字串＝來源未提供；數字去掉尾端 0 */
const num = (s?: string) => {
  if (s == null || s.trim() === '') return '—';
  const n = Number(s);
  return Number.isFinite(n) ? String(+n.toFixed(6)) : s;
};

export default function DividendCalendarCard() {
  const { data, state } = useApi<DivDoc>(URL);
  const nameOf = useNameOf();
  const rows = (data?.upcoming ?? []).slice(0, SHOW);
  const upd = data?.updatedAt ? new Date(data.updatedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }) : null;
  return (
    <Card title="除權息預告" state={state} dataDate={upd}
      note="資料來源為證交所上市除權息預告表（資料日為本站整理日）；權＝除權、息＝除息；現金股利單位元／股，股票股利為來源「比率」原值。來源空白顯示「—」（不補 0）。">
      {rows.length === 0 ? <p className={amStyles.note}>來源目前未列未來除權息。</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>個股</th><th>除權息日</th><th>類別</th><th>現金股利</th><th>股票股利比率</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={`${r.code}-${r.date}`}>
                <td><StockLink code={r.code} name={r.name ?? nameOf(r.code)} /></td>
                <td>{rocToIso(r.date)?.slice(5) ?? '—'}</td>
                <td>{r.type || '—'}</td>
                <td>{num(r.cash)}</td>
                <td>{num(r.stockRatio)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
