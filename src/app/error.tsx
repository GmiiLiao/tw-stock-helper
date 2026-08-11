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

  const detail = [
    error?.digest ? `digest: ${error.digest}` : null,
    `message: ${error?.message || '(無訊息)'}`,
    error?.stack ? `stack:\n${error.stack.split('\n').slice(0, 6).join('\n')}` : null,
    typeof navigator !== 'undefined' ? `ua: ${navigator.userAgent}` : null,
    typeof location !== 'undefined' ? `url: ${location.href}` : null,
  ].filter(Boolean).join('\n');

  const btn = (bg: string, color = '#fff'): React.CSSProperties => ({
    padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
    fontWeight: 800, fontSize: 'calc(13.5px * var(--fz))', background: bg, color,
  });

  return (
    <div style={{
      minHeight: '70vh', display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center',
    }}>
      <div style={{ fontSize: 'calc(40px * var(--fz))' }}>⚠️</div>
      <div style={{ fontSize: 'calc(18px * var(--fz))', fontWeight: 900, color: 'var(--text-primary)' }}>這一頁暫時出了問題</div>
      <div style={{ fontSize: 'calc(13.5px * var(--fz))', color: '#dbe4f5', lineHeight: 1.9, maxWidth: 520 }}>
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
      {/* ⚠ 一定要把**真正的錯誤訊息**顯示出來（2026-08-11）：
          先前這裡只印 error.digest，但 digest 只有**伺服器端**錯誤才有；
          client-side 例外（hydration 不匹配、undefined 存取…）digest 是 undefined，
          於是整個區塊不渲染 —— 使用者看到一張沒有任何線索的錯誤畫面，
          回報時我們也拿不到任何可查的東西，只能靠猜。
          改成：有 digest 就印 digest，沒有就印 message + stack 前幾行，並提供一鍵複製。 */}
      <details style={{ marginTop: 10, maxWidth: 560, width: '100%' }}>
        <summary style={{ fontSize: 'calc(12px * var(--fz))', color: '#a9b6d6', cursor: 'pointer' }}>
          顯示技術細節（回報問題時請附上）
        </summary>
        <pre style={{
          marginTop: 6, padding: 10, borderRadius: 8, textAlign: 'left',
          background: 'rgba(148,163,184,0.10)', color: '#c7d2e5',
          fontSize: 'calc(11px * var(--fz))', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 180, overflow: 'auto', fontFamily: "'JetBrains Mono',monospace",
        }}>{detail}</pre>
        <button
          style={{ ...btn('#334155'), marginTop: 6, fontSize: 'calc(12px * var(--fz))' }}
          onClick={() => { navigator.clipboard?.writeText(detail).catch(() => {}); }}
        >複製錯誤訊息</button>
      </details>
    </div>
  );
}
