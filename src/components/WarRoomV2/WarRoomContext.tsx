'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2 的共用狀態。拆成兩個 context，讓只關心互動狀態的元件（抽屜、放大層）不必跟著每 5 秒的報價重繪：
//   useWarData()  — 匯流排資料（index／quotes／pulse／board）、時段與時鐘（now 每 30 秒對齊整 30 秒更新一次）
//   useWarUi()    — 互動狀態（快層代號登記、A2 切換／釘選、快看抽屜、放大層、當日釘選、損益遮罩、是否手機）
//   useWarRoom()  — 兩者合併（方便；會隨資料重繪）
// 本機狀態一律走 @/lib/safe-storage（私密視窗／停用網站資料時不會白屏）：
//   wr-pinned     { ymd, codes }   當日釘選（換日清空）
//   wr-focus-pin  { ymd, kind }    A2 釘選內容（當日有效）
//   wr-pnl-mask   '1' | '0'        持股損益遮罩（使用者裁定第 13 題：預設顯示）
// ─────────────────────────────────────────────────────────────────────────────
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { startLiveLoop, isForeground } from '@/lib/market-clock';
import { storageGet, storageSet } from '@/lib/safe-storage';
import { warClock, type WarClock, type WarSegment } from '@/lib/warroom/session';
import { focusForSegment, isFocusKind, type FocusKind } from '@/lib/warroom/focus-kinds';
import type { PulsePayload, BoardPayload } from '@/lib/warroom/types';
import {
  useWarRoomBus, registerWarFastCodes, clearWarFastCodes, getWarFastCodes, subscribeWarFastCodes,
  type WarBusState, type WarIndex, type WarQuote,
} from './useWarRoomBus';
import { useIsMobile } from './parts/useMedia';
import { takePendingZoom } from './pendingZoom';

/** 放大層（D2）可開的完整面板 */
export type ZoomTarget =
  | 'mine'          // A1 我的部位·全部（持股完整清單）
  | 'radar'         // B1 雷達完整版（舊 WarRoom 雷達）
  | 'short'         // B1 做空完整版（FadeWatch／ShortPanel）
  | 'risefall'      // 漲跌分布 1,900 方塊（RiseFallPanel；入口＝Z1 漲跌家數「分布 →」）
  | 'daytrade'      // 當沖工作台（DayTradeDesk）
  | 'limitFlow'     // C2 漲停順序流全量＋盤中漲停預測 A 榜（LimitUpPanel source="live"）
  | 'sectors'       // C1 族群完整版（MarketWind 完整版、官方 33 類）
  | 'feed'          // B2 異動流全部紀錄
  | 'tailPicks'     // 撿尾盤完整清單
  | 'health';       // 資料健康明細（Z0 健康燈彈窗「抓取明細 →」）

export interface WarRoomData {
  index: WarIndex | null;
  quotes: Readonly<Record<string, WarQuote>>;
  pulse: PulsePayload | null;
  board: BoardPayload | null;
  layers: WarBusState['layers'];
  /** 目前快層追蹤的代號（優先序：A1 先；最多 40） */
  fastCodes: readonly string[];
  /** 每 30 秒（對齊整 30 秒）更新一次的時間——倒數、價齡、資料章用 */
  now: number;
  segment: WarSegment;
  clock: WarClock;
}

