'use client';

// ── 根層錯誤邊界（error.tsx 之上的最後一道）────────────────────────
// error.tsx 只保得住 page 內的錯；若 layout 或 providers 就炸了，
// Next.js 會改用 global-error.tsx——它必須自帶 <html>/<body>。
// 沒有這一層時，使用者看到的就是那句
// 「Application error: a client-side exception has occurred」。

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="zh-TW">
      <body style={{ margin: 0, background: '#0b1220', color: '#e2e8f7', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 'calc(44px * var(--fz))' }}>⚠️</div>
          <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 900 }}>台股助手暫時無法載入</div>
          <div style={{ fontSize: 'calc(13.5px * var(--fz))', color: '#dbe4f5', lineHeight: 1.6, maxWidth: 520 }}>
            你的自選、持倉與交易紀錄都存在雲端，沒有遺失。<br />
            先按「重新載入」；若重複發生，按「清除本機暫存並重載」。
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
            <button onClick={() => reset()}
              style={{ padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 'calc(13.5px * var(--fz))', background: '#3d8ef8', color: '#fff' }}>
              重新載入
            </button>
            <button onClick={() => {
              try { localStorage.removeItem('tw-stock-app-storage'); } catch { /* 私密模式 */ }
              location.reload();
            }}
              style={{ padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 'calc(13.5px * var(--fz))', background: '#f59e0b', color: '#1a1a1a' }}>
              清除本機暫存並重載
            </button>
          </div>
          {error?.digest && (
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#a9b6d6', marginTop: 6, fontFamily: "'JetBrains Mono', monospace" }}>
              錯誤代碼 {error.digest}
            </div>
          )}
        </div>
      </body>
    </html>
  );
}
