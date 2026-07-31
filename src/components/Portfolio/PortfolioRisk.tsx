'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 投組相關性 / 分散度 / 集中度：訂閱 users/{uid}/data/portfolioRisk（daemon 計算）──

interface Risk {
  holdings: number; avgCorrelation: number; diversification: string;
  concentrationHHI: number; concentration: string;
  topSector?: { name: string; pct: number } | null;
  highestPair?: { a: string; b: string; corr: number } | null;
  rebalanceHint?: string;
  betaPortfolio?: number;
  stress?: { m5: number; m10: number; m20: number };
}

export default function PortfolioRisk() {
  const user = useAppStore(st => st.user);
  const allStocks = useAppStore(st => st.allStocks);
  const [d, setD] = useState<Risk | null>(null);

  useEffect(() => {
    if (!user?.uid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', user.uid, 'data', 'portfolioRisk');
    const unsub = onSnapshot(ref, snap => setD(snap.exists() ? (snap.data() as Risk) : null), () => {});
    return () => unsub();
  }, [user?.uid]);

  if (!d) return null;
  const nameOf = (c: string) => allStocks.find(s => s.code === c)?.name || c;
  const corrColor = d.avgCorrelation < 0.3 ? '#f03e3e' : d.avgCorrelation < 0.6 ? '#f59e0b' : '#2f9e44';
  const hhiColor = d.concentrationHHI > 0.5 ? '#2f9e44' : d.concentrationHHI > 0.3 ? '#f59e0b' : '#f03e3e';

  const cell = (label: string, value: string, sub: string, color: string) => (
    <div style={{ flex: 1, minWidth: 120, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color, fontFamily: "'JetBrains Mono',monospace" }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>
    </div>
  );

  return (
    <div style={{ marginBottom: 16, padding: '16px 18px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: 12 }}>🧬 投組相關性 / 分散度分析</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        {cell('平均相關係數', d.avgCorrelation.toFixed(2), d.diversification, corrColor)}
        {cell('集中度 HHI', d.concentrationHHI.toFixed(2), d.concentration, hhiColor)}
        {d.topSector ? cell('最大族群', `${d.topSector.pct}%`, d.topSector.name, d.topSector.pct >= 50 ? '#ef4444' : 'var(--text-primary)') : null}
        {d.betaPortfolio != null ? cell('投組 β', d.betaPortfolio.toFixed(2), d.betaPortfolio > 1.2 ? '波動大於大盤' : d.betaPortfolio < 0.8 ? '波動小於大盤' : '與大盤相當', d.betaPortfolio > 1.2 ? '#2f9e44' : d.betaPortfolio < 0.8 ? '#f03e3e' : '#f59e0b') : null}
      </div>
      {d.stress && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 8, padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
          🧪 壓力測試（β 推估）：大盤 −5% → <b style={{ color: '#f59e0b' }}>{d.stress.m5}%</b> · 大盤 −10% → <b style={{ color: '#f97316' }}>{d.stress.m10}%</b> · 大盤 −20% → <b style={{ color: '#ef4444' }}>{d.stress.m20}%</b>
        </div>
      )}
      {d.highestPair && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
          最高連動：{nameOf(d.highestPair.a)} ↔ {nameOf(d.highestPair.b)}（相關 {d.highestPair.corr}）{d.highestPair.corr > 0.7 ? '— 走勢高度同步，分散效果有限' : ''}
        </div>
      )}
      {d.rebalanceHint && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '8px 12px', background: 'rgba(99,102,241,0.08)', borderRadius: 8, lineHeight: 1.6 }}>
          💡 {d.rebalanceHint}
        </div>
      )}
    </div>
  );
}
