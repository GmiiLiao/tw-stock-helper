'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2 唯一的輪詢匯流排（全頁只有這一條；區塊元件不得自己開輪詢——快看抽屜 D1 例外）。
//
// 三層，各一個 startLiveLoop（每拍重算間隔、在途不疊打、失敗退避、卸載 abort、回前景立即補抓）：
//   快層  /api/twse/market-index?t=revealTick            加權／櫃買（盤中鎖相揭示邊界＋3 秒，約 5 秒）
//        /api/twse/mis-quote?codes=…&nv=1&t=revealTick  A1 持股＋釘選（最多 40 檔；nv=1 不登記瀏覽中、不佔快線名額）
//   中層  /api/warroom/pulse   30 秒
//   慢層  /api/warroom/board   60 秒
// 閘門 shouldPollWarRoom：交易日 08:30–13:45 且分頁在前景。盤外／非交易日：掛載時抓一次後就不再發請求
//   （計時器以 10 分鐘空轉；交易日 08:30 前會在 08:30 準時醒來）。快層代號變動時另抓一次報價（盤外也抓，次數有界）。
// 出錯保留上一份資料（不清空），記 lastError／lastOkAt 供資料章判斷；URL 不帶 Date.now()（拍號才是快取鍵）。
//
// 狀態放在模組層級（不是 React state）：全站常駐的 AlertEngine 在 WarRoomProvider 之外，
// 也要能讀同一份報價（critique C1：戰情頁的 AlertEngine 改吃匯流排的報價）——用 getWarBusState／useWarBusState。
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useSyncExternalStore } from 'react';
import { startLiveLoop, liveQuoteInterval, msToNextReveal, isForeground, revealTick } from '@/lib/market-clock';
import { warSegment, shouldPollWarRoom, msUntilWarPollWindow } from '@/lib/warroom/session';
import type { MarketIndexData, MisQuote } from '@/lib/twse-api-server';
import type { PulsePayload, BoardPayload } from '@/lib/warroom/types';

// ── 型別 ──────────────────────────────────────────────────────────────────────

/** 快層指數（/api/twse/market-index 的回應；台股欄位來自 daemon marketIndex/latest） */
export type WarIndex = Pick<MarketIndexData, 'weighted' | 'weightedChange' | 'weightedChangePercent'>
  & Partial<Pick<MarketIndexData, 'high' | 'low' | 'prevClose' | 'source' | 'tradeTime' | 'tradeDate' | 'snapshotAt' | 'usMarket' | 'twNight'>>
  & {
    /** 累積成交值（億元，t00 的 m 欄÷1000） */
    value?: number;
    otc?: number;
    otcChange?: number;
    otcChangePercent?: number;
    otcPrevClose?: number;
    otcHigh?: number;
    otcLow?: number;
    otcValue?: number;
    /** daemon 寫 marketIndex/latest 的時刻（epoch ms）——盤外也每 5 分鐘重寫，不是資料時間；資料章用 TopView.indexAsOf（tradeDate＋tradeTime） */
    at?: number;
  };

/** 快層個股報價（/api/twse/mis-quote 的一筆） */
export interface WarQuote {
  code: string;
  name: string;
  price: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
  changePercent: number;
  /** 股（不是張） */
  volume: number;
  tradeTime: string;
  /** MIS 揭示時戳（資料本身的時間）；null＝這拍沒有今日真成交 */
  revealAt: number | null;
  /** daemon 抓取時刻（與 revealAt 可差數十秒，不可混稱） */
  fetchedAt: number | null;
  /** 'mis_realtime'＝今日即時；其他＝收盤／種子價（不可標「即時」） */
  source: MisQuote['source'];
  /** true＝本拍回應沒帶到這檔，沿用上一份 */
  stale?: boolean;
}

export interface LayerMeta {
  /** 上次抓取成功的瀏覽器時刻（epoch ms）；從未成功為 null */
  lastOkAt: number | null;
  /** 最近一次失敗原因（成功後清成 null） */
  lastError: string | null;
  /** 連續失敗次數 */
  failCount: number;
}

export interface WarBusState {
  index: WarIndex | null;
  quotes: Readonly<Record<string, WarQuote>>;
  pulse: PulsePayload | null;
  board: BoardPayload | null;
  layers: Readonly<{ index: LayerMeta; quotes: LayerMeta; pulse: LayerMeta; board: LayerMeta }>;
  /** 匯流排是否運作中（WarRoomProvider 掛載中） */
  active: boolean;
}

