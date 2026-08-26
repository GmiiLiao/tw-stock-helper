'use client';

import { useEffect, useState } from 'react';

// ── 估值位階 PE Band ──
// 近 12 個月官方每日本益比 → 百分位帶；現在 PE 落點顯示貴/俗。全官方數據。

interface Band { pMin: number; p25: number; p50: number; p75: number; pMax: number }
interface Data { updatedAt: number; samples: number; price: number; peNow: number; eps: number | null; percentile: number; bands: Band; priceAt: { p25: number; p50: number; p75: number } | null }

export default function PeBand({ code }: { code: string }) {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => {
    let live = true; setD(null);
    fetch(`/api/ai/pe-band?code=${code}`).then(r => r.ok ? r.json() : null).then(x => { if (live) setD(x); }).catch(() => {});
    return () => { live = false; };
  }, [code]);

  if (!d?.bands) return null;
  const b = d.bands;
  const span = Math.max(b.pMax - b.pMin, 0.01);
  const pos = Math.min(Math.max((d.peNow - b.pMin) / span * 100, 0), 100);
  const zone = d.percentile <= 25 ? { t: '歷史偏俗', c: '#f03e3e' } : d.percentile <= 60 ? { t: '合理區間', c: '#f59e0b' } : d.percentile <= 85 ? { t: '偏貴', c: '#84cc16' } : { t: '歷史高檔', c: '#2f9e44' };  // 台股語意：便宜=好=紅、貴=綠

  return (
    <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontWeight: 700 }}>📐 估值位階（PE Band · 近12月）</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>現 PE {d.peNow} · 歷史第 <b style={{ color: zone.c }}>{d.percentile}</b> 百分位</span>
        <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: zone.c }}>{zone.t}</span>
      </div>
      <div style={{ position: 'relative', height: 18, borderRadius: 9, overflow: 'hidden', background: 'linear-gradient(90deg,#f03e3e33,#f59e0b33,#2f9e4433)' }}>
        {[b.p25, b.p50, b.p75].map(v => (
          <div key={v} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(v - b.pMin) / span * 100}%`, width: 1, background: 'rgba(255,255,255,0.35)' }} />
        ))}
        <div style={{ position: 'absolute', top: 1, bottom: 1, left: `calc(${pos}% - 2px)`, width: 4, borderRadius: 2, background: zone.c, boxShadow: `0 0 6px ${zone.c}` }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 4, fontFamily: "'JetBrains Mono',monospace" }}>
        <span>PE {b.pMin}</span><span>{b.p25}</span><span>{b.p50}</span><span>{b.p75}</span><span>{b.pMax}</span>
      </div>
      {d.priceAt && (
        <div style={{ marginTop: 8, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>
          以官方 EPS(TTM) {d.eps} 推算：便宜價(P25) <b style={{ color: '#f03e3e' }}>{d.priceAt.p25}</b> · 合理價(P50) <b style={{ color: '#f59e0b' }}>{d.priceAt.p50}</b> · 昂貴價(P75) <b style={{ color: '#2f9e44' }}>{d.priceAt.p75}</b>（現價 {d.price}）
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>資料：證交所每日本益比 {d.samples} 筆。持股/自選每週更新；僅供估值參考，非投資建議。</div>
    </div>
  );
}
