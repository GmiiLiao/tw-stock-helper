'use client';

import { useEffect, useState } from 'react';
import { useDataUid, canWriteUserData } from '@/lib/view-as';
import { doc, setDoc, arrayUnion } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 警報推播設定：訂閱 Web Push，daemon 發警報時直接推到此裝置 ──
// iOS 需 16.4+ 且先「加入主畫面」後才支援網頁推播。

const b64ToU8 = (s: string) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
};

export default function PushSetup() {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const [state, setState] = useState<'unsupported' | 'off' | 'on' | 'denied' | 'working'>('off');
  // Telegram 綁定（daemon tgLinkLoop 處理 /start <uid>；點連結→按 Start 即綁定）
  const [tg, setTg] = useState<{ botUsername: string | null; linked: boolean } | null>(null);
  useEffect(() => {
    if (!user?.uid) return;
    let live = true;
    const load = () => fetch(`/api/ai/telegram-status?uid=${user.uid}`).then(r => (r.ok ? r.json() : null)).then(x => { if (live && x) setTg(x); }).catch(() => {});
    load();
    const t = setInterval(load, 15000); // 綁定後 15 秒內顯示 ✓
    return () => { live = false; clearInterval(t); };
  }, [dataUid]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) { setState('unsupported'); return; }
    if (Notification.permission === 'denied') { setState('denied'); return; }
    navigator.serviceWorker.getRegistration('/push-sw.js').then(async reg => {
      const sub = reg && await reg.pushManager.getSubscription();
      setState(sub ? 'on' : 'off');
    }).catch(() => setState('off'));
  }, []);

  const enable = async () => {
    if (!user?.uid) return;
    if (!dataUid || !canWriteUserData()) {   // 🎭模擬中禁止寫入（會把訂閱寫進對方帳號）
      alert('身分模擬中為唯讀，無法啟用推播。'); return;
    }
    setState('working');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState('denied'); return; }
      const reg = await navigator.serviceWorker.register('/push-sw.js');
      const key = process.env.NEXT_PUBLIC_VAPID_KEY || '';
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) });
      await setDoc(doc(db, 'users', dataUid, 'data', 'pushSubs'), { subs: arrayUnion(JSON.stringify(sub.toJSON())), updatedAt: Date.now() }, { merge: true });
      setState('on');
    } catch { setState('off'); alert('啟用失敗：iOS 請先「分享→加入主畫面」後再從主畫面開啟本站啟用。'); }
  };

  if (!user?.uid) return null;
  return (
    <div style={{ marginBottom: 16, padding: '10px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      {state !== 'unsupported' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 'calc(0.9rem * var(--fz))' }}>📱 警報推播</span>
          <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>停損紀律／買點狙擊／論點轉弱等警報直接推到此裝置</span>
          {state === 'on' ? (
            <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: '#22c55e' }}>✓ 已啟用</span>
          ) : state === 'denied' ? (
            <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', color: '#ef4444' }}>已被瀏覽器封鎖，請至網站設定允許通知</span>
          ) : (
            <button onClick={enable} disabled={state === 'working'} className="btn btn-buy" style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', padding: '4px 14px' }}>
              {state === 'working' ? '啟用中…' : '啟用推播'}
            </button>
          )}
        </div>
      )}
      {/* Telegram 推播（bot 設定完成後才顯示連結按鈕） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: state !== 'unsupported' ? 8 : 0, paddingTop: state !== 'unsupported' ? 8 : 0, borderTop: state !== 'unsupported' ? '1px solid rgba(255,255,255,0.06)' : 'none' }}>
        <span style={{ fontWeight: 700, fontSize: 'calc(0.9rem * var(--fz))' }}>✈️ Telegram 推播</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>警報同步發送到 Telegram（手機免加入主畫面）</span>
        {tg?.linked ? (
          <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: '#22c55e' }}>✓ 已連結</span>
        ) : tg?.botUsername ? (
          <a href={`https://t.me/${tg.botUsername}?start=${user.uid}`} target="_blank" rel="noopener noreferrer"
            className="btn btn-buy" style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', padding: '4px 14px', textDecoration: 'none' }}>
            連結 Telegram
          </a>
        ) : (
          <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>尚未設定（管理員需設定 Bot Token）</span>
        )}
      </div>
    </div>
  );
}
