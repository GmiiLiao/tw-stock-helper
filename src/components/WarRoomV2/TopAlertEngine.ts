'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 一級警示引擎（Z2 警示帶與手機 S1 計數點的資料面）。只在一處掛：桌機 ZoneAlerts、手機 MobileBars（兩棵樹擇一）。
//
// 本期能做的一級（使用者裁定第 8 題；跌停排隊、開板＝2 期）：
//   觸停損   依 AI 停損規範 stop-v1.1 由前端判定（第二輪 A7「ok」已裁定：網頁判定、標「單一裝置·暫算」，維持到停損簿切換正式；
//            warroom-mine.stepStopEpisodes）：停損＝v1.1 前端暫算（成本線與持股分析 ATR 帶取高、ATR 帶不棘輪；與 A1 同一支
//            warStopView、同一份 useWarStopCtx）。只限自己的持股、只認今日成交更新的最低價、試撮與收盤競價窗不判定；每個觸及事件只發
//            一次（本機 localStorage wr-stop-ep:<uid> 記事件，前一交易日收盤 > 停損×1.02 才結束）。本機表同時是成本線棘輪的上一版
//            （停損、成本線、版本、逐筆快照）：攤平、FIFO 賣出不下移，成本更正才歸零；09:00 後持股變動／成本更正換版（或今天買進）
//            ＝今日新設停損，前端沒有真成交旗標 ⇒ 當日不判定；ATR 帶換值開盤起就適用 ⇒ 照常判定、進行中的事件延續。
//            持股分析或停損簿還在讀取（最多 15 秒）時先不推進事件表，避免「只有成本線」的暫時值換版。
//            這一檔第一次拿到前一交易日收盤時已在停損下（切換當天）只發一則二級彙總；之後本機沒有事件而前一交易日收盤已在
//            停損下＝本裝置漏判 ⇒ 一級「前一交易日收盤後補判·本裝置」。成本資料可疑 ⇒ 該檔一級暫停、每日一則二級。
//            Z2 文字只寫代號、事件與生效線（成本線／ATR 帶），標「單一裝置·暫算」，不寫停損價。
//            停損簿生效前，daemon 寫入的 type 'stop'／'discipline' 是舊制推播（停損算法不同）⇒ 一律二級並標明。
//            停損簿生效（stopBooks/{uid} phase 'live'）後停用前端判定與本機事件表，改讀 daemon 帶 requireAck＋id 的 type 'stop'
//            為一級（warroom-top.eventFromDaemonAlert stopLive；「收到」回寫同一則）。
//   重大利空 AI 新聞識讀（媒體 M；慢層 board.news 精簡表）× 使用者持股，
//            條件 A–E 與去重在 warroom-news.mjs（majorBearOf／stepMajorBear，有測試）：
//            只看規則類利空（daemon 程式規則判定：AI 讀內文認定主體與事實、方向由規則定；news-rule-classes.mjs）的
//            類別權重（新聞技能 §4.1，先驗·未回測）：≥0.7 一級、0.3–0.7 二級、<0.3 不列；
//            影響權重 w 研究期只顯示，不發任何等級（停損規範 §13.2 B4）；
//            同日每檔只發一次（判讀較新且警示等級上升＝二級→一級才再發，強弱升級不再發）、隔日同一句（逐字核對的引文，
//            沒有用理由）降二級「持續」；本機 wr-nvbear:<uid> 記錄。
//   大盤危險 資料時間 09:10 後、跌停 ≥10 且 ≥ 漲停×1.5、連續 2 拍（狀態機在 scripts/lib/warroom-top.mjs，有測試）；
//            當日已發狀態記在本機（wr-danger），重新整理不重發
// daemon 個人警示（停利、爆量下殺、舊制停損…）一律二級「我的」紀錄，給 B2（停損簿生效後帶 requireAck＋id 的觸停損除外，見上）；
//   文案只寫代號與事件，不寫個人停損價、成本、損益。
// 「收到」：本工作階段 ackWarEvent＋本機記當日（wr-z2-ack）；daemon 要求確認（requireAck＋id）的另照 PortfolioAlerts 回寫 ack
//   （交易內讀改寫、共用 alerts-split 的 ackAlertIn，避免蓋掉同一陣列裡 daemon 剛寫入的新警示——critique H3）。
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef } from 'react';
import { doc, onSnapshot, runTransaction } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import { useDataUid, canWriteUserData } from '@/lib/view-as';
import { storageGet, storageSet } from '@/lib/safe-storage';
import { taipeiYmd } from '@/lib/warroom/session';
import { useWarData, useWarUi } from './WarRoomContext';
import {
  publishWarEvent, publishWarEvents, ackWarEvent, useWarEvents, useWarEventAcks,
  type WarEvent, type WarEventInput,
} from './events';
import { setTopState, EMPTY_STOP_BOOK } from './TopStore';
import { fmtPct, fmtInt } from './parts/fmt';
import { FAST_CODES_MAX } from './useWarRoomBus';
import { useRiskCodes, isDispositionPending, type RiskInfo } from '@/lib/useRiskCodes';
import { prevTradingYmd, stopCalcPriceOf, usePreAuction, useWarStopCtx } from './MineModel';
import { useNewsBoard } from './NewsModel';
import type { WarQuote } from './useWarRoomBus';
import {
  stepDanger, parseDangerState, nearStopList, eventFromDaemonAlert, sortLevel1,
  type DangerState,
} from '../../../scripts/lib/warroom-top.mjs';
import { aggregatePositions, type Position } from '../../../scripts/lib/ai-stoploss.mjs';
import {
  warStopView, parseStopEpisodes, serializeStopEpisodes, stepStopEpisodes, stopLevel1Events, stopSeededEvent, stopSuspectEvents,
  type StopEpisodeRow, type StopEpisodeState, type StopBook, type WarStopCtx,
} from '../../../scripts/lib/warroom-mine.mjs';
import { stopBookLive } from '../../../scripts/lib/warroom-stopbook.mjs';
import type { WarSegment } from '@/lib/warroom/types';
import { LEGACY_ALERTS_DOC, ackAlertIn } from '../../../scripts/lib/alerts-split.mjs';
import {
  majorBearOf, stepMajorBear, parseMajorBearState, majorBearEvents, type MajorBearState,
} from '../../../scripts/lib/warroom-news.mjs';

