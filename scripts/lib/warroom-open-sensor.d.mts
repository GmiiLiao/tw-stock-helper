// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
// 形狀＝開盤感應器 v2.1 規格 §8.1 的 openSensor/{date}；缺欄位一律 null（不補預設值）。

export type OsStatus = 'ok' | 'undetermined' | 'nodata';
export type OsVolLabel = 'big' | 'small' | 'pending';
export type OsDom = 'all' | 'w' | 'gen';
export type OsDir = 'up' | 'down';
export type OsLamp = 'red' | 'green' | 'neutral' | 'gray';
export type OsCheckKey = 'c0902' | 'r0910' | 'r0920' | 'r0930' | 'r0940' | 'r0950' | 'r1000';
export type OsRecheckKey = Exclude<OsCheckKey, 'c0902'>;

export interface OsState {
  key: string | null;
  label: string | null;
  /** 1..7（七種命名狀態）；其餘 null */
  num: number | null;
  named: boolean | null;
  cell: { vol: OsVolLabel | null; dom: OsDom | null; dir: OsDir | null } | null;
  outsideReason: 'cell' | 'wUnconfirmed' | 'wUnstated' | null;
  sub: string | null;
  lamp: OsLamp | null;
  candidates: string[];
}

export interface OsW {
  pct: number | null; tsmcPct: number | null; restPct: number | null;
  restUp: number | null; restDown: number | null; restFlat: number | null; restFresh: number | null;
  dir: 'up' | 'down' | 'flat' | 'unconfirmed' | null; fresh: number | null; capCovPct: number | null;
}

export interface OsG {
  median: number | null; upRatio: number | null; up: number | null; down: number | null; flat: number | null;
  fresh: number | null; n: number | null; dir: 'up' | 'down' | 'flat' | null;
  /** 流動宇宙揭示時間中位數（G3 用；epoch ms） */
  revealMed: number | null;
}

export interface OsVol {
  /** 上市累積成交量（張，t00 m）與其揭示時間 */
  q: { lots: number | null; revealAt: number | null } | null;
  /** 開盤競價量（張） */
  qAucLots: number | null;
  /** 價格樣本：P̄（元/股）、窗 30／60／120 秒、檔數、樣本量（張）、含台積電、W30 檔數 */
  px: { bar: number | null; win: 30 | 60 | 120 | null; n: number | null; volLots: number | null; hasTsmc: boolean | null; w30n: number | null } | null;
  rho: { v: number | null; src: 'prior' | 'live' | null; n: number | null } | null;
  /** 上市累積成交金額（估，億元） */
  vHatYi: number | null;
  /** c(T) 時間累計比例與基準日數 */
  c: number | null; cN: number | null;
  /** 全日點估計（E1，億元）；E2 只當事實 */
  estYi: number | null; estE2Yi: number | null;
  H: number | null;
  /** 同時段門檻 H×c(T)（億元） */
  segThYi: number | null;
  label: OsVolLabel | null; est: boolean | null; reason: string | null; gapDay: boolean | null;
  /** 加總法伴隨值（億元，不參與判定） */
  vSum: { yi: number | null; n: number | null } | null;
}

export interface OsIdxSide { e: number | null; pct: number | null; revealAt: number | null }

export interface OsCheck {
  status: OsStatus;
  reasons: string[];
  late: boolean;
  slid: boolean;
  restoredLive: number | boolean | null;
  /** 檢查點揭示時間 'HH:MM:SS'（資料時間） */
  T: string | null;
  revealAt: number | null; revealP10: number | null; revealP90: number | null; writtenAt: number | null;
  state: OsState | null;
  w: OsW | null;
  g: OsG | null;
  s: number | null;
  dom: { rule: string | null; ratio: number | null } | null;
  open: { wOpenPct: number | null; gOpenMedian: number | null; dW: number | null; dG: number | null } | null;
  vol: OsVol | null;
  value: { wYi: number | null; gYi: number | null; wSharePct: number | null; wShareBasePct: number | null } | null;
  idx: {
    tse: OsIdxSide | null; otc: OsIdxSide | null;
    officialOpen: number | null; officialOpenPct: number | null; oStarPct: number | null; distortPp: number | null; distorted: boolean | null;
  } | null;
}

export interface OsPatternLine {
  status: string | null; key: string | null; label: string | null;
  /** 指數線：跳空 Gp、自開盤 D 為 %，p 為點位、pPct 為現值漲跌 %；一般股線：Gp、D 為百分點 */
  gp: number | null; d: number | null; f: number | null; p: number | null; pPct: number | null;
  eUsed: number | null; eCorrected: boolean | null; revealAt: number | null;
}

export interface OsPattern {
  T: string | null;
  writtenAt: number | null;
  lines: { tse: OsPatternLine | null; otc: OsPatternLine | null; gen: OsPatternLine | null };
  qualifier: string | null;
  basis: string | null;
}

export interface OsE {
  tse: { v: number | null; pct: number | null; revealAt: number | null } | null;
  otc: { v: number | null; pct: number | null; revealAt: number | null } | null;
  gen: number | null;
  officialOpen: number | null; officialOpenPct: number | null; oStarPct: number | null;
  distortPp: number | null; distorted: boolean | null; basis: string | null;
}

export interface OsECorr {
  unopened: { n: number | null; capPct: number | null; w30: string[] } | null;
  unknown: { n: number | null; capPct: number | null } | null;
  eFinal: boolean | null;
  tse: { T: string | null; pct: number | null; addPp: number | null; nOpened: number | null }[];
  gen: { T: string | null; pp: number | null }[];
  otc: { status: 'ok' | 'uncorrected' | null } | null;
}