export interface WarRoomUi {
  /** 登記快層要追蹤的代號（owner 預設 'mine'＝A1 持股＋釘選）。同 owner 再呼叫＝整組替換；傳 [] 清空。 */
  setFastCodes: (codes: readonly string[], owner?: string) => void;
  /** 時段自動對應的 A2 內容 */
  focusAuto: FocusKind;
  /** 實際顯示的 A2 內容＝focusPinned ?? focusOverride ?? focusAuto */
  focus: FocusKind;
  /** 手動切換（切換 ▾）；時段換了自動清掉 */
  focusOverride: FocusKind | null;
  setFocusOverride: (k: FocusKind | null) => void;
  /** 釘選（📌）：跨時段保留到當日結束或取消；pinFocus(null) 取消 */
  focusPinned: FocusKind | null;
  pinFocus: (k: FocusKind | null) => void;
  /** 快看抽屜（D1） */
  drawerCode: string | null;
  openDrawer: (code: string) => void;
  closeDrawer: () => void;
  /** 放大層（D2） */
  zoomTarget: ZoomTarget | null;
  openZoom: (t: ZoomTarget) => void;
  closeZoom: () => void;
  /** 當日釘選代號（換日清空；最多 PINNED_MAX） */
  pinned: readonly string[];
  togglePin: (code: string) => void;
  isPinned: (code: string) => boolean;
  /** 持股損益遮罩（預設 false＝顯示） */
  pnlMasked: boolean;
  togglePnlMask: () => void;
  /** <768px */
  isMobile: boolean;
}

export const PINNED_MAX = 12;
const CODE_RE = /^\d{4,6}$/;
const PIN_KEY = 'wr-pinned';
const FOCUS_PIN_KEY = 'wr-focus-pin';
const PNL_MASK_KEY = 'wr-pnl-mask';
const NOW_STEP_MS = 30_000;

const DataCtx = createContext<WarRoomData | null>(null);
const UiCtx = createContext<WarRoomUi | null>(null);

function readJson(key: string): unknown {
  const raw = storageGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function loadPinned(ymd: string): string[] {
  const v = readJson(PIN_KEY) as { ymd?: unknown; codes?: unknown } | null;
  if (!v || v.ymd !== ymd || !Array.isArray(v.codes)) return [];
  return v.codes.filter((c): c is string => typeof c === 'string' && CODE_RE.test(c)).slice(0, PINNED_MAX);
}

function loadFocusPin(ymd: string): FocusKind | null {
  const v = readJson(FOCUS_PIN_KEY) as { ymd?: unknown; kind?: unknown } | null;
  return v && v.ymd === ymd && isFocusKind(v.kind) ? v.kind : null;
}

/** 對齊整 30 秒的時鐘（背景分頁 10 分鐘一次；回前景立即補一次——startLiveLoop 內建） */
function useWarNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startLiveLoop(
    () => { setNow(Date.now()); },
    () => (isForeground() ? NOW_STEP_MS - (Date.now() % NOW_STEP_MS) + 50 : 600_000),
  ), []);
  return now;
}

const getFastCodesSnapshot = () => getWarFastCodes();
const EMPTY_CODES: readonly string[] = Object.freeze([]);

