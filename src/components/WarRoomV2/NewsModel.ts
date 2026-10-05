'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 戰情 v2 新聞判別的前端資料層（只讀匯流排的 board.news 精簡表，不自己開輪詢、不打任何請求）。
//   useNewsBoard()  精簡表＋與「今日適用交易日」的關係（ctx）＋Z2 條件 B 的時間下限；讀取失敗沿用上一份
//   useNewsPool()   使用者自己的持股／自選／當日釘選（同一份表在前端過濾，網址不帶個人參數）
//   useMopsIndex()  今日官方重訊索引（O 管線；只做「重訊」徽章，不併入新聞權重）
// 規則與文案的唯一實作在 scripts/lib/warroom-news.mjs（權重＝rankMediaVerdicts，先驗·未校準，只顯示強弱與警示門檻）。
// ─────────────────────────────────────────────────────────────────────────────
import { useMemo } from 'react';
import { useAppStore } from '@/lib/store';
import { isTradingYmd } from '@/lib/market-clock';
import type { Section } from '@/lib/warroom/types';
import type { NewsBoard } from '@/lib/warroom/build-news';
import { newsCtxOf, type NewsCtx } from '../../../scripts/lib/warroom-news.mjs';
import { taipeiAt } from '../../../scripts/lib/warroom-mine.mjs';
import { useWarData, useWarUi } from './WarRoomContext';

const DAY_MS = 86_400_000;
const CODE_RE = /^\d{4,6}$/;
const EMPTY_MOPS: Readonly<Record<string, [number, string]>> = Object.freeze({});

/** 往前（-1）或往後（+1）最近一個交易日（休市日曆＋週末；最多 15 天）。MineModel.prevTradingYmd 同一套規則，這裡另寫避免循環匯入 */
function stepTradingYmd(ymd: string, dir: 1 | -1): string | null {
  let t = Date.parse(`${ymd}T00:00:00Z`);
  for (let i = 0; i < 15 && Number.isFinite(t); i++) {
    t += dir * DAY_MS;
    const d = new Date(t).toISOString().slice(0, 10);
    if (isTradingYmd(d)) return d;
  }
  return null;
}

/** 今日適用交易日：今天是交易日＝今天；否則下一個交易日（判別表 targetDate 與它比對） */
export function applicableYmdOf(ymd: string): string | null {
  return isTradingYmd(ymd) ? ymd : stepTradingYmd(ymd, 1);
}

/** Z2 條件 B 的防禦下限：適用日的上一交易日 13:30（更早的判讀不進警示） */
export function newsMinAtOf(applicableYmd: string | null): number | null {
  if (!applicableYmd) return null;
  const prev = stepTradingYmd(applicableYmd, -1);
  const t = prev ? taipeiAt(prev, 13, 30) : Number.NaN;
  return Number.isFinite(t) ? t : null;
}

// 讀取失敗時沿用上一份成功的精簡表（模組層級：桌機／手機兩棵樹、Provider 重掛都保留）
let lastGood: Section<NewsBoard> | null = null;

export interface NewsBoardView {
  /** loading＝慢層尚未回來；error＝讀不到且沒有上一份；ok＝有表（可能是沿用的上一份，見 stale） */
  status: 'loading' | 'error' | 'ok';
  board: NewsBoard | null;
  /** 這次讀取失敗、顯示的是上一份 */
  stale: boolean;
  error: string | null;
  ctx: NewsCtx;
  minAtMs: number | null;
}

export function useNewsBoard(): NewsBoardView {
  const { board, clock } = useWarData();
  const sec = board?.news;
  const ymd = clock.ymd;
  return useMemo(() => {
    if (sec?.ok) lastGood = sec;
    const use = sec?.ok ? sec : lastGood;
    const nb = use && use.ok ? use.data : null;
    const app = applicableYmdOf(ymd);
    const status: NewsBoardView['status'] = nb ? 'ok' : sec ? 'error' : 'loading';
    return {
      status,
      board: nb,
      stale: !!nb && !!sec && !sec.ok,
      error: sec && !sec.ok ? sec.error : null,
      ctx: newsCtxOf(nb?.meta ?? null, app),
      minAtMs: newsMinAtOf(app),
    };
  }, [sec, ymd]);
}

export interface NewsPool {
  /** 持股（數量 >0） */
  holdings: ReadonlySet<string>;
  /** 自選（舊版清單＋各群組） */
  watch: ReadonlySet<string>;
  /** 當日釘選 */
  pinned: ReadonlySet<string>;
  /** 依建立順序（A2 清單用） */
  holdingList: readonly string[];
  watchList: readonly string[];
}

const uniq = (codes: readonly string[]) => [...new Set(codes.filter((c) => CODE_RE.test(c)))];

export function useNewsPool(): NewsPool {
  const holdingsRaw = useAppStore((s) => s.holdings);
  const watchRaw = useAppStore((s) => s.watchlist);
  const groups = useAppStore((s) => s.watchlistGroups);
  const { pinned } = useWarUi();
  return useMemo(() => {
    const holdingList = uniq(holdingsRaw.slice()
      .filter((h) => h && typeof h.code === 'string' && !(typeof h.quantity === 'number' && h.quantity <= 0))
      .map((h) => h.code));
    const watchItems = [...watchRaw.slice(), ...groups.slice().flatMap((g) => (g?.stocks ?? []).slice())];
    const watchList = uniq(watchItems.map((w) => (w && typeof w.code === 'string' ? w.code : '')));
    return {
      holdings: new Set(holdingList), watch: new Set(watchList), pinned: new Set(uniq(pinned.slice())),
      holdingList, watchList,
    };
  }, [holdingsRaw, watchRaw, groups, pinned]);
}

/** 今日官方重訊索引（代號 → [公告時刻, 主旨前段]；B2 的 feeds 區段已有，不多打請求）。讀不到時回空表（徽章不顯示） */
export function useMopsIndex(): Readonly<Record<string, [number, string]>> {
  const { board } = useWarData();
  const feeds = board?.feeds;
  const events = feeds?.ok ? feeds.data.events : null;
  return events?.ok ? events.data.index.mops : EMPTY_MOPS;
}