const ACK_KEY = 'wr-z2-ack';
const ACK_MAX = 120;
const DANGER_KEY = 'wr-danger';
const STOP_EP_KEY = 'wr-stop-ep';
const NEWS_BEAR_KEY = 'wr-nvbear';
const TEXT_MAX = 200;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const dbReady = () => !!db && typeof (db as { type?: unknown }).type !== 'undefined';

function readJson(key: string): unknown {
  const raw = storageGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── 「收到」本機記錄（當日） ───────────────────────────────────────────────

function loadAcks(ymd: string): string[] {
  const v = readJson(ACK_KEY);
  if (!isObj(v) || v.ymd !== ymd || !Array.isArray(v.ids)) return [];
  return v.ids.filter((x): x is string => typeof x === 'string' && x.length <= 200).slice(-ACK_MAX);
}

function persistAck(id: string): void {
  const ymd = taipeiYmd(Date.now());
  const ids = loadAcks(ymd);
  if (ids.includes(id)) return;
  storageSet(ACK_KEY, JSON.stringify({ ymd, ids: [...ids, id].slice(-ACK_MAX) }));
}

// daemon 要求確認的警示（requireAck＋id）：事件 id → daemon 警示 id，與目前訂閱的 uid
let ackTargets: { uid: string | null; byEvent: ReadonlyMap<string, string> } = { uid: null, byEvent: new Map() };

/** Z2／手機「收到」：本工作階段標記＋本機記當日；daemon 要求確認的另回寫 ack（模擬他人身分時不寫） */
export async function ackTopEvent(id: string): Promise<void> {
  ackWarEvent(id);
  persistAck(id);
  const alertId = ackTargets.byEvent.get(id);
  const uid = ackTargets.uid;
  if (!alertId || !uid || !canWriteUserData() || !dbReady()) return;
  const ref = doc(db, 'users', uid, 'data', LEGACY_ALERTS_DOC);
  try {
    // 與 PortfolioAlerts 同一支 ackAlertIn（scripts/lib/alerts-split.mjs）：交易內只改這一則、已收到不覆寫、沒變就不寫
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const { list, changed } = ackAlertIn((snap.data() as { alerts?: unknown }).alerts, alertId, Date.now(), 'web');
      if (changed) tx.update(ref, { updatedAt: Date.now(), alerts: list });
    });
  } catch (e) {
    console.warn('[warroom] 收到回寫失敗（本機已記住）', e instanceof Error ? e.message : e);
  }
}

