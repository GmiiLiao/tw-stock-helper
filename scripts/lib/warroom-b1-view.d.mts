// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { WarSegment } from './warroom-session.mjs';

export type RadarStratKey =
  | 'ignite' | 'volSurge' | 'openStrong' | 'ma5Bounce' | 'followThru' | 'chipIgnite' | 'squeeze' | 'breakHigh';
export type StratSelect = RadarStratKey | 'all';
export type B1Phase = 'pre' | 'waiting' | 'show';
export type B1Extra = 'gap' | 'tp' | null;

export const RADAR_STRAT_ORDER: readonly RadarStratKey[];
export const RADAR_STRAT_DISPLAY: readonly RadarStratKey[];
export const RADAR_STRAT_GLYPH: Readonly<Record<RadarStratKey, string>>;
export const RADAR_STRAT_LABEL: Readonly<Record<RadarStratKey, string>>;
export const RADAR_STRAT_NAME: Readonly<Record<RadarStratKey, string>>;
export const FADE_GLYPH: Readonly<Record<string, string>>;
export const NEW_WINDOW_MS: number;
export const CONSENSUS_MIN: number;
export const GOLD_TOP_N: number;
export const EARLY_SAMPLE_END: number;

export function isRadarStrat(k: unknown): k is RadarStratKey;
export function sortHits(hits: readonly string[] | null | undefined): RadarStratKey[];
export function b1Phase(input: { segment: WarSegment; beforeOpen: boolean; ymd: string; dataDate: string | null }): B1Phase;
export function defaultStrat(segment: WarSegment): StratSelect;
export function extraColumn(segment: WarSegment): B1Extra;
export function isEarlySample(segment: WarSegment, minute: number): boolean;
export function isConsensus(row: { hits: readonly string[] } | null | undefined): boolean;
export function goldCodes(rows: readonly { code: string; hits: readonly string[] }[]): string[];
export function filterLong<T extends { hits: readonly string[] }>(
  rows: readonly T[], opts?: { strat?: StratSelect; consensusOnly?: boolean },
): T[];
export function stratCounts(rows: readonly { hits: readonly string[] }[]): Record<RadarStratKey, number>;
export function isNewRow(firstSeen: number | null | undefined, now: number): boolean;
export function minutesOnBoard(firstSeen: number | null | undefined, asOf: number | null | undefined): number | null;
export function shortGlyphs(row: { pattern: string; also?: readonly string[] }): string[];

export interface ConsensusState { ymd: string; asOf: number | null; codes: string[] }
export function diffNewConsensus<T extends { code: string; hits: readonly string[] }>(
  state: ConsensusState | null,
  rows: readonly T[],
  ctx: { ymd: string; asOf: number | null; dataDate: string | null },
): { state: ConsensusState | null; fresh: T[] };
export function consensusText(row: { code: string; name: string; hits: readonly string[] }): string;
