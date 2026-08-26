'use client';

import { useEffect, useState } from 'react';
import MarketWind from '@/components/MarketWind/MarketWind';
import ChipWind from '@/components/ChipWind/ChipWind';
import ChipDivergence from '@/components/ChipWind/ChipDivergence';

// ── 🧭 風向總覽：題材風向 × 籌碼風向 × 量價背離 整合同一視圖 ──────────
// 頂部綜合判讀：價格風向(強勢股/題材) vs 籌碼風向(法人淨額) 是否同向。

interface Synthesis { label: string; color: string; text: string }

function synth(priceLabel: string | null, chipTotal: number | null): Synthesis | null {
  if (!priceLabel || chipTotal == null) return null;
  const priceBull = priceLabel.startsWith('全面多頭') || priceLabel.startsWith('結構');
  const priceBear = priceLabel.startsWith('偏空');
  const chipBull = chipTotal > 0;
  if (priceBull && chipBull) return { label: '量價籌碼同向偏多', color: '#f03e3e', text: '股價強勢＋法人同步買超，多頭較扎實，順勢操作但仍設停損。' };
  if (priceBull && !chipBull) return { label: '價漲籌碼背離', color: '#f59f00', text: '股價走強但法人當日淨賣，留意背離；追價風險偏高，觀察法人是否轉買。' };
  if (!priceBull && chipBull) return { label: '價弱籌碼偏多', color: '#3d8ef8', text: '股價偏弱但法人淨買超，可能低接吸貨、醞釀打底，留意止跌訊號。' };
  if (priceBear && !chipBull) return { label: '量價籌碼同弱', color: '#2f9e44', text: '股價弱勢＋法人賣超，籌碼與價格同步走弱，宜防守、降低部位。' };
  return { label: '多空拉鋸', color: 'var(--text-secondary)', text: '價格與籌碼方向不一致或訊號中性，等待更明確的一致訊號。' };
}

export default function WindHub({ compact = false }: { compact?: boolean }) {
  const [tab, setTab] = useState<'theme' | 'chip' | 'div'>('theme');
  const [priceLabel, setPriceLabel] = useState<string | null>(null);
  const [chipTotal, setChipTotal] = useState<number | null>(null);
  const [chipDate, setChipDate] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      fetch('/api/ai/market-wind').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x?.direction) setPriceLabel(x.direction.label); }).catch(() => {});
      fetch('/api/ai/chip-wind').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x?.timeframes?.d1) { setChipTotal(x.timeframes.d1.marketNet.total); setChipDate(x.latestDate || null); } }).catch(() => {});
    };
    load();
    const t = setInterval(load, 180000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const s = synth(priceLabel, chipTotal);
  const TABS: { key: typeof tab; label: string; icon: string }[] = [
    { key: 'theme', label: '題材風向', icon: '🌪' },
    { key: 'chip', label: '籌碼風向', icon: '🧭' },
    { key: 'div', label: '量價背離', icon: '🔀' },
  ];

  return (
    <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(1.05rem * var(--fz))' }}>🧭 風向總覽</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>題材（價格動能）× 籌碼（法人資金）× 量價背離</span>
      </div>

      {/* 綜合判讀：價格 × 籌碼 是否同向 */}
      {s && (
        <div style={{ padding: '9px 13px', borderRadius: 10, background: 'rgba(148,163,184,0.06)', border: `1px solid ${s.color}44`, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>價格<span style={{ fontSize: 'calc(12.5px * var(--fz))' }}>(今日)</span></span>
            <b style={{ fontSize: 'calc(12.5px * var(--fz))' }}>{priceLabel?.split('（')[0]}</b>
            <span style={{ color: 'var(--text-muted)' }}>×</span>
            <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>籌碼<span style={{ fontSize: 'calc(12.5px * var(--fz))' }}>{chipDate ? `(${chipDate.slice(5)})` : ''}</span></span>
            <b style={{ fontSize: 'calc(12.5px * var(--fz))', color: (chipTotal ?? 0) >= 0 ? '#f03e3e' : '#2f9e44' }}>法人{(chipTotal ?? 0) >= 0 ? '買超' : '賣超'} {Math.abs(Math.round(chipTotal ?? 0)).toLocaleString()}張</b>
            <span style={{ marginLeft: 'auto', fontSize: 'calc(13px * var(--fz))', fontWeight: 900, color: s.color }}>→ {s.label}</span>
          </div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.6 }}>{s.text}</div>
        </div>
      )}

      {/* 分頁切換 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <span key={t.key} onClick={() => setTab(t.key)} style={{ fontSize: 'calc(13px * var(--fz))', fontWeight: 700, padding: '5px 14px', borderRadius: 20, cursor: 'pointer', color: tab === t.key ? '#fff' : 'var(--text-secondary)', background: tab === t.key ? '#3d8ef8' : 'rgba(148,163,184,0.1)' }}>
            {t.icon} {t.label}
          </span>
        ))}
      </div>

      {tab === 'theme' && <MarketWind bare compact={compact} />}
      {tab === 'chip' && <ChipWind bare compact={compact} />}
      {tab === 'div' && <ChipDivergence compact={compact} />}
    </div>
  );
}
