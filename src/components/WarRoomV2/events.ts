// 盤中戰情 v2 前端事件匯流排（模組層級 pub/sub＋最近 N 筆 ring buffer）。
//
// 寫入端：AlertEngine（全站常駐，在 WarRoomProvider 之外——所以這裡是模組層級，不是 React context）、
//         各區塊偵測到的事件（盤勢轉換、雷達新進共識…）。
// 讀取端：Z2 警示帶（level 1）、B2 即時異動流（level 1–2 全部紀錄）、手機 S1 計數點。
// 規則（使用者裁定第 8 題）：一級只有 5 類——觸停損、跌停排隊（2 期）、開板（2 期）、AI 讀內文判定的重大利空、大盤翻轉危險。
//   持股鎖漲停、自選觸價＝二級。同一事件只在 Z2 出現一次；B2 留紀錄。文案只寫代號與事件，不寫個人停損價（隱私）。
// 去重：同 id 不重複收（id 預設 `${kind}:${code}:${at}`；要跨重新整理去重的，呼叫端自己給穩定 id 並用 localStorage 記當日已發）。
import { useSyncExternalStore } from 'react';

export type WarEventLevel = 1 | 2 | 3;
/** O＝官方公告（MOPS／證交所），M＝媒體新聞（AI 讀過內文才判別） */
export type WarEventSource = 'O' | 'M';

export type WarEventKind =
  | 'stopLoss'        // 一級：持股觸及停損（依 AI 停損規範 stop-v1 由前端判定，見 TopAlertEngine／warroom-mine；daemon 舊制停損推播降二級 'mine'）
  | 'limitDownQueue'  // 一級：持股跌停排隊（2 期）
  | 'limitOpen'       // 一級：持股漲停開板（2 期）
  | 'majorNegative'   // 一級：持股出現 AI 讀過內文判定的重大利空（目前只有規則法律；權重門檻類待使用者裁定前發二級 'newsVerdict'，見 warroom-news.mjs）
  | 'marketDanger'    // 一級：大盤翻轉危險（09:10 後、跌停 ≥10 且 ≥ 漲停×1.5、連續 2 拍）
  | 'holdingLimitUp'  // 二級：持股鎖漲停
  | 'watchPrice'      // 二級：自選觸及自設價
  | 'mine'            // 我的其他警示紀錄（AlertEngine 轉進來的個人警示）
  | 'limitTouch'      // 首觸漲停
  | 'limitDownTouch'  // 首觸跌停
  | 'surgeUp'         // 爆量急拉
  | 'surgeDown'       // 爆量急殺
  | 'consensus'       // 雷達新進共識 ★
  | 'mops'            // 重訊（官方 O）
  | 'newsVerdict'     // 新聞判別（媒體 M）
  | 'disposition'     // 新增處置／注意（官方 O）
  | 'pulseShift'      // 盤勢燈轉換
  | 'queue'           // 漲停排隊（盤前～09:15）
  | 'gap'             // 開盤跳空
  | 'tailPick'        // 撿尾盤進入候選
  | 'info';

/** B2 類型欄顯示文字 */
export const WAR_EVENT_LABEL: Readonly<Record<WarEventKind, string>> = {
  stopLoss: '觸停損', limitDownQueue: '跌停排隊', limitOpen: '開板', majorNegative: '重大利空', marketDanger: '大盤危險',
  holdingLimitUp: '持股鎖漲停', watchPrice: '觸價', mine: '我的', limitTouch: '首觸漲停', limitDownTouch: '首觸跌停',
  surgeUp: '爆量急拉', surgeDown: '爆量急殺', consensus: '雷達共識', mops: '重訊', newsVerdict: '新聞判別',
  disposition: '新增處置', pulseShift: '盤勢轉換', queue: '排隊', gap: '跳空', tailPick: '撿尾盤', info: '訊息',
};

