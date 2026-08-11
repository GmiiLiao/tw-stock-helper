'use client';

import { useEffect, useState } from 'react';
import { useDataUid } from '@/lib/view-as';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 汰弱留強輪動建議：持股評分 vs 全市場百分位，弱勢持股顯示機會成本 ──

interface Item { code: string; name: string; score: number | null; percentile: number | null; signal: string | null; weak: boolean; note: string | null }
interface Alt { code: string; name: string; score: number; signal: string }
interface Doc { updatedAt: number; topAvg: number; items: Item[]; alternatives: Alt[] }

export default function RotationAdvice() {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const navigateTo = useAppStore(st => st.navigateTo);
  const [data, setData] = useState<Doc | null>(null);

  useEffect(() => {
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const unsub = onSnapshot(doc(db, 'users', dataUid, 'data', 'rotation'), snap => setData(snap.exists() ? (snap.data() as Doc) : null), () => {});
    return () => unsub();
  }, [dataUid]);

  if (!data?.items?.length) return null;
  const weak = data.items.filter(i => i.weak);

  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: weak.length ? '1px solid rgba(249,115,22,0.4)' : '1px solid var(--border-primary)' }}>
      <div style={{ fontWeight: 700, fontSize: 'calc(0.95rem * var(--fz))', marginBottom: 8 }}>♻️ 汰弱留強檢查
        <span style={{ fontWeight: 400, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', marginLeft: 8 }}>持股評分 vs 全市場（每日收盤後更新）</span>
      </div>
      {data.items.map(i => (
        <div key={i.code} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-primary)', fontSize: 'calc(13px * var(--fz))' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b style={{ color: '#7dd3fc', cursor: 'pointer' }} onClick={() => navigateTo('stock', i.code)}>{i.code} {i.name}</b>
            <span>評分 <b style={{ color: i.weak ? '#f97316' : '#fbbf24' }}>{i.score ?? '—'}</b></span>
            {i.percentile != null && <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>市場前 {100 - i.percentile}%</span>}
            {i.weak && <span style={{ marginLeft: 'auto', fontSize: 'calc(11px * var(--fz))', fontWeight: 700, color: '#f97316' }}>⚠ 弱勢</span>}
          </div>
          {i.note && <div style={{ marginTop: 3, fontSize: 'calc(12px * var(--fz))', color: '#f97316', lineHeight: 1.6 }}>{i.note}</div>}
        </div>
      ))}
      {weak.length > 0 && data.alternatives?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-secondary)' }}>
          目前評分最強替代參考：{data.alternatives.map(a => (
            <span key={a.code} onClick={() => navigateTo('stock', a.code)} style={{ cursor: 'pointer', marginRight: 8, color: '#7dd3fc' }}>
              {a.code} {a.name}（<b style={{ color: '#fbbf24' }}>{a.score}</b>）
            </span>
          ))}
          <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>※ 依五大因子技術評分之數據比較，非個股買賣建議；轉倉另計交易成本約 0.6%。</div>
        </div>
      )}
    </div>
  );
}
