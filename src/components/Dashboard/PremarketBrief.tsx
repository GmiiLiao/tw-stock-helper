'use client';

import { useEffect, useState } from 'react';
import { useIsPremium } from '@/lib/view-as';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import { getChangeColor } from '@/lib/twse-api';

// ── Premium-only 開盤前 AI 策略快報 banner (Dashboard). Shows the daemon's
//    pre-market brief: 10 picks + entry/exit + market strategy, plus the
//    member's own holdings strategy (from portfolioAnalysis). ──

// 等級清單已集中到 lib/view-as（PREMIUM_LEVELS）——此處不再各自定義，避免模擬只改到一半
const SIGNAL_COLOR: Record<string, string> = { STRONG_BUY: '#c92a2a', BUY: '#e67700', WATCH: '#1971c2', NEUTRAL: '#868e96' };

interface Pick { code: string; name: string; signal: string; signalLabel: string; score: number; price: number; changePercent: number; buy: number | null; target: number | null; stop: number | null; note: string; swingAction?: string | null; swingScore?: number | null; swingBias?: number | null; chase?: boolean }
interface Brief { date: string; generatedAt: number; model: string; marketStrategy: string; picks: Pick[]; disclaimer: string }
interface HoldingA { code: string; name: string; action: string; sellTrigger: string }

export default function PremarketBrief() {
  const user = useAppStore(s => s.user);
  const isPremium = useIsPremium();   // 受身分模擬影響（見 lib/view-as）
  const [brief, setBrief] = useState<Brief | null>(null);
  const [holdings, setHoldings] = useState<Record<string, HoldingA>>({});
  const [open, setOpen] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isPremium) return;
    let live = true;
    const load = () => fetch('/api/premarket-brief').then(r => r.ok ? r.json() : null).then(d => { if (live && d && !d.error) setBrief(d); }).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { live = false; clearInterval(id); };
  }, [isPremium]);

  // member's own holdings strategy (reuse portfolioAnalysis)
  useEffect(() => {
    if (!isPremium || !user?.uid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', user.uid, 'data', 'portfolioAnalysis');
    const unsub = onSnapshot(ref, snap => {
      const d = snap.exists() ? snap.data() : null;
      setHoldings(d?.analyses || {});
    }, () => {});
    return () => unsub();
  }, [isPremium, user?.uid]);

  if (!isPremium || !brief || dismissed) return null;
  const heldCodes = Object.keys(holdings);

  return (
    <div style={{ margin: '0 0 16px', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-lg)', background: 'linear-gradient(135deg, rgba(201,42,42,0.07), rgba(61,142,248,0.04))', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 'calc(1rem * var(--fz))' }}>📢 開盤前 AI 策略快報</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, padding: '2px 7px', borderRadius: 999, background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>💎 高級會員</span>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{brief.date}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => setOpen(v => !v)} style={btnStyle}>{open ? '▲ 收合' : '▼ 展開'}</button>
          <button onClick={() => setDismissed(true)} style={btnStyle}>✕</button>
        </span>
      </div>

      {open && (
        <div style={{ padding: '0 16px 14px' }}>
          {/* market strategy */}
          <div style={{ fontSize: 'calc(0.965rem * var(--fz))', lineHeight: 1.7, color: 'var(--text-secondary)', marginBottom: 12, whiteSpace: 'pre-wrap' }}>
            <strong style={{ color: 'var(--text-primary)' }}>🧭 大盤策略：</strong>{brief.marketStrategy}
          </div>

          {/* 10 picks */}
          <div style={{ fontWeight: 700, marginBottom: 6 }}>🎯 今日精選 10 檔（進出場建議）</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: 8, marginBottom: 12 }}>
            {brief.picks.map(p => {
              const c = SIGNAL_COLOR[p.signal] || '#868e96';
              const up = p.changePercent > 0;
              return (
                <div key={p.code} style={{ border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)', padding: '9px 11px', background: 'var(--bg-card)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: 'var(--accent-blue)' }}>{p.code}</span>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, padding: '1px 7px', borderRadius: 999, background: `${c}1f`, color: c, border: `1px solid ${c}` }}>{p.signalLabel}</span>
                    <span style={{ marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(12.5px * var(--fz))', color: p.changePercent == null ? 'var(--text-muted)' : getChangeColor(p.changePercent) }}>{p.price}（{up ? '+' : ''}{p.changePercent?.toFixed?.(2)}%）</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(12.5px * var(--fz))', margin: '5px 0', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--color-up)' }}>買 {p.buy ?? '—'}</span>
                    <span style={{ color: 'var(--color-down)' }}>目標 {p.target ?? '—'}</span>
                    <span style={{ color: 'var(--text-muted)' }}>損 {p.stop ?? '—'}</span>
                    {p.swingAction && (
                      <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: p.chase ? 'rgba(230,119,0,0.15)' : 'rgba(99,102,241,0.12)', color: p.chase ? '#e67700' : '#818cf8' }} title={`波段紀律評分 ${p.swingScore}/100 · 乖離 ${p.swingBias}%`}>
                        🎯 {p.swingAction}{p.chase ? '·勿追高' : ''}
                      </span>
                    )}
                  </div>
                  {p.note && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{p.note}</div>}
                </div>
              );
            })}
          </div>

          {/* member's holdings strategy */}
          {heldCodes.length > 0 && (
            <>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>💼 你的持股操作策略</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                {heldCodes.map(code => {
                  const h = holdings[code];
                  return (
                    <div key={code} style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent-blue)' }}>{code}</span> {h.name}
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)', margin: '0 6px' }}>· {h.action}</span>
                      {h.sellTrigger && <span style={{ color: 'var(--text-muted)' }}>（{h.sellTrigger}）</span>}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6, borderTop: '1px solid var(--border-primary)', paddingTop: 8 }}>
            {brief.disclaimer}（本地模型 {brief.model}）
          </div>
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = { background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))', padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit' };
