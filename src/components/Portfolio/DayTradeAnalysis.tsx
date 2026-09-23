'use client';

import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useAppStore } from '@/lib/store';
import { buildDayTradeReport, dayTradeBreakEvenPct } from '@/lib/daytrade-calc';
import { useBrokerSettings } from '@/lib/useBrokerSettings';
import { fmtQty } from '@/lib/tw-fee';

// ── ⚡ 當沖損益分析（2026-09-16）──
// 口徑見 src/lib/daytrade-calc.ts：同日同碼買賣配對、成本＝當日買進均價、費稅取紀錄實際值按比例分攤。
// 與上方「已實現損益」不是同一套：那邊是加權平均成本的帳本，這邊是「這一趟」的損益。
// 兩者本來就不會相等，所以卡片標題與口徑說明都要把差別講清楚，不要讓使用者拿兩個數字互相對帳。

const RED = '#f03e3e', GREEN = '#2f9e44', MUTED = 'var(--text-muted)';
const mono = "'JetBrains Mono', monospace";
const money = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('zh-TW')}`;
const card: React.CSSProperties = { padding: '16px', borderRadius: '12px', background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' };

export default function DayTradeAnalysis() {
  const tradeRecords = useAppStore(s => s.tradeRecords);
  const [broker] = useBrokerSettings();
  const report = useMemo(() => buildDayTradeReport(tradeRecords), [tradeRecords]);
  const [showAll, setShowAll] = useState(false);
  const breakEven = dayTradeBreakEvenPct(broker.discount, true);

  // 沒有任何當沖配對也沒有警示 → 只留一行提示，不佔版面
  if (report.count === 0 && report.warnings.length === 0) {
    return (
      <div style={{ ...card, color: MUTED, fontSize: 'calc(12.5px * var(--fz))' }}>
        ⚡ 當沖損益分析：尚無「同一天同一檔既買又賣」的交易紀錄。記錄當沖時請在賣出勾選「現股當沖」，稅會按 0.15% 計。
        目前設定下，當沖一趟至少要漲 <strong style={{ color: 'var(--text-primary)' }}>{breakEven}%</strong> 才損益兩平（手續費雙邊 {(0.1425 * (broker.discount || 1) * 2).toFixed(3)}% ＋ 當沖稅 0.15%）。
      </div>
    );
  }

  const rows = showAll ? report.rows : report.rows.slice(0, 12);
  const netColor = report.totalNet >= 0 ? RED : GREEN;
  const tiles: Array<{ label: string; value: string; color?: string; sub?: string }> = [
    { label: '當沖淨損益', value: `${money(report.totalNet)} 元`, color: netColor, sub: `${report.count} 趟｜毛 ${money(report.totalGross)}·費稅 −${(report.totalFee + report.totalTax).toLocaleString()}` },
    { label: '勝率', value: `${report.winRate.toFixed(1)}%`, color: report.winRate >= 50 ? RED : GREEN, sub: `${report.winCount} 勝 / ${report.lossCount} 負` },
    { label: '每趟期望值', value: `${money(report.avgNet)} 元`, color: report.avgNet >= 0 ? RED : GREEN, sub: '淨損益 ÷ 趟數' },
    { label: '盈虧比', value: report.avgLoss !== 0 ? Math.abs(report.avgWin / report.avgLoss).toFixed(2) : '∞', sub: `平均獲利 ${money(report.avgWin)}·平均虧損 ${money(report.avgLoss)}` },
    { label: '獲利因子', value: report.profitFactor == null ? '∞' : report.profitFactor.toFixed(2), color: (report.profitFactor ?? 9) >= 1 ? RED : GREEN, sub: '總獲利 ÷ 總虧損；<1 表示整體在賠' },
    { label: '費稅占成交比', value: `${report.costRatio.toFixed(3)}%`, sub: `兩平門檻 ${breakEven}%（現行折讓）｜費 ${report.totalFee.toLocaleString()}·稅 ${report.totalTax.toLocaleString()}` },
    { label: '最長連虧', value: `${report.maxLossStreak} 趟`, color: report.maxLossStreak >= 3 ? '#f59e0b' : undefined, sub: '連續虧損趟數（舊→新）' },
    { label: '最佳 / 最差一趟', value: report.best ? `${money(report.best.net)} / ${money(report.worst?.net ?? 0)}` : '—', sub: report.best ? `${report.best.code} ${report.best.date}｜${report.worst?.code} ${report.worst?.date}` : undefined },
  ];

  return (
    <div style={card}>
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: MUTED, marginBottom: 6 }}>⚡ 當沖損益分析（同日同碼買賣配對·費稅取紀錄實際值）</div>
      <div style={{ fontSize: 'calc(12px * var(--fz))', color: MUTED, marginBottom: 12, lineHeight: 1.5 }}>
        📐 成本用<strong>當天的買進均價</strong>，不是帳本的加權平均——同一檔若另有舊持股，這裡算的是「那一趟」而非稀釋後的數字，
        故與上方「已實現損益」不會相等。只配對當日買賣重疊的張數，多買的留倉、多賣的視為出脫舊持股。
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(180px, 100%), 1fr))', gap: 10, marginBottom: 14 }}>
        {tiles.map((t, i) => (
          <div key={i} style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-tertiary)' }}>
            <div style={{ fontSize: 'calc(12px * var(--fz))', color: MUTED, marginBottom: 4 }}>{t.label}</div>
            <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, fontFamily: mono, color: t.color || 'var(--text-primary)', whiteSpace: 'nowrap' }}>{t.value}</div>
            {t.sub && <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: MUTED, marginTop: 3, lineHeight: 1.4 }}>{t.sub}</div>}
          </div>
        ))}
      </div>

      {report.warnings.length > 0 && (
        <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.35)', marginBottom: 12, fontSize: 'calc(12px * var(--fz))', color: '#f59e0b' }}>
          {report.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}

      {report.monthly.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 'calc(12px * var(--fz))', color: MUTED, marginBottom: 6 }}>📊 月度當沖淨損益</div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={report.monthly.slice(-12)}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: MUTED }} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis tick={{ fontSize: 12, fill: MUTED }} tickFormatter={(v: number) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(0)}萬` : v.toLocaleString())} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: 8, fontSize: 'calc(12px * var(--fz))' }}
                labelStyle={{ color: '#ffffff', fontWeight: 800 }}
                itemStyle={{ color: '#e2e8f7' }}                       // 預設會沿用長條色，深底上是黑字（2026-09-16 使用者回報）
                cursor={{ fill: 'rgba(255,255,255,0.06)' }}             // 預設 hover 底色是淺灰塊，深底上刺眼
                formatter={(v: any, _n: any, p: any) => [`${money(Number(v))} 元（${p?.payload?.count ?? 0} 趟）`, '當沖淨損益']}
              />
              <Bar dataKey="net" radius={[4, 4, 0, 0]}>
                {report.monthly.slice(-12).map((m, i) => <Cell key={i} fill={m.net >= 0 ? RED : GREEN} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {report.byCode.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 'calc(12px * var(--fz))', color: MUTED, marginBottom: 6 }}>🏆 個股當沖排行</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {report.byCode.slice(0, 10).map(c => (
              <span key={c.code} style={{ padding: '4px 8px', borderRadius: 8, background: 'var(--bg-tertiary)', fontSize: 'calc(12px * var(--fz))', whiteSpace: 'nowrap' }}>
                <strong>{c.code}</strong> <span style={{ color: MUTED }}>{c.name}</span>
                <span style={{ fontFamily: mono, fontWeight: 700, color: c.net >= 0 ? RED : GREEN, marginLeft: 6 }}>{money(c.net)}</span>
                <span style={{ color: MUTED, marginLeft: 4 }}>{c.count} 趟·勝 {c.winRate.toFixed(0)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {report.rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(12.5px * var(--fz))', minWidth: 620 }}>
            <thead>
              <tr style={{ color: MUTED, textAlign: 'right' }}>
                <th style={{ textAlign: 'left', padding: '4px' }}>日期</th>
                <th style={{ textAlign: 'left', padding: '4px' }}>標的</th>
                <th style={{ padding: '4px' }}>配對</th>
                <th style={{ padding: '4px' }}>買均</th>
                <th style={{ padding: '4px' }}>賣均</th>
                <th style={{ padding: '4px' }}>毛利</th>
                <th style={{ padding: '4px' }}>費稅</th>
                <th style={{ padding: '4px' }}>淨損益</th>
                <th style={{ padding: '4px' }}>報酬率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} style={{ borderTop: '1px solid var(--border-primary)', textAlign: 'right' }}>
                  <td style={{ textAlign: 'left', padding: '4px', whiteSpace: 'nowrap' }}>{r.date}</td>
                  <td style={{ textAlign: 'left', padding: '4px', whiteSpace: 'nowrap' }}>
                    <strong>{r.code}</strong> <span style={{ color: MUTED }}>{r.name}</span>
                    {r.unflaggedTax && <span title="賣出紀錄未勾「現股當沖」，稅按 0.3% 記錄；若實際是當沖請到交易紀錄修正該筆" style={{ color: '#f59e0b', marginLeft: 4 }}>稅0.3%</span>}
                    {(r.buyLots !== r.lots || r.sellLots !== r.lots) && <span title={`當日買 ${fmtQty(r.buyLots, r.unit)}／賣 ${fmtQty(r.sellLots, r.unit)}，只配對重疊部分`} style={{ color: MUTED, marginLeft: 4 }}>部分</span>}
                  </td>
                  <td style={{ padding: '4px', whiteSpace: 'nowrap' }}>{fmtQty(r.lots, r.unit)}</td>
                  <td style={{ padding: '4px', fontFamily: mono }}>{r.buyAvg.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</td>
                  <td style={{ padding: '4px', fontFamily: mono }}>{r.sellAvg.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</td>
                  <td style={{ padding: '4px', fontFamily: mono, color: r.gross >= 0 ? RED : GREEN }}>{money(r.gross)}</td>
                  <td style={{ padding: '4px', fontFamily: mono, color: MUTED }}>−{(r.fee + r.tax).toLocaleString()}</td>
                  <td style={{ padding: '4px', fontFamily: mono, fontWeight: 700, color: r.net >= 0 ? RED : GREEN }}>{money(r.net)}</td>
                  <td style={{ padding: '4px', fontFamily: mono, color: r.net >= 0 ? RED : GREEN }}>{r.roi >= 0 ? '+' : ''}{r.roi}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.rows.length > 12 && (
            <button onClick={() => setShowAll(v => !v)} style={{ marginTop: 8, background: 'none', border: '1px solid var(--border-primary)', borderRadius: 8, padding: '4px 10px', color: MUTED, cursor: 'pointer', fontSize: 'calc(12px * var(--fz))' }}>
              {showAll ? '收合' : `展開全部 ${report.rows.length} 趟`}
            </button>
          )}
        </div>
      )}
      <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: MUTED, marginTop: 10 }}>非投資建議。當沖證交稅減半（0.15%）依現行政策，以主管機關公告為準。</div>
    </div>
  );
}
