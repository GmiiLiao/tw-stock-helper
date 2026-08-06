'use client';

import { useAppStore } from './store';

// ── 🎭 身分模擬：全站「有效等級」的唯一來源 ────────────────────────
//
// 為什麼要有這支：原本每個要做權限判斷的元件各自寫
//   `const isPremium = PREMIUM_LEVELS.includes(user.level)`。
// 模擬功能一旦只改其中幾處，就會出現「導覽以為你是會員、卡片以為你不是」的
// 半套狀態——那比沒有模擬更難查。**判斷等級一律只走 useEffectiveLevel()。**
//
// 語意：模擬中 → 用模擬的等級；沒模擬 → 用自己的等級。

export const PREMIUM_LEVELS = ['premium', 'admin', 'superadmin'];

export function useEffectiveLevel(): string {
  const own = useAppStore(s => s.user?.level);
  const sim = useAppStore(s => s.viewAs?.level);
  return sim ?? own ?? '';
}

/** 是否具高級會員權限（含 admin / superadmin），已套用身分模擬。 */
export function useIsPremium(): boolean {
  const level = useEffectiveLevel();
  const hasUser = useAppStore(s => !!s.user);
  return hasUser && PREMIUM_LEVELS.includes(level);
}

/** 模擬中為 true——用來顯示警示、封鎖寫入類 UI。 */
export function useIsSimulating(): boolean {
  return useAppStore(s => !!s.viewAs);
}

// ── 讀哪個人的資料 ────────────────────────────────────────────────
// 投資組合的卡片是**各自直接訂閱 Firestore** 的，若仍用自己的 uid，
// 模擬時就會看到管理員自己的 daemon 文件——那就完全失去意義
// （2026-08-06 的白畫面正是 portfolioRisk 文件形狀造成，非模擬不可）。
// ⇒ 讀取一律走這支：模擬中讀被模擬者，否則讀自己。
export function useDataUid(): string | null {
  const own = useAppStore(s => s.user?.uid);
  const sim = useAppStore(s => s.viewAs?.uid);
  return sim ?? own ?? null;
}

/**
 * 寫入前必問。模擬中一律 false——此時畫面上的資料是別人的，
 * 任何寫入都會落到**該會員**的文件上（管理員在規則層有權限，擋不住，
 * 只能在這裡擋）。回傳 false 時呼叫端必須直接 return。
 */
export function canWriteUserData(): boolean {
  return !useAppStore.getState().viewAs;
}
