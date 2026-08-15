// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export interface HoldingStrategyResult {
  chg: number; pos: number | null; brk20: boolean; charLabel: string | null;
  selfPath: number[];    // 近20日累計%（錨=今日=0）——隔日沖圖與相似圖共用
  hi20Rel: number;       // 20日高相對今日的%位置（>0=未破、<0=已站上）
  filterPass: boolean; passes: string[]; fails: string[];
  hold: Array<{ d: number; med: number; win: number; n: number }>;
  heldDays: number | null; holdN: number;
  analog: {
    n: number; tube: number; relaxedOutDays: number | null; stats: Array<{ d: number; med: number; win: number }>;
    grow: number | null; draw: number | null;   // <5 段時留空——小樣本中位數不是統計
    selfPath: number[];   // 本檔近20日累計%（錨=今天=0）
    examples: Array<{ code: string; name: string; ind: string | null; sameInd: boolean; date: string; ret5: number | null; path: number[]; winLen: number }>;
  } | null;
  analogNote: string | null;
  selfPath5: number[] | null;   // 近5日累計%（錨=今日=0）——隔日沖相似日圖
  pagoda: PagodaJudgment | null;      // 日K 寶塔線（波段口徑·MA20=月線）
  pagoda60: PagodaJudgment | null;    // 60分K 寶塔線（短線口徑·由 pagodaSignals 供）
  nextAnalog: {
    n: number; tube: number; relaxedOutDays: number | null;
    openMed: number | null; openWin: number | null;   // 隔日開盤賣口徑（鐵律出場）
    d5Med: number | null; d5Win: number | null;
    examples: Array<{ code: string; name: string; ind: string | null; sameInd: boolean; date: string;
      openRet: number | null; path5: number[]; winLen5: number }>;
  } | null;
}
export interface PagodaJudgment {
  color: 'red' | 'green'; run: number; flip: 'up' | 'down' | null;
  close: number; ma: number; above: boolean;
  action: '續抱' | '賣出' | '觀察' | '警戒'; note: string;
}
export interface StrategySeries { [code: string]: { dates: string[]; c: number[]; h: number[]; l: number[] } }
export interface StrategyWindows { codes: string[]; idx: Int32Array; vecs: Float32Array; count: number }
export function buildStrategySeries(archDocsAsc: Array<{ date: string; closeJson: string }>): StrategySeries;
export function buildStrategyWindows(series: StrategySeries): StrategyWindows;
export function computeHoldingStrategy(
  ctx: { series: StrategySeries; windows: StrategyWindows; charMap: Record<string, { label?: string }>; pagoda60Map?: Record<string, PagodaJudgment> },
  code: string, buyDate: string | null,
): HoldingStrategyResult | null;
