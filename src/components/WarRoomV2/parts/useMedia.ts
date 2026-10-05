'use client';

// 視窗寬度判斷（useSyncExternalStore：伺服器快照為 false，水合安全）。
// 手機版（<768）與桌機版是兩棵不同的樹：只掛其中一棵（不是 CSS 隱藏另一棵——隱藏的那棵照樣會跑 effect）。
import { useSyncExternalStore } from 'react';

export const MOBILE_QUERY = '(max-width: 767px)';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => (typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches),
    () => false,
  );
}

/** <768px＝手機版（S1／S2＋單欄段落） */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
