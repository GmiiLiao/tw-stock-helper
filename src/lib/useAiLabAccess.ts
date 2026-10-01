'use client';

// 🤖 會員 AI 實驗開通狀態（2026-10-01）：只有高級會員才查，一個登入期間最多每 10 分鐘問一次伺服器（/api/ai/my-ai-lab?probe=1）。
//   開通與否以伺服器為準（aiLabAccess/{uid} 只有超級管理員 API 能寫）；這裡只決定投資組合頁要不要出現「🤖 AI 實驗」分頁
//   （2026-10-01 使用者：入口由導覽列移到投資組合頁）。
import { useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import { useIsPremium } from '@/lib/view-as';

const TTL_MS = 10 * 60_000;
let cache: { uid: string; swing: boolean; at: number } | null = null;

export function useAiLabAccess(): boolean {
  const uid = useAppStore(s => s.user?.uid ?? null);
  const isPremium = useIsPremium();
  const [swing, setSwing] = useState(() => !!(cache && cache.uid === uid && cache.swing));
  useEffect(() => {
    if (!uid || !isPremium) { setSwing(false); return; }
    if (cache && cache.uid === uid && Date.now() - cache.at < TTL_MS) { setSwing(cache.swing); return; }
    let alive = true;
    (async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) return;
        const r = await fetch('/api/ai/my-ai-lab?probe=1', { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;   // 暫時失敗：維持現狀，下次再問
        const ok = (await r.json())?.access?.swing === true;
        cache = { uid, swing: ok, at: Date.now() };
        if (alive) setSwing(ok);
      } catch { /* 網路失敗：維持現狀 */ }
    })();
    return () => { alive = false; };
  }, [uid, isPremium]);
  return swing;
}
