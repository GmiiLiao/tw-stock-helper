'use client';

import { useEffect, useState } from 'react';
import { useDataUid } from '@/lib/view-as';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import CostReference from '@/components/shared/CostReference';
import RiskBadge from '@/components/shared/RiskBadge';
import { RISK_NOTE, topPctText, type Risk } from './riskLabel';

// ── 汰弱留強檢查：持股技術評分 vs 全市場百分位 ──
// 2026-09-30 修正（使用者「為何論點相反」）：強弱改用「未含風險扣分」的技術評分；處置／注意另列為交易風險，不再當成弱勢；
//   附 20／60 日漲幅（事實）；不再給「續抱等於放棄轉倉機會」的建議（波段強弱尚無通過驗證的預測模型）。

interface Item { code: string; name: string; score: number | null; scoreAdj?: number | null; percentile: number | null; signal: string | null; risk?: Risk; ret20?: number | null; ret60?: number | null; weak: boolean; note: string | null }
const pctTxt = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
interface Alt { code: string; name: string; score: number; signal: string }
interface Doc { updatedAt: number; topAvg: number; items: Item[]; alternatives: Alt[] }

export default function RotationAdvice() {
  const dt = useDayTradeCodes();   // 當沖資格：必須在任何 early return 之前
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
  const legacy = !(data as { basis?: string }).basis;   // 舊版文件（評分含風險扣分）：提示等待今日重算

  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: weak.length ? '1px solid rgba(249,115,22,0.4)' : '1px solid var(--border-primary)' }}>
      <div style={{ fontWeight: 700, fontSize: 'calc(0.95rem * var(--fz))', marginBottom: 8 }}>♻️ 汰弱留強檢查
        <span style={{ fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginLeft: 8 }}>持股技術評分（未含風險扣分）vs 全市場；處置／注意另列風險（每日收盤後更新）</span>
      </div>
      {legacy && <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#fbbf24', marginBottom: 6 }}>⚠ 下方仍是舊口徑（評分含處置／注意扣分），今日收盤後重算。</div>}
      {data.items.map(i => (
        <div key={i.code} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-primary)', fontSize: 'calc(13px * var(--fz))' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b style={{ color: '#7dd3fc', cursor: 'pointer' }} onClick={() => navigateTo('stock', i.code)}>{i.code} {i.name}</b> {(() => { const st = statusOf(dt, i.code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()}
            <span>技術評分 <b style={{ color: i.weak ? '#f97316' : '#fbbf24' }}>{i.score != null ? +i.score.toFixed(2) : '—'}</b></span>
            {i.percentile != null && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{topPctText(i.percentile)}</span>}
            <RiskBadge code={i.code} size="xs" />
            {i.weak && <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: '#f97316' }}>⚠ 技術面偏弱</span>}
          </div>
          {(i.ret20 != null || i.ret60 != null) && (
            <div style={{ marginTop: 2, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
              近 20 日 <span style={{ color: (i.ret20 ?? 0) >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{pctTxt(i.ret20)}</span>
              ·近 60 日 <span style={{ color: (i.ret60 ?? 0) >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{pctTxt(i.ret60)}</span>
              {i.risk && i.scoreAdj != null && <span title={RISK_NOTE[i.risk]} style={{ cursor: 'help' }}>·排序用評分（含風險扣分）{+i.scoreAdj.toFixed(2)} ⓘ</span>}
            </div>
          )}
          {i.note && <div style={{ marginTop: 3, fontSize: 'calc(13px * var(--fz))', color: '#f97316', lineHeight: 1.6 }}>{i.note.replace(/(\d+\.\d{2})\d+/g, '$1')}</div>}
        </div>
      ))}
      {weak.length > 0 && data.alternatives?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-secondary)' }}>
          目前評分最高（已排除處置／注意風險）參考：{data.alternatives.map(a => (
            <span key={a.code} onClick={() => navigateTo('stock', a.code)} style={{ cursor: 'pointer', marginRight: 8, color: '#7dd3fc' }}>
              {a.code} {a.name}（<b style={{ color: '#fbbf24' }}>{+a.score.toFixed(2)}</b>）
            </span>
          ))}
          <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>※ 技術評分是當日技術面的描述，不是未來報酬的預測（波段強弱預測模型影子測試中）；非個股買賣建議。</div>
          <div style={{ marginTop: 2, color: 'var(--text-muted)' }}><CostReference holdDays={[5, 20]} /></div>
        </div>
      )}
    </div>
  );
}
