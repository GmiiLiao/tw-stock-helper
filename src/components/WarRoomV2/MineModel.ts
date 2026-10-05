'use client';

// ─────────────────────────────────────────────────────────────────────────────
// A1 我的部位：把「持股＋當日釘選＋快層報價＋停損（規範 stop-v1）＋風險名單＋新聞判別」組成畫面列（ZoneMine 用；riskTagOf／newsOf／
//   useDrawerStop 快看抽屜也用）。
//
// 口徑（同名必同口徑，CLAUDE.md）：
//   損益%   ＝ 扣費稅淨額（netRealizedPnL：現價賣出、扣買賣手續費〔你的券商折讓、最低手續費〕與證交稅）
//            —— 與投資組合頁「持倉明細」同一支函式、同一個折讓設定；毛額只放 tooltip 當附註
//   今日     ＝ 今日部位變動（毛額，不含費稅）：(現價−昨收)×股數；今天買的那筆用買價當基準
//   距停損%  ＝ AI 停損規範 stop-v1（使用者 2026-10-05 指示；scripts/lib/warroom-mine.mjs warStopView）：
//            停損＝成本線（買進均價 −8% 向上取合法檔位）。停損簿 stopBooks 未上線 ⇒ 前端暫算、未含除權息調整；
//            棘輪的上一版＝本機事件表（TopStore.stopBook，Z2 引擎寫入）——A1、快看抽屜、Z2、逼近清單帶同一份，數字一致；
//            逼近＝距停損 ≤2%（沒有 ATR14）；觸停損只認今日成交更新的最低價（試撮與收盤競價窗不判定）。
//            舊「AI 停損」（ATR 浮動帶）改稱結構參考價（非停損），只在提示與快看抽屜顯示、不觸發。
//   金額一律 ×1000（holdings.quantity 單位是張）
// 時段：
//   盤前／試撮清空（pre／preclear）＝價格欄顯示昨收、漲跌與損益「—」，距停損以昨收計（持股代號、成本、停損錨保留）
//   收盤競價（auction）＝價格是試撮指示價（斜體「指」）；損益、距停損、今日、色條改用 13:25 前最後一筆真成交，
//     指示價可能永不成交，不拿它判斷（critique-usability 第 6 點）。快看抽屜與 Z2 逼近清單用同一支 stopCalcPriceOf、
//     同一份 13:25 前成交（usePreAuction 模組層級共用），「距停損」同名同口徑。
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAppStore, type HoldingItem } from '@/lib/store';
import { netRealizedPnL, sharesOf, type BrokerSettings } from '@/lib/tw-fee';
import { useBrokerSettings } from '@/lib/useBrokerSettings';
import { isLimitDown, isLimitUp, marketBadge, type StockInfo } from '@/lib/twse-api';
import { isTradingYmd } from '@/lib/market-clock';
import { useRiskCodes, isDispositionPending, shortRiskDate, type RiskInfo } from '@/lib/useRiskCodes';
import type { NewsEntry } from '@/lib/warroom/build-news';
import type { WarSegment, WarClock } from '@/lib/warroom/types';
import { aggregatePositions, isEtfCode, stopPxText, type Position } from '../../../scripts/lib/ai-stoploss.mjs';
import {
  grossPnl, lastCloseOf, dayPnlOf, sumDayPnl, mergeTradedBefore, taipeiAt, warStopView,
  type WarStopView, type WarStopLevel, type StopBook,
} from '../../../scripts/lib/warroom-mine.mjs';
import { useTopState } from './TopStore';
import { useWarData, useWarUi } from './WarRoomContext';
import type { WarQuote } from './useWarRoomBus';
import { rowAgeOf, type RowAge } from './parts/freshness';
import { useStructRefs, type StructRefs } from './MineStops';
import {
  newsLampView, majorBearOf, isNewsUniverse, newsKpi, type NewsLampView, type MajorBear,
} from '../../../scripts/lib/warroom-news.mjs';
import { useNewsBoard, type NewsBoardView } from './NewsModel';
import { indexAsOf } from './TopView';

/** 顯示價的性質：live 盤中報價｜close 收盤後／休市｜yclose 盤前顯示昨收｜indicative 收盤競價試撮指示價｜none 尚無報價 */
export type PriceMode = 'live' | 'close' | 'yclose' | 'indicative' | 'none';

export interface RiskTag { label: '處置' | '將處置' | '注意'; title: string }

