'use client';

import { useEffect, useState } from 'react';
import { useDataUid } from '@/lib/view-as';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 🪞 影子帳戶（借鏡 Vibe-Trading Shadow Account）──────────────
// daemon 從交易紀錄學出「你實際在用的規則」，與鐵律比對，
// 並模擬「若每筆都照隔日收盤出」的損益差 — 把破戒代價變成具體數字。

interface Shadow {
  updatedAt: number; pairsAnalyzed: number; avgDownCount: number;
  learned: { medHoldDays: number; overnightRate: number; avgWinExit: number | null; avgLossExit: number | null; deepLossCount: number; winRate: number };
  violations: string[];
  ruleSim: { n: number; actualPnL: number; ruleBasedPnL: number; diff: number } | null;
}

export default function ShadowAccount() {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const [s, setS] = useState<Shadow | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const unsub = onSnapshot(doc(db, 'users', dataUid, 'data', 'shadowAccount'), snap => {
      setS(snap.exists() ? (snap.data() as Shadow) : null);
    }, () => {});
    return () => unsub();
  }, [dataUid]);

  if (!s?.learned) return null;
  const L = s.learned;
  const fmt = (n: number) => n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });

  return (
    <div style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: `1px solid ${s.violations.length ? 'rgba(239,68,68,0.4)' : 'var(--border-primary)'}` }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'baseline', gap: 10, cursor: 'pointer', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: '0.95rem' }}>🪞 影子帳戶</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>從你的 {s.pairsAnalyzed} 筆交易學出「實際規則」，對照鐵律抓破戒</span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#7dd3fc', fontWeight: 700 }}>{open ? '收合 ▸' : '展開 ▾'}</span>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          {/* 你的實際規則 vs 鐵律 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 10 }}>
            {[
              { k: '隔日沖遵守率', v: `${L.overnightRate}%`, warn: L.overnightRate < 70, note: '鐵律 100%' },
              { k: '中位持有天數', v: `${L.medHoldDays} 天`, warn: L.medHoldDays > 1, note: '鐵律 ≤1 天' },
              { k: '實際停損位', v: L.avgLossExit != null ? `${L.avgLossExit}%` : '—', warn: (L.avgLossExit ?? 0) < -8, note: '鐵律 -8%' },
              { k: '實際停利位', v: L.avgWinExit != null ? `+${L.avgWinExit}%` : '—', warn: false, note: `勝率 ${L.winRate}%` },
            ].map(x => (
              <div key={x.k} style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(148,163,184,0.06)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{x.k} <span style={{ opacity: 0.7 }}>({x.note})</span></div>
                <div style={{ fontSize: 16, fontWeight: 800, color: x.warn ? '#2f9e44' : '#f03e3e' }}>{x.v}</div>
              </div>
            ))}
          </div>
          {/* 破戒清單 */}
          {s.violations.length > 0 && (
            <div style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', marginBottom: 8 }}>
              {s.violations.map((v, i) => (
                <div key={i} style={{ fontSize: 12.5, color: '#fca5a5', lineHeight: 1.8 }}>⛔ {v}</div>
              ))}
            </div>
          )}
          {/* 規則模擬 vs 實際 */}
          {s.ruleSim && (
            <div style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', fontSize: 12.5, lineHeight: 1.8 }}>
              <b style={{ color: '#fbbf24' }}>規則模擬（{s.ruleSim.n} 筆可比對）：</b>
              若每筆都照「隔日收盤出」鐵律 → 損益 <b style={{ color: s.ruleSim.ruleBasedPnL >= 0 ? '#f03e3e' : '#2f9e44' }}>{fmt(s.ruleSim.ruleBasedPnL)}</b> 元，
              你的實際 <b style={{ color: s.ruleSim.actualPnL >= 0 ? '#f03e3e' : '#2f9e44' }}>{fmt(s.ruleSim.actualPnL)}</b> 元
              → 差距 <b style={{ color: s.ruleSim.diff > 0 ? '#2f9e44' : '#f03e3e', fontSize: 14 }}>{s.ruleSim.diff > 0 ? `破戒多虧 ${fmt(s.ruleSim.diff)}` : `你贏過鐵律 ${fmt(-s.ruleSim.diff)}`}</b> 元
            </div>
          )}
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>全確定性計算（交易紀錄+官方收盤），每日盤後更新。非投資建議。</div>
        </div>
      )}
    </div>
  );
}