// ── 大盤危險本機狀態 ──────────────────────────────────────────────────────

function readDanger(ymd: string): { state: DangerState; text: string } {
  const raw = readJson(DANGER_KEY);
  const text = isObj(raw) && typeof raw.text === 'string' ? raw.text.slice(0, TEXT_MAX) : '';
  return { state: parseDangerState(raw, ymd), text };
}

function writeDanger(state: DangerState, text: string): void {
  storageSet(DANGER_KEY, JSON.stringify({ ...state, text: text.slice(0, TEXT_MAX) }));
}

const dangerEventId = (ymd: string, seq: number) => `marketDanger:${ymd}:${seq}`;

// ── 觸停損（規範 stop-v1.1·本機事件表；A7 單一裝置·暫算） ───────────────────────

type TradedMap = Readonly<Record<string, { price: number; revealAt: number }>>;

interface StopRowCtx {
  quotes: Readonly<Record<string, WarQuote>>;
  risk: RiskInfo;
  nowMs: number;
  tradingDay: boolean;
  segment: WarSegment;
  preAuction: TradedMap;
  book: StopBook;
  /** 停損共用輸入（持股分析 ATR 帶、前一交易日、停損簿；與 A1 同一份 useWarStopCtx） */
  stopCtx: WarStopCtx;
}

/**
 * 每檔持股的判定列：與 A1 同一支 warStopView、同一支 stopCalcPriceOf、同一份本機事件表與停損共用輸入（數字必然一致）；
 * floor／source＝這一版的成本線棘輪與生效線（存進本機表）；prevClose 只在今日有真成交時給（MIS 昨收）。
 */
function stopRowsOf(groups: readonly Position[], ctx: StopRowCtx): StopEpisodeRow[] {
  const { quotes, risk, nowMs, tradingDay, segment, preAuction, book, stopCtx } = ctx;
  const today = taipeiYmd(nowMs);
  const prevYmd = prevTradingYmd(today);
  return groups.map((p) => {
    const q = quotes[p.code] ?? null;
    const live = q?.source === 'mis_realtime';
    const v = warStopView({
      position: p, quote: q, calcPrice: stopCalcPriceOf(segment, q, preAuction[p.code]).calcPrice, nowMs, todayYmd: today, tradingDay,
      disposition: risk.loaded && risk.disposition.has(p.code) && !isDispositionPending(risk, p.code),
      entry: Object.prototype.hasOwnProperty.call(book, p.code) ? book[p.code] : null,
      ctx: stopCtx,
    });
    return {
      code: p.code, stop: v.stop, floor: v.res.floorStop, source: v.res.stopSource, touch: v.touch, at: q?.revealAt ?? null,
      prevClose: live && q.prevClose > 0 ? q.prevClose : null, prevYmd: live && prevYmd !== today ? prevYmd : null,
      lots: p.lots, reason: v.res.versionReason, suspect: v.stop != null && v.res.suspect,
    };
  });
}

// ── 引擎 ──────────────────────────────────────────────────────────────────

