'use client';

// 🚀 起漲影子後台：/api/admin/surge-shadow 的共用讀取（超級管理員 token、逾時、只採用最後一次請求的回應）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '@/lib/firebase';

const TIMEOUT_MS = 15_000;
export type LabResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function labGet<T>(qs: string): Promise<LabResult<T>> {
  try {
    const token = (await auth.currentUser?.getIdToken()) ?? '';
    const r = await fetch(`/api/admin/surge-shadow?${qs}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let j: unknown = null;
    try { j = await r.json(); } catch { j = null; }
    const msg = j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string' ? (j as { error: string }).error : '';
    if (!r.ok || !j) return { ok: false, error: `HTTP ${r.status}${msg ? `：${msg}` : ''}` };
    return { ok: true, data: j as T };
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') return { ok: false, error: `逾時（${TIMEOUT_MS / 1000} 秒）` };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 掛載時讀一次（分頁切到才掛載＝按需載入）；重載失敗保留上一份資料、只回報錯誤。 */
export function useLabView<T>(view: 'cv' | 'mirror' | 'pipeline') {
  const [state, setState] = useState<{ data: T | null; err: string; loading: boolean }>({ data: null, err: '', loading: true });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState(s => ({ ...s, loading: true, err: '' }));
    const r = await labGet<T>(`view=${view}`);
    if (my !== seq.current) return;
    setState(s => (r.ok ? { data: r.data, err: '', loading: false } : { data: s.data, err: r.error, loading: false }));
  }, [view]);
  useEffect(() => { void load(); }, [load]);
  return { ...state, reload: load };
}

/** ISO → 台北「MM-DD HH:MM」（顯示用；無效回 —）。 */
export function twTime(iso: string | null | undefined): string {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '—';
  return new Date(t + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
}

export const LAB_FOOT = '研究回測數字：未扣成本；非投資建議。';
