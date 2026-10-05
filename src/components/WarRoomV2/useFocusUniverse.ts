'use client';

// A2 時段焦點要看的「我的池」：持股、自選、候選（＋候選便條）、當日釘選，以及代號→名稱查詢。
// 全是使用者本機狀態（zustand 已由 useFirebaseSync 同步）；聚合路由不帶任何個人參數，挑選在前端做。
import { useCallback, useMemo } from 'react';
import { useAppStore } from '@/lib/store';
import { useWarData, useWarUi } from './WarRoomContext';

const CODE_RE = /^\d{4,6}$/;
const EMPTY: readonly string[] = Object.freeze([]);

function uniqueCodes(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of codes) {
    if (!CODE_RE.test(c) || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

export interface FocusUniverse {
  /** 持股代號（依建立順序、去重） */
  holdings: readonly string[];
  /** 自選（舊版清單＋各群組，去重） */
  watchlist: readonly string[];
  /** 候選（＋候選便條），不含已是持股者 */
  candidates: readonly string[];
  /** 當日釘選，不含已是持股者 */
  pinned: readonly string[];
  /** 代號→名稱（匯流排報價 → 持股 → 自選 → 首屏全市場清單）；查不到回 '' */
  nameOf: (code: string) => string;
}

export function useFocusUniverse(): FocusUniverse {
  const holdingsRaw = useAppStore((s) => s.holdings);
  const watchRaw = useAppStore((s) => s.watchlist);
  const groups = useAppStore((s) => s.watchlistGroups);
  const candRaw = useAppStore((s) => s.compareCodes);
  const allStocks = useAppStore((s) => s.allStocks);
  const { quotes } = useWarData();
  const { pinned: pinnedRaw } = useWarUi();

  const base = useMemo(() => {
    const names = new Map<string, string>();
    for (const h of holdingsRaw.slice()) if (h?.code && h.name) names.set(h.code, h.name);
    const watchItems = [...watchRaw.slice(), ...groups.slice().flatMap((g) => (g?.stocks ?? []).slice())];
    for (const w of watchItems) if (w?.code && w.name && !names.has(w.code)) names.set(w.code, w.name);
    const holdings = uniqueCodes(holdingsRaw.slice().map((h) => h?.code ?? ''));
    const held = new Set(holdings);
    return {
      names,
      holdings,
      watchlist: uniqueCodes(watchItems.map((w) => w?.code ?? '')),
      candidates: uniqueCodes((candRaw ?? EMPTY).slice()).filter((c) => !held.has(c)),
      pinned: uniqueCodes(pinnedRaw.slice()).filter((c) => !held.has(c)),
    };
  }, [holdingsRaw, watchRaw, groups, candRaw, pinnedRaw]);

  // 全市場清單只在查不到名稱時才用（約 2,000 檔；首屏載入後專注模式下不再更新，名稱不會變）
  const allNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of allStocks.slice()) if (s?.code && s.name) m.set(s.code, s.name);
    return m;
  }, [allStocks]);

  const nameOf = useCallback(
    (code: string) => quotes[code]?.name || base.names.get(code) || allNames.get(code) || '',
    [quotes, base, allNames],
  );

  return { holdings: base.holdings, watchlist: base.watchlist, candidates: base.candidates, pinned: base.pinned, nameOf };
}
