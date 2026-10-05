// 型別宣告：scripts/lib/surge-tracks-report.mjs（route 與後台元件共用）。報酬類欄位刻意不存在（介面不顯示報酬）。
export type TracksListId = 'M0@10' | 'S0_atr14@5' | 'SFB_atr14@5' | 'R0_combo@5' | 'W_atr14@3';
export type Ci = [number, number] | null;

export interface TracksRefStat { hits: number; picks: number; precisionPct: number; deltaPp: number; deltaCiPp: [number, number]; lift: number }
export interface TracksPickOutcome { t1: boolean; buyable: boolean; lockedOpen: boolean; noOpen: boolean; dispT: boolean; flags: string }
export interface TracksPick {
  rank: number | null; code: string | null; name: string | null; nameSrc: string | null; market: string | null; track: string | null;
  close: number | null; vol20: number | null; qmaxLots: number | null; qmaxRule: string | null; dk: number | null; disposalBadge: string | null;
  attention5: number | null; attentionBadge: string | null; score: number | null; comboN: number | null; outcome: TracksPickOutcome | null;
}
export interface TracksListOutcome { events: number | null; picks: number | null; hits: number | null; expectedRand: number | null; baseRatePct: number | null; precisionPct: number | null; deltaPp: number | null; randDrawHits: number | null }
export interface TracksListBlock {
  id: TracksListId; section: string; title: string; label: string; listVerdict: string; grey: boolean; exploratory: boolean; K: number;
  warnings: string[]; reference: { sel: TracksRefStat; ho: TracksRefStat } | null; status: 'frozen' | 'not-wired' | 'missing';
  nPool: number | null; ranking: string | null; rand: { picks: number | null; drawCodes: string[] } | null; picks: TracksPick[]; outcome: TracksListOutcome | null;
}
export interface TracksEvent { code: string | null; name: string | null; market: string | null; track: string | null; trackText: string | null; failing: string[]; listId: string | null; rank: number | null; K: number | null; nPool: number | null; picked: boolean; note: string | null }
export interface TracksDayDoc {
  schema: string; kind: string; registrationId: string; day: string; t: string | null; seal: string; sealShort: string; frozenAt: string | null; deadline: string | null;
  trackCounts: Record<string, number>; matured: { y: string | null; h5: string | null; h10: string | null };
  lists: TracksListBlock[]; events: TracksEvent[] | null; eventsByTrack: Record<string, number> | null;
  parity: { verdict: string | null; nDiffs: number | null; inputsChanged: string[] } | null;
  disposalAttention: { strictUnknown: Record<string, { disposal_missing_days: string[]; attention_missing_days: string[] }> | null };
  closesAtS: Record<string, number> | null; fixedLabels: string[]; costRef: Array<{ item: string; value: string }>; referenceNote: string; footer: string;
}
export interface TracksDayRow {
  id: string | null; day: string; t: string | null; status: 'frozen' | 'gap'; sealShort: string | null; matured: TracksDayDoc['matured'] | null;
  lists: Record<string, { picks: number | null; hits: number | null; nPool: number | null }>; nEvents: number | null; parity: string | null; gapReason: string | null; unmet?: string[];
}
export interface TracksCum { days: number | null; windowDays: number | null; picks: number | null; hits: number | null; expectedRand: number | null; precisionPct: number | null; randPrecisionPct: number | null; deltaPp: number | null; deltaCiPp: Ci; lift: number | null; liftCi: Ci }
export interface TracksIndexDoc {
  schema: string; kind: string; registrationId: string; generatedAt: string | null; s0: string | null; days: TracksDayRow[]; nCore: number; nGaps: number;
  cumulative: Record<string, TracksCum | null>;
  gates: { nScored: number; g60: { target: number; reached: boolean; crash: Record<string, boolean | null> }; g250: { target: number; reached: boolean; verdict: Record<string, string | null> }; note: string };
  process: Record<string, unknown> | null; pipeline: { finished: string | null; exit: number | null; errors: number | null; skipped: string | null } | null;
  listMeta: Record<string, { title: string; grey: boolean; exploratory: boolean }>; referenceNote: string; footer: string;
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
export const FOOTER: string;
export const G60_N: number;
export const G250_N: number;
export const LIST_ORDER: TracksListId[];
export const LIST_META: Record<TracksListId, { section: string; title: string; grey: boolean; exploratory: boolean; K: number; label: string; verdict: string }>;
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
export function buildTracksIndexDoc(input: { days?: TracksDayRow[]; summary?: unknown; status?: unknown; generatedAt: string }): TracksIndexDoc;
export function assertTracksDocSizes(writes: Array<[string, { reportJson?: string }]>): Array<[string, number]>;
export function forwardReplaceProblems(published: Array<{ id: string; seal: string }>, next: Array<{ id: string; seal: string }>): { clash: string[]; missing: string[] };