/** 新聞燈一格（AI 新聞識讀·媒體 M）：entry＝判別表那一列（null＝未判別）、view＝燈號（權重先驗·未校準，只表強弱）、
 *  mb＝持股重大利空條件（只有持股才判；warroom-news.majorBearOf） */
export interface NewsCell { entry: NewsEntry | null; view: NewsLampView; mb: MajorBear | null }
/** 新聞燈狀態：cell＝判別表已載入；'unknown'＝讀不到（且沒有上一份）；null＝尚未載入 */
export type NewsState = NewsCell | 'unknown' | null;

export interface MineRow {
  code: string;
  name: string;
  /** 市／櫃／興／ETF／創；查不到 null */
  mkt: string | null;
  isHolding: boolean;
  lots: number;
  avgCost: number;
  quote: WarQuote | null;
  /** 價格欄要顯示的數字（盤前＝昨收） */
  price: number | null;
  priceMode: PriceMode;
  chgPct: number | null;
  /** 損益／距停損／今日用的價（收盤競價窗＝13:25 前最後成交） */
  calcPrice: number | null;
  /** calcPrice 的來源說明（tooltip）；一般盤中為 null */
  calcNote: string | null;
  netPct: number | null;
  netAmount: number | null;
  grossPct: number | null;
  grossAmount: number | null;
  /** 停損（規範 stop-v1·前端暫算）；釘選列為 null */
  stop: WarStopView | null;
  dist: number | null;
  level: WarStopLevel | null;
  /** 距停損「—」的原因（無報價、成本資料缺） */
  stopNote: string | null;
  /** 結構參考價（舊 AI 停損·ATR 浮動帶）：非停損，只顯示 */
  structRef: number | null;
  risk: RiskTag | null;
  news: NewsState;
  age: RowAge;
  limit: 'up' | 'down' | null;
  /** 第二行原因短句（只有走勢與部位：停損、觸及漲跌停）；盤前不顯示 */
  reason: string | null;
  /** 琥珀左色條：距停損 ≤2%、今日觸及或價格在停損下 */
  amber: boolean;
  /** 排序用：持有成本（Σ 買價×股） */
  costBasis: number;
}

export interface MineKpi {
  holdings: number;
  /** 今日（或前交易日）部位變動；盤前、沒有任何報價時 null */
  day: { amount: number; pct: number; counted: number } | null;
  dayLabel: '今日' | '前交易日';
  /** 有持股但沒報價、沒算進今日的檔數 */
  dayMissing: number;
  /** 逼近停損（含已觸及） */
  near: number;
  hit: number;
  risk: number;
  /** 新聞（AI 讀內文·媒體 M）：今日適用、非承接、判利空的持股數；判別表讀不到時 null */
  newsBear: number | null;
  /** 持股中未判別／資訊不足／價格描述（ETF 等不做個股新聞識讀的不算）；判別表讀不到時 null */
  newsMissing: number | null;
  /** 有判別但不是今日適用（承接或前一交易日判別） */
  newsOld: number;
  /** 風險名單殘缺或未載入（KPI 要標「名單可能不完整」） */
  riskIncomplete: boolean;
}

export interface MineModel {
  rows: MineRow[];
  pins: MineRow[];
  kpi: MineKpi;
  /** 列中最新的揭示時間（資料章用） */
  asOf: number | null;
  structRefs: StructRefs;
}

export interface MineInput {
  holdings: readonly HoldingItem[];
  pinned: readonly string[];
  quotes: Readonly<Record<string, WarQuote>>;
  stocks: ReadonlyMap<string, StockInfo>;
  segment: WarSegment;
  clock: WarClock;
  now: number;
  broker: BrokerSettings;
  structRefs: StructRefs;
  risk: RiskInfo;
  /** 新聞判別精簡表（board.news；useNewsBoard） */
  news: NewsBoardView;
  /** 收盤競價窗前最後一筆真成交（代號 → 價） */
  preAuction: Readonly<Record<string, { price: number; revealAt: number }>>;
  /** 停損本機事件表（棘輪的上一版；TopStore.stopBook） */
  stopBook: StopBook;
}

const DAY_MS = 86_400_000;
const PRICE_LABEL: Readonly<Record<PriceMode, string>> = { live: '現價', close: '收盤', yclose: '昨收', indicative: '試撮指示價', none: '現價' };
/** 停損原因句裡那個價的名稱：收盤競價窗有 13:25 前成交就用它，否則是指示價 */
const priceLabelOf = (mode: PriceMode, frozen: boolean) => (mode === 'indicative' && frozen ? '13:25 前成交' : PRICE_LABEL[mode]);

