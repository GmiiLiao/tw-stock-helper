'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 交易日誌自動覆盤：訂閱 users/{uid}/data/tradeReview（常駐 daemon LLM）──

interface Review { review: string; generatedAt: number; stats?: { winRate: number; wins: number; losses: number } }

export default function PortfolioTradeReview() {
  const user = useAppStore(st => st.user);
  const [data, setData] = useState<Review | null>(null);

  useEffect(() => {
    if (!user?.uid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', user.uid, 'data', 'tradeReview');
    const unsub = onSnapshot(ref, snap => { setData(snap.exists() ? (snap.data() as Review) : null); }, () => {});
    return () => unsub();
  }, [user?.uid]);

  if (!data?.review) return null;

  return (
    <div style={{
      marginBottom: 16, padding: '16px 18px', borderRadius: 12,
      background: 'linear-gradient(135deg, rgba(34,197,94,0.06), rgba(59,130,246,0.05))',
      border: '1px solid rgba(34,197,94,0.22)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>🎓 AI 交易覆盤</span>
        {data.stats && (
          <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
            勝率 {data.stats.winRate}%（{data.stats.wins}勝/{data.stats.losses}負）
          </span>
        )}
      </div>
      <div style={{ fontSize: '0.86rem', lineHeight: 1.75, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{data.review}</div>
    </div>
  );
}
