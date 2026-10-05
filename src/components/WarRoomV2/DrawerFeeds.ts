'use client';

// ─────────────────────────────────────────────────────────────────────────────
// D1 快看抽屜的資料（只在抽屜開著時抓；關閉＝卸載＝停止）。全頁唯一允許自己輪詢的區塊（契約：快看抽屜例外）。
//   1 分走勢  /api/twse/stock-intraday?code=   既有路由；開啟時抓一次，之後交易日 08:30–13:45 前景每 30 秒
//   內外盤    /api/twse/order-flow?code=       既有路由（只讀 marketSnapshot/flow）；開啟一次＋同閘門每 60 秒
//   法人      /api/ai/inst-daily?code=         既有路由（只讀 chipDaily）；開啟一次
//   瀏覽中登記 /api/twse/mis-quote?codes=       不帶 nv=1 ⇒ 伺服器記為「瀏覽中」，daemon 把它納入即時快線（保留 15 分鐘）。
//             前端配額（critique M1）：15 分鐘內最多 3 個不同代號，第 4 個起不登記、畫面標「登記前為延遲資料」；
//             配額記在 localStorage（@/lib/safe-storage，wr-drawer-reg）；只在輪詢窗內登記，開著每 60 秒續登一次。
// 一律：fetch＝卸載 abort＋8 秒逾時；不新增任何外部網域；不手打上游（這些都是既有的同源路由）。
// 呼叫端以代號當 key 掛載（換代號＝整個重掛），所以這些 hook 不另外處理「代號變了要清狀態」。
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import { startLiveLoop, isForeground } from '@/lib/market-clock';
import { storageGet, storageSet } from '@/lib/safe-storage';
import { shouldPollWarRoom } from '@/lib/warroom/session';
import { decideRegistration, REG_MAX } from '../../../scripts/lib/warroom-drawer.mjs';

const FETCH_TIMEOUT_MS = 8_000;
const INTRADAY_MS = 30_000;
const FLOW_MS = 60_000;
const REG_PING_MS = 60_000;
const IDLE_MS = 600_000;
const REG_KEY = 'wr-drawer-reg';
const SESSION_START_MIN = 9 * 60;
const SESSION_END_MIN = 13 * 60 + 30;
const TAIPEI_OFFSET_SEC = 8 * 3600;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 呼叫端 signal（卸載 abort）＋8 秒逾時 */
function linked(parent: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any([parent, timeout]);
  const ac = new AbortController();
  const relay = (s: AbortSignal) => () => ac.abort(s.reason);
  if (parent.aborted) ac.abort(parent.reason);
  else {
    parent.addEventListener('abort', relay(parent), { once: true });
    timeout.addEventListener('abort', relay(timeout), { once: true });
  }
  return ac.signal;
}

async function getJson(url: string, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, { signal: linked(signal) });
  const body = r.ok ? await r.json() : null;
  return { status: r.status, body };
}

/** 抽屜開著時的間隔：輪詢窗內 base，其餘空轉（startLiveLoop 會在回前景時補一次） */
const gatedInterval = (base: number) => (): number => (isForeground() && shouldPollWarRoom() ? base : IDLE_MS);

type LoadFn = (signal: AbortSignal) => Promise<void>;

/** 開啟時抓一次（不看閘門——盤外也要有畫面），之後在輪詢窗內依 base 間隔重抓 */
function useGatedLoad(key: string, base: number | null, load: LoadFn) {
  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal).catch(() => { /* 失敗已記在狀態 */ });
    const stop = base == null ? null : startLiveLoop((signal) => (shouldPollWarRoom() ? load(signal) : undefined), gatedInterval(base));
    return () => { ac.abort(); stop?.(); };
    // load 依 key（代號）而定；每次 render 新建的閉包不應重啟輪詢
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, base]);
}

// ── 1 分走勢 ──────────────────────────────────────────────────────────────────

export interface IntradayPoint { t: number; price: number }
export interface IntradayState {
  status: 'loading' | 'ok' | 'empty' | 'error';
  points: IntradayPoint[];
  prevClose: number | null;
  /** mis-fast＝daemon 即時序列；yahoo+mis＝Yahoo（延遲約 20 分）＋daemon 尾段；mis＝只有 daemon */
  source: string | null;
}
// ⚠ 不在這裡算 VWAP：daemon 序列的量是「累積量」，但它的早盤回補段（backfillIntradayMorning）是 Yahoo 的「每分鐘量」，
//   兩種口徑接在同一條序列裡、前端分不出接縫 ⇒ 算出來的會是錯數字。正確來源是 daemon 快照裡已算好的 vwap 欄位，
//   目前沒有單檔讀取路由（見回報 notDone），所以抽屜不畫 VWAP 線。

const minuteOfDay = (tSec: number) => Math.floor(((tSec + TAIPEI_OFFSET_SEC) % 86_400) / 60);

function parseIntraday(body: unknown): Omit<IntradayState, 'status'> | null {
  if (!isObj(body) || !Array.isArray(body.ticks)) return null;
  const points: IntradayPoint[] = [];
  for (const t of body.ticks as unknown[]) {
    if (!isObj(t)) continue;
    const time = num(t.time), close = num(t.close);
    if (time == null || close == null || !(close > 0)) continue;
    const m = minuteOfDay(time);
    if (m < SESSION_START_MIN || m > SESSION_END_MIN) continue;   // 只留 09:00–13:30（盤後零股、試撮點會把 X 軸拖長）
    points.push({ t: time, price: close });
  }
  const source = typeof body.source === 'string' ? body.source : null;
  const pc = num(body.prevClose);
  return { points, prevClose: pc != null && pc > 0 ? pc : null, source };
}

const INTRADAY0: IntradayState = { status: 'loading', points: [], prevClose: null, source: null };

