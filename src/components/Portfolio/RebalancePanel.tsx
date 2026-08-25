'use client';

import { useEffect, useState } from 'react';
import { useDataUid, canWriteUserData } from '@/lib/view-as';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 配置漂移再平衡（portfolio-rebalance）──
// 預設：單一個股 ≤25%、單一產業 ≤40%、現金 ≥10%。daemon 每日算漂移與減持試算。

interface Weight { code: string; name: string; industry: string; pct: number; mv: number }
interface IndW { industry: string; pct: number }
interface Violation { type: string; code?: string; name?: string; industry?: string; pct: number; limit: number; suggestion: string }
interface Rebal { updatedAt: number; totalStock: number; cash: number | null; cashPct: number | null; limits: { maxStockPct: number; maxIndustryPct: number; minCashPct: number }; weights: Weight[]; industryWeights: IndW[]; violations: Violation[] }

export default function RebalancePanel() {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const [data, setData] = useState<Rebal | null>(null);
  const [cashInput, setCashInput] = useState('');
  const [saveMsg, setSaveMsg] = useState('');

  useEffect(() => {
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const unsub = onSnapshot(doc(db, 'users', dataUid, 'data', 'rebalance'), snap => setData(snap.exists() ? (snap.data() as Rebal) : null), () => {});
    return () => unsub();
  }, [dataUid]);

  const saveCash = async () => {
    if (!dataUid || !canWriteUserData()) return;   // 🎭模擬中禁止寫入（畫面上的是別人的資料）
    const v = parseFloat(cashInput);
    if (!user?.uid) return;
    if (isNaN(v) || v < 0) { setSaveMsg('請輸入有效金額(元)'); return; }
    try {
      await setDoc(doc(db, 'users', dataUid, 'data', 'rebalanceSettings'), { cash: v, updatedAt: Date.now() }, { merge: true });
      setCashInput('');
      setSaveMsg(`✓ 已儲存現金 ${(v / 10000).toFixed(1)} 萬，約 1 分鐘內重新計算`);
      setTimeout(() => setSaveMsg(''), 90000);
    } catch (e) {
      setSaveMsg(`儲存失敗：${e instanceof Error ? e.message : '請重試'}`);
    }
  };

  if (!user?.uid || !data || !data.weights?.length) return null;
  const lim = data.limits;

  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 'calc(0.95rem * var(--fz))' }}>⚖️ 配置漂移檢查</span>
        <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>個股≤{lim.maxStockPct}%·產業≤{lim.maxIndustryPct}%·現金≥{lim.minCashPct}%　<b>分母＝總資產（持股＋現金）</b></span>
        <span style={{ marginLeft: 'auto', fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>
          持股市值 {(data.totalStock / 10000).toFixed(0)} 萬{data.cash != null ? ` · 現金 ${(data.cash / 10000).toFixed(0)} 萬（${data.cashPct}%）` : ''}
        </span>
      </div>

      {data.violations.length > 0 ? (
        <div style={{ marginBottom: 10 }}>
          {data.violations.map((v, i) => (
            <div key={i} style={{ fontSize: 'calc(13px * var(--fz))', lineHeight: 1.7, color: '#f59e0b' }}>
              ⚠ {v.type === 'stock' ? `${v.code} ${v.name} 佔比 ${v.pct}%` : v.type === 'industry' ? `${v.industry} ${v.pct}%` : `現金 ${v.pct}%`} — {v.suggestion}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#22c55e', marginBottom: 10 }}>✓ 配置均衡，無超限項目</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {data.weights.slice(0, 10).map(w => (
          <div key={w.code} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 46px', gap: 8, alignItems: 'center', fontSize: 'calc(12px * var(--fz))' }}>
            <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.code} {w.name}</span>
            <div style={{ position: 'relative', height: 12, background: 'var(--bg-tertiary)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ position: 'absolute', inset: 0, width: `${Math.min(w.pct / Math.max(lim.maxStockPct * 1.4, 1) * 100, 100)}%`, background: w.pct > lim.maxStockPct ? '#ef4444' : '#38bdf8', opacity: 0.85, borderRadius: 6 }} />
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${lim.maxStockPct / (lim.maxStockPct * 1.4) * 100}%`, width: 1, background: 'rgba(255,255,255,0.45)' }} />
            </div>
            <span style={{ textAlign: 'right', fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: w.pct > lim.maxStockPct ? '#ef4444' : 'var(--text-primary)' }}>{w.pct}%</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
        產業曝險：{data.industryWeights.slice(0, 5).map(iw => (
          <span key={iw.industry} style={{ padding: '2px 8px', borderRadius: 10, background: 'var(--bg-tertiary)', color: iw.pct > lim.maxIndustryPct ? '#ef4444' : 'var(--text-secondary)' }}>{iw.industry} {iw.pct}%</span>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {saveMsg && <span style={{ fontSize: 'calc(12px * var(--fz))', color: saveMsg.startsWith('✓') ? '#22c55e' : '#ef4444' }}>{saveMsg}</span>}
          <input className="input" type="number" min="0" inputMode="numeric" placeholder={data.cash != null ? `現金 ${data.cash}` : '輸入現金部位(元)'} value={cashInput}
            onChange={e => setCashInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveCash(); }} style={{ width: 150, fontSize: 'calc(12px * var(--fz))', padding: '4px 8px' }} />
          <button className="btn btn-buy" style={{ fontSize: 'calc(12px * var(--fz))', padding: '4px 10px' }} onClick={saveCash} disabled={!cashInput}>更新現金</button>
        </span>
      </div>
    </div>
  );
}