export interface OsCur {
  key: string | null; label: string | null; T: string | null; revealAt: number | null;
  final: boolean; frozenAt: number | null; finalBy: string | null; eTsePct: number | null; eGenPct: number | null;
}

export interface OsTrailItem { T: string | null; kind: 'state' | 'eCorr'; key: string | null; label: string | null; revealAt: number | null }

export type OsMarkMap = Record<string, number>;

export interface OsPost {
  basis: string | null; writtenAt: number | null; A: number | null; H: number | null; label: 'big' | 'small' | null;
  qMatch: OsMarkMap | null; rhoRatio: OsMarkMap | null; rhoSum: OsMarkMap | null; errRatio: OsMarkMap | null; errSum: OsMarkMap | null;
}

export interface OsParams {
  H: number | null; hSeg: [number | null, number | null] | null; hBasis: string | null; struct: string | null; vol: string | null;
  cBase: { n: number | null; from: string | null; to: string | null; missing: string[] } | null;
  rho0: number | null;
}

export interface OsDocUniverse {
  sharesAsOf: string | null; sharesSrc: 'cache' | 'mirror' | null; prevYmd: string | null;
  w30CapPct: number | null; tsmcCapPct: number | null; tsmcInW30Pct: number | null; liquidN: number | null; liquidMinLots: number | null;
}

export interface OsDoc {
  date: string;
  basis: string | null;
  mode: string | null;
  dateSrc: 't00' | 'clock' | null;
  writtenAt: number | null;
  params: OsParams | null;
  universe: OsDocUniverse | null;
  c0902: OsCheck | null;
  rechecks: Record<OsRecheckKey, OsCheck | null>;
  checks: { e: OsE | null; c0920: OsPattern | null; c0930: OsPattern | null };
  eCorr: OsECorr | null;
  cur: OsCur | null;
  trail: OsTrailItem[];
  outside: { cells: string[]; firstAt: number | null } | null;
  indexRing: { n: number | null; gaps: number | null } | null;
  post: OsPost | null;
}

export type OsSeg = number | [number | null, number | null] | string | null;

export interface OsThreshold {
  basis: string | null; H: number | null; effectiveFrom: string | null; seg: OsSeg;
  m60: number | null; n: number | null; from: string | null; to: string | null;
  streak: { seg: OsSeg; n: number | null; dates: string[] } | null;
  gaps: string[]; stale: boolean | null; asOf: string | null; writtenAt: number | null;
}

export interface OsOutsideStats {
  basis: string | null;
  cells: { key: string; n: number | null; dates: string[] }[];
  countedDates: string[];
  pending: { n: number | null; dates: string[] } | null;
  undetermined: { n: number | null; dates: string[] } | null;
  updatedAt: number | null;
}

export interface OsUniverseSummary {
  date: string | null; basis: string | null; createdAt: number | null;
  sharesAsOf: string | null; sharesSrc: 'cache' | 'mirror' | null; prevYmd: string | null;
  w30: { code: string; capYi: number | null; wPct: number | null }[];
  tsmcCapPct: number | null; w30CapPct: number | null; liquidN: number | null; liquidMinLots: number | null;
  excluded: { etf: number | null; tdr: number | null; fullDelivery: number | null; split: number | null };
}

/** GET /api/admin/open-sensor 的回應（超管專用·private no-store） */
export interface OpenSensorPayload {
  /** 路由組裝時刻（epoch ms）——不是資料時間 */
  at: number;
  /** 看板日期（交易日＝今天；非交易日＝最後交易日；或 ?date= 指定） */
  date: string;
  /** 伺服器端台北今天 */
  today: string;
  /** 今天是否交易日（伺服器端休市日曆） */
  tradingToday: boolean;
  /** openSensor/{date}；null＝文件不存在 */
  doc: OsDoc | null;
  universe: OsUniverseSummary | null;
  threshold: OsThreshold | null;
  outsideStats: OsOutsideStats | null;
  /** 這次讀取故障的來源（文件不存在不算故障） */
  failed: string[];
}

export const OS_BASIS: string;
export const OS_BADGE: string;
export const OS_CHECK_KEYS: readonly OsCheckKey[];
export const OS_RECHECK_KEYS: readonly OsRecheckKey[];
export const OS_PATTERN_KEYS: readonly ('c0920' | 'c0930')[];
export const OS_TIMES: Readonly<{ first: number; deadline: number; freeze: number; timeoutFreeze: number }>;
export const OS_POLL: Readonly<{ fromMinute: number; untilMinute: number; everyMs: number }>;

export function shouldPollOpenSensorAt(ms: number, tradingDay: boolean, hidden?: boolean): boolean;
export function msUntilOpenSensorWindow(ms: number, tradingDay: boolean): number | null;
export function resolveBoardYmd(todayYmd: string, isTradingYmd: (ymd: string) => boolean): string | null;

export function normalizeCheck(c: unknown): OsCheck | null;
export function normalizePattern3(p: unknown): OsPattern | null;
export function normalizeOpenSensor(doc: unknown): OsDoc | null;
export function currentCheck(doc: OsDoc | null | undefined): { key: OsCheckKey; check: OsCheck } | null;
export function checkOf(doc: OsDoc | null | undefined, key: OsCheckKey): OsCheck | null;
export function normalizeOsThreshold(doc: unknown): OsThreshold | null;
export function normalizeOsOutsideStats(doc: unknown): OsOutsideStats | null;
export function summarizeOsUniverse(doc: unknown): OsUniverseSummary | null;
export function normalizeOpenSensorPayload(j: unknown): OpenSensorPayload | null;
