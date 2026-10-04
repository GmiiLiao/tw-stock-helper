'use client';

import { Card, StockLink, amStyles, sg, tone, useApi, useNameOf } from '../shared';

// /api/ai/scanner（scanner/latest）：daemon 盤後以成交值前 400 大為宇宙的技術面掃描，各清單依漲幅取前 15。
interface Hit { code: string; name?: string; close?: number | null; changePct?: number | null; volX?: number | null }
interface ScannerDoc {
  date?: string;
  newHigh52?: Hit[]; volBreakout?: Hit[]; maBull?: Hit[]; goldenCross?: Hit[]; gapUp?: Hit[]; strong?: Hit[];
}

const URL = '/api/ai/scanner';
const SHOW = 5;
const LISTS: [keyof Omit<ScannerDoc, 'date'>, string][] = [
  ['newHigh52', '52 週新高'],
  ['volBreakout', '爆量上漲（量≥20 日均量 2 倍且漲逾 3%）'],
  ['maBull', '均線多頭排列（5>10>20>60）'],
  ['goldenCross', '5 日線上穿 20 日線'],
  ['gapUp', '跳空上漲'],
  ['strong', '漲幅 ≥9%'],
];

export default function ScannerCard() {
  const { data, state } = useApi<ScannerDoc>(URL);
  const nameOf = useNameOf();
  return (
    <Card title="選股掃描" tier="站內既有榜單，非本頁預測" state={state} dataDate={data?.date}
      note="成交值前 400 大為宇宙，各清單依當日漲幅排序、每清單最多取 15 檔、此處顯示前 5。僅為條件篩出的描述，非投資建議。">
      {LISTS.map(([key, label]) => {
        const rows = data?.[key] ?? [];
        return (
          <div key={key}>
            <h4>{label}（{rows.length} 檔）</h4>
            {rows.length === 0 ? <p className={amStyles.note}>當日無符合者。</p> : (
              <table className={amStyles.tbl}>
                <thead><tr><th>個股</th><th>收盤</th><th>漲跌%</th>{key === 'volBreakout' && <th>量比</th>}</tr></thead>
                <tbody>
                  {rows.slice(0, SHOW).map(r => (
                    <tr key={r.code}>
                      <td><StockLink code={r.code} name={r.name ?? nameOf(r.code)} /></td>
                      <td>{r.close ?? '—'}</td>
                      <td className={tone(r.changePct)}>{sg(r.changePct)}</td>
                      {key === 'volBreakout' && <td>{r.volX != null ? `${r.volX}x` : '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </Card>
  );
}
