'use client';

import { useEffect, useState } from 'react';
import { useDataUid } from '@/lib/view-as';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 崩盤防禦清單：大盤急跌日 daemon 自動生成，48 小時內顯示 ──

interface Report { at: number; date: string; median: number; downRatio: number; content: string; highRisk: number }

export default function DefenseBanner() {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const [rep, setRep] = useState<Report | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const unsub = onSnapshot(doc(db, 'users', dataUid, 'data', 'defenseReport'), snap => setRep(snap.exists() ? (snap.data() as Report) : null), () => {});
    return () => unsub();
  }, [dataUid]);

  if (!rep || Date.now() - rep.at > 48 * 3600000) return null;
  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.45)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 'calc(14px * var(--fz))', color: '#ef4444' }}>🛡 崩盤防禦清單（{rep.date}）</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>大盤跌幅中位 {rep.median}%、{rep.downRatio}% 個股下跌{rep.highRisk ? ` · ${rep.highRisk} 檔逼近停損` : ''}</span>
        <button onClick={() => setOpen(o => !o)} style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', padding: '2px 10px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: '#ef4444', cursor: 'pointer' }}>{open ? '收合' : '展開'}</button>
      </div>
      {/* 2026-10-01 判讀內文改標準字級 13.5px、行高 1.8→1.6；標題原繼承未乘 --fz 的 14px，補上倍率以維持大於內文 */}
      {open && <div style={{ marginTop: 8, fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.6, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{rep.content.replace(/^#+ /gm, '').replace(/^- /gm, '· ').replace(/\*\*/g, '')}</div>}
    </div>
  );
}
