'use client';

// 戰情 A1／快看抽屜／Z2 引擎的停損輸入（AI 停損規範 stop-v1.1；SKILL「生效範圍」、§3.6；實作計畫 §3.1）：
//   ① 持股分析 ATR 帶：users/{uid}/data/portfolioAnalysis.analyses[code].stopLoss（daemon 約 30 分鐘寫一次；/api/rating 的
//      calculateAtrStop，以前一完整交易日官方收盤夾值、盤中不變）。舊稱「AI 停損」「結構參考價」——v1.1 前端暫算把它當 ATR 帶，
//      與成本線取高、不棘輪（warroom-mine.provisionalStop：frontLinesOf＋resolveStop bandRatchet:false），畫面標
//      「ATR 帶（持股分析·觸發線之一）」。
//   ② daemon 停損簿：stopBooks/{uid}（daemon 以 Admin SDK 單一寫入；firestore.rules 規劃為本人與管理員唯讀——規則部署前讀取
//      會被拒，狀態 'error'，一律退回前端暫算）。phase 'live' 且 specVersion 'stop-v1.1' 才生效；'shadow' 只供抽屜對照
//      （scripts/lib/warroom-stopbook.mjs）。
// 只讀 Firestore 文件（onSnapshot），不打任何上游、與線上人數無關；每份文件一個模組層級訂閱，A1、抽屜、Z2 引擎共用（引用計數，
//   有人在用才訂閱，最後一個卸載就退訂）。身分模擬中讀被模擬者（useDataUid）。
// 讀取超過 SLOW_MS 仍無回應 ⇒ 狀態 'slow'（Z2 引擎不再等它，先依現有資料判定；畫面標「讀取逾時」）。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { doc, onSnapshot, type DocumentReference } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDataUid } from '@/lib/view-as';
import type { StopDocStatus } from '../../../scripts/lib/warroom-mine.mjs';
import { parseStopBookDoc, type StopBookView } from '../../../scripts/lib/warroom-stopbook.mjs';

const SLOW_MS = 15_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const firestoreReady = () => !!db && typeof (db as { type?: unknown }).type !== 'undefined';

interface DocState<T> { status: StopDocStatus; data: T | null }

/**
 * 一份使用者文件的模組層級共用訂閱（依 uid；引用計數）。parse 回 null＝文件形狀不合格，當作沒有文件（'none'）。
 * 回傳 hook：讀取中 'loading'、逾時 'slow'、讀到 'ok'、文件不存在／未登入 'none'、讀取失敗 'error'（不猜、不沿用別人的資料）。
 */
function createDocStore<T>(label: string, refOf: (uid: string) => DocumentReference, parse: (raw: unknown) => T | null) {
  const LOADING: DocState<T> = Object.freeze({ status: 'loading', data: null });
  const SLOW: DocState<T> = Object.freeze({ status: 'slow', data: null });
  const NONE: DocState<T> = Object.freeze({ status: 'none', data: null });
  const ERROR: DocState<T> = Object.freeze({ status: 'error', data: null });
  let state: DocState<T> = LOADING;
  let curUid: string | null = null;
  let unsub: (() => void) | null = null;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  let users = 0;
  const listeners = new Set<() => void>();

  const clearSlow = () => { if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; } };
  function emit(next: DocState<T>) {
    if (next.status !== 'loading') clearSlow();
    if (next === state) return;
    state = next;
    for (const l of listeners) l();
  }
  function close() {
    clearSlow();
    unsub?.();
    unsub = null;
  }
  function open(uid: string | null) {
    close();
    curUid = uid;
    if (!uid || !firestoreReady()) { emit(NONE); return; }
    emit(LOADING);
    slowTimer = setTimeout(() => { slowTimer = null; if (curUid === uid && state.status === 'loading') emit(SLOW); }, SLOW_MS);
    unsub = onSnapshot(
      refOf(uid),
      (snap) => {
        if (curUid !== uid) return;
        const data = snap.exists() ? parse(snap.data()) : null;
        emit(data == null ? NONE : Object.freeze({ status: 'ok', data }));
      },
      (err) => {
        console.warn(`[warroom] ${label}讀取失敗（停損改用前端暫算）`, err?.code ?? err);
        if (curUid === uid) emit(ERROR);
      },
    );
  }
  function acquire(uid: string | null): () => void {
    users += 1;
    if (users === 1 || uid !== curUid) open(uid);
    return () => {
      users -= 1;
      if (users === 0) { close(); curUid = null; state = LOADING; }
    };
  }
  const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
  const getState = () => state;
  const getServer = () => LOADING;
  return function useDocState(): DocState<T> {
    const uid = useDataUid();
    useEffect(() => acquire(uid ?? null), [uid]);
    return useSyncExternalStore(subscribe, getState, getServer);
  };
}

// ── ① 持股分析 ATR 帶 ────────────────────────────────────────────────────────

interface BandData {
  /** 代號 → 持股分析 ATR 帶（analyses[code].stopLoss；只收 > 0） */
  bands: Readonly<Record<string, number>>;
  /** 分析產出時間（epoch ms）；沒有為 null */
  generatedAt: number | null;
}

function parseBands(data: unknown): BandData | null {
  if (!isObj(data)) return null;
  const bands: Record<string, number> = {};
  const analyses = isObj(data.analyses) ? data.analyses : {};
  for (const [code, a] of Object.entries(analyses)) {
    const sl = isObj(a) ? a.stopLoss : null;
    if (typeof sl === 'number' && Number.isFinite(sl) && sl > 0) bands[code] = sl;
  }
  const g = data.generatedAt;
  return Object.freeze({ bands: Object.freeze(bands), generatedAt: typeof g === 'number' && Number.isFinite(g) && g > 0 ? g : null });
}

const useBandDoc = createDocStore<BandData>('持股分析 ATR 帶', (uid) => doc(db, 'users', uid, 'data', 'portfolioAnalysis'), parseBands);

const EMPTY_BANDS: Readonly<Record<string, number>> = Object.freeze({});

export interface RatingBands {
  status: StopDocStatus;
  /** 代號 → 持股分析 ATR 帶（v1.1 前端暫算的觸發線之一） */
  bands: Readonly<Record<string, number>>;
  generatedAt: number | null;
}

/** 持股分析 ATR 帶（v1.1 前端暫算與成本線取高；停損簿生效後只給 noOfficialBars 的代號沿用現行推播口徑） */
export function useRatingBands(): RatingBands {
  const st = useBandDoc();
  return useMemo(() => ({ status: st.status, bands: st.data?.bands ?? EMPTY_BANDS, generatedAt: st.data?.generatedAt ?? null }), [st]);
}

// ── ② daemon 停損簿 stopBooks/{uid} ───────────────────────────────────────────

const useStopBookState = createDocStore<StopBookView>('停損簿', (uid) => doc(db, 'stopBooks', uid), parseStopBookDoc);

export interface StopBookDocState {
  status: StopDocStatus;
  /** 停損簿（形狀不合格或沒有＝null）；生效與否由 warroom-stopbook.stopBookLive 判斷 */
  book: StopBookView | null;
}

export function useStopBookDoc(): StopBookDocState {
  const st = useStopBookState();
  return useMemo(() => ({ status: st.status, book: st.data }), [st]);
}
