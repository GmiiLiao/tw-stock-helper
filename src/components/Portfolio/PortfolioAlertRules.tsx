'use client';

import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, setDoc, arrayUnion } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 自訂條件警報：使用者設定到價/漲跌幅條件，daemon 盤中觸發即推播。 ──

interface Rule { id: string; code: string; name: string; type: string; value: number }

const TYPES = [
  { v: 'price_above', t: '漲破(元)' },
  { v: 'price_below', t: '跌破(元)' },
  { v: 'pct_above', t: '漲幅≥(%)' },
  { v: 'pct_below', t: '跌幅≥(%)' },
];
const typeLabel = (t: string) => TYPES.find(x => x.v === t)?.t || t;

export default function PortfolioAlertRules() {
  const user = useAppStore(st => st.user);
  const allStocks = useAppStore(st => st.allStocks);
  const [rules, setRules] = useState<Rule[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<{ code: string; name: string } | null>(null);
  const [type, setType] = useState('price_above');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!user?.uid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', user.uid, 'data', 'alertRules');
    const unsub = onSnapshot(ref, snap => setRules(snap.exists() ? (snap.data().rules || []) : []), () => {});
    return () => unsub();
  }, [user?.uid]);

  const matches = useMemo(() => {
    if (!search || search.length < 1) return [];
    return allStocks.filter(s => /^\d{4,5}$/.test(s.code) && (s.code.includes(search) || s.name.includes(search))).slice(0, 6);
  }, [search, allStocks]);

  const save = async (next: Rule[]) => {
    if (!user?.uid) return;
    await setDoc(doc(db, 'users', user.uid, 'data', 'alertRules'), { rules: next, updatedAt: Date.now() }, { merge: true });
  };
  const add = async () => {
    const v = parseFloat(value);
    if (!picked || isNaN(v) || v <= 0 || !user?.uid) return;
    const rule: Rule = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, code: picked.code, name: picked.name, type, value: v };
    await setDoc(doc(db, 'users', user.uid, 'data', 'alertRules'), { rules: arrayUnion(rule), updatedAt: Date.now() }, { merge: true });
    setPicked(null); setSearch(''); setValue(''); setOpen(false);
  };
  const remove = (id: string) => save(rules.filter(r => r.id !== id));

  if (!user?.uid) return null;

  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: rules.length || open ? 10 : 0 }}>
        <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>🔔 自訂條件警報</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>({rules.length})</span>
        <button onClick={() => setOpen(o => !o)} style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 12px', borderRadius: 8, background: 'var(--accent-purple,#6366f1)', color: '#fff', border: 'none', cursor: 'pointer' }}>
          {open ? '取消' : '+ 新增'}
        </button>
      </div>

      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginBottom: 10, padding: 10, background: 'var(--bg-tertiary)', borderRadius: 8 }}>
          <div style={{ position: 'relative', flex: '1 1 160px' }}>
            <input className="input" placeholder="搜尋股票" value={picked ? `${picked.code} ${picked.name}` : search}
              onChange={e => { setSearch(e.target.value); setPicked(null); }} style={{ width: '100%' }} />
            {!picked && matches.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: 8, marginTop: 2, maxHeight: 160, overflowY: 'auto' }}>
                {matches.map(s => (
                  <div key={s.code} onClick={() => { setPicked({ code: s.code, name: s.name }); setSearch(''); }} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                    <b>{s.code}</b><span style={{ color: 'var(--text-muted)' }}>{s.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <select className="input" value={type} onChange={e => setType(e.target.value)} style={{ width: 110 }}>
            {TYPES.map(t => <option key={t.v} value={t.v}>{t.t}</option>)}
          </select>
          <input className="input" type="number" placeholder="數值" value={value} onChange={e => setValue(e.target.value)} style={{ width: 90 }} />
          <button onClick={add} disabled={!picked || !value} className="btn btn-buy">加入</button>
        </div>
      )}

      {rules.map(r => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '5px 0', borderBottom: '1px solid var(--border-primary)' }}>
          <b>{r.code}</b><span style={{ color: 'var(--text-muted)' }}>{r.name}</span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>{typeLabel(r.type)} <b>{r.value}</b></span>
          <button onClick={() => remove(r.id)} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 6, background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)', cursor: 'pointer' }}>🗑️</button>
        </div>
      ))}
    </div>
  );
}
