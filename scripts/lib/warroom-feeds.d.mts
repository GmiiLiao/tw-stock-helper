// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）

/** B2 伺服器端事件種類（與 src/components/WarRoomV2/events.ts 的 WarEventKind 同名，共用類型欄文字） */
export type FeedKind = 'surgeUp' | 'surgeDown' | 'limitTouch' | 'consensus' | 'newsVerdict' | 'mops' | 'queue';

export interface FeedEvent {
  /** `s:${kind}:${code}:${at}`——同一事件每次回傳 id 相同，前端據此去重累積（排隊例外：`s:queue:${code}:${ymd}`，每檔當日一則） */
  id: string;
  /** 事件本身的時間（epoch ms）：爆量＝計算輪、漲停＝首次觸及的分鐘、雷達＝首次上榜、新聞＝判別產出、重訊＝公告時刻、排隊＝偵測到的那一輪 */
  at: number;
  kind: FeedKind;
  code: string;
  name: string;
  /** 代號與名稱以外的事實描述（不含指令句） */
  text: string;
  /** O＝官方公告、M＝媒體新聞（AI 讀過內文） */
  source?: 'O' | 'M';
  side?: 'long' | 'short';
}

/** 每檔最新一則重訊 [時間, 文字]——前端拿使用者持股／釘選對照，補出「我的」事件（不帶每人參數到伺服器）。
 *  新聞判別的「我的」事件改由前端從 board.news 精簡表產生（warroom-news.mineNewsEvents），這裡不再帶。 */
export interface FeedCodeIndex {
  mops: Record<string, [number, string]>;
}

export interface ThemeDef { key: string; name: string; codes: string[] }
export interface ThemeIndex { themes: ThemeDef[]; byCode: Record<string, string[]> }

export interface SectorRow {
  key: string;
  name: string;
  /** 成交值加權漲跌%（marketWind） */
  wChg: number | null;
  /** 中位數漲跌%（舊文件沒有 wChg 時的退路） */
  medChg: number | null;
  /** 題材成交值占比% */
  valueShare: number | null;
  strong: number | null;
  members: number | null;
  /** 今日觸及漲停家數（漲停順序流同源·檔位口徑）；資料日對不上為 null */
  touched: number | null;
  /** 題材成分股（themeMap；對照缺時退回 leaders） */
  codes: string[];
}

export interface SectorSummary { text: string; asOf: number | null; ai: boolean }

export interface LimitFlowRow {
  code: string;
  name: string;
  /** 首次觸及漲停 HH:MM（台北） */
  time: string;
  at: number | null;
  /** 當日第幾家觸及漲停 */
  rank: number;
  /** 族群名：題材（themeMap）優先，沒有對照退回官方產業別 */
  group: string | null;
  groupKey: string | null;
  groupKind: 'theme' | 'industry' | null;
  /** 題材內第幾家（官方產業別不數） */
  groupRank: number | null;
  /** 這一列是該題材第 3 家（族群成形） */
  formed: boolean;
  /** 所屬題材今日已有 ≥3 家 */
  inFormedGroup: boolean;
  /** 「首板」或「5日N板」（近 5 日漲停次數，不是連板數）；資料沒有就 null */
  boards: string | null;
}

export interface LimitFlowPayload { flowDate: string | null; rows: LimitFlowRow[]; total: number }

export const FEED_EVENT_CAP: number;
export const FEED_MERGE_WINDOW_MS: number;
export const CONSENSUS_NEW_MS: number;
export const FORMED_AT: number;

export function fmtPctText(n: unknown, digits?: number): string | null;
export function normYmd(v: unknown): string | null;
export function taipeiMsOf(ymd: unknown, hhmm: unknown): number | null;
export function parseJsonField(v: unknown): Record<string, unknown> | null;

export function buildThemeIndex(seedChains: unknown, customChains: unknown): ThemeIndex;

export function pickFactSentence(text: unknown): string | null;
export function tidySubject(s: unknown): string;
export function buildSectorRows(windDoc: Record<string, unknown> | null, themeIndex: ThemeIndex | null, touchedCodes: Set<string> | null): SectorRow[];
export function sectorChgOf(r: Pick<SectorRow, 'wChg' | 'medChg'> | null | undefined): number | null;
export function flowSummaryOf(rows: readonly SectorRow[]): string | null;
export function sectorSummary(windDoc: Record<string, unknown> | null, rows: readonly SectorRow[]): SectorSummary | null;
export function orderSectorRows(rows: readonly SectorRow[], mineCodes: ReadonlySet<string> | readonly string[] | null, limit?: number | null): (SectorRow & { mine: boolean })[];

export function buildLimitFlow(luDoc: Record<string, unknown> | null, themeIndex: ThemeIndex | null, themeOrderKeys: readonly string[] | null): LimitFlowPayload;

export function surgeEvents(latestDoc: Record<string, unknown> | null, archiveDoc: Record<string, unknown> | null, ymd: string, opts?: { perCycle?: number; archiveTop?: number }): FeedEvent[];
export function limitTouchEvents(flow: LimitFlowPayload | null, ymd: string): FeedEvent[];
export function consensusEvents(radarDoc: Record<string, unknown> | null, ymd: string, opts?: { newMs?: number }): FeedEvent[];
export function queueEvents(queueDoc: Record<string, unknown> | null, ymd: string, opts?: { cap?: number }): FeedEvent[];
/** 新聞判別時間標記：早於今天「（mm/dd）」、今天 09:00 前「（盤前）」、其餘 '' */
export function newsTimeTag(atMs: number, nowMs: number): string;
export function mopsEvents(mopsDoc: Record<string, unknown> | null, ymd: string, activeCodes: ReadonlySet<string> | readonly string[] | null, opts?: { cap?: number; indexCap?: number; subjectMax?: number }): { events: FeedEvent[]; index: Record<string, [number, string]> };
export function mergeServerEvents(lists: readonly (readonly FeedEvent[] | null | undefined)[], cap?: number): FeedEvent[];
export function fillNames(events: readonly FeedEvent[], names: ReadonlyMap<string, string>): FeedEvent[];

export interface MergeableEvent { id: string; at: number; kind: string; code?: string; mine?: boolean }
export function mergeFeedGroups<T extends MergeableEvent>(events: readonly T[], windowMs?: number): { head: T; count: number }[];
export function pinMineFirst<T extends MergeableEvent>(
  groups: readonly { head: T; count: number }[],
  nowMs: number,
  opts?: { pinMs?: number; pinMax?: number; isPinnable?: (g: { head: T; count: number }) => boolean },
): { head: T; count: number }[];
