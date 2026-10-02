'use client';

import { useEffect, useState } from 'react';
import { startLiveLoop, isForeground } from '@/lib/market-clock';
import { useAppStore } from '@/lib/store';
import SectorWind from '@/components/SectorWind/SectorWind';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import { getChangeColor } from '@/lib/twse-api';

// ── 🌪 風向 2.0：強勢股統計 → 題材供應鏈 → 驅動力歸因 ──────────────
// 第1層 大盤走向（結構/全面行情）；第2層 題材鏈聚集度＋上下游驗證
// （全鏈齊漲＝真風向、只有中下游＝補漲/假風向候選）；第3層 白話驅動力
// 歸因（產業面/國際面/政策面，證據弱必標示）。官方33類降為第二參考。

interface Leader { code: string; name: string; cp: number; volX: number; limitUp: boolean }
interface Seg { role: string; label: string; avgChg: number; strong: number; n: number }
interface Theme { key: string; name: string; score: number; strong: number; members: number; medChg: number; wChg?: number; valueShare?: number | null; limitUps: number; yNet: number; chainStatus: string; segs: Seg[]; leaders: Leader[] }
interface WindData {
  updatedAt: number; date: string; marketOpen: boolean;
  direction: { label: string; up: number; down: number; flat: number; strongCount: number; topShare: number; breadth: number; wChg?: number };
  themes: Theme[];
  narrative: { text: string; at: number; drivers: Record<string, { type: string; text: string }>; newsUsed: string[] } | null;
}

const isTwTradingHours = () => {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
};

const DRIVER_META: Record<string, { icon: string; color: string }> = {
  '產業面': { icon: '🏭', color: '#7dd3fc' },
  '國際面': { icon: '🌍', color: '#c4b5fd' },
  '政策面': { icon: '🏛️', color: '#fbbf24' },
  '證據弱': { icon: '❓', color: '#8b9bb8' },
};

const chainBadge = (s: string) => {
  if (s === '全鏈齊漲') return { text: '✅ 全鏈齊漲（真風向）', color: '#f03e3e' };
  if (s.startsWith('只有中下游')) return { text: '⚠️ 只有中下游（補漲/假風向候選）', color: '#fbbf24' };
  if (s === '部分連動') return { text: '◐ 部分連動', color: '#b3c0d4' };
  if (s === '未連動') return { text: '－未連動', color: '#8b9bb8' };
  return null; // 族群型不顯示鏈驗證
};

