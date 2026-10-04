// 型別宣告：scripts/lib/surge-lab-report.mjs（route 與後台元件共用）
export type CvTaskId = 't1L' | 't2L' | 'lu1L';
export type CvVersionId = 'pre_fix' | 'current';
export type CvModel = 'base' | 'official';
export type CvKind = 'hits' | 'misses' | 'outside';
export type Ci = [number, number] | null;
export type Pair = [number, number] | null;

export interface CvModelStat { prec: number | null; auc: number | null; lift: number | null; hits: number | null; picks: number | null; nfeat: number | null; seeds: number | null; vs_base?: { dprec: Ci; dauc: Ci } }
export interface CvAblationRow extends CvModelStat { key: string; referenceOnly: boolean }
export interface CvHitmiss { K: number | null; n_hit: number | null; n_miss: number | null; feature_pct_mean: Record<string, Pair>; source_has_value_rate: Record<string, Pair>; miss_rank_bins: Record<string, number | null>; by_market: Record<string, Pair>; legend: string | null }
export interface CvMeta { task: string | null; K: number | null; test_rows: number | null; positives: number | null; days: number | null; base_rate: number | null; protocol: string | null; groups: Record<string, string[]> }
export interface RobustHalf { days: number; base: number; official: number; diff_ci: [number, number] }
/** 穩健度（百分比單位；robust.py 輸出原樣） */
export interface CvRobust {
  task: string; overall: { base: number; official: number }; by_half: Record<string, RobustHalf>;
  base: Record<string, number | null | Record<string, number | null>>; official: Record<string, number | null | Record<string, number | null>>;
  universe?: Record<string, number | null>;
}
export interface CvRowsRef { docId: string; totalRows: number; keptRows: number; filterNote: string | null }
export type CvRowsSlot = CvRowsRef | { skipped: string };
export interface CvVersion {
  id: CvVersionId; label: string; versionLabel: string; sameAs: CvVersionId | null; note?: string;
  dir?: string; sha12?: string | null; mtime?: string | null; meta?: CvMeta | null; base?: CvModelStat | null; official?: CvModelStat | null;
  ablation?: CvAblationRow[]; hitmiss?: { base: CvHitmiss | null; official: CvHitmiss | null };
  robust?: CvRobust | null; robustNote?: string | null;
  analysis?: { file: string; sha12: string | null; markdown: string; truncated: boolean; chars: number } | null;
  rows?: { base?: Record<string, CvRowsSlot> | { skipped: string }; official?: Record<string, CvRowsSlot> | { skipped: string }; outside?: Record<string, CvRowsRef> };
  warnings?: string[];
}
export interface CvRowsDocMeta { id: string; task: CvTaskId; version: CvVersionId; model: CvModel | 'all'; kind: CvKind; totalRows: number; keptRows: number; filterNote: string | null; gzBytes: number; sha256: string }
export interface CvDoc { schema: string; dataDate: string; generatedAt: string; tasks: Array<{ id: CvTaskId; label: string; versions: CvVersion[]; note: string | null }>; rowsDocs: CvRowsDocMeta[] }

export interface MirrorDataset { key: string; host: string | null; id: string; first: string | null; last: string | null; unit: 'day' | 'month' | 'quarter' | 'other'; counts: Record<string, number>; stale: boolean | null; verified: boolean | null }
export interface MirrorDoc {
  schema: string; dataDate: string; generatedAt: string; lastTradingDay: string | null; present: boolean; manifestUpdated: string | null; manifestAlerts: { at?: string; missing?: number } | null;
  summary: { datasets: number; daily: number; stale: number; withBad: number; verifyTotal: number; verifyOk: number; alertsMissing: number | null };
  verifyFailures: Array<{ id: string; status: string | null; note: string | null; rows: number | null; echo: string | null; at: string | null }>;
  alerts: { rule: string | null; at: string | null; missingTotal: number; missing: Array<{ id: string | null; key: string | null; status: string | null }>; truncated: boolean } | null;
  alertsNote: string | null;
  lock: { cmd: string | null; pid: number | null; at: string | null; alive: boolean | null } | null;
  budget: { day: string | null; requests: number | null } | null;
  runs: Array<{ name: string | null; requests: number | null; stats: Record<string, number> | null; alerts: number | null; at: string | null }>;
  datasets: MirrorDataset[];
}
export interface PipelineDoc { schema: string; dataDate: string; generatedAt: string; present: boolean; status: Record<string, unknown> | null; mtime: string | null; note: string | null }

export type RowsCell = string | number | null;
export interface RowsTable { cols: string[]; rows: RowsCell[][] }
export interface RowsQuery { task: CvTaskId; version: CvVersionId; model: CvModel; kind: CvKind; market: 'all' | 'tse' | 'otc'; sort: 'date' | 'rank'; rankMin: number | null; rankMax: number | null; page: number; from: string | null; to: string | null; q: string }
export interface RowsPage extends RowsTable { total: number; page: number; pages: number; pageSize: number; rankIgnored: boolean }

export const CV_SCHEMA: string;
export const CVROWS_SCHEMA: string;
export const MIRROR_SCHEMA: string;
export const PIPELINE_SCHEMA: string;
export const LAB_DOC_IDS: { cv: string; mirror: string; pipeline: string };
export const MAX_DOC_BYTES: number;
export const ROWS_PAGE_SIZE: number;
export const LU_MISS_RANK_MAX: number;
export const CVROWS_ID_RE: RegExp;
export const CV_TASKS: Array<{ id: CvTaskId; label: string }>;
export const CV_VERSIONS: Array<{ id: CvVersionId; label: string; dir: string; snapshot: string | null }>;

export function parseRowsQuery(params: URLSearchParams): { ok: true; query: RowsQuery } | { ok: false; error: string };
export function resolveRowsDoc(cvDoc: CvDoc | null, q: { task: string; version: string; model: string; kind: string }): CvRowsDocMeta | null;
export function queryRows(table: RowsTable, query: RowsQuery, pageSize?: number): RowsPage;
