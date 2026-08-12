// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export interface HoldingStrategyResult {
  chg: number; pos: number | null; brk20: boolean; charLabel: string | null;
  filterPass: boolean; passes: string[]; fails: string[];
  hold: Array<{ d: number; med: number; win: number; n: number }>;
  heldDays: number | null; holdN: number;
  analog: {
    n: number; stats: Array<{ d: number; med: number; win: number }>;
    grow: number; draw: number;
    examples: Array<{ code: string; date: string; ret5: number | null }>;
  } | null;
}
export interface StrategySeries { [code: string]: { dates: string[]; c: number[]; h: number[]; l: number[] } }
export interface StrategyWindows { codes: string[]; idx: Int32Array; vecs: Float32Array; count: number }
export function buildStrategySeries(archDocsAsc: Array<{ date: string; closeJson: string }>): StrategySeries;
export function buildStrategyWindows(series: StrategySeries): StrategyWindows;
export function computeHoldingStrategy(
  ctx: { series: StrategySeries; windows: StrategyWindows; charMap: Record<string, { label?: string }> },
  code: string, buyDate: string | null,
): HoldingStrategyResult | null;
