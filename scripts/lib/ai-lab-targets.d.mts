// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export interface WindowStat { n: number; target: number; days: number; partial: boolean; from?: string | null; to?: string; ret: number | null; met: boolean; windows: number; positive: number; hitRate: number | null; streak: number; best: number | null; worst: number | null; metWindows?: number }
export interface TargetBoard { total: number; cumRetPct: number; tradingDays: number; windows: WindowStat[]; cumTarget: number | null; targetTotal: number | null; cumMet: boolean; cumProgress: number | null }
export const LAB_TARGETS: Readonly<Record<number, number>>;
export function windowStats(series: { date: string; total: number }[], initial: number, n: number, target?: number): WindowStat;
export const SWING_CUM_TARGET: number;
export function targetBoard(series: { date: string; total: number }[], initial: number, opts?: { cumTarget?: number | null }): TargetBoard;