/** ymd 之前最近一個交易日（休市日曆＋週末；最多往回 15 天）。Z2 觸停損事件結算也用它 */
export function prevTradingYmd(ymd: string): string {
  let t = Date.parse(`${ymd}T00:00:00Z`);
  for (let i = 0; i < 15 && Number.isFinite(t); i++) {
    t -= DAY_MS;
    const d = new Date(t).toISOString().slice(0, 10);
    if (isTradingYmd(d)) return d;
  }
  return ymd;
}

/** 處置／注意小標（RiskBadge 同口徑：已公告未生效的處置仍算注意；名單未載入回 null） */
export function riskTagOf(risk: RiskInfo, code: string): RiskTag | null {
  if (!risk.loaded) return null;
  const pending = risk.disposition.has(code) && isDispositionPending(risk, code);
  if (risk.disposition.has(code) && !pending) {
    const until = shortRiskDate(risk.dispEnd.get(code));
    return { label: '處置', title: until ? `處置股票，處置至 ${until}（交易受限、分盤撮合）` : '處置股票（交易受限）' };
  }
  if (pending) {
    return { label: '將處置', title: `已公告處置，${shortRiskDate(risk.dispStart.get(code))} 起（生效前仍為注意股）` };
  }
  if (risk.attention.has(code)) {
    const until = shortRiskDate(risk.attEnd.get(code));
    return { label: '注意', title: until ? `注意股票（交易異常），至 ${until}` : '注意股票（交易異常）' };
  }
  return null;
}

/** 新聞燈狀態（見 NewsState）。holding＝持股才判重大利空條件 */
export function newsOf(news: NewsBoardView, code: string, holding: boolean): NewsState {
  if (news.status === 'loading') return null;
  if (!news.board) return 'unknown';
  const entry = news.board.map[code] ?? null;
  const view = newsLampView(entry, news.ctx, { universe: isNewsUniverse(code) });
  const mb = holding && entry ? majorBearOf(entry, { scope: 'holding', ctx: news.ctx, minAtMs: news.minAtMs }) : null;
  return { entry, view, mb };
}

function priceModeOf(segment: WarSegment, quote: WarQuote | null): PriceMode {
  if (!quote) return 'none';
  if (segment === 'pre' || segment === 'preclear') return 'yclose';
  if (segment === 'auction') return 'indicative';
  if (segment === 'after' || segment === 'nontrading') return 'close';
  return 'live';
}

interface PriceView { price: number | null; chgPct: number | null; calcPrice: number | null; calcNote: string | null }

function priceView(mode: PriceMode, quote: WarQuote | null, frozen: { price: number } | undefined): PriceView {
  if (!quote || mode === 'none') return { price: null, chgPct: null, calcPrice: null, calcNote: null };
  if (mode === 'yclose') {
    const y = lastCloseOf(quote);
    return { price: y, chgPct: null, calcPrice: y, calcNote: '盤前以昨收計' };
  }
  if (mode === 'indicative') {
    return frozen
      ? { price: quote.price, chgPct: quote.changePercent, calcPrice: frozen.price, calcNote: '收盤競價中：以 13:25 前最後成交計（指示價可能不成交）' }
      : { price: quote.price, chgPct: quote.changePercent, calcPrice: quote.price, calcNote: '收盤競價中：未取得 13:25 前成交，暫以指示價計（可能不成交）' };
  }
  return { price: quote.price, chgPct: quote.changePercent, calcPrice: quote.price, calcNote: null };
}

/**
 * 距停損／損益用的價與名稱（A1、快看抽屜、Z2 逼近清單與觸停損判定共用——同名同口徑）：
 * 盤前＝昨收；收盤競價窗＝13:25 前最後一筆真成交（沒有才暫用指示價）；其餘＝報價。
 */
export function stopCalcPriceOf(segment: WarSegment, q: WarQuote | null, frozen: { price: number } | undefined): { calcPrice: number | null; label: string } {
  const mode = priceModeOf(segment, q);
  return { calcPrice: priceView(mode, q, frozen).calcPrice, label: priceLabelOf(mode, !!frozen) };
}

