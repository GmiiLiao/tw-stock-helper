'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';

// ── 🎯 三大法人籌碼訊號（四準則判讀）──────────────────────────────
// ① 外資單日買超≥5000張=隔日支撐 ② 三方同向買超=強烈多頭
// ③ 外資連買≥3日+創新高=最佳入場 ④ 外資賣超+融資增=散戶接棒危險
// code 有值 → 顯示該股觸發的訊號標籤；無 → 全市場四榜卡。

interface RuleMeta { label: string; icon: string; color: string; bg: string; desc: string }
const RULES: Record<string, RuleMeta> = {
  foreignHeavyBuy: { label: '外資大買', icon: '💰', color: '#f03e3e', bg: 'rgba(240,62,62,0.10)', desc: '外資單日買超 ≥5000 張，隔日易有支撐' },
  tripleAlign: { label: '三方同買', icon: '🔴', color: '#f03e3e', bg: 'rgba(240,62,62,0.10)', desc: '外資＋投信＋自營同時買超，強烈多頭訊號' },
  streakNewHigh: { label: '連買創高', icon: '🚀', color: '#e8590c', bg: 'rgba(232,89,12,0.10)', desc: '外資連買≥3日且股價創20日新高，籌碼追蹤最佳入場' },
  retailBagholder: { label: '散戶接棒', icon: '⚠️', color: '#f59f00', bg: 'rgba(245,159,0,0.10)', desc: '外資賣超但融資增加，散戶接棒、危險訊號' },
};
const ORDER = ['tripleAlign', 'streakNewHigh', 'foreignHeavyBuy', 'retailBagholder'];

const fmtLots = (n: number) => (n >= 0 ? '+' : '') + Math.round(n).toLocaleString();

