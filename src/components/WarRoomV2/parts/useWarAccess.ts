'use client';

// 盤中戰情 v2／盤前備課的兩道資格（都受身分模擬影響）：
//   ① useWarV2Allowed：v2（新版戰情、專注模式、盤前備課、新舊版切換）只限超管——2026-10-05 使用者指示
//      「v2版只有超管可以用，暫不開放其它人使用」。超管模擬其他會員時，看到的是該會員的舊版戰情。
//   ② useWarAccess：高級會員（含 admin／superadmin）或新註冊 14 天體驗期——與舊版 WarRoom、Navbar 同一口徑。
// 「v2 有沒有生效」的判斷點一律共用 ①／useWarV2Layout，不要各自讀 user.level 或 warLayout：
//   page.tsx（版面、專注模式、舊版切換列）、Navbar（盤前備課入口）、PrepRoom（入口守門）、
//   CandidateDock（決策工作台去向）、DecisionDesk（撿股去向）。
import { useAppStore } from '@/lib/store';
import { useEffectiveLevel, useIsPremium } from '@/lib/view-as';
import { auth } from '@/lib/firebase';

const TRIAL_DAYS = 14;
const DAY_MS = 86_400_000;
/** 可使用盤中戰情 v2 的有效等級（暫不開放其他等級） */
const WAR_V2_LEVEL = 'superadmin';

export function useWarAccess(): boolean {
  const isPremium = useIsPremium();
  const uid = useAppStore((s) => s.user?.uid ?? null);
  if (isPremium) return true;
  if (!uid) return false;
  const ct = (auth as { currentUser?: { metadata?: { creationTime?: string } } })?.currentUser?.metadata?.creationTime;
  return !!ct && (Date.now() - new Date(ct).getTime()) / DAY_MS < TRIAL_DAYS;
}

/** 可否使用盤中戰情 v2／盤前備課：已登入且有效等級（已套用身分模擬）為超管。未登入、一般、高級會員、admin 一律 false。
 *  站長 email（NEXT_PUBLIC_ADMIN_EMAIL）與 AdminPanel 的 isSuper 同口徑也算超管——但只在**沒有模擬**時；模擬中只看被模擬者的等級。 */
export function useWarV2Allowed(): boolean {
  const level = useEffectiveLevel();
  const hasUser = useAppStore((s) => !!s.user);
  const simulating = useAppStore((s) => !!s.viewAs);
  const email = useAppStore((s) => s.user?.email ?? null);
  const ownerEmail = process.env.NEXT_PUBLIC_ADMIN_EMAIL;
  if (!hasUser) return false;
  if (level === WAR_V2_LEVEL) return true;
  return !simulating && !!ownerEmail && email === ownerEmail;
}

/**
 * 目前生效的戰情版面是不是 v2：有 v2 資格，且版面偏好不是 'classic'（非 classic 一律視為 v2——persist 的舊／壞值兜底）。
 * 沒有 v2 資格 ⇒ 永遠 false，完全不看 warLayout（store 預設是 'v2'，非超管也會帶著這個值）。
 */
export function useWarV2Layout(): boolean {
  const allowed = useWarV2Allowed();
  const warLayout = useAppStore((s) => s.warLayout);
  return allowed && warLayout !== 'classic';
}