export function useDrawerIntraday(code: string): IntradayState {
  const [st, setSt] = useState<IntradayState>(INTRADAY0);
  useGatedLoad(code, INTRADAY_MS, async (signal) => {
    try {
      const { status, body } = await getJson(`/api/twse/stock-intraday?code=${encodeURIComponent(code)}`, signal);
      if (signal.aborted) return;
      if (status === 404) { setSt((p) => (p.points.length ? p : { ...INTRADAY0, status: 'empty' })); return; }
      const parsed = parseIntraday(body);
      if (!parsed) throw new Error(`HTTP ${status}`);
      setSt({ status: parsed.points.length ? 'ok' : 'empty', ...parsed });
    } catch (e) {
      if (signal.aborted) return;
      setSt((p) => (p.points.length ? p : { ...INTRADAY0, status: 'error' }));   // 有舊圖就保留
      throw e;
    }
  });
  return st;
}

// ── 內外盤（取樣）──────────────────────────────────────────────────────────────

export interface FlowState {
  status: 'loading' | 'ok' | 'none' | 'error' | 'na';
  outerPct: number | null;
  innerPct: number | null;
  /** 樣本起點（epoch ms：該檔第一次進入 daemon 取樣的時刻）；null＝來源未提供 */
  since: number | null;
  at: number | null;
  /** 取樣所屬交易日 YYYY-MM-DD（來源自報） */
  date: string | null;
}
const FLOW0: FlowState = { status: 'loading', outerPct: null, innerPct: null, since: null, at: null, date: null };
const FLOW_CODE_RE = /^\d{4}$/;   // order-flow 路由只收 4 碼

export function useDrawerFlow(code: string): FlowState {
  const supported = FLOW_CODE_RE.test(code);
  const [st, setSt] = useState<FlowState>(supported ? FLOW0 : { ...FLOW0, status: 'na' });
  useGatedLoad(`${code}:${supported}`, supported ? FLOW_MS : null, async (signal) => {
    if (!supported) return;
    try {
      const { status, body } = await getJson(`/api/twse/order-flow?code=${code}`, signal);
      if (signal.aborted) return;
      if (!isObj(body)) throw new Error(`HTTP ${status}`);
      if (body.found !== true) { setSt({ ...FLOW0, status: 'none' }); return; }
      setSt({
        status: 'ok', outerPct: num(body.outerPct), innerPct: num(body.innerPct),
        since: num(body.since), at: num(body.at), date: typeof body.date === 'string' ? body.date : null,
      });
    } catch (e) {
      if (signal.aborted) return;
      setSt((p) => (p.status === 'ok' ? p : { ...FLOW0, status: 'error' }));
      throw e;
    }
  });
  return st;
}

// ── 前交易日法人（chipDaily）──────────────────────────────────────────────────

export interface InstState {
  status: 'loading' | 'ok' | 'none' | 'error';
  /** 張；買超為正 */
  foreign: number | null;
  trust: number | null;
  dealer: number | null;
  /** 資料日 YYYY-MM-DD（來源自報） */
  dataDate: string | null;
}
const INST0: InstState = { status: 'loading', foreign: null, trust: null, dealer: null, dataDate: null };

export function useDrawerInst(code: string): InstState {
  const [st, setSt] = useState<InstState>(INST0);
  useGatedLoad(code, null, async (signal) => {
    try {
      const { status, body } = await getJson(`/api/ai/inst-daily?code=${encodeURIComponent(code)}`, signal);
      if (signal.aborted) return;
      if (!isObj(body)) throw new Error(`HTTP ${status}`);
      const dataDate = typeof body.dataDate === 'string' ? body.dataDate : null;
      if (body.found !== true) { setSt({ ...INST0, status: 'none', dataDate }); return; }
      setSt({ status: 'ok', foreign: num(body.foreign), trust: num(body.trust), dealer: num(body.dealer), dataDate });
    } catch (e) {
      if (signal.aborted) return;
      setSt({ ...INST0, status: 'error' });
      throw e;
    }
  });
  return st;
}

// ── 瀏覽中登記（15 分鐘內最多 3 檔）──────────────────────────────────────────

export interface RegState {
  /** off＝輪詢窗外（不登記，也不佔名額）；registered＝本檔已登記；denied＝名額已滿，未登記 */
  kind: 'off' | 'registered' | 'denied';
  /** 目前佔用名額的代號（新→舊） */
  held: string[];
  max: number;
}

function readRegs(): unknown {
  const raw = storageGet(REG_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export function useDrawerRegistration(code: string): RegState {
  const [st, setSt] = useState<RegState>({ kind: 'off', held: [], max: REG_MAX });
  useEffect(() => {
    const ping = (signal: AbortSignal): Promise<void> | undefined => {
      if (!shouldPollWarRoom()) { setSt((p) => (p.kind === 'off' ? p : { kind: 'off', held: [], max: REG_MAX })); return undefined; }
      const d = decideRegistration(readRegs(), code, Date.now());
      storageSet(REG_KEY, JSON.stringify(d.next));
      setSt({ kind: d.allowed ? 'registered' : 'denied', held: d.held, max: REG_MAX });
      if (!d.allowed) return undefined;
      // 不帶 nv=1 ⇒ 伺服器記「瀏覽中」；與個股頁走勢圖同一個網址（CDN 共用）。回應內容不用（報價由匯流排提供）。
      return fetch(`/api/twse/mis-quote?codes=${code}`, { signal: linked(signal) }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      });
    };
    const ac = new AbortController();
    void ping(ac.signal)?.catch(() => { /* 登記失敗下一拍再試 */ });
    const stop = startLiveLoop(ping, gatedInterval(REG_PING_MS));
    return () => { ac.abort(); stop(); };
  }, [code]);
  return st;
}
