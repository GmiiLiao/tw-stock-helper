'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 自動停損/停利提醒：訂閱 users/{uid}/data/alerts(常駐 daemon 觸價寫入) ──

interface Alert {
  code: string; name: string;
  type: 'stop' | 'take' | 'reentry' | 'trailing' | 'custom' | 'catalyst' | 'thesis' | 'discipline' | 'buyzone' | 'exdiv' | 'anomaly' | 'daytrade' | 'etfprem' | 'dca' | 'adr' | 'defense' | 'exit' | 'forecast' | 'earlybird' | 'opensell' | 'chipclear' | 'chipsell' | 'chipweak' | 'finwarn' | 'rebound' | 'washout';
  price: number; threshold: number; pnlPct: number;
  message: string; at: number;
}

const STYLE: Record<Alert['type'], { color: string; icon: string }> = {
  stop: { color: '#2f9e44', icon: '⛔' },   // 台股語意：壞訊=綠
  take: { color: '#f03e3e', icon: '🎯' },  // 停利=獲利=紅
  reentry: { color: '#3b82f6', icon: '🔄' },
  trailing: { color: '#a78bfa', icon: '📈' },
  custom: { color: '#f59e0b', icon: '🔔' },
  catalyst: { color: '#7dd3fc', icon: '📅' },
  thesis: { color: '#f97316', icon: '🧩' },
  discipline: { color: '#2f9e44', icon: '⛔' },
  buyzone: { color: '#f03e3e', icon: '🎯' },
  exdiv: { color: '#eab308', icon: '💸' },
  anomaly: { color: '#e8590c', icon: '⚡' },
  daytrade: { color: '#f97316', icon: '🌀' },
  etfprem: { color: '#a78bfa', icon: '💠' },
  dca: { color: '#38bdf8', icon: '📥' },
  adr: { color: '#38bdf8', icon: '🌉' },
  defense: { color: '#2f9e44', icon: '🛡' },
  exit: { color: '#2f9e44', icon: '🚨' },
  forecast: { color: '#7dd3fc', icon: '📰' },
  earlybird: { color: '#fbbf24', icon: '🐦' },
  opensell: { color: '#f59e0b', icon: '⏰' },
  chipclear: { color: '#2f9e44', icon: '🚨' },
  chipsell: { color: '#e8590c', icon: '⚠️' },
  chipweak: { color: '#e8590c', icon: '⚠️' },
  rebound: { color: '#22c55e', icon: '📤' },
  washout: { color: '#f59e0b', icon: '🌀' },
  finwarn: { color: '#a78bfa', icon: '📉' },
};

export default function PortfolioAlerts() {
  const user = useAppStore(st => st.user);
  const navigateTo = useAppStore(st => st.navigateTo);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    if (!user?.uid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', user.uid, 'data', 'alerts');
    const unsub = onSnapshot(ref, snap => {
      const data = snap.exists() ? (snap.data() as { alerts?: Alert[] }) : null;
      setAlerts(data?.alerts ?? []);
    }, () => {});
    return () => unsub();
  }, [user?.uid]);

  // Only show alerts from the last 24h, newest first, capped.
  const recent = alerts.filter(a => Date.now() - a.at < 24 * 3600 * 1000).slice(0, 6);
  if (recent.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
      {recent.map((a, i) => {
        const st = STYLE[a.type] ?? STYLE.take;
        const color = st.color;
        const clickable = /^\d{4,6}$/.test(String(a.code || ''));
        return (
          <div key={`${a.code}-${a.type}-${a.at}-${i}`}
            onClick={clickable ? () => navigateTo('stock', a.code) : undefined}
            title={clickable ? `開啟 ${a.code} 個股分析` : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
              borderRadius: 10, background: `${color}1a`, border: `1px solid ${color}40`,
              cursor: clickable ? 'pointer' : 'default',
            }}>
            <span style={{ fontSize: 18 }}>{st.icon}</span>
            <span style={{ flex: 1, fontSize: '0.86rem', color: 'var(--text-primary)', fontWeight: 600 }}>{a.message}</span>
            {clickable && <span style={{ fontSize: '0.72rem', color, fontWeight: 700, whiteSpace: 'nowrap' }}>開啟 ›</span>}
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {new Date(a.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        );
      })}
    </div>
  );
}
