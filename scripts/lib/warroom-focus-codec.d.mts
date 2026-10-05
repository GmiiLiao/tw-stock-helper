// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）

export type FocusPart = 'script' | 'gates' | 'daytrade' | 'tail';

export interface FocusWindow {
  /** 台北當日分鐘數（含） */
  from: number;
  /** 台北當日分鐘數（不含） */
  to: number;
  /** 給畫面看的時窗文字 */
  label: string;
}

export const FOCUS_WINDOW: Readonly<Record<FocusPart, Readonly<FocusWindow>>>;
export function focusPartActive(part: FocusPart, minute: number, trading: boolean): boolean;

export const GATE1_THRESHOLD_PCT: number;

/** 全市場開盤三關數據（欄式編碼；見 warroom-focus-codec.mjs 檔頭） */
export interface GateRowsWire {
  /** 代號差分 */
  d: string;
  /** 前段量÷昨量 %（整數；缺＝空字串） */
  r: string;
  /** 漲跌 %×100（整數） */
  c: string;
  /** VWAP 位置：'1' 在上、'0' 在下、'-' 未知 */
  w: string;
  /** 檔數 */
  n: number;
}

export interface GateRowIn {
  code: string;
  /** 前段量÷昨量 %；缺昨量為 null */
  ratio: number | null;
  /** 漲跌 % */
  chg: number;
  /** 現價相對 VWAP：1 在上（含等於）、0 在下、null 未知 */
  vw: 1 | 0 | null;
}

export interface GateRowOut {
  ratio: number | null;
  chg: number;
  vw: 1 | 0 | null;
}

export function encodeGateRows(rows: readonly GateRowIn[]): GateRowsWire;
export function decodeGateRows(g: Partial<GateRowsWire> | null | undefined): Map<string, GateRowOut>;

export type GateRsLabel = '跟風' | '自己強' | '中性';
export function gateRsLabel(chg: number | null | undefined, idxChg: number | null | undefined): { rs: number; label: GateRsLabel } | null;
