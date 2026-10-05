// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { Position, StopResolution, StopBookPosition, StopSource } from './ai-stoploss.mjs';

/** stopBooks/{uid} 讀回後的形狀（positions 只做最低限度的形狀過濾；欄位以 ai-stoploss.d.mts StopBookPosition 為準） */
export interface StopBookView {
  phase: 'shadow' | 'live';
  specVersion: string;
  /** 最近定版的收盤資料日（YYYY-MM-DD）；缺為 null */
  dataDate: string | null;
  updatedAt: number | null;
  positions: Readonly<Record<string, Partial<StopBookPosition> & Record<string, unknown>>>;
  /** daemon 寫的已驗證官方鏡像歸檔種類（＝STOP_VERIFIED_ARCHIVES）；缺＝空＝都還沒驗證（bookStopOf 的 legacy 判斷用） */
  verifiedArchives: ReadonlyArray<'etf' | 'emerging'>;
}

export function parseStopBookDoc(raw: unknown): StopBookView | null;
/** phase 'live' 且 specVersion 'stop-v1.1' */
export function stopBookLive(book: StopBookView | null | undefined): boolean;
export function sameLots(a: unknown, b: unknown): boolean;
/** 沒有資料日，或資料日早於前一交易日 */
export function stopBookStale(book: StopBookView | null | undefined, prevYmd: string | null | undefined): boolean;

/** book＝停損簿這一版；bookCalc＝帶停損簿原料暫算（待 daemon 確認）；legacy＝legacyCodeActive（noOfficialBars 或歸檔未驗證）沿用現行推播口徑 */
export type BookStopMode = 'book' | 'bookCalc' | 'legacy';
export type BookCalcWhy = 'missing' | 'stale' | 'lots' | 'invalid';
export function bookStopOf(position: Position, opts: {
  book: StopBookView;
  todayYmd?: string;
  prevYmd?: string | null;
  lastPrice?: number | null;
  nowMs?: number;
  /** 持股分析 ATR 帶（legacy 模式用） */
  ratingBand?: number | null;
}): { mode: BookStopMode; res: StopResolution; bp: (Partial<StopBookPosition> & Record<string, unknown>) | null; why: BookCalcWhy | null };
export function bookCalcWhyText(why: BookCalcWhy | null | undefined, book: StopBookView | null | undefined): string;

export interface ShadowStop {
  stop: number; stopSource: StopSource | null; basisText: string; dataDate: string | null; noOfficialBars: boolean;
}
/** 影子期 daemon 試算值（只供抽屜對照，不參與判定） */
export function shadowStopOf(book: StopBookView | null | undefined, code: string): ShadowStop | null;
