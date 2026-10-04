'use client';

// 🤖 會員 AI 實驗開通狀態（2026-10-01）：只有高級會員才查，一個登入期間最多每 10 分鐘問一次伺服器（/api/ai/my-ai-lab?probe=1）。
//   開通與否以伺服器為準（aiLabAccess/{uid} 只有超級管理員 API 能寫）；這裡只決定投資組合頁要不要出現「🤖 AI 實驗」分頁
//   （2026-10-01 使用者：入口由導覽列移到投資組合頁）。
// 2026-10-04（G4-24）：伺服器對「已開通但會員資格（付費等級）已失效」回 state:'disabled'、access.swing:false ⇒ 入口隱藏。
// 2026-10-04（G3-27）：結果綁定 uid——換帳號時不沿用前一個帳號的結果（先視為 false 再探測）；探測 fetch 加逾時。
import { useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import { useIsPremium } from '@/lib/view-as';

const TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;
let cache: { uid: string; swing: boolean; at: number } | null = null;

/** 後台切換開通後呼叫：下次進投資組合頁重新向伺服器確認（超級管理員開通自己測試時不必等 10 分鐘快取） */
export function invalidateAiLabAccess(): void { cache = null; }

type Result = { uid: string; swing: boolean } | null;

export function useAiLabAccess(): boolean {
  const uid = useAppStore(s => s.user?.uid ?? null);
  const isPremium = useIsPremium();
  // 結果與 uid 綁在一起：uid 一變，下方 return 立即視為 false（不必等 effect 把舊值清掉）
  const [result, setResult] = useState<Result>(() => (cache && cache.uid === uid ? { uid: cache.uid, swing: cache.swing } : null));
  useEffect(() => {
    if (!uid || !isPremium) { setResult(null); return; }
    if (cache && cache.uid === uid && Date.now() - cache.at < TTL_MS) { setResult({ uid, swing: cache.swing }); return; }
    let alive = true;
    (async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token || !alive) return;
        // 探測期間 auth 若已切到別的帳號，token 與 uid 不符 ⇒ 不採用
        if (auth.currentUser?.uid !== uid) return;
        const r = await fetch('/api/ai/my-ai-lab?probe=1', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!r.ok) return;   // 暫時失敗：維持現狀（同帳號的舊結果），下次再問
        const ok = (await r.json())?.access?.swing === true;
        cache = { uid, swing: ok, at: Date.now() };
        if (alive) setResult({ uid, swing: ok });
      } catch { /* 網路失敗／逾時：維持現狀 */ }
    })();
    return () => { alive = false; };
  }, [uid, isPremium]);
  return !!(uid && isPremium && result && result.uid === uid && result.swing);
}
