'use client';

import { useEffect, useState } from 'react';
import { storageRemove } from '@/lib/safe-storage';

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

// ── chunk 載入失敗＝**版本更新後的舊分頁**，不是真的壞掉（2026-08-11 使用者遇到）──
//
// 症狀：使用者看到「這一頁暫時出了問題」，細節是
//   `Loading chunk 6472 failed. (error: .../chunks/6472.28dd34f….js)` → ChunkLoadError。
//
// 成因：這是 SPA + 內容雜湊檔名的必然結果。使用者的分頁是**部署前**載入的，
//   HTML 與已載入的 runtime 記得的是舊 build 的 chunk 檔名；
//   部署後 Firebase Hosting 只服務新 release 的檔案，舊 chunk 直接 404。
//   於是只要他之後點到任何**尚未載入過**的 lazy 分頁，就會炸在這裡。
//   當天部署越多次、分頁開越久，中獎機率越高。
//
// ⇒ 正確處理是**自動重載一次**，使用者根本不該看到錯誤頁：重載會拿到新的 HTML
//   與新的 chunk 對照表，問題自動消失，狀態也都在雲端。
//   ⚠ 必須有防迴圈鎖：若重載後仍是 chunk 錯誤（例如部署到一半、CDN 尚未一致），
//     第二次就不再自動重載，改顯示錯誤頁——否則會變成無限重整，比原本更糟。
const RELOAD_KEY = 'chunk-reload-at';
const isChunkError = (e: unknown) => {
  const err = e as { name?: string; message?: string } | null;
  const msg = `${err?.name || ''} ${err?.message || ''}`;
  return /ChunkLoadError|Loading chunk \S+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(msg);
};

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const chunk = isChunkError(error);
  // 這一輪是否已經自動重載過（同一個分頁 60 秒內只自動救一次）
  const [alreadyTried] = useState(() => {
    if (typeof sessionStorage === 'undefined') return false;
    const t = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    return Date.now() - t < 60_000;
  });

  useEffect(() => {
    console.error('[PageError]', error);
    if (chunk && !alreadyTried) {
      try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* 私密模式 */ }
      // reload(true) 早已被移除；改用帶版本參數的 replace 確保拿到新的 HTML 而非 bfcache
      location.replace(location.pathname + location.search + (location.search ? '&' : '?') + '_v=' + Date.now() + location.hash);
    }
  }, [error, chunk, alreadyTried]);

  // 正在自動重載：不要閃一下錯誤頁再跳走，那比直接跳更嚇人
  if (chunk && !alreadyTried) {
    return (
      <div style={{ minHeight: '70vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 'calc(30px * var(--fz))' }}>🔄</div>
        <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800, color: 'var(--text-primary)' }}>正在更新到最新版本…</div>
        <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#dbe4f5' }}>網站剛更新過，這個分頁正在自動重新載入。</div>
      </div>
    );
  }

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
      <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 900, color: 'var(--text-primary)' }}>
        {chunk ? '網站已更新，請重新載入' : '這一頁暫時出了問題'}
      </div>
      <div style={{ fontSize: 'calc(13.5px * var(--fz))', color: '#dbe4f5', lineHeight: 1.9, maxWidth: 520 }}>
        你的資料都在雲端，沒有遺失。<br />
        {chunk
          ? '這個分頁是在網站更新前開啟的，舊版的程式檔案已經不存在。自動重載剛才沒有成功，請手動按一次「重新載入」。'
          : <>先按「重試」；如果還是不行，按「清除本機暫存並重載」——這只清瀏覽器暫存的畫面狀態，
            自選、持倉、交易紀錄都會從雲端重新載入。</>}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
        <button style={btn('#3d8ef8')} onClick={() => (chunk ? location.reload() : reset())}>{chunk ? '重新載入' : '重試'}</button>
        <button style={btn('#f59e0b', '#1a1a1a')} onClick={() => {
          storageRemove('tw-stock-app-storage');   // safe-storage 內部已吞私密模式例外
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
        <summary style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#a9b6d6', cursor: 'pointer' }}>
          顯示技術細節（回報問題時請附上）
        </summary>
        <pre style={{
          marginTop: 6, padding: 10, borderRadius: 8, textAlign: 'left',
          background: 'rgba(148,163,184,0.10)', color: '#c7d2e5',
          fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 180, overflow: 'auto', fontFamily: "'JetBrains Mono',monospace",
        }}>{detail}</pre>
        <button
          style={{ ...btn('#334155'), marginTop: 6, fontSize: 'calc(12.5px * var(--fz))' }}
          onClick={() => { navigator.clipboard?.writeText(detail).catch(() => {}); }}
        >複製錯誤訊息</button>
      </details>
    </div>
  );
}
