// ── localStorage 唯一合法入口（wm-ci-guardrails·2026-09-12 R9）──
//
// 為什麼不直接呼叫 localStorage：私密視窗、Safari ITP、被封鎖站點資料、SSR
// 三種情境下 **accessor 本身會丟例外**（不是回 null），沒包 try 的元件整棵樹白屏。
// 2026-09-12 掃描：10 檔 24 處直接呼叫，其中 7 處未包 try。與其逐檔補 try，
// 不如只留一個入口，並由 scripts/enforce-safe-storage.mjs 把「原生呼叫」判紅。
//
// Read Outcome 三態：`readStorage` 區分「讀到值／沒有這個 key／讀不到（storage 不可用）」。
// 大多數偏好設定用 `storageGet`（miss 與 failure 都回 null，反正都退預設）；
// 只有「失敗時行為不同」的呼叫端（例：隱私告知——存不了就別一直跳）用 `readStorage`。

export type StorageRead = { ok: true; value: string | null } | { ok: false };

function ls(): Storage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function readStorage(key: string): StorageRead {
  const s = ls();
  if (!s) return { ok: false };
  try { return { ok: true, value: s.getItem(key) }; } catch { return { ok: false }; }
}

export function storageGet(key: string): string | null {
  const r = readStorage(key);
  return r.ok ? r.value : null;
}

export function storageSet(key: string, value: string): boolean {
  const s = ls();
  if (!s) return false;
  try { s.setItem(key, value); return true; } catch { return false; }
}

export function storageRemove(key: string): boolean {
  const s = ls();
  if (!s) return false;
  try { s.removeItem(key); return true; } catch { return false; }
}
