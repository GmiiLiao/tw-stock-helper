'use client';

// 盤前備課的分頁名冊與「目前分頁」（2026-10-05 使用者裁定第 5 題）。
// 目前分頁存在模組層級＋localStorage（safe-storage，失敗退預設）：
//   - 離開本頁再回來（例：點代號進個股再返回）仍停在同一分頁，清單的 data-anchor 捲動才對得上；
//   - 其他元件可直接導到指定分頁：openPrepTab('desk')（例：候選便條的「決策工作台」、戰情 A2 盤後連結）；
//   - 候選便條要判斷「目前是不是在工作台分頁」時用 usePrepTab()。
// 伺服器端與水合首拍一律回預設分頁（useSyncExternalStore 的 server snapshot），不會有水合差異。
import { useSyncExternalStore } from 'react';
import { storageGet, storageSet } from '@/lib/safe-storage';
import { useAppStore } from '@/lib/store';

export type PrepTabId = 'chip' | 'limitup' | 'gaplu' | 'desk' | 'squeeze' | 'short';

export interface PrepTabMeta {
  readonly id: PrepTabId;
  readonly icon: string;
  readonly label: string;
  /** 手機 3×2 方格用的短名 */
  readonly shortLabel: string;
  /** 這份清單的資料時點（只寫事實；出處＝各面板自己的說明與 daemon 寫入節奏） */
  readonly basis: string;
}

export const PREP_TABS: readonly PrepTabMeta[] = [
  { id: 'chip', icon: '🧬', label: '籌碼推選', shortLabel: '籌碼推選', basis: '法人、資券為最近一次盤後公布的資料（盤中即前一交易日）；名稱與價格為即時。' },
  { id: 'limitup', icon: '🚀', label: '漲停預測', shortLabel: '漲停預測', basis: '盤後定案的預測名單，凍結一整天；盤中即時重算版在盤中戰情。' },
  { id: 'gaplu', icon: '🎯', label: '跳空漲停', shortLabel: '跳空漲停', basis: '20 日波段形態；名單 13:36 定榜，收盤歸檔後（15:10、16:30）重算。' },
  { id: 'desk', icon: '🗒️', label: '隔日沖決策工作台', shortLabel: '決策工作台', basis: '候選便條逐檔比對；籌碼判讀為前一交易日收盤後資料。' },
  { id: 'squeeze', icon: '🩳', label: '軋空候選', shortLabel: '軋空候選', basis: '每晚 21:45 資券公布後定出次一交易日名單，適用日當天不變；15:10–21:45 之間為過渡版（券資比為前一交易日）。' },
  { id: 'short', icon: '🐻', label: '空方候選', shortLabel: '空方候選', basis: '盤中每 10 分鐘刷新、收盤後定榜。' },
];

export const DEFAULT_PREP_TAB: PrepTabId = 'chip';
export const PREP_TAB_STORAGE_KEY = 'prepTab';

export function isPrepTabId(v: unknown): v is PrepTabId {
  return typeof v === 'string' && PREP_TABS.some(t => t.id === v);
}

let current: PrepTabId | null = null;   // null＝尚未從 localStorage 讀回
const listeners = new Set<() => void>();

export function getPrepTab(): PrepTabId {
  if (current === null) {
    const saved = storageGet(PREP_TAB_STORAGE_KEY);
    current = isPrepTabId(saved) ? saved : DEFAULT_PREP_TAB;
  }
  return current;
}

export function setPrepTab(tab: PrepTabId): void {
  if (!isPrepTabId(tab)) return;
  storageSet(PREP_TAB_STORAGE_KEY, tab);   // 存不了（私密視窗等）只影響「下次記住」，本次照常切換
  if (getPrepTab() === tab) return;
  current = tab;
  listeners.forEach(l => l());
}

export function subscribePrepTab(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const serverSnapshot = (): PrepTabId => DEFAULT_PREP_TAB;

export function usePrepTab(): PrepTabId {
  return useSyncExternalStore(subscribePrepTab, getPrepTab, serverSnapshot);
}

/** 切到指定分頁並導向盤前備課頁（已在本頁時只切分頁） */
export function openPrepTab(tab: PrepTabId): void {
  setPrepTab(tab);
  useAppStore.getState().navigateTo('prep');
}
