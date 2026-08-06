'use client';

import { useEffect, useState } from 'react';
import { useDataUid } from '@/lib/view-as';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 週末復盤週報（daemon 每週六 10:00 純模板生成）──

interface Report { weekOf: string; content: string; generatedAt: number }

export default function WeeklyReport() {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const [rep, setRep] = useState<Report | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const unsub = onSnapshot(doc(db, 'users', dataUid, 'data', 'weeklyReport'), snap => setRep(snap.exists() ? (snap.data() as Report) : null), () => {});
    return () => unsub();
  }, [dataUid]);

  if (!rep?.content) return null;
  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>🗓️ 週報 {rep.weekOf}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>每週六生成 · 零幻覺模板</span>
        <button onClick={() => setOpen(o => !o)} style={{ marginLeft: 'auto', fontSize: 12, padding: '2px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer' }}>{open ? '收合' : '展開'}</button>
      </div>
      {open && <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.8, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{rep.content.replace(/^#+ /gm, '').replace(/^- /gm, '· ')}</div>}
    </div>
  );
}
