// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { GateRowsWire } from './warroom-focus-codec.mjs';

export const FOCUS_LIMITS: Readonly<{ queue: number; dtPerSide: number; stopKeepMs: number; tail: number }>;

export function parseJsonField(v: unknown): Record<string, unknown> | null;
export function prevTradingYmd(ymd: string, isTradingYmd: (ymd: string) => boolean, maxBack?: number): string | null;

/** 搶漲停排隊（limitQueue/latest 前 N 檔） */
export interface FocusQueueItem {
  code: string;
  name: string;
  /** 買一委買張數（排隊中，尚未成交上去） */
  lots: number | null;
  chg: number | null;
  /** 漲停價 */
  limit: number | null;
}
export interface FocusQueue {
  /** 來源自報資料日 */
  date: string | null;
  /** 排隊總檔數 */
  total: number;
  items: FocusQueueItem[];
}
export function buildQueue(doc: Record<string, unknown> | null | undefined, limit?: number): FocusQueue | null;

/** 日韓早盤（asiaPremarket/latest） */
export interface FocusAsia {
  date: string | null;
  /** 日經 225 漲跌 % */
  jp: number | null;
  /** 韓國（KOSPI／KOSDAQ 平均）漲跌 % */
  kr: number | null;
  /** 費半（前一晚美股收盤）漲跌 % */
  sox: number | null;
  /** 報價約落後幾分（Yahoo 免費源） */
  delayMin: number | null;
  /** 補跑（不是盤前觀測值） */
  late: boolean;
  /** 日韓方向分歧 */
  split: boolean;
}
export function buildAsia(doc: Record<string, unknown> | null | undefined): FocusAsia | null;


export function yVolLookup(closeMap: Record<string, unknown> | null | undefined): (code: string) => number | null;

export interface GateQuoteLike {
  live?: boolean;
  price?: number;
  changePercent?: number;
  volume?: number;
  vwap?: number | null;
  high?: number;
  low?: number;
}
export function buildGateRows(input: {
  quotes: Readonly<Record<string, GateQuoteLike>> | null | undefined;
  yVol: (code: string) => number | null;
  frozenBy?: Record<string, unknown> | null;
}): GateRowsWire;

export function dayPos(s: GateQuoteLike | null | undefined): number | null;

export interface DeskPlanLike {
  entry?: number;
  d?: number;
  costR?: number;
  hit?: boolean[];
}
export function unrealizedNetR(plan: DeskPlanLike | null | undefined, price: number | null | undefined, side: 'long' | 'short', split?: readonly number[]): number | null;

/** 當沖觀察一列 */
export interface FocusDtRow {
  side: 'long' | 'short';
  code: string;
  name: string;
  /** on＝成立中；stop＝15 分鐘內剛出場 */
  phase: 'on' | 'stop';
  /** 成立時間（epoch ms） */
  since: number | null;
  /** 列表時間：成立中＝成立時間、剛出場＝出場時間 */
  t: number | null;
  /** 型態（ORB／突破回踩／開低反轉…） */
  type: string | null;
  /** 假設進場價 */
  entry: number | null;
  /** 停損（成立中＝目前追蹤停損） */
  stop: number | null;
  /** 現價（工作台最近一根 1 分 K 收盤） */
  px: number | null;
  chg: number | null;
  /** 淨 R：成立中＝以現價估算（扣成本）；剛出場＝日誌口徑 */
  netR: number | null;
  /** 出場原因（剛出場才有） */
  reason: string | null;
  exitPx: number | null;
  /** 日內位置（撿尾盤段才補；其餘 null） */
  pos: number | null;
}
export interface FocusDtSide {
  rows: FocusDtRow[];
  /** 成立中筆數 */
  on: number;
  /** 15 分鐘內剛出場筆數 */
  stop: number;
  /** 等待條件筆數（已寫定觸發價與停損） */
  wait: number;
  /** 監控中檔數 */
  monitored: number;
}
export interface FocusDaytrade {
  /** 來源自報日期（不是今天 ⇒ 兩側皆空） */
  date: string | null;
  long: FocusDtSide;
  short: FocusDtSide;
}
export function buildDaytrade(
  doc: Record<string, unknown> | null | undefined,
  opts: { ymd: string; now: number; split?: readonly number[]; perSide?: number; keepMs?: number },
): FocusDaytrade | null;
export function withDayPos(dt: FocusDaytrade | null, quotes: Readonly<Record<string, GateQuoteLike>> | null | undefined): FocusDaytrade | null;

/** 撿尾盤候選（marketPattern/latest.tailPicks.buyable） */
export interface FocusTailItem {
  code: string;
  name: string;
  market: string | null;
  px: number | null;
  chg: number | null;
  /** 日內位置 0–1 */
  pos: number | null;
  /** 量比（對近 5 日均量） */
  volX: number | null;
  /** 外資連續買超天數（前交易日以前的 T86） */
  fStreak: number | null;
  /** 籌碼性格 */
  char: string | null;
}
export interface FocusTail {
  date: string | null;
  /** live＝盤中 12:45 起即時快照版；close＝收盤後版 */
  source: 'live' | 'close' | null;
  /** 法人資料所屬交易日 */
  instDate: string | null;
  /** 符合濾網的總檔數 */
  total: number;
  /** 鎖漲停（尾盤買不到）檔數 */
  locked: number;
  items: FocusTailItem[];
}
export function buildTail(mpDoc: Record<string, unknown> | null | undefined, limit?: number): FocusTail | null;
