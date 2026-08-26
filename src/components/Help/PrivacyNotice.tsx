'use client';

// ── 🔒 隱私聲明頁＋首次告知橫幅 ───────────────────────────────────
// PrivacyPage：說明記錄哪些資料、用途、對外展示規則（匿名彙總）。
// ConsentBanner：登入後首次一次性告知（localStorage + users doc 標記），
// 「我知道了」即收合；連結至完整聲明頁。

import { useEffect, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

const SECTIONS: { t: string; items: string[] }[] = [
  {
    t: '我們記錄哪些資料',
    items: [
      '帳號資料：Email、暱稱、會員等級、登入時間。',
      '操作記錄：造訪的頁面與功能（如開啟盤中戰情、加入候選、查看某檔個股）、操作時間。',
      '交易記錄：你在本站手動記錄的買賣（價格、張數、費用稅金、損益）——僅你自己輸入的，本站無法也不會存取你的券商帳戶。',
      '決策歸因快照：你記錄「買入」當下，該股出現在哪些榜單、評分與你近 30 分鐘的頁面足跡——用於分析「哪些功能真的幫助提高勝率」。',
    ],
  },
  {
    t: '這些資料的用途',
    items: [
      '個人功能：投組損益計算、籌碼判讀警示、決策工作台、成績追蹤——都需要你的交易記錄才能運作。',
      '產品改善：分析哪些功能被使用、哪些決策路徑勝率較高，回饋成更好的選股引導。',
      '成效統計：以「匿名、彙總」形式計算平台整體勝率與使用狀況（例：全站使用者平均勝率）。',
    ],
  },
  {
    t: '對外展示規則',
    items: [
      '對外（含招募、行銷）只使用匿名彙總數據，絕不出現可識別個人的資訊或個別損益。',
      '你的交易明細與損益僅你本人與站方管理員可見；管理員檢視僅用於服務維運與統計。',
      '所有資料每日備份於站方受控環境，不出售、不提供第三方。',
    ],
  },
  {
    t: '你的選擇',
    items: [
      '不想被記錄操作行為？目前記錄僅在登入狀態發生——登出瀏覽即不記錄個人化行為。',
      '刪除帳號或資料：聯繫 nicholas@gmii.tw，我們會在合理期間內刪除你的個人資料。',
    ],
  },
];

/** 隱私聲明內文（2026-08-27 起併入使用說明書，故抽成可重用元件）。
 *  獨立頁 PrivacyPage 保留但只是薄殼——舊連結（同意橫幅、外部書籤）不會壞。 */
export function PrivacyContent() {
  return (
    <div style={{ fontSize: 'calc(13px * var(--fz))', lineHeight: 1.9 }}>
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 12 }}>
        更新日期：2026-07-17 · 台股助手 TW Stock Pro
      </div>
      {SECTIONS.map(sec => (
        <div key={sec.t} style={{ marginBottom: 14, padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>{sec.t}</div>
          {sec.items.map((it, i) => <div key={i} style={{ color: 'var(--text-secondary)' }}>· {it}</div>)}
        </div>
      ))}
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
        本站為投資分析工具，非證券商亦非投資顧問；所有資料與統計僅供參考，非投資建議。
      </div>
    </div>
  );
}

export function PrivacyPage() {
  const navigateTo = useAppStore(s => s.navigateTo);
  return (
    <div style={{ padding: '14px 16px', maxWidth: 780, margin: '0 auto' }}>
      <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 900, marginBottom: 4 }}>🔒 隱私聲明</div>
      <PrivacyContent />
      <button onClick={() => navigateTo('help')}
        style={{ marginTop: 14, padding: '7px 16px', borderRadius: 10, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, cursor: 'pointer', border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-secondary)' }}>
        ← 回使用說明書
      </button>
    </div>
  );
}

const ACK_KEY = 'privacyAckV1';

export function ConsentBanner() {
  const user = useAppStore(s => s.user);
  const navigateTo = useAppStore(s => s.navigateTo);
  const currentPage = useAppStore(s => s.currentPage);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!user?.uid) { setShow(false); return; }
    try { setShow(localStorage.getItem(ACK_KEY) !== '1'); } catch { setShow(false); }
  }, [user?.uid]);

  if (!show || currentPage === 'privacy') return null;

  const ack = () => {
    try { localStorage.setItem(ACK_KEY, '1'); } catch { /* ignore */ }
    setShow(false);
    const u = auth?.currentUser;
    if (u) setDoc(doc(db, 'users', u.uid), { privacyAckAt: Date.now() }, { merge: true }).catch(() => {});
  };

  return (
    <div style={{ position: 'fixed', left: 12, right: 12, bottom: 12, zIndex: 950, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{ pointerEvents: 'auto', maxWidth: 720, width: '100%', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '10px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid rgba(125,211,252,0.4)', boxShadow: '0 8px 28px rgba(0,0,0,0.4)', fontSize: 'calc(12.5px * var(--fz))' }}>
        <span style={{ flex: '1 1 320px', lineHeight: 1.7 }}>
          🔒 為提供投組損益、決策分析與服務改善，本站會記錄你的操作與交易記錄（僅你輸入的）；對外只使用匿名彙總。
          <b onClick={() => navigateTo('privacy')} style={{ color: '#7dd3fc', cursor: 'pointer', marginLeft: 4 }}>閱讀完整隱私聲明</b>
        </span>
        <button onClick={ack}
          style={{ padding: '7px 18px', borderRadius: 10, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, cursor: 'pointer', border: 'none', background: 'linear-gradient(135deg,#3d8ef8,#7dd3fc)', color: '#fff' }}>
          我知道了
        </button>
      </div>
    </div>
  );
}