export interface WarEvent {
  id: string;
  /** 事件本身的時間（epoch ms）：揭示時間／公告時間／判別時間，不是收到的時間 */
  at: number;
  kind: WarEventKind;
  level: WarEventLevel;
  code?: string;
  /** 一行事實描述（不寫指令句、不寫個人停損價） */
  text: string;
  source?: WarEventSource;
  /** 與使用者持股／釘選相關（B2「我的」篩選、列底色） */
  mine?: boolean;
  /** B2「做多／做空」篩選 */
  side?: 'long' | 'short';
}

export type WarEventInput = Omit<WarEvent, 'id'> & { id?: string };

const MAX_EVENTS = 200;
const EMPTY: readonly WarEvent[] = Object.freeze([]);
const EMPTY_ACKS: ReadonlySet<string> = new Set<string>();

let events: readonly WarEvent[] = EMPTY;   // 新到舊；有變動才換參照（useSyncExternalStore 需要穩定快照）
let acks: ReadonlySet<string> = EMPTY_ACKS;
const ids = new Set<string>();
const changeListeners = new Set<() => void>();
const eventListeners = new Set<(e: WarEvent) => void>();

const notifyChange = () => { for (const l of changeListeners) l(); };

function normalize(input: WarEventInput): WarEvent | null {
  if (!input || typeof input.text !== 'string' || !input.text.trim()) return null;
  if (!Number.isFinite(input.at) || input.at <= 0) return null;
  if (input.level !== 1 && input.level !== 2 && input.level !== 3) return null;
  const code = typeof input.code === 'string' && /^\d{4,6}[A-Z]?$/.test(input.code) ? input.code : undefined;
  const id = input.id && input.id.length <= 200 ? input.id : `${input.kind}:${code ?? ''}:${input.at}`;
  return { ...input, id, code };
}

/** 收一批事件（同 id 略過）。回傳實際新增的事件（新到舊）。 */
export function publishWarEvents(inputs: readonly WarEventInput[]): WarEvent[] {
  const added: WarEvent[] = [];
  for (const input of inputs) {
    const e = normalize(input);
    if (!e || ids.has(e.id)) continue;
    ids.add(e.id);
    added.push(e);
  }
  if (!added.length) return added;
  const merged = [...added, ...events].sort((a, b) => b.at - a.at);
  const kept = merged.slice(0, MAX_EVENTS);
  for (const dropped of merged.slice(MAX_EVENTS)) ids.delete(dropped.id);
  events = Object.freeze(kept);
  added.sort((a, b) => b.at - a.at);
  for (const e of added) for (const l of eventListeners) l(e);
  notifyChange();
  return added;
}

/** 收一筆事件；重複 id 回 null */
export function publishWarEvent(input: WarEventInput): WarEvent | null {
  return publishWarEvents([input])[0] ?? null;
}

/** 目前的事件（新到舊，最多 200 筆）；沒有變動時回同一個參照 */
export function getWarEvents(): readonly WarEvent[] {
  return events;
}

/** 訂閱「清單有變動」（給 useSyncExternalStore）；回傳取消函式 */
export function subscribeWarEvents(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

/** 訂閱「每一筆新事件」（閃框、計數 +n 用）；回傳取消函式 */
export function onWarEvent(listener: (e: WarEvent) => void): () => void {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}

/** Z2「收到」：標記已收到（同一工作階段內）；要跨重新整理記住由呼叫端自行存 localStorage */
export function ackWarEvent(id: string): void {
  if (acks.has(id)) return;
  const next = new Set(acks);
  next.add(id);
  acks = next;
  notifyChange();
}

export function isWarEventAcked(id: string): boolean {
  return acks.has(id);
}

export function getWarEventAcks(): ReadonlySet<string> {
  return acks;
}

/** 換日或測試用：清空全部事件與已收到標記 */
export function clearWarEvents(): void {
  events = EMPTY;
  acks = EMPTY_ACKS;
  ids.clear();
  notifyChange();
}

/** React：事件清單（新到舊）。篩選請在呼叫端 useMemo 做，避免每次產生新陣列。 */
export function useWarEvents(): readonly WarEvent[] {
  return useSyncExternalStore(subscribeWarEvents, getWarEvents, () => EMPTY);
}

/** React：已收到的事件 id 集合 */
export function useWarEventAcks(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeWarEvents, getWarEventAcks, () => EMPTY_ACKS);
}
