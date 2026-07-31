'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc, arrayUnion } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── RAG 問 AI：寫問題到 users/{uid}/data/questions，常駐 daemon 用第二大腦資料
//    + 本地 LLM 回答後回寫，這裡即時訂閱顯示。 ──

const PREMIUM = ['premium', 'admin', 'superadmin'];

interface QA { id: string; code: string; question: string; answer?: string; status: string; at: number }

export default function StockAsk({ code, name }: { code: string; name: string }) {
  const user = useAppStore(s => s.user);
  const isPremium = !!user && PREMIUM.includes(user.level);
  const [items, setItems] = useState<QA[]>([]);
  const [q, setQ] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!user?.uid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', user.uid, 'data', 'questions');
    const unsub = onSnapshot(ref, snap => {
      const all = (snap.exists() ? (snap.data().items || []) : []) as QA[];
      setItems(all.filter(x => x.code === code).sort((a, b) => b.at - a.at).slice(0, 10));
    }, () => {});
    return () => unsub();
  }, [user?.uid, code]);

  const send = async () => {
    if (!q.trim() || !user?.uid || sending) return;
    setSending(true);
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, code, name, question: q.trim().slice(0, 200), status: 'pending', at: Date.now() };
    try {
      await setDoc(doc(db, 'users', user.uid, 'data', 'questions'), { items: arrayUnion(item) }, { merge: true });
      setQ('');
    } catch { alert('送出失敗，請稍後再試'); }
    setSending(false);
  };

  if (!isPremium) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🔒</div>
        <div>「問 AI」為高級會員專屬功能</div>
        <div style={{ fontSize: 13, marginTop: 6, opacity: 0.8 }}>本地 AI 依第二大腦資料回答你對個股的提問</div>
      </div>
    );
  }

  const suggestions = ['這檔現在可以買嗎？', '支撐和壓力在哪？', '籌碼面如何？', '最近有什麼利多利空？'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        🧠 問 AI 關於 <b style={{ color: 'var(--text-secondary)' }}>{code} {name}</b> 的問題 —— 本地 AI 會根據第二大腦的技術/籌碼/新聞資料回答（約 10–40 秒）。
      </div>

      {/* 輸入 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input" value={q} maxLength={200}
          placeholder="輸入你的問題…"
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          style={{ flex: 1 }}
        />
        <button className="btn btn-buy" onClick={send} disabled={sending || !q.trim()}>送出</button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {suggestions.map(s => (
          <button key={s} onClick={() => setQ(s)} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 14, border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer' }}>{s}</button>
        ))}
      </div>

      {/* 對話串 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
        {items.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>還沒有提問。試試上面的建議問題。</div>}
        {items.map(it => (
          <div key={it.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ alignSelf: 'flex-end', maxWidth: '85%', padding: '8px 12px', borderRadius: '12px 12px 2px 12px', background: 'var(--accent-purple, #6366f1)', color: '#fff', fontSize: 14 }}>{it.question}</div>
            <div style={{ alignSelf: 'flex-start', maxWidth: '90%', padding: '10px 14px', borderRadius: '12px 12px 12px 2px', background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', fontSize: 14, lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
              {it.status === 'pending'
                ? <span style={{ color: 'var(--text-muted)' }}>🤔 本地 AI 思考中…</span>
                : (it.answer || '（無回應）')}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
