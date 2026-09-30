'use client';

import { useEffect, useState } from 'react';
import { useDataUid, canWriteUserData } from '@/lib/view-as';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import RiskBadge from '@/components/shared/RiskBadge';
import { RISK_NOTE, topPctText, type Risk } from './riskLabel';

// ── 投資論點追蹤（thesis-tracker）──
// daemon 依當時數據預填草稿（零幻覺），此處讓使用者檢視/修改論點與信心度；
// 支柱每日自動檢核 ✓/✗，多數瓦解時 daemon 會推「論點轉弱」警報。
// 2026-09-30 論點加評分補強：支持度（描述目前證據、非預測）、技術評分（未含風險扣分）與百分位、
//   目前的處置／注意風險（另列，不混進走勢判斷）、不在論點裡的其他指標（參考）。

interface Pillar { key: string; label: string; ok: boolean }
interface Tech { base: number | null; adj: number | null; pct: number | null }
interface Thesis {
  name: string; status: string; conviction: string; thesis: string; pillars: Pillar[]; risks: string[]; targetPrice: number; stopLoss: number; intact: boolean; updatedAt: number;
  refs?: Pillar[]; support?: number | null; tech?: Tech; risk?: Risk;   // daemon 每日重算（舊文件沒有）
}
const SUPPORT_TIP = '支持度＝(2×論點支柱成立數＋其他指標成立數)÷(2×支柱數＋其他指標數)×100。描述目前的證據有多少站在論點這邊，不是報酬預測。';
const supportColor = (v: number) => (v >= 60 ? '#f03e3e' : v >= 40 ? '#fbbf24' : '#2f9e44');

const CONV: Record<string, { t: string; c: string }> = {
  high: { t: '高信心', c: '#dc2626' }, medium: { t: '中信心', c: '#f59e0b' }, low: { t: '低信心', c: '#94a3b8' },
};

export default function ThesisCards() {
  const dt = useDayTradeCodes();   // 當沖資格：必須在任何 early return 之前
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const navigateTo = useAppStore(st => st.navigateTo);
  const [theses, setTheses] = useState<Record<string, Thesis>>({});
  const [editCode, setEditCode] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', dataUid, 'data', 'theses');
    const unsub = onSnapshot(ref, snap => setTheses(snap.exists() ? (snap.data().theses || {}) : {}), () => {});
    return () => unsub();
  }, [dataUid]);

  const save = async (code: string, patch: Partial<Thesis>) => {
    if (!dataUid || !canWriteUserData()) return;   // 🎭模擬中禁止寫入（畫面上的是別人的資料）
    if (!user?.uid) return;
    const next = { ...theses, [code]: { ...theses[code], ...patch, status: 'edited', updatedAt: Date.now() } };
    await setDoc(doc(db, 'users', dataUid, 'data', 'theses'), { theses: next, updatedAt: Date.now() }, { merge: true });
  };

  const codes = Object.keys(theses);
  if (!user?.uid || codes.length === 0) return null;

  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ fontWeight: 700, fontSize: 'calc(0.95rem * var(--fz))', marginBottom: 4 }}>🧩 投資論點追蹤 <span style={{ fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>AI 依數據預填草稿，點擊論點可修改；支柱每日自動檢核</span></div>
      {codes.map(code => {
        const t = theses[code];
        const okN = (t.pillars || []).filter(p => p.ok).length;
        return (
          <div key={code} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-primary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ cursor: 'pointer', color: '#7dd3fc' }} onClick={() => navigateTo('stock', code)}>{code} {t.name}</b> {(() => { const st = statusOf(dt, code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()}
              <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '1px 8px', borderRadius: 10, background: t.intact ? 'rgba(240,62,62,0.12)' : 'rgba(47,158,68,0.12)', color: t.intact ? '#f03e3e' : '#2f9e44' }}>
                {t.intact ? `論點成立 ${okN}/${(t.pillars || []).length}` : `⚠ 論點轉弱 ${okN}/${(t.pillars || []).length}`}
              </span>
              {t.support != null && (
                <span title={SUPPORT_TIP} style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: supportColor(t.support), cursor: 'help' }}>支持度 {t.support}</span>
              )}
              <RiskBadge code={code} size="xs" />
              <select value={t.conviction} onChange={e => save(code, { conviction: e.target.value })}
                style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '1px 4px', borderRadius: 6, background: 'var(--bg-tertiary)', color: (CONV[t.conviction] || CONV.medium).c, border: '1px solid var(--border-primary)' }}>
                {Object.entries(CONV).map(([v, x]) => <option key={v} value={v}>{x.t}</option>)}
              </select>
              <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>目標 {t.targetPrice} · 停損 {t.stopLoss}</span>
            </div>
            {editCode === code ? (
              <div style={{ marginTop: 6 }}>
                <textarea className="input" value={draft} rows={2} maxLength={200} onChange={e => setDraft(e.target.value)} style={{ width: '100%', fontSize: 'calc(13.5px * var(--fz))' }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button className="btn btn-buy" style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '3px 12px' }} onClick={() => { save(code, { thesis: draft }); setEditCode(null); }}>儲存</button>
                  <button style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '3px 12px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer' }} onClick={() => setEditCode(null)}>取消</button>
                </div>
              </div>
            ) : (
              <div onClick={() => { setEditCode(code); setDraft(t.thesis); }} title="點擊修改論點"
                style={{ marginTop: 5, fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6, color: 'var(--text-secondary)', cursor: 'text' }}>{t.thesis}</div>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {(t.pillars || []).map(p => (
                <span key={p.key} style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '2px 8px', borderRadius: 10, background: p.ok ? 'rgba(240,62,62,0.10)' : 'rgba(47,158,68,0.10)', color: p.ok ? '#f03e3e' : '#2f9e44', border: `1px solid ${p.ok ? 'rgba(240,62,62,0.25)' : 'rgba(47,158,68,0.25)'}` }}>
                  {p.ok ? '✓' : '✗'} {p.label}
                </span>
              ))}
            </div>
            {(t.refs?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 5 }}>
                <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>參考（不在論點內）</span>
                {t.refs!.map(p => (
                  <span key={p.key} style={{ fontSize: 'calc(12px * var(--fz))', padding: '1px 7px', borderRadius: 10, color: 'var(--text-muted)', border: '1px dashed var(--border-primary)' }}>
                    {p.ok ? '✓' : '✗'} {p.label}
                  </span>
                ))}
              </div>
            )}
            {t.tech?.base != null && (
              <div style={{ marginTop: 5, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
                技術評分（未含風險扣分）<b style={{ color: 'var(--text-secondary)' }}>{t.tech.base}</b>
                {t.tech.pct != null && <>·{topPctText(t.tech.pct)}</>}
                {t.risk && t.tech.adj != null && <span title={RISK_NOTE[t.risk]} style={{ cursor: 'help' }}>·排序用評分（含風險扣分）{t.tech.adj} ⓘ</span>}
                <span>·描述目前狀態，非報酬預測；非投資建議</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