// ── 個股標籤模式 ──
function StockTags({ code }: { code: string }) {
  const [sig, setSig] = useState<{ tags: string[]; foreign: number; trust: number; dealer: number; streak: number; newHigh: boolean; marginChg: number } | null>(null);
  const [meta, setMeta] = useState<{ dataDate?: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/ai/chip-signals?code=${code}`).then(r => (r.ok ? r.json() : null)).then(d => { if (live && d) { setSig(d.signal); setMeta(d); } }).catch(() => {});
    return () => { live = false; };
  }, [code]);
  if (!sig?.tags?.length) return null;
  return (
    <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 900, fontSize: '0.95rem' }}>🎯 籌碼訊號</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>資料日 {meta?.dataDate}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {sig.tags.map(t => {
          const m = RULES[t]; if (!m) return null;
          return <span key={t} style={{ fontSize: 12.5, fontWeight: 800, padding: '3px 10px', borderRadius: 20, color: m.color, background: m.bg, border: `1px solid ${m.color}55` }}>{m.icon} {m.label}</span>;
        })}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        {sig.tags.map(t => <div key={t}>· {RULES[t]?.desc}</div>)}
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
        單日 外資 <b style={{ color: sig.foreign >= 0 ? '#f03e3e' : '#2f9e44' }}>{fmtLots(sig.foreign)}</b>
        ／投信 <b style={{ color: sig.trust >= 0 ? '#f03e3e' : '#2f9e44' }}>{fmtLots(sig.trust)}</b>
        ／自營 <b style={{ color: sig.dealer >= 0 ? '#f03e3e' : '#2f9e44' }}>{fmtLots(sig.dealer)}</b> 張
        {sig.streak > 0 && <span> · 外資連買 {sig.streak} 日</span>}
        {sig.marginChg !== 0 && <span> · 融資{sig.marginChg > 0 ? '增' : '減'} {Math.abs(Math.round(sig.marginChg)).toLocaleString()} 張</span>}
      </div>
    </div>
  );
}

// ── 全市場四榜模式 ──
interface Item { code: string; name: string; foreign: number; trust?: number; dealer?: number; total?: number; streak?: number; close?: number; marginUp?: number }
interface MarketData { dataDate?: string; marginDate?: string; counts?: Record<string, number>; rules?: Record<string, Item[]> }

export default function ChipSignals({ code, compact = false }: { code?: string; compact?: boolean }) {
  const navigateTo = useAppStore(s => s.navigateTo);
  const allStocks = useAppStore(s => s.allStocks);
  const [data, setData] = useState<MarketData | null>(null);
  const [open, setOpen] = useState<string | null>('tripleAlign');

  useEffect(() => {
    if (code) return;
    let live = true;
    fetch('/api/ai/chip-signals').then(r => (r.ok ? r.json() : null)).then(d => { if (live && d) setData(d); }).catch(() => {});
    const t = setInterval(() => fetch('/api/ai/chip-signals').then(r => (r.ok ? r.json() : null)).then(d => { if (live && d) setData(d); }).catch(() => {}), 600000);
    return () => { live = false; clearInterval(t); };
  }, [code]);

  if (code) return <StockTags code={code} />;
  if (!data?.rules) return null;

  // 個股方塊（熱力圖式）：底色依當日漲跌紅/綠，角標市/櫃，附該榜專屬指標
  const tile = (it: Item, rk: string) => {
    const st = allStocks.find(s => s.code === it.code);
    const chg = st?.changePercent;
    const price = st?.price;
    const up = (chg ?? 0) >= 0;
    const bg = chg == null ? 'rgba(148,163,184,0.10)' : up ? 'rgba(240,62,62,0.16)' : 'rgba(47,158,68,0.16)';
    const bd = chg == null ? 'var(--border-primary)' : up ? 'rgba(240,62,62,0.45)' : 'rgba(47,158,68,0.45)';
    const cc = chg == null ? 'var(--text-secondary)' : up ? '#f03e3e' : '#2f9e44';
    const otc = st?.market === 'otc';
    const metric = rk === 'tripleAlign' ? `外${fmtLots(it.foreign)} 投${fmtLots(it.trust || 0)} 自${fmtLots(it.dealer || 0)}`
      : rk === 'foreignHeavyBuy' ? `外資 ${fmtLots(it.foreign)} 張`
      : rk === 'streakNewHigh' ? `連買 ${it.streak} 日·創高`
      : `外資${fmtLots(it.foreign)}·融資增${Math.round(it.marginUp || 0).toLocaleString()}`;
    return (
      <div key={it.code} onClick={() => navigateTo('stock', it.code)}
        style={{ position: 'relative', cursor: 'pointer', padding: '7px 9px', borderRadius: 8, background: bg, border: `1px solid ${bd}`, minWidth: 0 }}>
        {st?.market && (
          <span style={{ position: 'absolute', top: 3, right: 5, fontSize: 9, fontWeight: 800, color: otc ? '#f59e0b' : '#3d8ef8' }}>{otc ? '櫃' : '市'}</span>
        )}
        <div style={{ fontSize: 12.5, fontWeight: 800, lineHeight: 1.3 }}>{it.code}</div>
        <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</div>
        {price != null && chg != null ? (
          <div style={{ fontSize: 11.5, fontWeight: 700, color: cc, fontFamily: 'JetBrains Mono, monospace' }}>
            {price} {chg >= 0 ? '+' : ''}{chg.toFixed(1)}%
          </div>
        ) : null}
        <div style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={metric}>{metric}</div>
      </div>
    );
  };

  return (
    <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 900, fontSize: '1rem' }}>🎯 籌碼訊號</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>三大法人四準則 · 資料日 {data.dataDate}{data.marginDate ? ` · 融資 ${data.marginDate}` : ''}</span>
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        {ORDER.map(rk => {
          const m = RULES[rk]; const items = data.rules?.[rk] || [];
          const isOpen = open === rk;
          return (
            <div key={rk} style={{ borderRadius: 8, background: isOpen ? m.bg : 'transparent' }}>
              <div onClick={() => setOpen(o => (o === rk ? null : rk))} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer', fontSize: 13 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 12 }}>{isOpen ? '▾' : '▸'}</span>
                <span style={{ fontWeight: 800, color: m.color }}>{m.icon} {m.label}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{items.length} 檔</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.desc}</span>
              </div>
              {isOpen && (
                items.length ? (
                  <div style={{ padding: '2px 8px 10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: 6 }}>
                    {items.map(it => tile(it, rk))}
                  </div>
                ) : (
                  <div style={{ padding: '2px 10px 10px 32px', fontSize: 12.5, color: 'var(--text-muted)' }}>今日無</div>
                )
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        T86 約 15:00 出、融資約 21:30 出；盤中顯示最近已公布完整日。確定性統計，非投資建議。
      </div>
    </div>
  );
}