type LayerName = keyof WarBusState['layers'];

const META0: LayerMeta = Object.freeze({ lastOkAt: null, lastError: null, failCount: 0 });
const INITIAL: WarBusState = Object.freeze({
  index: null,
  quotes: Object.freeze({}),
  pulse: null,
  board: null,
  layers: Object.freeze({ index: META0, quotes: META0, pulse: META0, board: META0 }),
  active: false,
});

// ── 模組層級狀態（單一實例）────────────────────────────────────────────────

let bus: WarBusState = INITIAL;
const busListeners = new Set<() => void>();

function setBus(next: WarBusState) {
  bus = next;
  for (const l of busListeners) l();
}
const ok = (): LayerMeta => ({ lastOkAt: Date.now(), lastError: null, failCount: 0 });
const fail = (m: LayerMeta, err: unknown): LayerMeta => ({
  lastOkAt: m.lastOkAt,
  lastError: errText(err),
  failCount: m.failCount + 1,
});
function errText(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') return '連線逾時';
  if (err instanceof Error) return err.message.slice(0, 80);
  return '讀取失敗';
}
function withLayer(state: WarBusState, name: LayerName, meta: LayerMeta): WarBusState['layers'] {
  return { ...state.layers, [name]: meta };
}

/** 目前匯流排狀態（WarRoomProvider 之外也可讀，例如 AlertEngine） */
export function getWarBusState(): WarBusState {
  return bus;
}
export function subscribeWarBus(listener: () => void): () => void {
  busListeners.add(listener);
  return () => { busListeners.delete(listener); };
}
export function isWarBusActive(): boolean {
  return bus.active;
}
/** React：讀匯流排狀態（不會啟動輪詢；輪詢只由 WarRoomProvider 的 useWarRoomBus 啟動） */
export function useWarBusState(): WarBusState {
  return useSyncExternalStore(subscribeWarBus, getWarBusState, () => INITIAL);
}

// ── 快層代號登記（模組層級：WarRoomProvider 之外也可登記）────────────────────

export const FAST_CODES_MAX = 40;
const CODE_RE = /^\d{4,6}$/;   // 與 mis-quote route 的白名單同口徑
const owners = new Map<string, readonly string[]>();
/** 名額不足時的優先序（明定，不靠登記先後）：A1 持股＋釘選 → 快看抽屜（使用者正在看的那一檔）→ 一級警示引擎的持股 →
 *  AlertEngine 的自設價／自選（缺的那幾檔它會自己補抓，排最後也不漏評估）；其他 owner 依登記先後接在後面。 */
const OWNER_RANK: Readonly<Record<string, number>> = { mine: 0, drawer: 1, top: 2, alerts: 9 };
const OTHER_RANK = 5;
const rankOf = (owner: string) => OWNER_RANK[owner] ?? OTHER_RANK;
let fastCodes: readonly string[] = Object.freeze([]);
let fastKey = '';
const fastListeners = new Set<() => void>();

function recomputeFast() {
  const seen = new Set<string>();
  // Array.prototype.sort 是穩定排序：同級 owner 維持登記先後
  const ordered = [...owners.entries()].sort(([a], [b]) => rankOf(a) - rankOf(b));
  for (const [, codes] of ordered) for (const c of codes) {
    if (seen.size >= FAST_CODES_MAX) break;
    if (CODE_RE.test(c)) seen.add(c);
  }
  const list = [...seen];
  const key = [...list].sort().join(',');
  if (key === fastKey) return;
  fastKey = key;
  fastCodes = Object.freeze(list);
  for (const l of fastListeners) l();
}

/** 登記要快層追蹤的代號（owner 預設 'mine'＝A1 持股＋釘選，永遠排最前；全體聯集最多 40 檔，依 OWNER_RANK 截掉排後面的） */
export function registerWarFastCodes(owner: string, codes: readonly string[]): void {
  owners.set(owner, Object.freeze([...codes]));
  recomputeFast();
}
export function clearWarFastCodes(owner?: string): void {
  if (owner == null) owners.clear(); else owners.delete(owner);
  recomputeFast();
}
/** 目前快層代號（優先序：mine 先；最多 40） */
export function getWarFastCodes(): readonly string[] {
  return fastCodes;
}
export function subscribeWarFastCodes(listener: () => void): () => void {
  fastListeners.add(listener);
  return () => { fastListeners.delete(listener); };
}
const getFastKey = () => fastKey;

