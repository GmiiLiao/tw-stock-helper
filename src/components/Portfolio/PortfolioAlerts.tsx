'use client';

import { useEffect, useState } from 'react';
import { useDataUid, canWriteUserData } from '@/lib/view-as';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import DayTradeBadge from '@/components/shared/DayTradeBadge';

// ── 自動停損/停利提醒：訂閱 users/{uid}/data/alerts(常駐 daemon 觸價寫入) ──

interface Alert {
  code: string; name: string;
  type: 'stop' | 'take' | 'reentry' | 'trailing' | 'custom' | 'catalyst' | 'thesis' | 'discipline' | 'buyzone' | 'exdiv' | 'anomaly' | 'daytrade' | 'etfprem' | 'dca' | 'adr' | 'defense' | 'exit' | 'forecast' | 'earlybird' | 'opensell' | 'chipclear' | 'chipsell' | 'chipweak' | 'finwarn' | 'rebound' | 'washout' | 'rsiHot85' | 'rsiDual85' | 'reversalUp' | 'reversalDown';
  price: number; threshold: number; pnlPct: number;
  message: string; at: number;
  // 反轉訊號要求點擊確認（daemon pushReversalAlerts 寫入；TG 端也可確認）
  id?: string; key?: string; requireAck?: boolean; ack?: number; ackVia?: string; reminded?: boolean;
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
  // RSI 高檔警報（2026-08-03）。⚠雙高**不是賣訊**——實測續抱10日均反而更高、
  //   真頂點率更低，是波動雙向放大；單腳過熱(RSI10未跟上)才是三組中最像頂的。
  //   故雙高用橘色（警戒）而非紅色（賣出），避免顏色本身暗示錯誤動作。
  rsiHot85: { color: '#eab308', icon: '⚠️' },
  rsiDual85: { color: '#fb923c', icon: '🔥' },
  finwarn: { color: '#a78bfa', icon: '📉' },
  reversalUp: { color: '#f03e3e', icon: '📈' },     // 反轉上漲＝紅（台股語意）
  reversalDown: { color: '#2f9e44', icon: '📉' },   // 出貨訊號＝壞訊＝綠
};

export default function PortfolioAlerts() {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const navigateTo = useAppStore(st => st.navigateTo);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [acking, setAcking] = useState<string | null>(null);

  // 點擊「✅ 收到」：回寫 ack 時間戳（整份 alerts 重寫＝與 daemon 同一寫法）
  const ackAlert = async (id: string) => {
    if (!canWriteUserData()) return;   // 🎭模擬中禁止寫入（會替對方按下已確認）
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    setAcking(id);
    try {
      const next = alerts.map(a => a.id === id ? { ...a, ack: Date.now(), ackVia: 'web' } : a);
      await setDoc(doc(db, 'users', dataUid, 'data', 'alerts'), { updatedAt: Date.now(), alerts: next });
    } catch { /* onSnapshot 會回捲畫面，失敗不需額外處理 */ }
    setAcking(null);
  };

  useEffect(() => {
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', dataUid, 'data', 'alerts');
    const unsub = onSnapshot(ref, snap => {
      const data = snap.exists() ? (snap.data() as { alerts?: Alert[] }) : null;
      setAlerts(data?.alerts ?? []);
    }, () => {});
    return () => unsub();
  }, [dataUid]);

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
            <span style={{ fontSize: 'calc(14.5px * var(--fz))' }}>{st.icon}</span>
            <DayTradeBadge code={a.code} size="xs" />
            <span style={{ flex: 1, fontSize: 'calc(0.86rem * var(--fz))', color: 'var(--text-primary)', fontWeight: 600 }}>{a.message}</span>
            {a.requireAck && a.id && (a.ack
              ? <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>已確認 ✓</span>
              : <button
                  onClick={e => { e.stopPropagation(); if (a.id) ackAlert(a.id); }}
                  disabled={acking === a.id}
                  style={{ padding: '4px 10px', borderRadius: 8, border: `1px solid ${color}`, background: color,
                    color: '#fff', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {acking === a.id ? '…' : '✅ 收到'}
                </button>)}
            {clickable && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color, fontWeight: 700, whiteSpace: 'nowrap' }}>開啟 ›</span>}
            <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {new Date(a.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        );
      })}
    </div>
  );
}
