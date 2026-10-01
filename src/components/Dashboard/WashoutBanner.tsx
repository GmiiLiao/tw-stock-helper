'use client';

// ── 🌀 洗盤監測看板（實測校準版年度風險提醒）──────────────────────────
// 依本站實測（^TWII 6.6年+證交所融資餘額）：修正<5%=正常、5~15%=歷史洗盤區間、
// >15%=超出全部歷史洗盤範圍（空頭劇本）。誠實原則：洗盤與空頭開端事前無法區分。

import { useEffect, useState } from 'react';

interface Washout {
  found: boolean; updatedAt: number; index: number; hi66: number; dd: number;
  marginDrop: number; foreign5: number; volRatio: number | null;
  stage: '正常波動' | '洗盤區間' | '空頭警戒'; confirming: boolean; signals: string[]; advice: string;
}

const STAGE_STYLE: Record<Washout['stage'], { c: string; bg: string; icon: string }> = {
  正常波動: { c: '#f03e3e', bg: 'rgba(240,62,62,0.07)', icon: '🔴' },  // 台股語意：好=紅
  洗盤區間: { c: '#f59e0b', bg: 'rgba(245,158,11,0.08)', icon: '🌀' },
  空頭警戒: { c: '#2f9e44', bg: 'rgba(47,158,68,0.08)', icon: '🚨' },
};

export default function WashoutBanner() {
  const [w, setW] = useState<Washout | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/api/ai/washout').then(r => (r.ok ? r.json() : null)).then(d => { if (live && d?.found) setW(d); }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!w || w.stage === '正常波動') return null; // 正常波動不佔版面，洗盤/空頭才現身提醒

  const s = STAGE_STYLE[w.stage];
  return (
    <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 12, background: s.bg, border: `1px solid ${s.c}55` }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', cursor: 'pointer' }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(1rem * var(--fz))', color: s.c }}>{s.icon} 大盤{w.stage}</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700 }}>距高點 <b style={{ color: s.c, fontFamily: 'JetBrains Mono, monospace' }}>-{w.dd}%</b>（{w.hi66.toLocaleString()} → {w.index.toLocaleString()}）</span>
        {w.confirming && <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, padding: '1px 8px', borderRadius: 10, background: 'rgba(240,62,62,0.15)', color: '#f03e3e' }}>洗完確認中 {w.signals.length}/4 訊號</span>}
        <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{open ? '收合 ▾' : '詳情 ▸'}</span>
      </div>
      {open && (
        <div style={{ marginTop: 8, fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          <div>{w.advice}</div>
          <div style={{ marginTop: 4, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>
            確認訊號：{w.signals.length ? w.signals.join('、') : '尚無'}｜融資自峰值 -{w.marginDrop}%｜外資5日 {w.foreign5 >= 0 ? '+' : ''}{w.foreign5.toLocaleString()} 張{w.volRatio != null ? `｜量能 5日/20日 ${w.volRatio}x` : ''}
          </div>
          <div style={{ marginTop: 4, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>
            實測依據：2020-2024 四段牛市修正 6.7~12.7% 後 6 個月指數再漲 17~32%；但 2024/7 同樣特徵實為 -28.7% 空頭開端——洗盤與空頭事前無法區分，等確認訊號(外資轉買/放量收紅/站回月線/融資止穩 ≥2)再進場。非投資建議。
          </div>
        </div>
      )}
    </div>
  );
}
