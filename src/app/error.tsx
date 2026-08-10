'use client';

import { useEffect } from 'react';

// ── 頁面層錯誤邊界（2026-08-06 補）──────────────────────────────────
//
// 事故：使用者常看到 Next.js 預設的
//   「Application error: a client-side exception has occurred」整頁死掉。
//   本專案**完全沒有 error.tsx / global-error.tsx**，所以任何一個未捕捉的例外
//   都會炸掉整個 app，畫面上只剩一行英文，使用者不知道能做什麼、我們也拿不到線索。
//
// 這裡做三件事：①講人話 ②給可執行的復原動作（重試 / 清本機狀態重載）
//              ③把 digest 顯示出來，使用者回報時我們才對得上是哪一顆錯誤。
//
// ⚠「清除本機暫存」只清 zustand 的 localStorage key，不動 Firebase 登入狀態；
//   雲端資料（自選/持股/交易）都在 Firestore，重新登入就會回來。

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[PageError]', error);
  }, [error]);

  const btn = (bg: string, color = '#fff'): React.CSSProperties => ({
    padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
    fontWeight: 800, fontSize: 13.5, background: bg, color,
  });

  return (
    <div style={{
      minHeight: '70vh', display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center',
    }}>
      <div style={{ fontSize: 40 }}>⚠️</div>
      <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-primary)' }}>這一頁暫時出了問題</div>
      <div style={{ fontSize: 13.5, color: '#dbe4f5', lineHeight: 1.9, maxWidth: 520 }}>
        你的資料都在雲端，沒有遺失。<br />
        先按「重試」；如果還是不行，按「清除本機暫存並重載」——這只清瀏覽器暫存的畫面狀態，
        自選、持倉、交易紀錄都會從雲端重新載入。
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
        <button style={btn('#3d8ef8')} onClick={() => reset()}>重試</button>
        <button style={btn('#f59e0b', '#1a1a1a')} onClick={() => {
          try { localStorage.removeItem('tw-stock-app-storage'); } catch { /* 私密模式可能不給存取 */ }
          location.reload();
        }}>清除本機暫存並重載</button>
      </div>
      {error?.digest && (
        <div style={{ fontSize: 11, color: '#a9b6d6', marginTop: 6, fontFamily: "'JetBrains Mono',monospace" }}>
          錯誤代碼 {error.digest}（回報時附上這串，我們才查得到是哪一顆）
        </div>
      )}
    </div>
  );
}