export default function MarketWind({ compact = false, bare = false }: { compact?: boolean; bare?: boolean }) {
  const dt = useDayTradeCodes();   // 當沖資格：必須在任何 early return 之前
  const navigateTo = useAppStore(s => s.navigateTo);
  const [data, setData] = useState<WindData | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showRef, setShowRef] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/market-wind').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x) setData(x); }).catch(() => {});
    load();   // 首次載入不設閘
    // 間隔每拍重算（G3-05）；daemon sectorLoop 休市仍每 30 分重算（含收盤定案）⇒ 只擋背景分頁、不擋休市
    const stop = startLiveLoop(() => { if (isForeground()) load(); }, () => (isTwTradingHours() ? 90000 : 600000));
    return () => { live = false; stop(); };
  }, []);

  if (!data?.themes?.length) return null;
  const dir = data.direction;
  const drivers = data.narrative?.drivers || {};
  const themes = (compact ? data.themes.slice(0, 6) : data.themes).filter(t => t.strong > 0 || !compact);
  const dirColor = dir.label.startsWith('全面多頭') ? '#f03e3e' : dir.label.startsWith('結構') ? '#fbbf24' : dir.label.startsWith('偏空') ? '#2f9e44' : '#b3c0d4';

  return (
    <div style={bare ? {} : { marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: bare ? 'none' : 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(1rem * var(--fz))' }}>🌪 大盤風向</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          強勢股聚集 × 供應鏈驗證 × 驅動力歸因 · {data.marketOpen ? '盤中即時' : '收盤定案'}
        </span>
      </div>

      {/* 大盤走向判定 */}
      <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(61,142,248,0.08)', marginBottom: 8 }}>
        <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 900, color: dirColor, marginBottom: 3 }}>{dir.label}</div>
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>
          漲 {dir.up} / 跌 {dir.down}{dir.wChg != null && <> · <span title="全市場成交值加權漲跌：資金面的大盤方向（家數只看多數個股，這個看錢往哪裡走）">成交加權 <b style={{ color: getChangeColor(dir.wChg) }}>{dir.wChg > 0 ? '+' : ''}{dir.wChg}%</b></span></>} · 強勢股 {dir.strongCount} 檔 · 前3題材佔強勢股 {Math.round(dir.topShare * 100)}%
        </div>
      </div>

      {/* 白話敘事（qwythos 歸因，30分更新） */}
      {data.narrative?.text && (
        <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(148,163,184,0.06)', marginBottom: 10, fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.6 }}>
          🗣 {data.narrative.text}
          <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginLeft: 8 }}>
            AI 判讀 {new Date(data.narrative.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })}
          </span>
        </div>
      )}

      {/* 題材鏈榜 */}
      <div style={{ display: 'grid', gap: 3 }}>
        {themes.map(t => {
          const open = openKey === t.key;
          const drv = drivers[t.key];
          const dm = drv ? DRIVER_META[drv.type] : null;
          const cb = chainBadge(t.chainStatus);
          return (
            <div key={t.key} style={{ borderRadius: 8, background: open ? 'rgba(61,142,248,0.08)' : 'transparent' }}>
              <div onClick={() => setOpenKey(o => (o === t.key ? null : t.key))}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 'calc(13px * var(--fz))', cursor: 'pointer', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', width: 12 }}>{open ? '▾' : '▸'}</span>
                <span style={{ fontWeight: 700, minWidth: 108 }}>{t.name}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 56, height: 6, borderRadius: 3, background: 'rgba(148,163,184,0.15)', overflow: 'hidden', display: 'inline-block' }}>
                    <span style={{ display: 'block', height: '100%', width: `${t.score}%`, background: t.score >= 55 ? '#f03e3e' : t.score >= 35 ? '#fbbf24' : '#8b9bb8' }} />
                  </span>
                  <b style={{ minWidth: 30, color: t.score >= 55 ? '#f03e3e' : 'var(--text-secondary)' }}>{t.score}</b>
                </span>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>強勢 {t.strong}/{t.members}</span>
                {t.wChg != null && <span title="題材成員成交值加權漲跌" style={{ fontSize: 'calc(12.5px * var(--fz))', fontFamily: "'JetBrains Mono', monospace", color: getChangeColor(t.wChg) }}>{t.wChg > 0 ? '+' : ''}{t.wChg}%</span>}
                {t.valueShare != null && <span title="題材成交值占全市場比重——越大代表越多資金在這裡" style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>資金 {t.valueShare}%</span>}
                {t.limitUps > 0 && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#f03e3e', fontWeight: 800 }}>漲停{t.limitUps}</span>}
                {cb && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: cb.color, fontWeight: 700 }}>{cb.text}</span>}
                {dm && <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', color: dm.color, fontWeight: 700 }}>{dm.icon} {drv!.type}</span>}
              </div>
              {open && (
                <div style={{ padding: '2px 10px 8px 32px', fontSize: 'calc(12.5px * var(--fz))', display: 'grid', gap: 5 }}>
                  {drv && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6 }}>
                      {dm?.icon} <b style={{ color: dm?.color }}>{drv.type}</b>：{drv.text}
                      {drv.type === '證據弱' && <span style={{ color: 'var(--text-muted)' }}>（新聞無直接證據，屬推測）</span>}
                    </div>
                  )}
                  {t.segs.filter(s => s.role !== '族群').length > 0 && (
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {t.segs.map((s, i) => (
                        <span key={i} style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '2px 8px', borderRadius: 6, background: 'rgba(148,163,184,0.08)', color: s.avgChg > 0.5 ? '#f03e3e' : s.avgChg < -0.5 ? '#2f9e44' : 'var(--text-muted)' }}>
                          {s.role}{s.label ? `·${s.label}` : ''} {s.avgChg >= 0 ? '+' : ''}{s.avgChg}%{s.strong > 0 ? ` 🔥${s.strong}` : ''}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--text-muted)' }}>領漲：</span>
                    {t.leaders.map(l => (
                      <span key={l.code} onClick={e => { e.stopPropagation(); navigateTo('stock', l.code); }} style={{ cursor: 'pointer' }}>
                        <b style={{ color: '#7dd3fc' }}>{l.code} {l.name}</b> {(() => { const st = statusOf(dt, l.code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()}
                        <span style={{ color: '#f03e3e', marginLeft: 4 }}>+{l.cp}%{l.limitUp ? '🔒' : ''}</span>
                        {l.volX > 0 && <span style={{ color: 'var(--text-muted)', marginLeft: 3, fontSize: 'calc(12.5px * var(--fz))' }}>{l.volX}x量</span>}
                      </span>
                    ))}
                    {t.yNet !== 0 && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: t.yNet > 0 ? '#f03e3e' : '#2f9e44' }}>昨法人{t.yNet > 0 ? '+' : ''}{t.yNet.toLocaleString()}張</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 第二參考值：官方 33 類加權分（收合） */}
      <div style={{ marginTop: 8 }}>
        <div onClick={() => setShowRef(v => !v)} style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>
          {showRef ? '▾' : '▸'} 第二參考：官方 33 產業分類加權分
        </div>
        {showRef && <div style={{ marginTop: 6 }}><SectorWind compact={compact} /></div>}
      </div>

      <div style={{ marginTop: 6, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        統計皆為確定性計算；驅動力歸因由本地 AI 依當日新聞標題判讀，「證據弱」表示新聞無直接佐證。非投資建議。
      </div>
    </div>
  );
}
