'use client';

import { useEffect, useState } from 'react';
import { useDataUid } from '@/lib/view-as';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import type { Ledger } from '@/lib/portfolio-calc';

// ── 交易日誌自動覆盤：訂閱 users/{uid}/data/tradeReview（常駐 daemon LLM）──
//
// 過期標示（2026-08-01）：覆盤是 daemon 每日 15:10 產出的**快照**，
// 使用者一改交易紀錄它就過期。先前沒有任何標示，於是同一頁上方寫
// 「總損益 -712,785」、下方重算寫 -533,480，兩個數字打架、都不敢信。
// 現在比對 stats.totalRealized 與當下帳本，不符就明講「這是舊統計」。

interface Review {
  review: string;
  generatedAt: number;
  stats?: { winRate: number; wins: number; losses: number; totalRealized?: number; basis?: string };
}

export default function PortfolioTradeReview({ ledger }: { ledger?: Ledger }) {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const [data, setData] = useState<Review | null>(null);

  useEffect(() => {
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', dataUid, 'data', 'tradeReview');
    const unsub = onSnapshot(ref, snap => { setData(snap.exists() ? (snap.data() as Review) : null); }, () => {});
    return () => unsub();
  }, [dataUid]);

  if (!data?.review) return null;

  const stored = data.stats?.totalRealized;
  const stale = !!ledger && stored != null && Math.abs(stored - ledger.totalRealized) > 1;

  return (
    <div style={{
      marginBottom: 16, padding: '16px 18px', borderRadius: 12,
      background: 'linear-gradient(135deg, rgba(34,197,94,0.06), rgba(59,130,246,0.05))',
      border: '1px solid rgba(34,197,94,0.22)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 'calc(0.95rem * var(--fz))' }}>🎓 AI 交易覆盤</span>
        {data.stats && (
          <span style={{ fontSize: 'calc(0.74rem * var(--fz))', color: 'var(--text-muted)' }}>
            勝率 {data.stats.winRate}%（{data.stats.wins}勝/{data.stats.losses}負）
          </span>
        )}
        <span style={{ fontSize: 'calc(0.72rem * var(--fz))', color: 'var(--text-muted)' }}>
          {new Date(data.generatedAt).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 產出
        </span>
      </div>
      {stale && (
        <div style={{
          fontSize: 'calc(0.76rem * var(--fz))', lineHeight: 1.6, color: '#f59e0b', marginBottom: 8,
          padding: '7px 10px', borderRadius: 8, background: 'rgba(245,158,11,0.08)',
        }}>
          ⚠ 這則覆盤是依<strong>當時的統計</strong>寫的（已實現 {Math.round(stored!).toLocaleString()}），
          與目前重算的 <strong>{Math.round(ledger!.totalRealized).toLocaleString()}</strong> 不同 ——
          下方數字才是最新。覆盤內文會在下一次 daemon 產出（每交易日 15:10）時更新。
        </div>
      )}
      <div style={{ fontSize: 'calc(0.86rem * var(--fz))', lineHeight: 1.75, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{data.review}</div>
    </div>
  );
}
