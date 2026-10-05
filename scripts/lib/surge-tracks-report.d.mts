// 型別宣告：scripts/lib/surge-tracks-report.mjs（route 與後台元件共用）。報酬類欄位刻意不存在（介面不顯示報酬）。
export type TracksListId = 'M0@10' | 'S0_atr14@5' | 'SFB_atr14@5' | 'R0_combo@5' | 'W_atr14@3';
export type Ci = [number, number] | null;

export interface TracksRefStat { hits: number; picks: number; precisionPct: number; deltaPp: number; deltaCiPp: [number, number]; lift: number }
export interface TracksPickOutcome { t1: boolean; buyable: boolean; lockedOpen: boolean; noOpen: boolean; dispT: boolean; dispTUnknown: boolean; flags: string }
export interface TracksPick {
  rank: number | null; code: string | null; name: string | null; nameSrc: string | null; market: string | null; track: string | null;
  close: number | null; vol20: number | null; qmaxLots: number | null; qmaxRule: string | null; dk: number | null; disposalBadge: string | null;
  attention5: number | null; attentionBadge: string | null; score: number | null; comboN: number | null; outcome: TracksPickOutcome | null;
}
export interface TracksListOutcome { events: number | null; picks: number | null; hits: number | null; expectedRand: number | null; baseRatePct: number | null; precisionPct: number | null; deltaPp: number | null; randDrawHits: number | null; nDispTUnknown: number | null }
export interface TracksListBlock {
  id: TracksListId; section: string; title: string; label: string; listVerdict: string; grey: boolean; watchLabel: string | null; exploratory: boolean; K: number;
  warnings: string[]; reference: { sel: TracksRefStat; ho: TracksRefStat } | null; status: 'frozen' | 'not-wired' | 'missing';
  nPool: number | null; ranking: string | null; rand: { picks: number | null; drawCodes: string[] } | null; picks: TracksPick[]; outcome: TracksListOutcome | null;
}
export interface TracksEvent { code: string | null; name: string | null; market: string | null; track: string | null; trackText: string | null; failing: string[]; listId: string | null; rank: number | null; K: number | null; nPool: number | null; picked: boolean; note: string | null; score: number | null; dk: number | null; flags: string }
export interface TracksCovRow { nClose: number | null; nOfficial: number | null; nTickFallback: number | null; coverage: number | null }
export interface TracksLimitCoverage { s: Record<string, TracksCovRow> | null; t: Record<string, TracksCovRow> | null; t1: Record<string, TracksCovRow> | null; min: number | null }
export interface TracksDayDoc {
  schema: string; kind: string; registrationId: string; registrationVersion: string; day: string; t: string | null; seal: string; sealShort: string; frozenAt: string | null; deadline: string | null;
  trackCounts: Record<string, number>; matured: { y: string | null; h5: string | null; h10: string | null };
  lists: TracksListBlock[]; events: TracksEvent[] | null; eventsByTrack: Record<string, number> | null;
  parity: { verdict: string | null; nDiffs: number | null; inputsChanged: string[] } | null;
  disposalAttention: { strictUnknown: Record<string, { disposal_missing_days: string[]; attention_missing_days: string[] }> | null };
  closesAtS: Record<string, number> | null; limitCoverage: TracksLimitCoverage; fixedLabels: string[]; costRef: Array<{ item: string; value: string }>; referenceNote: string; footer: string;
}
export interface TracksDayRow {
  id: string | null; day: string; t: string | null; status: 'frozen' | 'gap' | 'problem'; sealShort: string | null; matured: TracksDayDoc['matured'] | null;
  lists: Record<string, { picks: number | null; hits: number | null; nPool: number | null }>; nEvents: number | null; parity: string | null; gapReason: string | null; unmet?: string[]; problem?: string | null;
}
export interface TracksCum { days: number | null; windowDays: number | null; picks: number | null; hits: number | null; expectedRand: number | null; precisionPct: number | null; randPrecisionPct: number | null; deltaPp: number | null; deltaCiPp: Ci; lift: number | null; liftCi: Ci }
export interface TracksIndexDoc {
  schema: string; kind: string; registrationId: string; registrationVersion: string; hoBurnedNote: string; generatedAt: string | null; s0: string | null; days: TracksDayRow[]; nCore: number; nGaps: number;
  cumulative: Record<string, TracksCum | null>;
  gates: {
    nScored: number;
    g60: { target: number; reached: boolean; outcome: string | null; crash: Record<string, boolean>; failedChecks: string[]; ruling: string | null };
    g250: { target: number; reached: boolean; paused: boolean | null; reason: string | null; verdict: Record<string, string | null> };
    g500: { target: number; reached: boolean; verdict: Record<string, string | null> };
    note: string;
  };
  process: Record<string, { ok: boolean | null; nTradingDays?: number | null; silentDays?: string[]; gapRatio?: number | null; why?: string | null; fail?: string[]; dataCorrection?: string[]; c7Gaps?: string[] }> | null;
  pipeline: { finished: string | null; exit: number | null; errors: number | null; skipped: string | null; prewireOk: boolean | null; prewireWhy: string | null; dispAttOverlap: string | null; pinsOk: boolean | null } | null;
  alerts: Array<{ level: string | null; code: string | null; msg: string | null }>; alertsTime: string | null;
  publishProblems: Array<{ day: string | null; why: string | null }>;
  rawArchive: { ok: boolean; nLocal: number | null; nVerified: number | null; time: string | null; missing: string[] } | null;
  listMeta: Record<string, { title: string; grey: boolean; exploratory: boolean; watchLabel: string | null }>; referenceNote: string; footer: string;
}

