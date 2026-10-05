'use client';

// B2／C1／C2／D2 共用的前端資料層（只讀匯流排的 board.feeds，不自己開輪詢）。
//   useFeedsSections()  三個子區段（events／sectors／limitFlow），各自「出錯沿用上一份正確資料」
//                       （匯流排只保留到 board 的頂層區段；子區段這層在這裡補，asOf 不前進 ⇒ 資料章自然轉延遲／過期）
//   useMineCodes()      持股（store.holdings）與當日釘選（ui.pinned）
//   useFeedEvents()     B2 事件：伺服器最近 40 則（模組層級累積去重，最多 300 則、24 小時）
//                       ＋ events.ts 的本機事件（AlertEngine／Z2 等發佈的我的警示，level 1–2）
//                       ＋ 依持股／釘選從 index 補出的「我的」重訊
//                       ＋ 從 board.news 精簡表過濾出的「我的」新聞判別（warroom-news.mineNewsEvents：持股＋自選＋釘選；
//                         權重沿用 rankMediaVerdicts、先驗·未校準；持股達重大利空條件的由 Z2 引擎發，這裡不重複）；新到舊
//   useArrivals()       新到事件的 NEW（3 分鐘）與底色閃（3 秒，只限我的／本機二級以上）
// 伺服器事件刻意不寫進 events.ts：它的 ring buffer 只有 200 筆，市場事件一天就能把 Z2 的一級警示擠掉。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAppStore } from '@/lib/store';
import type { Section } from '@/lib/warroom/types';
import type { FeedsData, FeedEvent, FeedEventsData, SectorsData, LimitFlowData } from '@/lib/warroom/build-feeds';
import { majorBearOf, mineNewsEvents } from '../../../scripts/lib/warroom-news.mjs';
import { useWarData, useWarUi } from './WarRoomContext';
import { useNewsBoard, useNewsPool } from './NewsModel';
import { useWarEvents, type WarEventKind, type WarEventLevel, type WarEventSource } from './events';

// ── 子區段：出錯沿用上一份 ────────────────────────────────────────────────────

type SubKey = keyof FeedsData;
const lastGood: { [K in SubKey]?: FeedsData[K] } = {};

function keepGood<K extends SubKey>(key: K, next: FeedsData[K] | undefined): FeedsData[K] | null {
  if (next && next.ok) {
    lastGood[key] = next;
    return next;
  }
  return lastGood[key] ?? next ?? null;
}

export interface FeedsSections {
  events: Section<FeedEventsData> | null;
  sectors: Section<SectorsData> | null;
  limitFlow: Section<LimitFlowData> | null;
  /** board 已至少回來過一次（區分「載入中」與「真的沒有資料」） */
  loaded: boolean;
  /** 慢層最近一次抓取失敗的訊息（畫面只說「讀取失敗·重試中」，不露內部細節） */
  failing: boolean;
}

export function useFeedsSections(): FeedsSections {
  const { board, layers } = useWarData();
  const feeds = board?.feeds;
  const failing = layers.board.failCount > 0;
  return useMemo(() => {
    const d = feeds?.ok ? feeds.data : undefined;
    return {
      events: keepGood('events', d?.events),
      sectors: keepGood('sectors', d?.sectors),
      limitFlow: keepGood('limitFlow', d?.limitFlow),
      loaded: board != null,
      failing,
    };
  }, [feeds, board, failing]);
}

// ── 持股與釘選 ──────────────────────────────────────────────────────────────

export interface MineCodes {
  /** 持股代號（數量 >0） */
  holdings: ReadonlySet<string>;
  /** 持股 ∪ 當日釘選（B2「我的」） */
  mine: ReadonlySet<string>;
}

export function useMineCodes(): MineCodes {
  const holdings = useAppStore((s) => s.holdings);
  const { pinned } = useWarUi();
  return useMemo(() => {
    const h = new Set<string>();
    for (const it of holdings) {
      if (!it || typeof it.code !== 'string') continue;
      if (typeof it.quantity === 'number' && it.quantity <= 0) continue;
      h.add(it.code);
    }
    return { holdings: h, mine: new Set([...h, ...pinned]) };
  }, [holdings, pinned]);
}

/** 代號 → 名稱（新聞判別文件沒有名稱時補用；store.allStocks 是首屏快照，名稱不會變） */
export function useNameMap(): ReadonlyMap<string, string> {
  const all = useAppStore((s) => s.allStocks);
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const s of all) if (s?.code && s.name) m.set(s.code, s.name);
    return m;
  }, [all]);
}

// ── 伺服器事件累積（模組層級：Provider 重掛也保留） ───────────────────────────

const KEEP_MAX = 300;
const KEEP_MS = 24 * 3_600_000;
let serverEvents: readonly FeedEvent[] = Object.freeze([]);
const serverIds = new Set<string>();
const serverListeners = new Set<() => void>();

function ingestServerEvents(items: readonly FeedEvent[]): void {
  const fresh = items.filter((e) => e && typeof e.id === 'string' && !serverIds.has(e.id));
  if (!fresh.length) return;
  const cutoff = Date.now() - KEEP_MS;
  const merged = [...fresh, ...serverEvents].filter((e) => e.at >= cutoff).sort((a, b) => b.at - a.at).slice(0, KEEP_MAX);
  serverIds.clear();
  for (const e of merged) serverIds.add(e.id);
  serverEvents = Object.freeze(merged);
  for (const l of serverListeners) l();
}

const subscribeServer = (l: () => void) => {
  serverListeners.add(l);
  return () => { serverListeners.delete(l); };
};
const getServer = () => serverEvents;
const EMPTY_EVENTS: readonly FeedEvent[] = Object.freeze([]);