function netOf(pos: Position, price: number, broker: BrokerSettings, code: string): { amount: number; pct: number } | null {
  let pnl = 0, cost = 0;
  for (const l of pos.lots) {
    const nr = netRealizedPnL(price, l.buyPrice, l.qty, broker, { code });
    pnl += nr.pnl;
    cost += l.buyPrice * sharesOf(l.qty) + nr.buyFee;
  }
  return cost > 0 ? { amount: pnl, pct: (pnl / cost) * 100 } : null;
}

function limitOf(mode: PriceMode, q: WarQuote | null): 'up' | 'down' | null {
  if (!q || (mode !== 'live' && mode !== 'close')) return null;
  if (mode === 'live' && q.source !== 'mis_realtime') return null;
  if (isLimitUp(q.price, q.change)) return 'up';
  if (isLimitDown(q.price, q.change)) return 'down';
  return null;
}

function reasonOf(mode: PriceMode, stop: WarStopView | null, limit: 'up' | 'down' | null): string | null {
  if (mode === 'yclose') return null;   // 盤前不顯示原因列（preview）
  const parts: string[] = [];
  if (stop?.reason) parts.push(stop.reason);
  if (limit === 'up') parts.push('觸及漲停價');
  if (limit === 'down') parts.push('觸及跌停價');
  return parts.length ? parts.join('·') : null;
}

function nameOf(code: string, q: WarQuote | null, fallback: string, stocks: ReadonlyMap<string, StockInfo>): string {
  return q?.name || fallback || stocks.get(code)?.name || '';
}

function mktOf(code: string, name: string, stocks: ReadonlyMap<string, StockInfo>): string | null {
  const s = stocks.get(code);
  return marketBadge({ code, market: s?.market, name: name || s?.name })?.t ?? null;
}

function stopNoteOf(stop: WarStopView, hasPrice: boolean): string | null {
  if (stop.stop == null) return stop.res.basisText;   // 成本資料缺
  if (!hasPrice) return `${stop.title}·尚無報價`;
  return null;
}

/** 單一持股的停損（A1 列與快看抽屜共用；帶本機事件表這一檔當棘輪的上一版） */
function stopViewOf(pos: Position, q: WarQuote | null, calc: number | null, priceLabel: string, input: Pick<MineInput, 'now' | 'clock' | 'segment' | 'risk' | 'stopBook'>): WarStopView {
  return warStopView({
    position: pos, quote: q, calcPrice: calc, priceLabel, nowMs: input.now, todayYmd: input.clock.ymd,
    tradingDay: input.segment !== 'nontrading',
    disposition: input.risk.loaded && input.risk.disposition.has(pos.code) && !isDispositionPending(input.risk, pos.code),
    entry: Object.prototype.hasOwnProperty.call(input.stopBook, pos.code) ? input.stopBook[pos.code] : null,
  });
}

