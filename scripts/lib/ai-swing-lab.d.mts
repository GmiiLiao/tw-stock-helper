// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export interface SwingModelInfo { name: string; digest: string | null; family: string | null; parameterSize: string | null; quantization: string | null; modifiedAt: string | null }
export interface SwingPosition { shares: number; budget: number; estCost: number; exitH: number; lots: number; oddShares: number; reason?: string; sizedAt?: number; note?: string; sizing?: string }
export interface SimAccount { initial: number; realized: number; equity: number; openCost: number; cash: number; openN: number; closedN: number; retPct: number }
export interface SwingPick { position?: SwingPosition; code: string; name: string; confidence: number; horizon: number | null; reason: string; risk: string; sources: string[]; priceAtDecision: number | null }
export interface SimLeg { side: 'buy' | 'sell'; at: number | null; px: number; shares: number; amount: number; fee: number; tax: number }
export interface SimLedger { legs?: SimLeg[]; side: 'long' | 'short'; shares: number; dayTrade: boolean; buy: { at: number; px: number; amount: number; fee: number }; sell: { at: number; px: number; amount: number; fee: number; tax: number }; costTwd: number; pnlTwd: number; retPct: number; holdMs: number | null; decidedAt: number | null; entryAt: number; noLookahead: boolean | null; feeDiscount?: number }
export interface SwingOutcomePick { account?: boolean; ledger?: SimLedger | null; entryAt?: number; exitAt?: number; code: string; ret?: number | null; net: number | null; entryDate?: string; entryPx?: number; openMissing?: boolean; exitDate?: string; exitPx?: number; maxDD?: number; maxUp?: number; note?: string }
export interface SwingOutcome { h: number; exitDate: string; settledAt: number; picks: SwingOutcomePick[]; pool: { n: number; avg: number; win: number; avgRet?: number; winRet?: number } | null }
/** 未扣成本報酬 %（新紀錄 ret；舊紀錄 net＋固定成本） */
export declare const grossOf: (o: { ret?: number | null; net?: number | null } | null | undefined) => number | null;
export declare const poolGrossOf: (pool: { avgRet?: number; avg?: number } | null | undefined) => number | null;
export interface SwingHorizonStat { pnlTwd: number | null; days: number; n: number; avg: number | null; win: number | null; poolAvg: number | null; excess: number | null; beatPool: number | null }
export interface SwingLabDoc {
  date: string; version: string; model: SwingModelInfo | null; market: string | null; pool: { code: string; name: string; sources: string[] }[];
  picks: SwingPick[]; note: string; outcomes: Record<string, SwingOutcome>; frozenAt: number; settledAll?: boolean;
  adminNotes?: string; adminNotesAt?: number; adminBy?: string; prompt?: string | null; raw?: string | null; account?: SimAccount;
  review?: SwingReview; cashForBuys?: number; equityAtDecision?: number;
  buyFills?: Record<string, SwingFill>; sellFills?: Record<string, SwingFill & { ledger?: SimLedger | null; sellNoLookahead?: boolean | null }>;
}
export interface SwingFill { date: string; at?: number; px?: number; openMissing?: boolean; failed?: boolean; reason?: string }
export interface SwingReview { holdings: { key: string; code: string; name: string; shares: number; buyPx: number; lastPx: number | null; pnlPct: number | null; heldDays: number | null; onList: boolean }[]; sells: { key: string; code: string; name: string; shares: number; reason: string; estPx: number | null; estProceeds: number }[] }
export interface SwingLot { key: string; date: string; code: string; name: string; shares: number; status: 'pending' | 'held' | 'selling' | 'closed' | 'void' }
export const SWING_HORIZONS: readonly number[];
export const SWING_LAB_VERSION: string;
export function swingAccount(docs: SwingLabDoc[], beforeDate?: string | null, days?: unknown[] | null, opts?: import('./ai-swing-portfolio.mjs').AccountOpts): SimAccount;
export function swingStats(docs: { outcomes?: Record<string, SwingOutcome> }[]): Record<string, SwingHorizonStat>;
