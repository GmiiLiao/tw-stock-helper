// Z1 大盤脈動／手機 S1 的畫面推導（純函式；輸入＝匯流排的 index＋pulse.top＋時段＋大盤危險狀態）。
// 規則：
//   · 家數、漲跌停只用 marketPulse/latest（build-top 的 pulse）；盤前（08:30–09:00 與交易日 08:30 前）顯示「待開盤」，不顯示 0
//   · 期望漲停只寫「全日均 N（非同時刻）」，不顯示實際÷期望比值（critique H1：盤中比全日系統性偏低）
//   · 單位修正（2026-10-07，開盤感應器 v2.1 §10）：站上原本的「成交值 上市 N 億」其實是 t00 的 m÷1000＝**上市累積成交量（千張）**
//     （10/05 顯示 14,331「億」＝14,331 千張；當天實際上市成交金額 11,508 億）。改寫「成交量 上市 N 萬張」：
//     新欄位 tseVolLots（張）；舊文件只有 value（千張）⇒ ×1000 相容。量寫張、值寫億元，兩者分列不互換。
//     盤中沒有官方上市成交金額，這裡不顯示金額（開盤感應器的估計值只在超管影子區塊、標「估」）。
//     上櫃 o00 m 的語意未定（只核對 1 日，初判是成交金額）⇒ 核對完成前上櫃這一項不上畫面。不與昨日比（口徑待同口徑基準）。
//   · 指數資料日早於今天＝◆ 前交易日收盤（不顯示前一日的漲跌，避免被當成今天）
//   · 指數資料章＝來源自報的 tradeDate＋tradeTime（台北），不是 daemon 寫入時刻（盤外每 5 分鐘、週末也重寫）
//   · 盤勢燈：偏多紅、偏空綠、持平灰、危險紫（使用者裁定第 2 題）；大盤危險（連續 2 拍）成立時一律危險
import type { WarSegment, WarClock } from '@/lib/warroom/session';
import type { TopData } from '@/lib/warroom/types';
import type { WarIndex } from './useWarRoomBus';
import { LEVEL_TONE, type TopCounts } from '../../../scripts/lib/warroom-top.mjs';
import { taipeiDayStart } from '../../../scripts/lib/warroom-session.mjs';
import { fmtInt, fmtPct, mmdd } from './parts/fmt';

export type PulseLampTone = 'up' | 'dn' | 'flat' | 'danger';

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** 交易日 08:30 前與盤前試撮、清空窗：家數「待開盤」 */
export function isPreOpen(clock: Pick<WarClock, 'segment' | 'beforeOpen'>): boolean {
  return clock.segment === 'pre' || clock.segment === 'preclear' || (clock.segment === 'after' && clock.beforeOpen);
}

