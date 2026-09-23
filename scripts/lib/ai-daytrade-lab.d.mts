// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export interface AiLabRecord {
  id: string; side: 'long' | 'short'; code: string; name: string; type: string; why: string;
  triggerAt: number; triggerPx: number; stop: number; d: number; targets: number[];
  score: { total: number; knownMax: number; tier: string | null; missing: string[] };
  warnings: string[]; askedAt: number;
  decision: 'take' | 'skip' | null; confidence: number | null; reason: string | null; risk: string | null;
  status: 'pending' | 'filled' | 'skipped' | 'missed' | 'error' | 'quota' | 'out-of-window';
  fillPx: number | null; lagMs: number | null;
  exitAt?: number; exitPx?: number; exitReason?: string; ruleNetR?: number | null; mfeR?: number | null; aiNetPct?: number; aiNetR?: number | null;
}
export interface AiLabGroup { n: number; settled: number; ruleAvgR: number | null; ruleWin: number | null; aiAvgR: number | null; aiWin: number | null }
export interface AiLabSideStats { taken: AiLabGroup; skipped: AiLabGroup; missed: number; allRule: AiLabGroup }
export interface AiLabStats { long: AiLabSideStats; short: AiLabSideStats; all: AiLabSideStats }
export const AI_LAB_VERSION: string;
export const AI_LAB_QUOTA: { long: number; short: number };
export function labStats(records: AiLabRecord[]): AiLabStats;
export function factsOf(records: AiLabRecord[]): { worked: string[]; failed: string[] };
