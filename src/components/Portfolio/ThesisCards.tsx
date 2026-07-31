'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 投資論點追蹤（thesis-tracker）──
// daemon 依當時數據預填草稿（零幻覺），此處讓使用者檢視/修改論點與信心度；
// 支柱每日自動檢核 ✓/✗，多數瓦解時 daemon 會推「論點轉弱」警報。

interface Pillar { key: string; label: string; ok: boolean }
interface Thesis { name: string; status: string; conviction: string; thesis: string; pillars: Pillar[]; risks: string[]; targetPrice: number; stopLoss: number; intact: boolean; updatedAt: number }

const CONV: Record<string, { t: string; c: string }> = {
  high: { t: '高信心', c: '#dc2626' }, medium: { t: '中信心', c: '#f59e0b' }, low: { t: '低信心', c: '#94a3b8' },
};

export default function ThesisCards() {
  const user = useAppStore(st => st.user);
  const navigateTo = useAppStore(st => st.navigateTo);
  const [theses, setTheses] = useState<Record<string, Thesis>>({});
  const [editCode, setEditCode] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!user?.uid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', user.uid, 'data', 'theses');
    const unsub = onSnapshot(ref, snap => setTheses(snap.exists() ? (snap.data().theses || {}) : {}), () => {});
    return () => unsub();
  }, [user?.uid]);

  const save = async (code: string, patch: Partial<Thesis>) => {
    if (!user?.uid) return;
    const next = { ...theses, [code]: { ...theses[code], ...patch, status: 'edited', updatedAt: Date.now() } };
    await setDoc(doc(db, 'users', user.uid, 'data', 'theses'), { theses: next, updatedAt: Date.now() }, { merge: true });
  };

  const codes = Object.keys(theses);
  if (!user?.uid || codes.length === 0) return null;

  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: 4 }}>🧩 投資論點追蹤 <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-muted)' }}>AI 依數據預填草稿，點擊論點可修改；支柱每日自動檢核</span></div>
      {codes.map(code => {
        const t = theses[code];
        const okN = (t.pillars || []).filter(p => p.ok).length;
        return (
          <div key={code} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-primary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ cursor: 'pointer', color: '#7dd3fc' }} onClick={() => navigateTo('stock', code)}>{code} {t.name}</b>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 10, background: t.intact ? 'rgba(240,62,62,0.12)' : 'rgba(47,158,68,0.12)', color: t.intact ? '#f03e3e' : '#2f9e44' }}>
                {t.intact ? `論點成立 ${okN}/${(t.pillars || []).length}` : `⚠ 論點轉弱 ${okN}/${(t.pillars || []).length}`}
              </span>
              <select value={t.conviction} onChange={e => save(code, { conviction: e.target.value })}
                style={{ fontSize: 11, padding: '1px 4px', borderRadius: 6, background: 'var(--bg-tertiary)', color: (CONV[t.conviction] || CONV.medium).c, border: '1px solid var(--border-primary)' }}>
                {Object.entries(CONV).map(([v, x]) => <option key={v} value={v}>{x.t}</option>)}
              </select>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>目標 {t.targetPrice} · 停損 {t.stopLoss}</span>
            </div>
            {editCode === code ? (
              <div style={{ marginTop: 6 }}>
                <textarea className="input" value={draft} rows={2} maxLength={200} onChange={e => setDraft(e.target.value)} style={{ width: '100%', fontSize: 13 }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button className="btn btn-buy" style={{ fontSize: 12, padding: '3px 12px' }} onClick={() => { save(code, { thesis: draft }); setEditCode(null); }}>儲存</button>
                  <button style={{ fontSize: 12, padding: '3px 12px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer' }} onClick={() => setEditCode(null)}>取消</button>
                </div>
              </div>
            ) : (
              <div onClick={() => { setEditCode(code); setDraft(t.thesis); }} title="點擊修改論點"
                style={{ marginTop: 5, fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', cursor: 'text' }}>{t.thesis}</div>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {(t.pillars || []).map(p => (
                <span key={p.key} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: p.ok ? 'rgba(240,62,62,0.10)' : 'rgba(47,158,68,0.10)', color: p.ok ? '#f03e3e' : '#2f9e44', border: `1px solid ${p.ok ? 'rgba(240,62,62,0.25)' : 'rgba(47,158,68,0.25)'}` }}>
                  {p.ok ? '✓' : '✗'} {p.label}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
