// 型別橋接：讓 src/lib/warroom/build-b1.ts import 這份伺服器端純函式（唯一實作，勿另寫 TS 版）
import type { RadarStratKey } from './warroom-b1-view.mjs';

export type B1Market = 'tse' | 'otc';
export type B1Limit = 'up' | 'down' | null;

/** 做多列（雷達合併去重後的精簡欄位） */
export interface B1LongRow {
  code: string;
  /** 缺名稱為 ''（只顯示代號，不捏造） */
  name: string;
  market: B1Market | null;
  /** 雷達計算當下的價（榜單價每分鐘更新） */
  price: number;
  /** 漲跌%（對昨收） */
  chg: number | null;
  /** 量比（daemon 以時段線性校正的全日量能倍數） */
  volX: number | null;
  /** 日內位置 0–1（(價−低)/(高−低)） */
  pos: number | null;
  /** 開盤跳空% */
  gap: number | null;
  /** 命中策略（畫面順序）；≥2＝★共識 */
  hits: RadarStratKey[];
  /** 當日首次上榜時刻（epoch ms）；NEW 與上榜分鐘數用 */
  firstSeen: number | null;
  limit: B1Limit;
}

export interface B1Long {
  /** 雷達文件自報的資料日 YYYY-MM-DD */
  dataDate: string | null;
  rows: B1LongRow[];
  /** 合併去重後的總檔數（rows 最多 40） */
  total: number;
}

export type FadeTier = 'A' | 'B';

/** 做空列（轉空觀察；非放空訊號） */
export interface B1ShortRow {
  code: string;
  name: string;
  market: B1Market | null;
  price: number;
  chg: number | null;
  /** 量比＝今日量÷20 日均量÷已過時段比例（線性估計）；缺 20 日均量為 null */
  volX: number | null;
  pos: number | null;
  /** 開盤跳空% */
  gap: number | null;
  tier: FadeTier;
  /** 主型態（fade-patterns FADE_PATTERNS 的 key） */
  pattern: string;
  /** 同時命中的其他型態 key */
  also: string[];
  /** 自今日最高回吐（百分點，以昨收為基準） */
  give: number | null;
  /** 今日最高相對昨收% */
  hiUp: number | null;
  /** 現價是否在 VWAP 之上；VWAP 取樣不足為 null */
  aboveVwap: boolean | null;
  limit: B1Limit;
}

export interface B1Short {
  /** 快照 sweepAt 的台北日期 */
  dataDate: string | null;
  rows: B1ShortRow[];
  /** A／B 級合計（rows 最多 20） */
  total: number;
  /** 12:00 後成立、依 fade-patterns 降級而不列的檔數 */
  demoted: number;
  /** 盤中且 12:00 後（A／B 級不列出） */
  noonDemote: boolean;
  marketOpen: boolean;
}

export interface FadeSnapLike {
  code: string; name: string; price: number; change: number; changePercent: number;
  volume: number; volX: number | null; market: string; open: number; high: number; low: number;
  vwap?: number | null;
}
export interface FadeMetricsLike {
  hiUp: number; give: number; chg: number; openUp: number; openFall: number;
  volX: number; pace: number; aboveVwap: boolean | null; hm: number;
}
export interface FadePatternLike {
  key: string;
  tier: string;
  test: (m: FadeMetricsLike) => boolean;
}

export const LONG_LIMIT: number;
export const SHORT_LIMIT: number;
export const PER_STRAT_MIN: number;
export const DT_MIN_CODES: number;
export const TIER_RANK: Readonly<Record<'A' | 'B' | 'C' | 'X', number>>;
export const FADE_AVOID: readonly { key: string; test: (m: FadeMetricsLike) => boolean }[];

export function limitOf(price: number, prevClose: number): B1Limit;
export function toLongRow(it: unknown): Omit<B1LongRow, 'hits'> | null;
export function mergeRadar(doc: Record<string, unknown> | null, opts?: { limit?: number; perStrat?: number }): B1Long;
export function parseDtCodes(doc: Record<string, unknown> | null): Map<string, 1 | 2> | null;
export function parseAvg20(doc: Record<string, unknown> | null): Record<string, number>;
export function fadeClockAt(nowMs: number, marketOpen: boolean): { hm: number; frac: number };
export function snapToFadeSnaps(snap: unknown, avg20?: Record<string, number>): FadeSnapLike[];
export function fadeMetrics(s: FadeSnapLike, clock: { hm: number; frac: number }): FadeMetricsLike;
export function classifyShortRows(
  snaps: readonly FadeSnapLike[],
  ctx: {
    hm: number; frac: number; marketOpen: boolean;
    dtStatus: (code: string) => 0 | 1 | 2;
    patterns: readonly FadePatternLike[];
    limit?: number;
  },
): { rows: B1ShortRow[]; total: number; demoted: number; noonDemote: boolean };
