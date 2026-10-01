// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export interface AiLabRecord {
  id: string; side: 'long' | 'short'; code: string; name: string; type: string; why: string;
  triggerAt: number; triggerPx: number; stop: number; d: number; targets: number[];
  score: { total: number; knownMax: number; tier: string | null; missing: string[] };
  warnings: string[]; askedAt: number;
  decision: 'take' | 'skip' | null; confidence: number | null; reason: string | null; risk: string | null;
  // v4：ineligible＝處置／非當沖標的（不送 AI）、no-limit＝每日交易額度不足；quota／no-cash 為 v1–v3 凍結記錄的舊狀態
  status: 'pending' | 'filled' | 'skipped' | 'missed' | 'error' | 'ineligible' | 'no-limit' | 'quota' | 'out-of-window' | 'no-cash';
  fillPx: number | null; lagMs: number | null;
  exitAt?: number; exitPx?: number; exitReason?: string; ruleNetR?: number | null; mfeR?: number | null; aiNetPct?: number; aiNetR?: number | null;
  shares?: number; budget?: number; cashBefore?: number; cfNote?: string;
  lotsAsked?: number | null; lots?: number | null; sizeNote?: string; limitLeft?: number; limitAfter?: number; limitLeftAtAsk?: number; maxLotsAtAsk?: number;
  decidedAt?: number; fillAt?: number; fillQuoteAt?: number | null; fillSource?: string;
  ledger?: import('./ai-swing-lab.mjs').SimLedger | null; cfLedger?: import('./ai-swing-lab.mjs').SimLedger | null; ledgerNote?: string;
}
export interface AiLabGroup { n: number; settled: number; ruleAvgR: number | null; ruleWin: number | null; aiAvgR: number | null; aiWin: number | null; pnlTwd?: number | null; cfPnlTwd?: number | null }
export interface AiLabSideStats { taken: AiLabGroup; skipped: AiLabGroup; missed: number; allRule: AiLabGroup }
export interface AiLabStats { long: AiLabSideStats; short: AiLabSideStats; all: AiLabSideStats }
export const AI_LAB_VERSION: string;
/** 每日交易額度快照（v4；舊記錄為 quota） */
export interface AiLabLimit { limit: number; used: number; left: number }
export function labStats(records: AiLabRecord[]): AiLabStats;
export function factsOf(records: AiLabRecord[]): { worked: string[]; failed: string[] };
