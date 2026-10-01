// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export const DT_DAILY_LIMIT: number;
export const DT_LIMIT_MULTIPLE: number;
export function limitUsed(records: { status: string; fillPx?: number | null; shares?: number | null }[]): number;
export function limitLeft(limit: number, records: { status: string; fillPx?: number | null; shares?: number | null }[]): number;
export function maxLots(px: number, left: number): number;
export function tradeBlock(x: { side: 'long' | 'short'; disposition: boolean | null; elig: number | null }): string | null;
export function limitRequestOf(x: { cash: number; limit: number; last?: { status: string; cash: number } | null }): { current: number; cash: number; proposed: number } | null;
export function lotTranches(shares: number): number[];
