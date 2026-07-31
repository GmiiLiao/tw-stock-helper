// ── 會員權限判斷（單一事實來源）─────────────────────────────────────
// 與 Navbar／各 premium 元件同一套規則：premium/admin/superadmin 或
// 註冊後 14 天體驗期內視為有高級功能存取權。說明系統據此過濾內容，
// 確保「沒有權限的功能，說明也不出現」的一致性。

import { useMemo } from 'react';
import { useAppStore } from './store';
import { auth } from './firebase';

export const PREMIUM_LEVELS = ['premium', 'admin', 'superadmin'];
export const TRIAL_DAYS = 14;

export function usePremiumAccess(): boolean {
  const user = useAppStore(s => s.user);
  return useMemo(() => {
    if (!user?.uid) return false;
    if (PREMIUM_LEVELS.includes(user.level)) return true;
    const ct = (auth as { currentUser?: { metadata?: { creationTime?: string } } })?.currentUser?.metadata?.creationTime;
    if (!ct) return false;
    return (Date.now() - new Date(ct).getTime()) / 86400000 < TRIAL_DAYS;
  }, [user]);
}
