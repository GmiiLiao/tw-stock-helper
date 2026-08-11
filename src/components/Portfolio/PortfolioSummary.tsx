'use client';

import { useEffect, useState } from 'react';
import { useDataUid } from '@/lib/view-as';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 個人化每日摘要：訂閱 users/{uid}/data/dailySummary（常駐 daemon LLM 產生）──

interface Summary { date?: string; summary: string; generatedAt: number; model?: string }

export default function PortfolioSummary() {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const [data, setData] = useState<Summary | null>(null);

  useEffect(() => {
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', dataUid, 'data', 'dailySummary');
    const unsub = onSnapshot(ref, snap => { setData(snap.exists() ? (snap.data() as Summary) : null); }, () => {});
    return () => unsub();
  }, [dataUid]);

  if (!data?.summary) return null;

  return (
    <div style={{
      marginBottom: 16, padding: '14px 16px', borderRadius: 12,
      background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.06))',
      border: '1px solid rgba(99,102,241,0.25)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 'calc(0.92rem * var(--fz))' }}>🧑‍💼 個人化每日摘要</span>
        <span style={{ fontSize: 'calc(0.7rem * var(--fz))', color: 'var(--text-muted)' }}>{data.date}</span>
      </div>
      <div style={{ fontSize: 'calc(0.86rem * var(--fz))', lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{data.summary}</div>
    </div>
  );
}
