'use client';

import { useEffect, useState } from 'react';
import { startLiveLoop, isForeground, isTwTradingHours } from '@/lib/market-clock';
import { useAppStore } from '@/lib/store';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import { getChangeColor } from '@/lib/twse-api';

// ── 🧭 產業風向偵測：加權分 + 資金流向(加碼/減碼) ──────────────
// 讓看盤快速感知「錢往哪個族群跑」。加權分＝漲跌×家數廣度×籌碼傾向；
// delta＝與昨日比，正=資金流入(加碼)、負=流出(減碼)。

interface Leader { code: string; name: string; cp: number; netInst: number }
interface SectorW { industry: string; windScore: number; delta: number | null; avgChg: number; up: number; down: number; n: number; netInst: number; leaders: Leader[] }
interface WindData { updatedAt: number; date: string; marketOpen: boolean; sectors: SectorW[] }


export default function SectorWind({ compact = false }: { compact?: boolean }) {
  const dt = useDayTradeCodes();   // 當沖資格：必須在任何 early return 之前
  const navigateTo = useAppStore(s => s.navigateTo);
  const [data, setData] = useState<WindData | null>(null);
  const [openInd, setOpenInd] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/sector-wind').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x) setData(x); }).catch(() => {});
    load();   // 首次載入不設閘
    // 間隔每拍重算（G3-05）；daemon sectorLoop 休市仍每 30 分重算 ⇒ 只擋背景分頁、不擋休市
    const stop = startLiveLoop(() => { if (isForeground()) load(); }, () => (isTwTradingHours() ? 90000 : 600000));
    return () => { live = false; stop(); };
  }, []);

  if (!data?.sectors?.length) return null;
  const sectors = data.sectors;
  // 資金流向：delta 排序（加碼前段 / 減碼前段）
  const withDelta = sectors.filter(s => s.delta != null);
  const inflow = [...withDelta].sort((a, b) => (b.delta || 0) - (a.delta || 0)).filter(s => (s.delta || 0) > 0).slice(0, 4);
  const outflow = [...withDelta].sort((a, b) => (a.delta || 0) - (b.delta || 0)).filter(s => (s.delta || 0) < 0).slice(0, 4);

  const scoreColor = (v: number) => (v >= 62 ? '#f03e3e' : v >= 45 ? '#fbbf24' : '#2f9e44');
  const deltaTag = (d: number | null) => {
    if (d == null) return null;
    if (d >= 3) return <span style={{ color: '#f03e3e', fontWeight: 800 }}>加碼 ▲{d}</span>;
    if (d <= -3) return <span style={{ color: '#2f9e44', fontWeight: 800 }}>減碼 ▼{Math.abs(d)}</span>;
    return <span style={{ color: 'var(--text-muted)' }}>持平 {d >= 0 ? '+' : ''}{d}</span>;
  };

  return (
    <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(1rem * var(--fz))' }}>🧭 產業風向</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          加權分＝漲跌×家數×籌碼；資金流向＝與昨日比（加碼/減碼） · 官方 33 產業分類 · {data.marketOpen ? '盤中即時' : '收盤定案'}
        </span>
      </div>

      {/* 資金流向摘要（最快感知輪動） */}
      {(inflow.length > 0 || outflow.length > 0) && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ flex: '1 1 240px', padding: '7px 10px', borderRadius: 8, background: 'rgba(240,62,62,0.08)' }}>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: '#f03e3e', marginBottom: 3 }}>💰 資金流入（加碼）</div>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.6 }}>
              {inflow.length ? inflow.map(s => <span key={s.industry} style={{ marginRight: 10 }}>{s.industry} <b style={{ color: '#f03e3e' }}>▲{s.delta}</b></span>) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
            </div>
          </div>
          <div style={{ flex: '1 1 240px', padding: '7px 10px', borderRadius: 8, background: 'rgba(47,158,68,0.08)' }}>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: '#2f9e44', marginBottom: 3 }}>📉 資金流出（減碼）</div>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.6 }}>
              {outflow.length ? outflow.map(s => <span key={s.industry} style={{ marginRight: 10 }}>{s.industry} <b style={{ color: '#2f9e44' }}>▼{Math.abs(s.delta || 0)}</b></span>) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
            </div>
          </div>
        </div>
      )}

      {/* 產業加權分榜（點開看領漲個股） */}
      <div style={{ display: 'grid', gap: 3 }}>
        {(compact ? sectors.slice(0, 8) : sectors).map(s => {
          const open = openInd === s.industry;
          return (
            <div key={s.industry} style={{ borderRadius: 8, background: open ? 'rgba(61,142,248,0.08)' : 'transparent' }}>
              <div onClick={() => setOpenInd(o => (o === s.industry ? null : s.industry))}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 'calc(13px * var(--fz))', cursor: 'pointer', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', width: 12 }}>{open ? '▾' : '▸'}</span>
                <span style={{ fontWeight: 700, minWidth: 92 }}>{s.industry}</span>
                {/* 加權分條 */}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 64, height: 6, borderRadius: 3, background: 'rgba(148,163,184,0.15)', overflow: 'hidden', display: 'inline-block' }}>
                    <span style={{ display: 'block', height: '100%', width: `${s.windScore}%`, background: scoreColor(s.windScore) }} />
                  </span>
                  <b style={{ color: scoreColor(s.windScore), minWidth: 34 }}>{s.windScore}</b>
                </span>
                <span style={{ color: getChangeColor(s.avgChg), fontWeight: 700, minWidth: 54 }}>{s.avgChg > 0 ? '+' : ''}{s.avgChg}%</span>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{s.up}漲/{s.down}跌</span>
                {s.netInst ? <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: s.netInst > 0 ? '#f03e3e' : '#2f9e44', fontWeight: 700 }}>昨法人{s.netInst > 0 ? '+' : ''}{s.netInst.toLocaleString()}</span> : null}
                <span style={{ marginLeft: 'auto' }}>{deltaTag(s.delta)}</span>
              </div>
              {open && (
                <div style={{ padding: '2px 10px 8px 32px', display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 'calc(12.5px * var(--fz))' }}>
                  <span style={{ color: 'var(--text-muted)' }}>領漲：</span>
                  {s.leaders.map(l => (
                    <span key={l.code} onClick={() => navigateTo('stock', l.code)} style={{ cursor: 'pointer' }}>
                      <b style={{ color: '#7dd3fc' }}>{l.code} {l.name}</b>
                      {(() => { const st = statusOf(dt, l.code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()}
                      <span style={{ color: getChangeColor(l.cp), marginLeft: 4 }}>{l.cp > 0 ? '+' : ''}{l.cp}%</span>
                      {l.netInst ? <span style={{ color: l.netInst > 0 ? '#f03e3e' : '#2f9e44', marginLeft: 4, fontSize: 'calc(12.5px * var(--fz))' }}>法人{l.netInst > 0 ? '+' : ''}{l.netInst}</span> : null}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 6, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
        法人為昨日外資+投信(當日 T86 需 15:00 後)。加權分/資金流向為確定性統計，非投資建議。
      </div>
    </div>
  );
}
