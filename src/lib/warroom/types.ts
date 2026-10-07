// 盤中戰情 v2 的 payload 型別總表。
// ⚠ 這裡只 re-export／組合型別：各區塊的資料型別定義在各自的 build-*.ts（誰實作誰擁有，避免多人同改一檔）。
// 前端一律 `import type { ... } from '@/lib/warroom/types'`——只取型別，不會把伺服器程式打進前端 bundle。
import type { Section } from './section';
import type { TopData } from './build-top';
import type { FocusData } from './build-focus';
import type { B1Data } from './build-b1';
import type { FeedsData } from './build-feeds';
import type { NewsMapData } from './build-news';

export type { Section } from './section';
export type { WarReader, DocRead, DocData, ReadTier } from './reader';
export type { TopData } from './build-top';
export type { FocusData } from './build-focus';
export type { B1Data } from './build-b1';
export type { FeedsData } from './build-feeds';
export type { NewsMapData } from './build-news';
/** GET /api/admin/open-sensor（超管影子層；不在公開的 pulse／board 裡） */
export type { OpenSensorPayload } from './build-open-sensor';
export type { WarSegment, WarClock, WarNextNode } from './session';
export type { FocusKind } from './focus-kinds';

/** GET /api/warroom/pulse（中層，前端每 30 秒） */
export interface PulsePayload {
  top: Section<TopData>;
  focus: Section<FocusData>;
  /** 路由組裝時刻（epoch ms）——不是資料時間；資料時間看各區段的 asOf */
  at: number;
}

/** GET /api/warroom/board（慢層，前端每 60 秒） */
export interface BoardPayload {
  b1: Section<B1Data>;
  feeds: Section<FeedsData>;
  news: Section<NewsMapData>;
  /** 路由組裝時刻（epoch ms） */
  at: number;
}
