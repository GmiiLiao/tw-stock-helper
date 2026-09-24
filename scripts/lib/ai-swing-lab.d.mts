// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export interface SwingModelInfo { name: string; digest: string | null; family: string | null; parameterSize: string | null; quantization: string | null; modifiedAt: string | null }
export interface SwingPick { code: string; name: string; confidence: number; horizon: number | null; reason: string; risk: string; sources: string[]; priceAtDecision: number | null }
export interface SimLeg { side: 'buy' | 'sell'; at: number | null; px: number; shares: number; amount: number; fee: number; tax: number }
export interface SimLedger { legs?: SimLeg[]; side: 'long' | 'short'; shares: number; dayTrade: boolean; buy: { at: number; px: number; amount: number; fee: number }; sell: { at: number; px: number; amount: number; fee: number; tax: number }; costTwd: number; pnlTwd: number; retPct: number; holdMs: number | null; decidedAt: number | null; entryAt: number; noLookahead: boolean | null }
export interface SwingOutcomePick { ledger?: SimLedger | null; entryAt?: number; exitAt?: number; code: string; net: number | null; entryDate?: string; entryPx?: number; openMissing?: boolean; exitDate?: string; exitPx?: number; maxDD?: number; maxUp?: number; note?: string }
export interface SwingOutcome { h: number; exitDate: string; settledAt: number; picks: SwingOutcomePick[]; pool: { n: number; avg: number; win: number } | null }
export interface SwingHorizonStat { pnlTwd: number | null; days: number; n: number; avg: number | null; win: number | null; poolAvg: number | null; excess: number | null; beatPool: number | null }
export interface SwingLabDoc {
  date: string; version: string; model: SwingModelInfo | null; market: string | null; pool: { code: string; name: string; sources: string[] }[];
  picks: SwingPick[]; note: string; outcomes: Record<string, SwingOutcome>; frozenAt: number; settledAll?: boolean;
  adminNotes?: string; adminNotesAt?: number; adminBy?: string; prompt?: string | null; raw?: string | null;
}
export const SWING_HORIZONS: readonly number[];
export const SWING_LAB_VERSION: string;
export function swingStats(docs: { outcomes?: Record<string, SwingOutcome> }[]): Record<string, SwingHorizonStat>;