/** 純組裝（不含 hook）：同一份輸入必得同一份輸出 */
export function buildMineModel(input: MineInput): MineModel {
  const { quotes, stocks, segment, clock, broker, structRefs, risk, news, preAuction } = input;
  const dayYmd = clock.beforeOpen || segment === 'nontrading' ? prevTradingYmd(clock.ymd) : clock.ymd;

  const rows: MineRow[] = [];
  const dayParts: Array<{ amount: number; base: number } | null> = [];
  let dayMissing = 0;
  for (const agg of aggregatePositions(input.holdings)) {
    const q = quotes[agg.code] ?? null;
    const mode = priceModeOf(segment, q);
    const pv = priceView(mode, q, preAuction[agg.code]);
    const calc = pv.calcPrice;
    const stop = stopViewOf(agg, q, calc, priceLabelOf(mode, !!preAuction[agg.code]), input);
    const dist = stop.distPct;
    const level = stop.level;
    const showPnl = calc != null && mode !== 'yclose';
    const net = showPnl ? netOf(agg, calc, broker, agg.code) : null;
    const gross = showPnl ? grossPnl(agg.avgCost, agg.qty, calc) : null;
    const limit = limitOf(mode, q);
    const name = nameOf(agg.code, q, agg.name, stocks);
    if (mode !== 'yclose') {
      const part = q && calc != null ? dayPnlOf(agg.lots, { price: calc, prevClose: q.prevClose }, dayYmd) : null;
      if (part) dayParts.push(part); else dayMissing += 1;
    }
    rows.push({
      code: agg.code, name, mkt: mktOf(agg.code, name, stocks), isHolding: true,
      lots: agg.qty, avgCost: agg.avgCost, quote: q,
      price: pv.price, priceMode: mode, chgPct: pv.chgPct, calcPrice: calc, calcNote: pv.calcNote,
      netPct: net?.pct ?? null, netAmount: net?.amount ?? null,
      grossPct: gross?.pct ?? null, grossAmount: gross?.amount ?? null,
      stop, dist, level, stopNote: stop.stop != null && dist != null ? null : stopNoteOf(stop, calc != null),
      structRef: structRefs.refs[agg.code] ?? null,
      risk: riskTagOf(risk, agg.code), news: newsOf(news, agg.code, true),
      age: rowAgeOf(q, input.now, segment), limit,
      reason: reasonOf(mode, stop, limit),
      amber: level === 'hit' || level === 'near',
      costBasis: agg.avgCost * agg.qty * 1000,
    });
  }
  // 排序：已觸停損 → 逼近停損 → 其餘；同級依持有成本大到小（不用市值：每 5 秒變動會讓列跳來跳去）
  const rank = (r: MineRow) => (r.level === 'hit' ? 0 : r.level === 'near' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || b.costBasis - a.costBasis);

  const held = new Set(rows.map((r) => r.code));
  const pins: MineRow[] = input.pinned.filter((c) => !held.has(c)).map((code) => {
    const q = quotes[code] ?? null;
    const mode = priceModeOf(segment, q);
    const pv = priceView(mode, q, undefined);
    const name = nameOf(code, q, '', stocks);
    return {
      code, name, mkt: mktOf(code, name, stocks), isHolding: false, lots: 0, avgCost: 0, quote: q,
      price: pv.price, priceMode: mode, chgPct: pv.chgPct, calcPrice: null, calcNote: null,
      netPct: null, netAmount: null, grossPct: null, grossAmount: null,
      stop: null, dist: null, level: null, stopNote: null, structRef: null,
      risk: riskTagOf(risk, code), news: newsOf(news, code, false),
      age: rowAgeOf(q, input.now, segment), limit: limitOf(mode, q), reason: null, amber: false, costBasis: 0,
    };
  });

  let asOf: number | null = null;
  for (const r of [...rows, ...pins]) {
    const t = r.quote?.revealAt;
    if (typeof t === 'number' && (asOf == null || t > asOf)) asOf = t;
  }

  const pre = segment === 'pre' || segment === 'preclear';
  const nk = news.board ? newsKpi(rows.map((r) => r.code), news.board.map, news.ctx) : null;
  const kpi: MineKpi = {
    holdings: rows.length,
    day: pre ? null : sumDayPnl(dayParts),
    dayLabel: clock.beforeOpen || segment === 'nontrading' ? '前交易日' : '今日',
    dayMissing: pre ? 0 : dayMissing,
    near: rows.filter((r) => r.amber).length,
    hit: rows.filter((r) => r.level === 'hit').length,
    risk: rows.filter((r) => r.risk).length,
    newsBear: nk ? nk.bear : null,
    newsMissing: nk ? nk.missing : null,
    newsOld: nk ? nk.old : 0,
    riskIncomplete: !risk.loaded || !risk.complete,
  };
  return { rows, pins, kpi, asOf, structRefs };
}

type TradedMap = Readonly<Record<string, { price: number; revealAt: number }>>;
const EMPTY_TRADED: TradedMap = Object.freeze({});

// 收盤競價窗前最後一筆真成交：模組層級共用（A1、快看抽屜、Z2 引擎讀同一份；各呼叫端以同一份報價合併，結果相同、沒變不換參照）
interface TradedState { ymd: string; traded: TradedMap }
const TRADED_INITIAL: TradedState = Object.freeze({ ymd: '', traded: EMPTY_TRADED });
let tradedState: TradedState = TRADED_INITIAL;
const tradedListeners = new Set<() => void>();
function subscribeTraded(l: () => void): () => void {
  tradedListeners.add(l);
  return () => { tradedListeners.delete(l); };
}
const getTraded = () => tradedState;
const getTradedServer = () => TRADED_INITIAL;

/** 收盤競價窗前最後一筆真成交：只在尾盤與競價窗累積（其餘時段不需要，也不重繪）；換日自動作廢 */
export function usePreAuction(quotes: Readonly<Record<string, WarQuote>>, segment: WarSegment, ymd: string): TradedMap {
  useEffect(() => {
    if (segment !== 'tail' && segment !== 'auction') return;
    const cutoff = taipeiAt(ymd, 13, 25);
    if (!Number.isFinite(cutoff)) return;
    const base = tradedState.ymd === ymd ? tradedState.traded : EMPTY_TRADED;
    const next = mergeTradedBefore(base, quotes, cutoff);
    if (tradedState.ymd === ymd && next === tradedState.traded) return;
    tradedState = Object.freeze({ ymd, traded: next });
    for (const l of tradedListeners) l();
  }, [quotes, segment, ymd]);
  const st = useSyncExternalStore(subscribeTraded, getTraded, getTradedServer);
  return st.ymd === ymd ? st.traded : EMPTY_TRADED;
}

