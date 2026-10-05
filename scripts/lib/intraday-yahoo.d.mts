// 型別橋接：讓 src/app/api/twse/stock-intraday/route.ts 能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）

export interface IntradayTick {
  /** epoch 秒 */
  time: number;
  /** 台北 HH:mm */
  timeStr: string;
  close: number;
  volume: number;
}

export interface YahooTrunk {
  prevClose: number;
  ticks: readonly IntradayTick[];
}

/** Yahoo v8 chart 的 chart.result[0]（只列用到的欄位） */
export interface YahooChartResult {
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: Array<number | null>; volume?: Array<number | null> }> };
  meta?: { chartPreviousClose?: number; previousClose?: number };
}

export type FetchChart = (symbol: string) => Promise<YahooChartResult | null>;

export interface TrunkMemoOptions {
  negativeTtlMs?: number;
  maxStaleMs?: number;
  isDegraded?: (v: unknown) => boolean;
}

export type TrunkMemoize = (
  key: string,
  ttlMs: number,
  fetcher: () => Promise<YahooTrunk | null>,
  opts?: TrunkMemoOptions,
) => () => Promise<YahooTrunk | null>;

export declare const INTRADAY_CODE_RE: RegExp;
export declare const YAHOO_TRUNK_TTL_MS: number;
export declare const YAHOO_TRUNK_NEGATIVE_TTL_MS: number;
export declare const YAHOO_TRUNK_MAX_STALE_MS: number;

export declare function yahooTrunkKey(code: string): string;
export declare function taipeiHHmm(tsSec: number): string;
export declare function parseYahooChart(result: YahooChartResult | null | undefined): YahooTrunk;
export declare function fetchYahooTrunk(code: string, fetchChart: FetchChart): Promise<YahooTrunk | null>;
export declare function createYahooTrunkReader(deps: {
  memoize: TrunkMemoize;
  fetchChart: FetchChart;
  ttlMs?: number;
  negativeTtlMs?: number;
  maxStaleMs?: number;
}): (code: string) => Promise<YahooTrunk | null>;
