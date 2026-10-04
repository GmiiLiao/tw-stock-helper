'use client';

import { Card, amStyles, sg, tone, useApi } from '../shared';

// /api/ai/picks-scoreboard（picksScoreboard/latest）：站內「AI 推薦」逐日對答案成績，口徑同 AIRecommend 的 ScoreTable。
// 主表用現行口徑 aggV2；超額＝同一批進場日的推薦均報 − 可交易宇宙等權均報（未扣成本）。
interface Cell {
  n: number; winRate: number; avgRet: number;
  base?: { n: number; winRate: number; avgRet: number } | null;
  excess?: number | null; entryDays?: number;
}
type Agg = Record<string, Record<string, Cell>>;
interface Board {
  agg?: Agg; aggV2?: Agg; calib?: string; calibFrom?: string; recordsV2?: number;
  recent?: { days?: { date: string; asOf: string }[] };
}

const URL = '/api/ai/picks-scoreboard';
const ROWS: [string, string][] = [
  ['top20', 'AI 精選 TOP20'], ['intraday', '盤中潛力'], ['daily', '動能強勢'], ['growth', '成長潛力'], ['defensive', '穩健防禦'],
];
const HORIZONS = [5, 10, 20];
const THIN_ENTRY_DAYS = 5;

export default function PicksScoreboardCard() {
  const { data, state } = useApi<Board>(URL);
  const cur = data?.aggV2 && Object.keys(data.aggV2).length ? data.aggV2 : null;
  const asOf = data?.recent?.days?.[0]?.asOf ?? null;
  return (
    <Card title="AI 推薦成績（對答案）" tier="站內既有榜單，非本頁預測" state={state} dataDate={asOf}
      note="每檔推薦於 5/10/20 個交易日後以官方收盤結算（未扣成本）。先看超額，不要只看勝率：絕對報酬主要由市況決定。基準＝4 碼普通股、量≥300 張、剔除進場日漲停的等權均報，取同一批進場日。⚠ 表示進場日不足 5 天，樣本互相重疊、尚非估計值。歷史績效不代表未來，非投資建議。">
      <p className={amStyles.note}>
        現行口徑（{data?.calib ?? 'v2'}）成績{data?.calibFrom ? `，自 ${data.calibFrom} 起共 ${data.recordsV2 ?? 0} 個交易日` : ''}；資料日取最近一個推薦日的結算日。
      </p>
      {!cur ? <p className={amStyles.note}>累積中：第 5 個交易日後出現第一筆，在那之前沒有經過驗證的成績。</p> : (
        <table className={amStyles.tbl}>
          <thead><tr><th>榜單</th>{HORIZONS.map(h => <th key={h}>{h} 日 超額pp｜勝率｜均報%｜基準均報%</th>)}</tr></thead>
          <tbody>
            {ROWS.map(([k, label]) => (
              <tr key={k}>
                <td>{label}</td>
                {HORIZONS.map(h => {
                  const c = cur[k]?.[`d${h}`];
                  if (!c || c.excess == null) return <td key={h}>—</td>;
                  return (
                    <td key={h}>
                      <b className={tone(c.excess)}>{sg(c.excess)}</b>
                      {(c.entryDays ?? 0) < THIN_ENTRY_DAYS && <span title={`只有 ${c.entryDays ?? 0} 個進場日`}>⚠</span>}
                      {' ｜'}{c.winRate}%｜<span className={tone(c.avgRet)}>{sg(c.avgRet)}</span>｜{c.base ? sg(c.base.avgRet) : '—'}
                      <span className={amStyles.note}> n={c.n}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