export function WarRoomProvider({ children }: { children: ReactNode }) {
  const bus = useWarRoomBus();
  const fastCodes = useSyncExternalStore(subscribeWarFastCodes, getFastCodesSnapshot, () => EMPTY_CODES);
  const now = useWarNow();
  const clock = useMemo(() => warClock(now), [now]);
  const { segment, ymd } = clock;
  const isMobile = useIsMobile();

  // ── 快層代號登記：記下經由 context 登記過的 owner，卸載時一併清掉（AlertEngine 等外部 owner 不動）
  const ownersRef = useRef<Set<string>>(new Set());
  const setFastCodes = useCallback((codes: readonly string[], owner = 'mine') => {
    ownersRef.current.add(owner);
    registerWarFastCodes(owner, codes);
  }, []);
  useEffect(() => {
    const owners = ownersRef.current;
    return () => { for (const o of owners) clearWarFastCodes(o); };
  }, []);

  // ── A2：自動／手動切換／釘選
  const focusAuto = focusForSegment(segment);
  const [focusOverride, setFocusOverrideState] = useState<FocusKind | null>(null);
  const [focusPinned, setFocusPinned] = useState<FocusKind | null>(() => loadFocusPin(ymd));
  const lastSegment = useRef(segment);
  useEffect(() => {
    if (lastSegment.current !== segment) { lastSegment.current = segment; setFocusOverrideState(null); }
  }, [segment]);
  const setFocusOverride = useCallback((k: FocusKind | null) => setFocusOverrideState(k), []);
  const pinFocus = useCallback((k: FocusKind | null) => {
    setFocusPinned(k);
    storageSet(FOCUS_PIN_KEY, JSON.stringify(k ? { ymd, kind: k } : { ymd, kind: null }));
  }, [ymd]);
  const focus = focusPinned ?? focusOverride ?? focusAuto;

  // ── 當日釘選（換日清空）
  const [pinned, setPinned] = useState<string[]>(() => loadPinned(ymd));
  const pinnedYmd = useRef(ymd);
  useEffect(() => {
    if (pinnedYmd.current === ymd) return;
    pinnedYmd.current = ymd;
    setPinned([]);
    setFocusPinned(null);
    storageSet(PIN_KEY, JSON.stringify({ ymd, codes: [] }));
  }, [ymd]);
  const togglePin = useCallback((code: string) => {
    if (!CODE_RE.test(code)) return;
    setPinned((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code].slice(-PINNED_MAX);
      storageSet(PIN_KEY, JSON.stringify({ ymd: pinnedYmd.current, codes: next }));
      return next;
    });
  }, []);
  const isPinned = useCallback((code: string) => pinned.includes(code), [pinned]);

  // ── 損益遮罩
  const [pnlMasked, setPnlMasked] = useState<boolean>(() => storageGet(PNL_MASK_KEY) === '1');
  const togglePnlMask = useCallback(() => {
    setPnlMasked((v) => { storageSet(PNL_MASK_KEY, v ? '0' : '1'); return !v; });
  }, []);

  // ── 抽屜與放大層（Esc：先關放大層，再關抽屜）
  const [drawerCode, setDrawerCode] = useState<string | null>(null);
  const [zoomTarget, setZoomTarget] = useState<ZoomTarget | null>(null);
  const openDrawer = useCallback((code: string) => { if (CODE_RE.test(code)) setDrawerCode(code); }, []);
  const closeDrawer = useCallback(() => setDrawerCode(null), []);
  const openZoom = useCallback((t: ZoomTarget) => setZoomTarget(t), []);
  const closeZoom = useCallback(() => setZoomTarget(null), []);
  // 從其他頁帶著放大層請求進來（requestWarZoom）：掛載時取用一次（effect 而非 state 初始化——StrictMode 會呼叫初始化兩次）
  useEffect(() => {
    const t = takePendingZoom();
    if (t) setZoomTarget(t);
  }, []);
  useEffect(() => {
    if (!drawerCode && !zoomTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (zoomTarget) setZoomTarget(null); else setDrawerCode(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerCode, zoomTarget]);

  const data = useMemo<WarRoomData>(() => ({
    index: bus.index, quotes: bus.quotes, pulse: bus.pulse, board: bus.board, layers: bus.layers,
    fastCodes, now, segment, clock,
  }), [bus, fastCodes, now, segment, clock]);

  const ui = useMemo<WarRoomUi>(() => ({
    setFastCodes, focusAuto, focus, focusOverride, setFocusOverride, focusPinned, pinFocus,
    drawerCode, openDrawer, closeDrawer, zoomTarget, openZoom, closeZoom,
    pinned, togglePin, isPinned, pnlMasked, togglePnlMask, isMobile,
  }), [setFastCodes, focusAuto, focus, focusOverride, setFocusOverride, focusPinned, pinFocus,
    drawerCode, openDrawer, closeDrawer, zoomTarget, openZoom, closeZoom,
    pinned, togglePin, isPinned, pnlMasked, togglePnlMask, isMobile]);

  return (
    <UiCtx.Provider value={ui}>
      <DataCtx.Provider value={data}>{children}</DataCtx.Provider>
    </UiCtx.Provider>
  );
}

export function useWarData(): WarRoomData {
  const v = useContext(DataCtx);
  if (!v) throw new Error('useWarData 必須在 <WarRoomProvider> 內使用');
  return v;
}

export function useWarUi(): WarRoomUi {
  const v = useContext(UiCtx);
  if (!v) throw new Error('useWarUi 必須在 <WarRoomProvider> 內使用');
  return v;
}

export function useWarRoom(): WarRoomData & WarRoomUi {
  return { ...useWarData(), ...useWarUi() };
}