/** 指數 2 位小數、千分位 */
export function fmtIndex(n: number | null | undefined): string {
  if (!isNum(n) || n <= 0) return '—';
  return n.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const compactYmd = (ymd: string) => ymd.replace(/-/g, '');
const TPE_OFFSET_MS = 8 * 3_600_000;
const HMS_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * 指數資料本身的時間（epoch ms）：來源自報的 tradeDate（YYYYMMDD）＋tradeTime（台北 HH:MM[:SS]）。
 * 沒有 tradeTime（MI_INDEX 收盤版）＝該日 13:30 收盤；沒有可用的 tradeDate 才退回 daemon 寫入時刻（at／snapshotAt）。
 * 不用 at 當資料時間：daemon 盤外每 5 分鐘、週末也會重寫 marketIndex（at＝現在），資料章會把前一交易日標成「收盤前資料／即時」。
 */
export function indexAsOf(index: WarIndex | null | undefined): number | null {
  if (!index) return null;
  const d = typeof index.tradeDate === 'string' ? /^(\d{4})(\d{2})(\d{2})$/.exec(index.tradeDate) : null;
  if (d) {
    const t = typeof index.tradeTime === 'string' ? HMS_RE.exec(index.tradeTime.trim()) : null;
    const [h, m, sec] = t ? [+t[1], +t[2], t[3] ? +t[3] : 0] : [13, 30, 0];
    if (h <= 23 && m <= 59 && sec <= 59) return Date.UTC(+d[1], +d[2] - 1, +d[3], h, m, sec) - TPE_OFFSET_MS;
  }
  return isNum(index.at) ? index.at : isNum(index.snapshotAt) ? index.snapshotAt : null;
}

// ── 指數（快層 market-index） ──────────────────────────────────────────────

export interface IndexRow {
  label: '加權' | '櫃買';
  value: number | null;
  change: number | null;
  pct: number | null;
}

export interface IndexView {
  twii: IndexRow;
  otc: IndexRow;
  /** 資料日早於今天（前交易日收盤） */
  prev: boolean;
  /** 盤前／收盤競價的試撮指示值（斜體＋「指」） */
  indicative: boolean;
  /** 指數資料章的時間（來源自報的 tradeDate＋tradeTime；見 indexAsOf） */
  asOf: number | null;
  /** 成交量一行：「成交量 上市 1,433.1 萬張」；沒有資料為「成交量 —」 */
  volume: string;
  /** 那指期（NQ=F；market-index 回應的 usMarket，不另打請求）漲跌%；沒有資料為 null */
  nq: number | null;
}

/** 上市累積成交量（張）：新欄位 tseVolLots；舊文件的 value 是 t00 m÷1000＝千張 ⇒ ×1000。沒有資料回 null */
export function tseVolLotsOf(index: WarIndex | null | undefined): number | null {
  if (!index) return null;
  if (isNum(index.tseVolLots) && index.tseVolLots > 0) return index.tseVolLots;
  return isNum(index.value) && index.value > 0 ? Math.round(index.value * 1000) : null;
}

/** 張 → 「1,433.1 萬張」 */
export function fmtWanLots(lots: number | null): string {
  if (!isNum(lots)) return '—';
  return `${(lots / 10_000).toLocaleString('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} 萬張`;
}

// _top：保留參數位置（呼叫端不變）；成交量不與昨日比（口徑待同口徑基準，見檔頭）
export function indexView(index: WarIndex | null, _top: TopData | null, clock: Pick<WarClock, 'segment' | 'ymd'>, now: number): IndexView {
  const asOf = indexAsOf(index);
  const tradeDate = typeof index?.tradeDate === 'string' ? index.tradeDate : null;
  const prev = !!index && ((tradeDate != null && /^\d{8}$/.test(tradeDate) && tradeDate < compactYmd(clock.ymd))
    || (asOf != null && taipeiDayStart(asOf) < taipeiDayStart(now)));
  const seg = clock.segment;
  const indicative = !prev && (seg === 'pre' || seg === 'preclear' || seg === 'auction');
  const twii: IndexRow = {
    label: '加權',
    value: index && index.weighted > 0 ? index.weighted : null,
    change: index && isNum(index.weightedChange) ? index.weightedChange : null,
    pct: index && isNum(index.weightedChangePercent) ? index.weightedChangePercent : null,
  };
  const otc: IndexRow = {
    label: '櫃買',
    value: index && isNum(index.otc) && index.otc > 0 ? index.otc : null,
    change: index && isNum(index.otcChange) ? index.otcChange : null,
    pct: index && isNum(index.otcChangePercent) ? index.otcChangePercent : null,
  };
  const lots = tseVolLotsOf(index);
  const volume = lots != null ? `${prev ? '◆ 前交易日' : ''}成交量 上市 ${fmtWanLots(lots)}` : '成交量 —';
  const us = index?.usMarket;
  const nq = us && isNum(us.nasdaqFuturesPrice) && us.nasdaqFuturesPrice > 0 && isNum(us.nasdaqFuturesChangePercent)
    ? us.nasdaqFuturesChangePercent : null;
  return { twii, otc, prev, indicative, asOf, volume, nq };
}

// ── 家數、漲跌停、盤勢燈（marketPulse） ───────────────────────────────────

export interface BreadthView { up: number; flat: number; down: number; counted: number; sub: string }
export interface LimitsView { lu: number; ld: number; sub: string; subTitle: string }

export interface PulseView {
  tone: PulseLampTone;
  /** 燈上的字：極佳／偏多／持平／偏空／危險／待開盤／休市 */
  label: string;
  /** 盤型（今日 marketPattern.live；沒有為 '—'） */
  pattern: string;
  /** 一句事實（不寫指令句） */
  fact: string;
  /** null＝待開盤（不顯示 0） */
  breadth: BreadthView | null;
  limits: LimitsView | null;
  /** 盤前顯示的前交易日漲跌停（家數文件本身是前一日的才給） */
  prevLimits: { lu: number; ld: number; date: string } | null;
  /** 家數文件時間（Z1 家數、漲跌停資料章） */
  asOf: number | null;
  /** 盤前（含交易日 08:30 前）：家數顯示「待開盤」 */
  preOpen: boolean;
}

function compareWord(up: number, down: number): string {
  if (up > down) return '多於';
  if (up < down) return '少於';
  return '等於';
}

export function pulseView(
  top: TopData | null,
  index: WarIndex | null,
  clock: Pick<WarClock, 'segment' | 'beforeOpen' | 'ymd'>,
  now: number,
  dangerActive: boolean,
): PulseView {
  const p = top?.pulse ?? null;
  const c: TopCounts | null = p?.counts ?? null;
  const asOf = p?.asOf ?? null;
  const docIsPrevDay = asOf != null && taipeiDayStart(asOf) < taipeiDayStart(now);
  const pattern = top?.pattern?.label ?? '—';
  const seg: WarSegment = clock.segment;

  if (isPreOpen(clock)) {
    const iv = indexView(index, top, clock, now);
    const close = iv.prev ? iv.twii.value : (index?.prevClose ?? null);
    const nqText = iv.nq != null ? `；那指期 ${fmtPct(iv.nq)}` : '';
    return {
      tone: 'flat', label: '待開盤', pattern: '—',
      fact: close ? `昨收 ${fmtIndex(close)}${nqText}` : `09:00 開盤${nqText}`,
      breadth: null, limits: null,
      prevLimits: c && docIsPrevDay && asOf != null ? { lu: c.limitUp, ld: c.limitDown, date: mmdd(asOf) } : null,
      asOf,
      preOpen: true,
    };
  }

  const closedDay = seg === 'nontrading';
  let tone: PulseLampTone = p?.level ? (LEVEL_TONE[p.level.key] ?? 'flat') : 'flat';
  let label = p?.level?.label ?? '—';
  if (closedDay) { tone = 'flat'; label = '休市'; }
  else if (docIsPrevDay) { tone = 'flat'; label = '待更新'; }   // 交易時段但 daemon 今天還沒寫：不拿前一日級距當今天
  else if (dangerActive) { tone = 'danger'; label = '危險'; }

  let fact = '家數資料尚未產生';
  if (c) {
    const lim = `漲停 ${fmtInt(c.limitUp)}、跌停 ${fmtInt(c.limitDown)}`;
    if (closedDay || docIsPrevDay) {
      const tag = asOf != null ? `◆ ${mmdd(asOf)} ` : '◆ ';
      fact = `${tag}${lim}；上漲 ${fmtInt(c.up)}、下跌 ${fmtInt(c.down)}`;
    } else if (dangerActive) {
      fact = `跌停 ${fmtInt(c.limitDown)} ≥ 漲停 ${fmtInt(c.limitUp)}×1.5（連續 2 拍）；下跌 ${fmtInt(c.down)}`;
    } else if (seg === 'auction') {
      fact = `${lim}；收盤集合競價中`;
    } else if (p?.level?.key === 'bad' && isNum(p.twiiChg)) {
      fact = `加權 ${fmtPct(p.twiiChg)}（≤ −1.5% 級距）；${lim}`;
    } else {
      fact = `${lim}；上漲 ${fmtInt(c.up)} ${compareWord(c.up, c.down)}下跌 ${fmtInt(c.down)}`;
    }
  }

  const breadth: BreadthView | null = c
    ? {
      up: c.up, flat: c.flat, down: c.down, counted: c.counted,
      sub: seg === 'auction'
        ? `有效 ${fmtInt(c.counted)}·收盤競價中`
        : p?.basis === 'settled' && !p.marketNow
          ? `有效 ${fmtInt(c.counted)}·收盤結算·檔位口徑`
          : `有效 ${fmtInt(c.counted)}·4 碼普通股·檔位口徑`,
    }
    : null;
  const luExp = p?.level?.luExp ?? null;
  const limits: LimitsView | null = c
    ? {
      lu: c.limitUp, ld: c.limitDown,
      sub: luExp != null ? `全日均 ${fmtInt(luExp)}（非同時刻）` : '依檔位算漲跌停價',
      subTitle: '全日均＝同一漲跌幅級距的歷史全日收盤平均漲停家數（246 個交易日實測）；盤中家數與全日比較不是同時刻',
    }
    : null;
  return { tone, label, pattern, fact, breadth, limits, prevLimits: null, asOf, preOpen: false };
}

/** 漲跌比例條的三段寬度（%）；總數 0 回 null */
export function ratioWidths(b: Pick<BreadthView, 'up' | 'flat' | 'down'>): [number, number, number] | null {
  const tot = b.up + b.flat + b.down;
  if (!(tot > 0)) return null;
  return [(b.up / tot) * 100, (b.flat / tot) * 100, (b.down / tot) * 100];
}
