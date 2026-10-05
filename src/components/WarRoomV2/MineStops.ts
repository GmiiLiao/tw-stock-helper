'use client';

// A1 我的部位／快看抽屜：讀 daemon 寫的舊「AI 停損」（users/{uid}/data/portfolioAnalysis.analyses[code].stopLoss）。
// 2026-10-05 起戰情停損改用 AI 停損規範 stop-v1（scripts/lib/ai-stoploss.mjs、scripts/lib/warroom-mine.mjs）：
//   這個值是 /api/rating 的 ATR 浮動帶（calculateAtrStop），會跟著股價往下移、獲利中也可能觸發——
//   規範把它改稱「結構參考價（非停損）」，戰情只顯示、不拿來算距停損、不觸發任何警示（SKILL §0-1、§1）。
// 只讀自己的使用者文件（Firestore onSnapshot；daemon 約 30 分鐘寫一次），不打任何上游。
// 一個模組層級訂閱，A1 與抽屜共用（有人在用才訂閱，最後一個卸載就退訂）。身分模擬中讀被模擬者（useDataUid）。
import { useEffect, useSyncExternalStore } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDataUid } from '@/lib/view-as';

/** loading 讀取中｜ok 讀到文件｜none 文件不存在或未登入｜error 讀取失敗（結構參考價顯示「讀不到」，不猜） */
export type StructRefStatus = 'loading' | 'ok' | 'none' | 'error';

export interface StructRefs {
  status: StructRefStatus;
  /** 代號 → 結構參考價（舊 AI 停損；只收 > 0 的） */
  refs: Readonly<Record<string, number>>;
  /** 分析產出時間（epoch ms）；沒有為 null */
  generatedAt: number | null;
}

const EMPTY: Readonly<Record<string, number>> = Object.freeze({});
const LOADING: StructRefs = Object.freeze({ status: 'loading', refs: EMPTY, generatedAt: null });
const NONE: StructRefs = Object.freeze({ status: 'none', refs: EMPTY, generatedAt: null });
const ERROR: StructRefs = Object.freeze({ status: 'error', refs: EMPTY, generatedAt: null });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const firestoreReady = () => !!db && typeof (db as { type?: unknown }).type !== 'undefined';

function parse(data: unknown): StructRefs {
  if (!isObj(data)) return NONE;
  const refs: Record<string, number> = {};
  const analyses = isObj(data.analyses) ? data.analyses : {};
  for (const [code, a] of Object.entries(analyses)) {
    const sl = isObj(a) ? a.stopLoss : null;
    if (typeof sl === 'number' && Number.isFinite(sl) && sl > 0) refs[code] = sl;
  }
  const g = data.generatedAt;
  return { status: 'ok', refs, generatedAt: typeof g === 'number' && Number.isFinite(g) && g > 0 ? g : null };
}

// ── 模組層級共用訂閱（依 uid；引用計數） ───────────────────────────────────

let state: StructRefs = LOADING;
let curUid: string | null = null;
let unsub: (() => void) | null = null;
let users = 0;
const listeners = new Set<() => void>();

function emit(next: StructRefs) {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

function open(uid: string | null) {
  unsub?.();
  unsub = null;
  curUid = uid;
  if (!uid || !firestoreReady()) { emit(NONE); return; }
  emit(LOADING);
  unsub = onSnapshot(
    doc(db, 'users', uid, 'data', 'portfolioAnalysis'),
    (snap) => { if (curUid === uid) emit(snap.exists() ? parse(snap.data()) : NONE); },
    (err) => { console.error('[warroom] 結構參考價讀取失敗', err?.code ?? err); if (curUid === uid) emit(ERROR); },
  );
}

function acquire(uid: string | null): () => void {
  users += 1;
  if (users === 1 || uid !== curUid) open(uid);
  return () => {
    users -= 1;
    if (users === 0) { unsub?.(); unsub = null; curUid = null; state = LOADING; }
  };
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

const getState = () => state;

/** 結構參考價（舊 AI 停損）：只顯示、標「非停損」 */
export function useStructRefs(): StructRefs {
  const uid = useDataUid();
  useEffect(() => acquire(uid ?? null), [uid]);
  return useSyncExternalStore(subscribe, getState, () => LOADING);
}
