// 指揮列／大盤脈動／警示帶／手機 S1 共用的小狀態（模組層級 pub/sub）。
// 寫入端只有 TopAlertEngine（大盤危險狀態機、逼近停損清單、停損本機事件表）；讀取端：Z1 盤勢燈、Z2 橫幅、手機 S1 計數點、
//   A1 與快看抽屜（stopBook：停損棘輪的上一版，A1／抽屜／Z2／逼近清單帶同一份，數字才一致）。
// 放模組層級而不是 React context：ZoneAlerts（桌機）與 MobileBars（手機）兩處擇一掛 engine，讀取端不必管是誰在寫。
import { useSyncExternalStore } from 'react';
import type { NearStop } from '../../../scripts/lib/warroom-top.mjs';
import type { StopBook } from '../../../scripts/lib/warroom-mine.mjs';

export interface TopDanger {
  /** 大盤危險成立中（連續 2 拍成立、尚未連續 2 拍解除） */
  active: boolean;
  /** 當日第幾次成立（事件 id 用） */
  seq: number;
  /** 成立時的資料時間（marketPulse.updatedAt） */
  at: number | null;
}

export interface TopState {
  danger: TopDanger;
  /** 逼近停損（規範 stop-v1 暫算；距停損 ≤2%，含在停損價或以下），近到遠 */
  nearStop: readonly NearStop[];
  /** false＝逼近停損無法計算。規範 stop-v1 只用持股與報價，引擎寫入時恆為 true（初始值 false＝引擎尚未跑） */
  nearStopKnown: boolean;
  /** 監控中的持股檔數（不同代號） */
  holdingCount: number;
  /** 停損本機事件表（代號 → 這一版：停損、版本、逐筆快照；localStorage wr-stop-ep:<uid>）。未登入或尚未載入＝空表 */
  stopBook: StopBook;
}

/** 空的停損本機事件表（未登入、身分切換中） */
export const EMPTY_STOP_BOOK: StopBook = Object.freeze({});

const INITIAL: TopState = Object.freeze({
  danger: Object.freeze({ active: false, seq: 0, at: null }),
  nearStop: Object.freeze([]) as readonly NearStop[],
  nearStopKnown: false,
  holdingCount: 0,
  stopBook: EMPTY_STOP_BOOK,
});

let state: TopState = INITIAL;
const listeners = new Set<() => void>();

const sameNear = (a: readonly NearStop[], b: readonly NearStop[]) =>
  a.length === b.length && a.every((x, i) => x.code === b[i].code && x.distPct === b[i].distPct && x.name === b[i].name);

/** 部分更新（內容沒變不換參照，避免讀取端白重繪） */
export function setTopState(patch: Partial<TopState>): void {
  const next: TopState = { ...state, ...patch };
  const same = next.holdingCount === state.holdingCount && next.nearStopKnown === state.nearStopKnown
    && next.danger.active === state.danger.active && next.danger.seq === state.danger.seq && next.danger.at === state.danger.at
    && sameNear(next.nearStop, state.nearStop) && next.stopBook === state.stopBook;
  if (same) return;
  state = Object.freeze(next);
  for (const l of listeners) l();
}

export function getTopState(): TopState {
  return state;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useTopState(): TopState {
  return useSyncExternalStore(subscribe, getTopState, () => INITIAL);
}