export const TRACKS_INDEX_SCHEMA: string;
export const TRACKS_DAY_SCHEMA: string;
export const TRACKS_KIND_DAY: string;
export const TRACKS_KIND_INDEX: string;
export const TRACKS_INDEX_ID: string;
export const TRACKS_DAY_PREFIX: string;
export const TRACKS_DAY_ID_RE: RegExp;
export const DAY_RE: RegExp;
export const MAX_DOC_BYTES: number;
export const REGISTRATION_ID: string;
export const REGISTRATION_VERSION: string;
export const WATCH_LABEL: string;
export const HO_BURNED_NOTE: string;
export const FOOTER: string;
export const G60_N: number;
export const G250_N: number;
export const G500_N: number;
export const TRACKS_KIND_RAW: string;
export const TRACKS_KIND_RAW_SHARD: string;
export const TRACKS_RAW_SCHEMA: string;
export const TRACKS_RAW_PREFIX: string;
export const RAW_SHARD_BYTES: number;
export const TRACKS_RAW_ID_RE: RegExp;
export const LIST_ORDER: TracksListId[];
export const LIST_META: Record<TracksListId, { section: string; title: string; grey: boolean; exploratory: boolean; K: number; label: string; verdict: string; watchLabel: string | null }>;
export const LIST_META_BY_VERSION: Readonly<Record<string, Record<TracksListId, { section: string; title: string; grey: boolean; exploratory: boolean; K: number; label: string; verdict: string; watchLabel: string | null }>>>;
export const LIST_WARNINGS: Record<TracksListId, string[]>;
export const REFERENCE: Record<TracksListId, { sel: TracksRefStat; ho: TracksRefStat }>;
export const REFERENCE_NOTE: string;
export const COST_REF: Array<{ item: string; value: string }>;
export const FIXED_LABELS: string[];
export const FAIL_TEXT: Record<string, string>;
export const TRACK_TEXT: Record<string, string>;
export function dayDocId(day: string): string;
export function isTracksDayId(id: unknown): boolean;
export function assertNoReturns(doc: unknown, path?: string): void;
export function clean<T>(v: T): T;
export function buildTracksDayDoc(input: { core: unknown; y?: unknown; c5?: unknown; c10?: unknown; parity?: unknown }): TracksDayDoc;
export function tracksDaySummary(doc: TracksDayDoc): TracksDayRow;
export function gapSummary(gap: unknown): TracksDayRow;
export interface TracksDayProblem { day: string | null; t: string | null; sealShort: string | null; why: string }
export function buildTracksDayDocs(days: Array<{ core: unknown; y?: unknown; c5?: unknown; c10?: unknown; parity?: unknown }>): { docs: TracksDayDoc[]; problems: TracksDayProblem[] };
export function problemSummary(p: TracksDayProblem): TracksDayRow;
export function coreRegistrationVersion(core: unknown): string;
export function listMetaFor(version: string): Record<TracksListId, { section: string; title: string; grey: boolean; exploratory: boolean; K: number; label: string; verdict: string; watchLabel: string | null }> | null;
export function buildTracksIndexDoc(input: { days?: TracksDayRow[]; summary?: unknown; status?: unknown; generatedAt: string; alerts?: unknown; rawArchive?: unknown; publishProblems?: Array<{ day: string | null; why: string | null }> }): TracksIndexDoc;
export function assertTracksDocSizes(writes: Array<[string, { reportJson?: string }]>): Array<[string, number]>;
export function forwardReplaceProblems(published: Array<{ id: string; seal: string }>, next: Array<{ id: string; seal: string }>, withheld?: string[]): { clash: string[]; missing: string[] };
export function rawDocId(rel: string): string | null;
export function rawDocWrites(input: { id: string; file: string; seal: string | null; sha256: string; bytes: number; gz: Uint8Array }): Array<[string, Record<string, unknown>]>;
export function rawAssemble(head: unknown, shards?: unknown[]): Uint8Array;
export function rawReplaceProblems(published: Array<{ id: string; sha256: string }>, next: Array<{ id: string; sha256: string }>): { clash: string[]; missing: string[] };
export function rawVerifyStatus(local: Array<{ id: string; sha256: string }>, verified: Record<string, { sha256: string; time: string }> | null | undefined, time: string | null): { ok: boolean; n_local: number; n_verified: number; missing: string[]; time: string | null };