// ── 抓取 ──────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 8_000;
const IDLE_MS = 600_000;
const PULSE_MS = 30_000;
const BOARD_MS = 60_000;

/** 呼叫端的 signal（卸載 abort）＋8 秒逾時 */
function linkTimeout(parent: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any([parent, timeout]);
  const ac = new AbortController();
  const abort = (s: AbortSignal) => () => ac.abort(s.reason);
  if (parent.aborted) ac.abort(parent.reason);
  else if (timeout.aborted) ac.abort(timeout.reason);
  else {
    parent.addEventListener('abort', abort(parent), { once: true });
    timeout.addEventListener('abort', abort(timeout), { once: true });
  }
  return ac.signal;
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const r = await fetch(url, { signal: linkTimeout(signal) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

function parseIndex(j: unknown): WarIndex {
  // market-index 故障時回 200 { weighted:0 }——不可蓋掉上一份好資料
  if (!isObj(j) || !(num(j.weighted) > 0)) throw new Error('指數無資料');
  return j as unknown as WarIndex;
}

function parseQuotes(j: unknown, want: readonly string[], prev: Readonly<Record<string, WarQuote>>): Record<string, WarQuote> {
  if (!isObj(j) || !Array.isArray(j.quotes)) throw new Error('報價格式不符');
  const fresh: Record<string, WarQuote> = {};
  for (const raw of j.quotes as unknown[]) {
    if (!isObj(raw) || typeof raw.code !== 'string' || !(num(raw.price) > 0)) continue;
    fresh[raw.code] = {
      code: raw.code,
      name: typeof raw.name === 'string' ? raw.name : '',
      price: num(raw.price), open: num(raw.open), high: num(raw.high), low: num(raw.low),
      prevClose: num(raw.prevClose), change: num(raw.change), changePercent: num(raw.changePercent),
      volume: num(raw.volume),
      tradeTime: typeof raw.tradeTime === 'string' ? raw.tradeTime : '',
      revealAt: numOrNull(raw.revealAt),
      fetchedAt: numOrNull(raw.fetchedAt),
      source: (typeof raw.source === 'string' ? raw.source : 'stock_day_all') as MisQuote['source'],
    };
  }
  // 只保留目前登記的代號；本拍沒帶到的沿用上一份並標 stale（價齡點會照 revealAt 顯示它舊了）
  const next: Record<string, WarQuote> = {};
  for (const c of want) {
    if (fresh[c]) next[c] = fresh[c];
    else if (prev[c]) next[c] = prev[c].stale ? prev[c] : { ...prev[c], stale: true };
  }
  return next;
}

async function loadIndex(signal: AbortSignal): Promise<void> {
  try {
    const index = parseIndex(await getJson(`/api/twse/market-index?t=${revealTick()}`, signal));
    if (signal.aborted) return;
    setBus({ ...bus, index, layers: withLayer(bus, 'index', ok()) });
  } catch (e) {
    if (signal.aborted) return;
    setBus({ ...bus, layers: withLayer(bus, 'index', fail(bus.layers.index, e)) });
    throw e;
  }
}

// 同一拍同一組代號只抓一次（掛載時快層與「代號變動」可能同時觸發）
let lastQuotesFetch = '';

async function loadQuotes(signal: AbortSignal): Promise<void> {
  const want = getWarFastCodes();
  if (!want.length) {
    if (Object.keys(bus.quotes).length) setBus({ ...bus, quotes: Object.freeze({}) });
    return;
  }
  const tick = revealTick();
  const stamp = `${fastKey}@${tick}`;
  if (stamp === lastQuotesFetch) return;
  lastQuotesFetch = stamp;
  try {
    const codes = encodeURIComponent([...want].sort().join(','));
    const j = await getJson(`/api/twse/mis-quote?codes=${codes}&nv=1&t=${tick}`, signal);
    if (signal.aborted) return;
    const quotes = Object.freeze(parseQuotes(j, getWarFastCodes(), bus.quotes));
    setBus({ ...bus, quotes, layers: withLayer(bus, 'quotes', ok()) });
  } catch (e) {
    lastQuotesFetch = '';
    if (signal.aborted) return;
    setBus({ ...bus, layers: withLayer(bus, 'quotes', fail(bus.layers.quotes, e)) });
    throw e;
  }
}

/** 區段層級的「出錯保留上一份」：新回應某區段 ok:false、上一份同區段 ok:true ⇒ 沿用上一份
 *  （它的 asOf 不會前進，資料章自然轉「延遲／過期」，不清空畫面） */
function keepGoodSections(next: Record<string, unknown>, prev: object | null): Record<string, unknown> {
  if (!prev) return next;
  const old = prev as Record<string, unknown>;
  const out: Record<string, unknown> = { ...next };
  for (const [k, v] of Object.entries(next)) {
    const p = old[k];
    if (isObj(v) && v.ok === false && isObj(p) && p.ok === true) out[k] = p;
  }
  return out;
}

async function loadPayload(name: 'pulse' | 'board', signal: AbortSignal): Promise<void> {
  try {
    const j = await getJson(`/api/warroom/${name}`, signal);
    if (!isObj(j) || typeof j.at !== 'number') throw new Error('回應格式不符');
    if (signal.aborted) return;
    const merged = keepGoodSections(j, bus[name]);
    setBus({ ...bus, [name]: merged, layers: withLayer(bus, name, ok()) } as WarBusState);
  } catch (e) {
    if (signal.aborted) return;
    setBus({ ...bus, layers: withLayer(bus, name, fail(bus.layers[name], e)) });
    throw e;
  }
}

async function loadFast(signal: AbortSignal): Promise<void> {
  const [a, b] = await Promise.allSettled([loadIndex(signal), loadQuotes(signal)]);
  if (a.status === 'rejected') throw a.reason;
  if (b.status === 'rejected') throw b.reason;
}

// ── 間隔（每拍重算）──────────────────────────────────────────────────────────

/** 盤外空轉：交易日 08:30 前準時在 08:30 醒來，其餘 10 分鐘 */
function idleDelay(): number {
  const ms = msUntilWarPollWindow();
  return ms == null ? IDLE_MS : Math.min(IDLE_MS, Math.max(1_000, ms + 500));
}

function fastInterval(): number {
  if (!isForeground()) return IDLE_MS;
  const seg = warSegment();
  // 13:30–13:45 收盤定價窗：market-clock 的 getSession 算休市，liveQuoteInterval 會給 10 分鐘——這裡延續鎖相，收盤價揭示才看得到
  if (seg === 'closing') return msToNextReveal(3000);
  if (seg === 'after' || seg === 'nontrading') return idleDelay();
  return liveQuoteInterval();   // 盤中鎖相揭示邊界＋3 秒；盤前 15 秒
}

const slowInterval = (ms: number) => (): number => {
  if (!isForeground()) return IDLE_MS;
  return shouldPollWarRoom() ? ms : idleDelay();
};

// ── Hook（只有 WarRoomProvider 呼叫）────────────────────────────────────────

const swallow = () => { /* 失敗已記在 layers；保留上一份資料 */ };

/** 啟動三層輪詢並回傳狀態。全頁只能有一個呼叫點（WarRoomProvider）。 */
export function useWarRoomBus(): WarBusState {
  const state = useSyncExternalStore(subscribeWarBus, getWarBusState, () => INITIAL);
  const codesKey = useSyncExternalStore(subscribeWarFastCodes, getFastKey, () => '');

  // 掛載旗標（AlertEngine 據此判斷要不要改吃匯流排報價）
  useEffect(() => {
    setBus({ ...bus, active: true });
    return () => { setBus({ ...bus, active: false }); };
  }, []);

  // 三層：掛載時各抓一次（不看閘門——盤外也要有畫面），之後交給 startLiveLoop＋閘門
  useEffect(() => {
    const ac = new AbortController();
    void loadFast(ac.signal).catch(swallow);
    void loadPayload('pulse', ac.signal).catch(swallow);
    void loadPayload('board', ac.signal).catch(swallow);
    const stops = [
      startLiveLoop(signal => (shouldPollWarRoom() ? loadFast(signal) : undefined), fastInterval),
      startLiveLoop(signal => (shouldPollWarRoom() ? loadPayload('pulse', signal) : undefined), slowInterval(PULSE_MS)),
      startLiveLoop(signal => (shouldPollWarRoom() ? loadPayload('board', signal) : undefined), slowInterval(BOARD_MS)),
    ];
    return () => { ac.abort(); for (const stop of stops) stop(); };
  }, []);

  // 快層代號變動（A1 持股載入、釘選增減）：立刻抓一次報價——盤外也抓（只在變動時，次數有界）
  useEffect(() => {
    if (!codesKey) return;
    const ac = new AbortController();
    void loadQuotes(ac.signal).catch(swallow);
    return () => ac.abort();
  }, [codesKey]);

  return state;
}