/** 掛在 ZoneAlerts（桌機）或 MobileBars（手機）；只有副作用，畫面讀 useLevel1／useTopState */
export function useTopAlertEngine(): void {
  const { quotes, pulse, clock, segment } = useWarData();
  const { setFastCodes } = useWarUi();
  const holdings = useAppStore(s => s.holdings);
  const dataUid = useDataUid();
  const { ymd } = clock;
  const top = pulse?.top;

  const groups = useMemo(() => aggregatePositions(holdings), [holdings]);
  const codesKey = groups.map(g => g.code).join(',');

  // 持股報價走匯流排快層（A1 的 'mine' 永遠優先；同代號去重，不多打請求）
  useEffect(() => {
    setFastCodes(codesKey ? codesKey.split(',').slice(0, FAST_CODES_MAX) : [], 'top');
  }, [codesKey, setFastCodes]);

  // 當日已收到（重新整理後還原）
  useEffect(() => {
    for (const id of loadAcks(ymd)) ackWarEvent(id);
  }, [ymd]);

  // 停損共用輸入（與 A1 同一份）；停損簿生效（phase live）⇒ Z2 觸停損一級改讀 daemon、停用前端判定（A7）
  const stopCtx = useWarStopCtx(ymd);
  const stopLive = stopBookLive(stopCtx.book);

  // daemon 個人警示
  useEffect(() => {
    if (!dataUid || !dbReady()) return undefined;
    const ref = doc(db, 'users', dataUid, 'data', 'alerts');
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const list = data && Array.isArray(data.alerts) ? (data.alerts as unknown[]) : [];
      const today = taipeiYmd(Date.now());
      const inputs: WarEventInput[] = [];
      const byEvent = new Map<string, string>();
      for (const a of list) {
        const e = eventFromDaemonAlert(a, today, { stopLive });
        if (!e) continue;
        inputs.push(e);
        if (isObj(a) && a.requireAck === true && typeof a.id === 'string') byEvent.set(e.id, a.id);
        if (isObj(a) && a.ack) ackWarEvent(e.id);   // 已在別處（網頁投組頁、Telegram）按過收到
      }
      ackTargets = { uid: dataUid, byEvent };
      publishWarEvents(inputs);
    }, (err) => { console.warn('[warroom] 個人警示訂閱失敗', err?.message ?? err); });
    return () => { unsub(); ackTargets = { uid: null, byEvent: new Map() }; };
  }, [dataUid, stopLive]);

  // 停損（規範 stop-v1.1；停損簿生效前＝前端暫算）：每拍報價重判。
  //   · 一級觸停損（A7 單一裝置·暫算）：本機事件表依使用者分開存（身分模擬不混到自己的）；表同時是成本線棘輪的上一版，
  //     發布到 TopStore.stopBook 讓 A1、快看抽屜讀同一份。停損簿生效後不再推進、不再發（改讀 daemon）。
  //     持股分析 ATR 帶或停損簿還在讀取（最多 15 秒，之後狀態 'slow'）時先不推進，避免「只有成本線」的暫時值被記成一版。
  //   · 逼近停損（價格在停損下或 ≤1 ATR；沒有 ATR14 時 ≤2%）＋監控檔數：距停損用的價與 A1 同一支 stopCalcPriceOf（盤前昨收、
  //     收盤競價窗 13:25 前成交），停損帶同一份本機表與停損共用輸入；讀取中標「暫無法計算」。
  const risk = useRiskCodes();
  const tradingDay = segment !== 'nontrading';
  const preAuction = usePreAuction(quotes, segment, ymd);
  const epKey = dataUid ? `${STOP_EP_KEY}:${dataUid}` : null;
  const epRef = useRef<{ key: string; state: StopEpisodeState } | null>(null);
  const stopReady = stopCtx.bandStatus !== 'loading' && stopCtx.bookStatus !== 'loading';
  useEffect(() => {
    const nowMs = Date.now();
    const today = taipeiYmd(nowMs);
    let book: StopBook = EMPTY_STOP_BOOK;
    if (epKey) {   // 未登入或身分未就緒：不判（事件表依使用者存）
      if (epRef.current?.key !== epKey) epRef.current = { key: epKey, state: parseStopEpisodes(readJson(epKey)) };
      if (groups.length && stopReady && !stopLive) {
        const rows = stopRowsOf(groups, {
          quotes, risk, nowMs, tradingDay, segment, preAuction, book: epRef.current.state.byCode, stopCtx,
        });
        // 換版的版本日：非交易日記為最後交易日（使用者規則）
        const versionYmd = tradingDay ? today : prevTradingYmd(today);
        const step = stepStopEpisodes(epRef.current.state, rows, { todayYmd: today, nowMs, versionYmd });
        if (step.changed) {
          epRef.current = { key: epKey, state: step.state };
          storageSet(epKey, JSON.stringify(serializeStopEpisodes(step.state)));
        }
        const names = new Map(groups.map(g => [g.code, g.name]));
        const seeded = stopSeededEvent(step.state, names, today);
        const level1 = stopLevel1Events(step.state, names, today);
        const suspect = tradingDay ? stopSuspectEvents(rows.filter(r => r.suspect).map(r => r.code), names, today, nowMs) : [];
        publishWarEvents([...level1, ...(seeded ? [seeded] : []), ...suspect]);
      }
      book = epRef.current.state.byCode;
    }
    const prices: Record<string, number> = {};
    for (const g of groups) {
      const px = stopCalcPriceOf(segment, quotes[g.code] ?? null, preAuction[g.code]).calcPrice;
      if (px != null && px > 0) prices[g.code] = px;
    }
    setTopState({
      stopBook: book, nearStop: nearStopList(holdings, prices, book, { ctx: stopCtx, todayYmd: today, nowMs }),
      nearStopKnown: stopReady, holdingCount: groups.length,
    });
  }, [groups, holdings, quotes, risk, tradingDay, segment, preAuction, epKey, stopCtx, stopReady, stopLive]);

  // 大盤危險：先還原本機狀態（當日已發且未收到的，重新掛回 Z2；不算新發）
  const dangerRef = useRef<DangerState | null>(null);
  const dangerTextRef = useRef('');
  useEffect(() => {
    const saved = readDanger(ymd);
    dangerRef.current = saved.state;
    dangerTextRef.current = saved.text;
    const s = saved.state;
    setTopState({ danger: { active: s.active, seq: s.seq, at: s.active && s.lastFire ? s.lastFire : null } });
    if (s.active && saved.text && s.lastFire) {
      publishWarEvent({ id: dangerEventId(ymd, s.seq), at: s.lastFire, kind: 'marketDanger', level: 1, text: saved.text });
    }
  }, [ymd]);

  const topAsOf = top?.ok ? top.asOf : null;
  const counts = top?.ok ? top.data.pulse?.counts ?? null : null;
  const twiiChg = top?.ok ? top.data.pulse?.twiiChg ?? null : null;
  useEffect(() => {
    if (topAsOf == null) return;
    const { state: next, fired } = stepDanger(dangerRef.current, { asOf: topAsOf, counts });
    if (next === dangerRef.current) return;
    dangerRef.current = next;
    if (fired && counts) {
      const head = twiiChg != null ? `大盤 ${fmtPct(twiiChg)}·` : '';
      const text = `${head}跌停 ${fmtInt(counts.limitDown)} ≥ 漲停 ${fmtInt(counts.limitUp)}×1.5（連續 2 拍）`;
      dangerTextRef.current = text;
      publishWarEvent({ id: dangerEventId(next.ymd, next.seq), at: topAsOf, kind: 'marketDanger', level: 1, text });
    }
    writeDanger(next, dangerTextRef.current);
    setTopState({ danger: { active: next.active, seq: next.seq, at: next.active && next.lastFire ? next.lastFire : null } });
  }, [topAsOf, counts, twiiChg]);

  // AI 讀內文判定的持股重大利空（只看今日適用、非承接的判別；事件表依使用者分開存）
  const news = useNewsBoard();
  const nbKey = dataUid ? `${NEWS_BEAR_KEY}:${dataUid}` : null;
  const nbRef = useRef<{ key: string; state: MajorBearState } | null>(null);
  useEffect(() => {
    const nb = news.board;
    const targetDate = news.ctx.targetDate;
    if (!nb || !nbKey || !groups.length || news.ctx.fresh !== 'today' || !targetDate) return;
    const cands = groups.map((g) => {
      const entry = nb.map[g.code];
      return entry ? { code: g.code, entry, mb: majorBearOf(entry, { scope: 'holding', ctx: news.ctx, minAtMs: news.minAtMs }) } : null;
    }).filter((c): c is NonNullable<typeof c> => !!c && !!c.mb);
    if (nbRef.current?.key !== nbKey) nbRef.current = { key: nbKey, state: parseMajorBearState(readJson(nbKey)) };
    const step = stepMajorBear(nbRef.current.state, cands, { targetDate });
    if (step.changed) {
      nbRef.current = { key: nbKey, state: step.state };
      storageSet(nbKey, JSON.stringify(step.state));
    }
    if (!step.items.length) return;
    const names = new Map(groups.map(g => [g.code, g.name]));
    publishWarEvents(majorBearEvents(step.items, names, targetDate));
  }, [news, groups, nbKey]);
}

// ── 讀取端 ────────────────────────────────────────────────────────────────

export interface Level1View {
  /** 未收到的一級事件（嚴重度排序：大盤危險 → 觸停損 → … → 重大利空；同類新到舊） */
  list: readonly WarEvent[];
  /** 未收到的大盤危險（紫色全寬橫幅） */
  danger: WarEvent | null;
}

export function useLevel1(): Level1View {
  const events = useWarEvents();
  const acks = useWarEventAcks();
  return useMemo(() => {
    const list = sortLevel1(events.filter(e => e.level === 1 && !acks.has(e.id)));
    return { list, danger: list.find(e => e.kind === 'marketDanger') ?? null };
  }, [events, acks]);
}