// ── B2 合併後的事件 ──────────────────────────────────────────────────────────

export interface FeedItem {
  id: string;
  at: number;
  kind: WarEventKind;
  level: WarEventLevel;
  code?: string;
  name?: string;
  /** 伺服器事件：代號名稱以外的描述；本機事件：整句（文案已含代號） */
  text: string;
  source?: WarEventSource;
  side?: 'long' | 'short';
  /** 與持股／釘選相關 */
  mine: boolean;
  /** 來自 events.ts（我的警示紀錄） */
  local: boolean;
}

export function useFeedEvents(): { items: readonly FeedItem[]; section: Section<FeedEventsData> | null; loaded: boolean; failing: boolean } {
  const { events: section, loaded, failing } = useFeedsSections();
  const items = section?.ok ? section.data.items : null;
  useEffect(() => { if (items) ingestServerEvents(items); }, [items]);

  const server = useSyncExternalStore(subscribeServer, getServer, () => EMPTY_EVENTS);
  const local = useWarEvents();
  const { mine } = useMineCodes();
  const names = useNameMap();
  const index = section?.ok ? section.data.index : null;
  const news = useNewsBoard();
  const pool = useNewsPool();

  const merged = useMemo(() => {
    const byId = new Map<string, FeedItem>();
    for (const e of local) {
      if (e.level > 2) continue;   // 三級＝靜默，不進異動流
      byId.set(e.id, {
        id: e.id, at: e.at, kind: e.kind, level: e.level, code: e.code, text: e.text, source: e.source, side: e.side,
        mine: !!e.mine || (!!e.code && mine.has(e.code)), local: true,
      });
    }
    // 持股達重大利空條件的新聞判別由 Z2 引擎發（一級或待裁定的二級，見 TopAlertEngine），伺服器的同一則不再重複列
    const engineOwned = new Set<string>();
    if (news.board) {
      for (const code of pool.holdings) {
        const e = news.board.map[code];
        if (e && majorBearOf(e, { scope: 'holding', ctx: news.ctx, minAtMs: news.minAtMs })) engineOwned.add(code);
      }
    }
    const addServer = (e: FeedEvent) => {
      if (byId.has(e.id)) return;
      if (e.kind === 'newsVerdict' && engineOwned.has(e.code)) return;
      const name = e.name && e.name !== e.code ? e.name : names.get(e.code);
      byId.set(e.id, {
        id: e.id, at: e.at, kind: e.kind, level: 2, code: e.code, name, text: e.text, source: e.source, side: e.side,
        mine: mine.has(e.code), local: false,
      });
    };
    // 「我的」新聞判別先放（同 id 的伺服器事件就沿用這則，文字帶持股／自選說明；自選也算「我的」）。
    // 只取今日適用、非承接的判別；超過 KEEP_MS（24 小時）的不補。
    const t = Date.now();
    const cutoff = t - KEEP_MS;
    if (news.board) {
      const mineNews = mineNewsEvents(news.board, {
        holdings: pool.holdings, watch: pool.watch, pinned: pool.pinned, ctx: news.ctx, minAtMs: news.minAtMs, nowMs: t,
      });
      for (const e of mineNews) {
        if (e.at < cutoff || byId.has(e.id)) continue;
        byId.set(e.id, {
          id: e.id, at: e.at, kind: e.kind, level: 2, code: e.code, name: names.get(e.code), text: e.text, source: e.source, side: e.side,
          mine: true, local: false,
        });
      }
    }
    for (const e of server) addServer(e);
    // 「我的」重訊：伺服器只回全市場最近 40 則，持股的那一則可能不在裡面 ⇒ 用 index 補（id 與伺服器同規則，自動去重）。
    if (index) {
      for (const code of mine) {
        const m = index.mops[code];
        if (m && m[0] >= cutoff) addServer({ id: `s:mops:${code}:${m[0]}`, at: m[0], kind: 'mops', code, name: code, text: m[1], source: 'O' });
      }
    }
    return [...byId.values()].sort((a, b) => b.at - a.at);
  }, [local, server, mine, index, names, news, pool]);

  return { items: merged, section, loaded, failing };
}

// ── 新到事件：NEW 與底色閃 ───────────────────────────────────────────────────

const NEW_MS = 3 * 60_000;
const FLASH_MS = 3_000;
const arrivals = new Map<string, number>();   // id → 到達時刻；0＝首次載入就有（不標 NEW）
let baselined = false;

/** 回傳 { isNew(id), flashing: Set<id>, newCount }。ready＝異動流區段第一次成功回來（之前到的都算基線，不標 NEW） */
export function useArrivals(items: readonly FeedItem[], now: number, ready: boolean) {
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(() => new Set());
  const [, bump] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ready) return;
    const t = Date.now();
    const flash: string[] = [];
    let added = false;
    for (const it of items) {
      if (arrivals.has(it.id)) continue;
      arrivals.set(it.id, baselined ? t : 0);
      if (baselined) {
        added = true;
        if (it.mine || (it.local && it.level <= 2)) flash.push(it.id);
      }
    }
    baselined = true;
    if (arrivals.size > 2_000) {
      const keep = new Set(items.map((i) => i.id));
      for (const id of arrivals.keys()) if (!keep.has(id)) arrivals.delete(id);
    }
    if (added) bump((x) => x + 1);
    if (flash.length) {
      setFlashing(new Set(flash));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFlashing(new Set()), FLASH_MS);
    }
  }, [items, ready]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const isNew = (id: string) => {
    const a = arrivals.get(id) ?? 0;
    return a > 0 && now - a < NEW_MS;
  };
  const newCount = items.reduce((n, it) => n + (isNew(it.id) ? 1 : 0), 0);
  return { isNew, flashing, newCount };
}