/** A1 的資料（ZoneMine 用）。須在 WarRoomProvider 內。 */
export function useMineModel(): MineModel {
  const { quotes, segment, clock, now, index } = useWarData();
  const { pinned } = useWarUi();
  const holdings = useAppStore((s) => s.holdings);
  const allStocks = useAppStore((s) => s.allStocks);
  const [broker] = useBrokerSettings();
  const structRefs = useStructRefs();
  const risk = useRiskCodes();
  const preAuction = usePreAuction(quotes, segment, clock.ymd);
  const news = useNewsBoard();
  const { stopBook } = useTopState();

  // 名稱、市場別只需要持股與釘選那幾檔（allStocks 約 2,000 檔；專注模式下不再刷新，但這兩欄不會變）
  const codesKey = useMemo(() => [...holdings.map((h) => h.code), ...pinned].join(','), [holdings, pinned]);
  const stocks = useMemo(() => {
    const want = new Set(codesKey.split(',').filter(Boolean));
    const m = new Map<string, StockInfo>();
    for (const s of allStocks) if (want.has(s.code)) m.set(s.code, s);
    return m;
  }, [allStocks, codesKey]);

  const closeAsOf = indexAsOf(index);
  return useMemo(() => {
    const m = buildMineModel({
      holdings, pinned, quotes, stocks, segment, clock, now, broker, structRefs, risk, news, preAuction, stopBook,
    });
    // 收盤後報價來自收盤資料（沒有揭示時戳）⇒ 資料章改用指數自報的收盤時間（■ 收盤），不要標「無資料」
    const closed = segment === 'closing' || segment === 'after' || segment === 'nontrading';
    const hasPrice = [...m.rows, ...m.pins].some((r) => (r.quote?.price ?? 0) > 0);
    return m.asOf == null && closed && hasPrice && closeAsOf != null ? { ...m, asOf: closeAsOf } : m;
  }, [holdings, pinned, quotes, stocks, segment, clock, now, broker, structRefs, risk, news, preAuction, stopBook, closeAsOf]);
}

export interface DrawerStop {
  /** 沒有持有這檔 ⇒ null（抽屜不顯示停損區塊） */
  view: WarStopView | null;
  /** 距停損用的價與名稱（與 A1 同一支 stopCalcPriceOf：盤前＝昨收；收盤競價窗＝13:25 前最後成交，沒有才用指示價） */
  calcPrice: number | null;
  priceLabel: string;
  structRef: number | null;
  structStatus: StructRefs['status'];
  /** 結構參考價的顯示文字（依檔位） */
  structText: string | null;
}

/** 快看抽屜的停損區塊（與 A1 同一支 warStopView、同一支 stopCalcPriceOf、同一份本機事件表）。須在 WarRoomProvider 內。 */
export function useDrawerStop(code: string): DrawerStop {
  const { quotes, segment, clock, now } = useWarData();
  const holdings = useAppStore((s) => s.holdings);
  const structRefs = useStructRefs();
  const risk = useRiskCodes();
  const preAuction = usePreAuction(quotes, segment, clock.ymd);
  const { stopBook } = useTopState();
  const q = quotes[code] ?? null;
  const frozen = preAuction[code];
  return useMemo(() => {
    const pos = aggregatePositions(holdings.filter((h) => h.code === code))[0];
    const ref = structRefs.refs[code] ?? null;
    const base = { structRef: ref, structStatus: structRefs.status, structText: ref != null ? stopPxText(ref, isEtfCode(code)) : null };
    if (!pos) return { view: null, calcPrice: null, priceLabel: PRICE_LABEL.live, ...base };
    const { calcPrice: calc, label } = stopCalcPriceOf(segment, q, frozen);
    return { view: stopViewOf(pos, q, calc, label, { now, clock, segment, risk, stopBook }), calcPrice: calc, priceLabel: label, ...base };
  }, [holdings, code, q, frozen, segment, clock, now, risk, structRefs, stopBook]);
}
