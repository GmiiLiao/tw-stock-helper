import { NextRequest, NextResponse } from 'next/server';
import { getStockDayAllDataInternal } from '@/lib/twse-api-server';
import { rateLimit } from '@/lib/rate-limit';
import { memoize } from '@/lib/singleflight';
import { lookupCompany } from '@/lib/company-list-server';
import {
  fallbackNote, resolveIndustry, rocDateToIso,
  type CompanyLookup, type IndustryInfo,
} from '@/lib/company-list';
import { readMarketSnapshot, isSnapshotFresh } from '@/lib/market-snapshot-store';
import { tickSize } from '@/lib/twse-api';
import { gzipJsonAuto } from '@/lib/gzip-response';
import {
  instFlowReading, model20Reading, dist20Reading, horizonReadings, newsDirReading, hitReadings,
  openRangeReading, nextDayDirReading, closePosReading, closePosNotFoundReading, quoteContextOf, quoteFactsOf,
  todayMoveOf, summaryText, reasonsOf, basisText, openRangeBasisText, stopRefOf, anyUnavailable, unavailableReading,
  tradingLag, nextTradingYmd, nextLimitPrices, etfTickSize, hhmmTpe, mmdd, STALE_LAG, OPEN_RANGE_LIMIT_APPROX_PCT, READING_TEXT,
  type Reading, type ReadingKey, type QuoteContext, type QuoteFacts, type QuoteRowInput, type TodayMove, type StopRef, type TrendReasonOut,
} from '@/lib/stock-readings';
import { getInstFlowTable, readingClock } from '@/lib/stock-readings-server';
import { otcSourceField, type OtcSource } from '@/lib/otc-source';

export type { IndustryInfo };

// ============================================================
// Stock Trend Analysis API
// 公司資料＋當日行情的事實描述＋判讀欄位（readings）。
// 2026-10-08 使用者裁定「不使用原來的寫死值，使用判讀結果真實表示」「依判讀方向給出正確提示」「給值也給正確的文字提示」：
//   法人看好度／共識評等／目標上漲／信心度 72・58／明日開盤建議／產業模板新聞與業務描述等寫死值全部移除，
//   改為 readings.*（值＋狀態字＋提示＋依據＋資料日），沒有結果就據實寫「尚無判讀結果」（規格 hardcoded-to-real-spec）。
//   legacy 鍵保留一個部署週期給舊分頁（值改成不會崩、也不捏造的內容；L20 刪除）。
// 非投資建議。
// ============================================================

// 代號格式：4~6 碼，ETF／特別股可能帶英文尾碼（00632R、2881A）。不合格式直接 400——
// 任意字串會讓每個不同 URL 都打穿 CDN 並觸發 3 個外部上游（WM-SCAN G1-22）。
const CODE_RE = /^\d{4}[0-9A-Z]{0,2}$/;

// 超時規則（規格 §0.2）：法人籌碼動向若改走降級模式，把這個開關改 true（固定回「尚無判讀結果」降級文案）。
const INST_FLOW_DEGRADED = false;

// TWSE 公告：全市場同一份，memoize 5 分鐘（合流＋失敗冷卻 1 分鐘），不隨請求數放大（唯一不變式）。
const ANNOUNCEMENT_URL = 'https://www.twse.com.tw/rwd/zh/announcement/announcement?response=json';
const ANNOUNCEMENT_TTL_MS = 5 * 60_000;
const ANNOUNCEMENT_NEGATIVE_TTL_MS = 60_000;
const getAnnouncementRows = memoize<AnnouncementRow[]>('twse-announcement', ANNOUNCEMENT_TTL_MS, async () => {
  const res = await fetch(ANNOUNCEMENT_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: unknown = await res.json();   // HTML 錯誤頁在此拋錯 ⇒ 負快取，不再讓整支 API 500
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('announcement: data 不是陣列');
  return data as AnnouncementRow[];
}, { negativeTtlMs: ANNOUNCEMENT_NEGATIVE_TTL_MS, timeoutMs: 10_000 });

/**
 * 從全市場日行情取這一檔（集中式 server helper，自帶快取與合流）。
 * failed＝日行情真的讀不到（拋錯或整份空陣列）⇒ closePos 標 unavailable、短快取；
 * 讀到了但查無此代號（停牌、下市…）＝ row null、failed false ⇒ none，不觸發 partial（2026-10-08 審查 LOW）。
 */
async function loadStockDay(code: string): Promise<{ row: StockDayItem | null; failed: boolean; otcSource?: OtcSource }> {
  try {
    const allDayData = await getStockDayAllDataInternal();
    if (!allDayData.length) return { row: null, failed: true };
    const found = allDayData.find(s => s.Code === code);
    if (!found) return { row: null, failed: false };
    return { failed: false, row: {
      Code: found.Code,
      Name: found.Name,
      OpeningPrice: found.OpeningPrice,
      HighestPrice: found.HighestPrice,
      LowestPrice: found.LowestPrice,
      ClosingPrice: found.ClosingPrice,
      Change: found.Change,
      TradeVolume: found.TradeVolume,
      TradeValue: found.TradeValue,
      Transaction: found.Transaction,
      // ⚠ **市場別必須帶過來**（2026-09-01 使用者回報 7930 威世波漲停錯誤）：
      // 這裡是逐欄重建，漏掉 _market 就等於把「這是興櫃」這件事丟掉，
      // 下游的漲跌停判斷因此對興櫃套用了不存在的 ±10% 限制。
      // 我第一版只改下游、沒發現欄位在這裡就被剝掉——部署後驗證才發現沒生效。
      // 2026-10-08 起產業別也靠它辨識興櫃（resolveIndustry）。
      _market: found._market,
      // 2026-10-08（規格 §1.9）：fallback 收盤資料的資料日與來源。快照新鮮時 Date 取自 CSV（盤中＝前一交易日），
      // 所以資料日一律以快照中繼為準，這兩欄只在快照不新鮮時使用。
      Date: found.Date,
      _source: found._source,
    },
    // 上櫃第三方後備來源註記（2026-10-09 使用者裁定 A）：這一檔的列是後備列才帶（與上面的開高低收同一列）
    ...otcSourceField([found]) };
  } catch (err) {
    console.error('[trend-analysis] Failed to load day data via getStockDayAllDataInternal:', err instanceof Error ? err.message : String(err));
    return { row: null, failed: true };
  }
}

/** 公告列 → 提到此代號或公司簡稱的前 3 則 */
function pickAnnouncements(rows: AnnouncementRow[] | null, code: string, companyName: string): NewsItem[] {
  if (!rows) return [];
  return rows
    .filter(row => {
      const text = (row[3] || '').toString();
      return text.includes(code) || (companyName && text.includes(companyName));
    })
    .slice(0, 3)
    .map(row => ({
      date: (row[1] || '').toString().replace('中華民國', '').replace('年', '/').replace('月', '/').replace('日', ''),
      text: (row[3] || '').toString(),
    }));
}

export async function GET(request: NextRequest) {
  const code = (request.nextUrl.searchParams.get('code') || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    return NextResponse.json({ error: 'invalid code' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  // 專屬限流（G1-22）：快取未命中時最多打 3 個外部上游（TWSE／TPEx 公司基本資料、TWSE 公告），
  // 三者都經 memoize 合流＋負快取，實際上游次數與請求數脫鉤。
  // 前端只在開個股頁／趨勢面板時打一次 ⇒ 60/分鐘很寬，只擋濫用。限流器故障 fail-open（2026-09-28 裁定）。
  const limited = await rateLimit(request, 'trend-analysis', 60);
  if (limited) return limited;

  try {
    // 公司清單（含打包備援）、公告、日行情、法人 20 日比較表（Firestore，memoize 10 分）彼此獨立 ⇒ 並行；都不拋錯。
    // 快照中繼（資料日／盤中與否／掃描時刻）緊接在日行情之後讀：getStockDayAllDataInternal 剛讀過、3 秒實例快取必中，
    //   不增加 Firestore 讀取，也保證算資料日／盤中與否的快照和日行情列是同一份（放在 Promise.all 之後，
    //   公告或公司清單慢 3 秒以上就會重讀大文件、13:35 前後還可能讀到不同份——2026-10-08 審查 LOW）。
    const [lookup, annoRows, day, instTable, clock] = await Promise.all([
      lookupCompany(code),
      getAnnouncementRows(),
      loadStockDay(code).then(async d => ({ ...d, snap: await readMarketSnapshot() })),
      getInstFlowTable(),
      readingClock(),
    ]);
    const stockData = day.row;
    const snap = day.snap;

    // ETF／興櫃不在公司清單裡 ⇒ 名稱改用日行情的證券名稱（不再回空字串）
    const companyName = lookup.company?.['公司簡稱'] || stockData?.Name || '';
    const relevantAnnouncements = pickAnnouncements(annoRows, code, companyName);

    const industry = resolveIndustry(lookup, code, stockData?._market);
    const qc = quoteContextOf({
      snapFresh: isSnapshotFresh(snap),
      snapDataYmd: snap?.dataDate ?? null,
      snapMarketOpen: !!snap?.marketOpen,
      snapSweepMs: snap?.sweepAt ?? null,
      rowYmd: rowYmdOf(stockData?.Date),
      rowMarket: stockData?._market,
    });
    const q = quoteFactsOf(code, quoteRowOf(stockData), qc, code.startsWith('00') ? etfTickSize : tickSize);
    const quoteStale = !!qc.dataDate && tradingLag(qc.dataDate, clock.todayYmd, clock.isTradingYmd) >= STALE_LAG;
    // 過期時文案裡的「明日」改成明確日期（§1.1 stale 旗標）
    const nextYmd = quoteStale && qc.dataDate ? nextTradingYmd(qc.dataDate, clock.isTradingYmd) : null;
    const nextDay: NextDayWords = nextYmd && qc.dataDate
      ? { word: `${mmdd(nextYmd)} `, limitSuffix: `（以 ${mmdd(qc.dataDate)} 收盤試算）` }
      : { word: '明日', limitSuffix: '（檔位）' };
    const todayMove: TodayMove | null = q ? todayMoveOf(q.chgPct, {
      limit: q.limit, phase: qc.phase, tradeValue: q.tradeValue, closePos: q.closePos,
      dataDate: qc.dataDate, quoteAsOfMs: qc.quoteAsOfMs, stale: quoteStale, noTradeToday: q.noTradeToday,
    }) : null;
    const readings: Record<ReadingKey, Reading> = {
      instFlow: instFlowReading(instTable, code, { ...clock, isEsb: stockData?._market === 'esb', degraded: INST_FLOW_DEGRADED }),
      model20: model20Reading(),
      dist20: dist20Reading(),
      ...horizonReadings(),
      newsDir: newsDirReading(),
      ...hitReadings(),
      openRange: openRangeReading(),
      nextDayDir: nextDayDirReading(),
      closePos: q
        ? closePosReading(q.closePos, { limit: q.limit, phase: qc.phase, quoteAsOfMs: qc.quoteAsOfMs, dataDate: qc.dataDate, auditOutside: q.auditOutside, ...clock })
        : day.failed ? unavailableReading('closePos', READING_TEXT.closePos.labelClose) : closePosNotFoundReading(),
    };

    const trendAnalysis = buildTrendAnalysis(code, q, qc, companyName, quoteStale, day.failed);
    const newsHeadlines = buildNewsHeadlines(relevantAnnouncements);
    const industryOutlook = buildLegacyIndustryOutlook(industry);
    const preMarketRecommendation = buildPreMarketRecommendation(q, qc, todayMove);
    const companyProfile = buildCompanyProfile(code, lookup, industry, stockData);
    const pricePrediction = buildPricePrediction(code, q, qc, nextDay);

    const body = {
      code,
      companyName,
      industry,
      dataDate: qc.dataDate,
      phase: qc.phase,
      quoteAsOfMs: qc.quoteAsOfMs,
      /** 「明日」或過期時的明確日期（「10-12 」）；前端組「{nextDayWord}高點參考」用。舊 JSON 沒有＝明日 */
      nextDayWord: nextDay.word,
      todayMove,
      readings,
      trendAnalysis,
      newsHeadlines,
      industryOutlook,
      preMarketRecommendation,
      companyProfile,
      pricePrediction,
      generatedAt: new Date().toISOString(),
      ...(day.otcSource ? { otcSource: day.otcSource } : {}),
    };
    // 任一判讀讀取失敗 ⇒ 短快取＋X-Data-Status: partial，不把一次故障在 CDN 上釘 6 分鐘（api-cache unavailable() 的規矩）。
    // 不用 cacheHeader('quote')：收盤後它是 1800 秒的 CLOSED_OVERRIDE。
    if (anyUnavailable(readings)) {
      return gzipJsonAuto(body, { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=15', 'X-Data-Status': 'partial' });
    }
    return gzipJsonAuto(body, { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' });

  } catch (error) {
    console.error('Trend analysis error:', error);
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 });
  }
}

// ─── Types ───────────────────────────────────────────────────

type AnnouncementRow = (string | number)[];

interface StockDayItem {
  // 'tse' 上市 ｜ 'otc' 上櫃 ｜ 'esb' 興櫃。
  // 興櫃**沒有漲跌幅限制**，下游的漲跌停判斷必須看這個欄位。
  _market?: string;
  Code: string;
  Name: string;
  OpeningPrice: string;
  HighestPrice: string;
  LowestPrice: string;
  ClosingPrice: string;
  Change: string;
  TradeVolume: string;
  TradeValue: string;
  Transaction: string;
  // 上游原樣欄位（民國 YYYMMDD 等）：快照不新鮮時當資料日；快照新鮮時拿來核對非即時列的開高低／成交值是不是資料日的值
  //（快照路徑的 Date 取自 STOCK_DAY_ALL CSV，盤中＝前一交易日；快照合成的上櫃後備列與興櫃列是 ''）
  Date?: string;
  _source?: string;   // 'mis_live'｜'stock_day_all'｜'esb'（twse-api-server 每列都會標，不會是空的）
}

interface NewsItem {
  date: string;
  text: string;
}

/** 「明日」用語：過期（落後 ≥2 個交易日）時改成明確日期（§1.1） */
interface NextDayWords {
  word: string;          // '明日'｜'10-12 '
  limitSuffix: string;   // '（檔位）'｜'（以 10-08 收盤試算）'
}

/** 日行情列的資料日：民國 YYYMMDD（或 YYMMDD）／西元 YYYYMMDD／YYYY-MM-DD；格式不對回 null（不猜） */
function rowYmdOf(raw: string | undefined): string | null {
  const roc = rocDateToIso(raw);
  if (roc) return roc;
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length !== 8) return null;
  const ymd = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(ymd) ? ymd : null;
}

const num = (v: string | undefined): number => parseFloat(String(v ?? '').replace(/,/g, '')) || 0;

/**
 * 日行情列 → 純函式 quoteFactsOf 的輸入（開高低原始值、缺就是 0，不以收盤價補）。
 * 資料日閘門（非即時列的開高低／成交值與資料日不同天就不用）在 quoteFactsOf 裡，有單元測試。
 */
function quoteRowOf(stock: StockDayItem | null): QuoteRowInput | null {
  if (!stock) return null;
  return {
    close: num(stock.ClosingPrice),
    change: num(stock.Change),
    open: num(stock.OpeningPrice),
    high: num(stock.HighestPrice),
    low: num(stock.LowestPrice),
    tradeValue: num(stock.TradeValue),
    volume: num(stock.TradeVolume),
    rowYmd: rowYmdOf(stock.Date),
    source: stock._source ?? null,
    market: stock._market ?? null,
  };
}

/** 價位用語的錨點：收盤後「今收」、盤中「目前價」、興櫃「最新價」 */
const anchorWord = (qc: QuoteContext): string => (qc.phase === 'intraday' ? '目前價' : qc.phase === 'quote' ? '最新價' : '今收');

// ─── Trend Analysis Builder（F12：只描述事實，下跌側與上漲側對稱）────────

function buildTrendAnalysis(
  code: string,
  q: QuoteFacts | null,
  qc: QuoteContext,
  companyName: string,
  stale: boolean,
  dayFailed: boolean,
): TrendAnalysis {
  if (!q) {
    return {
      summary: dayFailed ? '暫時無法取得當日行情，請稍後重新整理。' : '當日行情清單查無此代號（可能停牌、下市，或代號有誤）。',
      reasons: [],
      momentum: 'neutral',
      momentumScore: 50,
    };
  }
  const move = {
    chgPct: q.chgPct, limit: q.limit, phase: qc.phase, tradeValue: q.tradeValue, closePos: q.closePos,
    dataDate: qc.dataDate, quoteAsOfMs: qc.quoteAsOfMs, stale, noTradeToday: q.noTradeToday, auditOutside: q.auditOutside,
  };
  const summary = summaryText({ ...move, companyName, code });
  const reasons = reasonsOf({ ...move, close: q.close, open: q.open, prevClose: q.prevClose });

  // legacy（L20 刪除）：舊 TrendPanel 的動能儀表與舊 recommendation 讀它；新前端不讀，數值算法不動
  let momentum: TrendAnalysis['momentum'] = 'neutral';
  let momentumScore = 50;
  if (q.chgPct >= 7) { momentum = 'strong_bull'; momentumScore = 90; }
  else if (q.chgPct >= 3 && q.closePos != null && q.closePos >= 0.7) { momentum = 'bull'; momentumScore = 75; }
  else if (q.chgPct >= 1) { momentum = 'mild_bull'; momentumScore = 62; }
  else if (q.chgPct >= -1) { momentum = 'neutral'; momentumScore = 50; }
  else { momentum = 'bear'; momentumScore = 30; }

  return { summary, reasons, momentum, momentumScore };
}

// ─── News Headlines Builder（F13：只留交易所公告；舊版的產業模板假新聞已刪除）──────

function buildNewsHeadlines(twseAnnouncements: NewsItem[]): NewsHeadline[] {
  return twseAnnouncements.map(anno => ({
    source: '證交所公告',
    headline: anno.text.length > 80 ? `${anno.text.substring(0, 78)}…` : anno.text,
    date: anno.date,
    type: 'official' as const,
    sentiment: 'neutral' as const,   // 未判別：公告不等於利多或利空
    url: 'https://www.twse.com.tw/rwd/zh/announcement/announcement',
  }));
}

// ─── Industry Outlook（legacy 佔位；F1–F5 改由 readings 提供）────────────────
// 舊版依產業寫死法人看好度 92／82…55、共識評等 BUY／HOLD、目標上漲 +18%…+5%、短中長期與催化劑／風險——全部移除。
// 舊分頁（部署前開著的）仍會讀這幾個鍵：回不會崩、也不捏造的值（null／空陣列／狀態字），L20 整段刪除。
function buildLegacyIndustryOutlook(industry: IndustryInfo): IndustryOutlook {
  return {
    industry,
    shortTerm: '研究中',
    midTerm: '研究中',
    longTerm: '尚無判讀結果',
    catalysts: [],
    risks: [],
    consensusRating: '無模型評等',
    avgTargetUpside: '尚無判讀結果',
    institutionalSentiment: null,
  };
}

// ─── Response Interfaces ──────────────────────────────────────

type TrendReason = TrendReasonOut;

interface TrendAnalysis {
  summary: string;
  reasons: TrendReason[];
  /** legacy（L20 刪除）：新前端不讀 */
  momentum: 'strong_bull' | 'bull' | 'mild_bull' | 'neutral' | 'bear';
  momentumScore: number;
}

interface NewsHeadline {
  source: string;
  headline: string;
  date: string;
  type: 'official' | 'industry' | 'analysis' | 'news';
  sentiment: 'positive' | 'negative' | 'neutral';
  url?: string;
}

/** legacy（L20 刪除） */
interface IndustryOutlook {
  industry: IndustryInfo;
  shortTerm: string;
  midTerm: string;
  longTerm: string;
  catalysts: string[];
  risks: string[];
  consensusRating: string;
  avgTargetUpside: string;
  institutionalSentiment: number | null;
}

// ─── Pre-Market（價格參考：公式試算，非買賣建議）────────────────

export interface OrderLevel {
  label: string;          // 例「今收 -1.5% 參考價」
  price: number;
  rationale: string;
  style: 'aggressive' | 'standard' | 'conservative' | 'limit';   // legacy 鍵值（舊前端需要）；新前端不顯示徽章
  riskLevel: 'high' | 'medium' | 'low';
}

export interface PreMarketRecommendation {
  todayClose: number;
  prevClose: number;
  todayChangePercent: number;
  expectedOpeningRange: { low: number; high: number; basis: string };
  /** legacy（L20 刪除）：固定 'wait'，舊前端 REC_CONFIG 需要合法鍵 */
  recommendation: 'strong_buy' | 'buy' | 'wait' | 'avoid';
  recommendationText: string;
  optimalOrderTime: string;
  orderLevels: OrderLevel[];
  /** legacy（L20 刪除）：舊前端 .toFixed；新前端只讀 stopRef */
  stopLossPrice: number;
  stopRef: StopRef;
  auctionStrategy: string;
  dayTradingNote: string;
  riskWarning: string;
}

const RISK_WARNING = '以上價位為公式試算（今收或昨收 × 固定倍數），不是預測，也不是買賣建議；判讀欄位依各自來源與資料日顯示。非投資建議。';
const NEXT_DAY_DIR_TEXT = '明日方向：尚無判讀結果（隔日方向模型研究中，未公開）。';

/** 倍數 → 「今收 -1.5% 參考價」（1.0 → 「今收參考價」） */
function orderLevel(anchor: string, close: number, mult: number, style: OrderLevel['style'], riskLevel: OrderLevel['riskLevel']): OrderLevel {
  const price = parseFloat((close * mult).toFixed(2));
  const pctRaw = parseFloat(((mult - 1) * 100).toFixed(2));
  const pctText = pctRaw === 0 ? '' : ` ${pctRaw > 0 ? '+' : '-'}${Math.abs(pctRaw)}%`;
  return {
    label: `${anchor}${pctText} 參考價`,
    price,
    rationale: `公式：${anchor} ${close} × ${mult} = ${price}（固定倍數，非掛單建議）`,
    style,
    riskLevel,
  };
}

function buildPreMarketRecommendation(q: QuoteFacts | null, qc: QuoteContext, todayMove: TodayMove | null): PreMarketRecommendation {
  if (!q || !(q.prevClose > 0)) {
    return {
      todayClose: q?.close ?? 0,
      prevClose: q?.prevClose ?? 0,
      todayChangePercent: 0,
      expectedOpeningRange: { low: 0, high: 0, basis: '當日行情資料不足，不試算。' },
      recommendation: 'wait',
      recommendationText: `${NEXT_DAY_DIR_TEXT}暫時無法取得當日行情。`,
      optimalOrderTime: '',
      orderLevels: [],
      stopLossPrice: 0,
      stopRef: stopRefOf(0, 0),
      auctionStrategy: '',
      dayTradingNote: '',
      riskWarning: RISK_WARNING,
    };
  }
  const { close, prevClose, chgPct } = q;
  const anchor = anchorWord(qc);
  // 開盤參考區間（公式，數值不變）：依今日漲幅分段的固定倍數。漲停段沿用舊式 ≥9.9% 近似（公式照算，不改分段）；
  // 文字寫明「近似漲停」，真漲停但漲幅未達 9.9% 時附註（openRangeBasisText）。
  const isLimitUpApprox = !q.isEsb && chgPct >= OPEN_RANGE_LIMIT_APPROX_PCT;
  const [lo, hi] = isLimitUpApprox ? [0.99, 1.05] : chgPct >= 5 ? [0.985, 1.03] : chgPct >= 2 ? [0.99, 1.02] : [0.98, 1.015];
  const openBasis = openRangeBasisText(lo, hi, {
    anchor, chgPct, limitUpApprox: isLimitUpApprox, limit: q.limit, phase: qc.phase, quoteAsOfMs: qc.quoteAsOfMs,
  });

  // 價格參考（公式，數值不變；舊版的推薦式標籤與文案已改為倍數說明）
  const orderLevels: OrderLevel[] = isLimitUpApprox
    ? [
      orderLevel(anchor, close, 1.02, 'aggressive', 'high'),
      orderLevel(anchor, close, 1.0, 'standard', 'medium'),
      orderLevel(anchor, close, 0.97, 'conservative', 'low'),
    ]
    : chgPct >= 3 && q.closePos != null && q.closePos >= 0.7
    ? [
      orderLevel(anchor, close, 0.99, 'standard', 'medium'),
      orderLevel(anchor, close, 0.975, 'conservative', 'low'),
      orderLevel(anchor, close, 1.005, 'aggressive', 'high'),
    ]
    : [
      orderLevel(anchor, close, 0.985, 'standard', 'medium'),
      orderLevel(anchor, close, 0.97, 'conservative', 'low'),
    ];

  // legacy 停損數字（算法不變；舊前端 .toFixed）。新前端讀 stopRef（公式值 ≥ 今收時不提供，F11）
  const stopLossPrice = parseFloat((prevClose * (chgPct >= 5 ? 0.93 : 0.95)).toFixed(2));

  return {
    todayClose: close,
    prevClose,
    todayChangePercent: parseFloat(chgPct.toFixed(2)),
    expectedOpeningRange: {
      low: parseFloat((close * lo).toFixed(2)),
      high: parseFloat((close * hi).toFixed(2)),
      basis: openBasis,
    },
    recommendation: 'wait',
    recommendationText: `${NEXT_DAY_DIR_TEXT}${todayMove?.text ?? ''}`,
    optimalOrderTime: '',
    orderLevels,
    stopLossPrice,
    stopRef: stopRefOf(close, prevClose, anchor),
    auctionStrategy: '',
    dayTradingNote: '',
    riskWarning: RISK_WARNING,
  };
}

// ─── Company Profile Builder ───────────────────────────────────

export interface CompanyProfile {
  code: string;
  fullName: string;
  shortName: string;
  chairman: string;
  ceo: string;
  spokesperson: string;
  address: string;
  phone: string;
  website: string;                // 官網（空字串＝來源未提供，不要編造）
  email: string;
  fax: string;
  spokespersonTitle: string;
  deputySpokesperson: string;
  englishName: string;
  taxId: string;
  transferAgent: string;
  transferAgentPhone: string;
  accountingFirm: string;
  foundedDate: string;
  listedDate: string;
  capitalAmount: string;
  capitalBillion: number; // in 億
  industryCategory: string;
  industryCode: string;
  /** 官方業務描述尚未接入（L13）：ETF／興櫃／99 為據實說明，其餘為 ''（舊的個股業務資料庫寫錯多檔，已刪） */
  mainBusiness: string;
  keyProducts: string[];
  /** legacy（L20 刪除）：舊 TrendPanel 以它索引物件，null 會崩；新前端改讀 scale */
  companyScale: 'large' | 'mid' | 'small';
  /** 依實收資本額分級（本站規則：≥500 億大型、≥50 億中型）；沒有資本額時 null（不顯示徽章） */
  scale: 'large' | 'mid' | 'small' | null;
  ageYears: number;
  listingAgeYears: number;
  /** live＝上游即時清單；fallback＝打包的官方鏡像快照；none＝公司清單查無（ETF／興櫃／未知） */
  dataSource: CompanyLookup['source'];
  /** 公司資料的來源自報資料日（YYYY-MM-DD）；none 時為 null */
  dataAsOf: string | null;
  /** 用備援時的標示（「備援資料日 YYYY-MM-DD」），即時資料為 '' */
  dataNote: string;
}

// 與 company-list.ts 的 z() 同義；buildCompanyProfile 是獨立函式，不共用區塊層變數
// （CLAUDE.md 記過 dSlash 跨區塊引用被吞成一行警告的教訓）。
const clean = (v: unknown): string => {
  const t = String(v ?? '').replace(/[\s　]+/g, ' ').trim();
  return /^[－—–-]*$/.test(t) ? '' : t;
};

const SCALE_LARGE_BILLION = 500;
const SCALE_MID_BILLION = 50;

function buildCompanyProfile(
  code: string,
  lookup: CompanyLookup,
  industry: IndustryInfo,
  stock: StockDayItem | null
): CompanyProfile {
  const raw = lookup.company;
  const dataNote = fallbackNote(lookup);
  // 用備援時在產業那一行標「備援資料日」：個股頁公司資訊的標頭是「{代號} · {industryCategory}」。
  // industry.name 本身不動（NewsTab 拿它組查詢詞）；結構化欄位另見 dataSource／dataAsOf／dataNote。
  const industryCategory = dataNote ? `${industry.name} · ${dataNote}` : industry.name;
  // ETF 是基金：沒有董事長／總經理／發言人，給 '--'（頁面不渲染），不要顯示「未知」
  const notApplicable = industry.code === 'ETF' ? '--' : '未知';
  const defaultProfile: CompanyProfile = {
    code,
    fullName: stock?.Name || code,
    shortName: stock?.Name || code,
    chairman: notApplicable,
    ceo: notApplicable,
    spokesperson: notApplicable,
    address: '--',
    phone: '--',
    website: '',
    email: '',
    fax: '',
    spokespersonTitle: '',
    deputySpokesperson: '',
    englishName: '',
    taxId: '',
    transferAgent: '',
    transferAgentPhone: '',
    accountingFirm: '',
    foundedDate: '--',
    listedDate: '--',
    capitalAmount: '--',
    capitalBillion: 0,
    industryCategory,
    industryCode: industry.code,
    mainBusiness: getMainBusiness(industry),
    keyProducts: [],
    companyScale: 'mid', // legacy L20：舊 TrendPanel 會以它索引物件；新前端讀 scale（此處為 null）
    scale: null,
    ageYears: 0,
    listingAgeYears: 0,
    dataSource: lookup.source,
    dataAsOf: lookup.asOf,
    dataNote,
  };

  if (!raw) return defaultProfile;

  // Parse capital (e.g. "77231817420" → 772 億)
  const capitalRaw = raw['實收資本額'] || '0';
  const capitalNum = parseInt(capitalRaw.replace(/[^0-9]/g, '')) || 0;
  const capitalBillion = parseFloat((capitalNum / 1e8).toFixed(1));

  // Scale by capital（本站規則：≥500 億大型、≥50 億中型）
  const companyScale: CompanyProfile['companyScale'] =
    capitalBillion >= SCALE_LARGE_BILLION ? 'large' : capitalBillion >= SCALE_MID_BILLION ? 'mid' : 'small';

  // Parse dates
  const foundedRaw = raw['成立日期'] || '';
  const listedRaw = raw['上市日期'] || '';
  const parseROCDate = (d: string) => {
    if (!d) return { display: '--', year: 0 };
    // Remove non-digits first
    const clean = d.replace(/\//g, '').replace(/\D/g, '');
    // TWSE uses YYYMMDD (3-digit ROC year, e.g. 0820501 = ROC 82/05/01 = 1993/05/01)
    // or YYMMDD (6 digits, e.g. 820501)
    if (clean.length === 7) {
      const y = parseInt(clean.substring(0, 3)) + 1911;
      const m = clean.substring(3, 5);
      const day = clean.substring(5, 7);
      return { display: `${y}/${m}/${day}`, year: y };
    } else if (clean.length === 6) {
      const y = parseInt(clean.substring(0, 2)) + 1911;
      const m = clean.substring(2, 4);
      const day = clean.substring(4, 6);
      return { display: `${y}/${m}/${day}`, year: y };
    } else if (clean.length >= 8) {
      // Western year format YYYYMMDD
      const y = parseInt(clean.substring(0, 4));
      const m = clean.substring(4, 6);
      const day = clean.substring(6, 8);
      return { display: `${y}/${m}/${day}`, year: y };
    }
    return { display: '--', year: 0 };
  };
  const founded = parseROCDate(foundedRaw);
  const listed = parseROCDate(listedRaw);
  const currentYear = new Date().getFullYear();

  return {
    code,
    fullName: raw['公司名稱'] || stock?.Name || code,
    shortName: raw['公司簡稱'] || stock?.Name || code,
    chairman: raw['董事長'] || '--',
    ceo: raw['總經理'] || '--',
    spokesperson: raw['發言人'] || '--',
    address: raw['住址'] || '--',
    phone: raw['總機電話'] || '--',
    // ⚠ 只接受 http(s) 開頭：來源偶有「－」或空白佔位，丟給 <a href> 會產生壞連結
    website: /^https?:\/\//i.test(clean(raw['網址'])) ? clean(raw['網址']) : '',
    email: clean(raw['電子郵件信箱']),
    fax: clean(raw['傳真機號碼']),
    spokespersonTitle: clean(raw['發言人職稱']),
    deputySpokesperson: clean(raw['代理發言人']),
    englishName: clean(raw['英文簡稱']),
    taxId: clean(raw['營利事業統一編號']),
    transferAgent: clean(raw['股票過戶機構']),
    transferAgentPhone: clean(raw['過戶電話']),
    accountingFirm: clean(raw['簽證會計師事務所']),
    foundedDate: founded.display,
    listedDate: listed.display,
    capitalAmount: capitalBillion > 0 ? `${capitalBillion} 億元` : '--',
    capitalBillion,
    industryCategory,
    industryCode: industry.code,
    mainBusiness: getMainBusiness(industry),
    keyProducts: [],
    companyScale,
    scale: capitalBillion > 0 ? companyScale : null,
    ageYears: founded.year > 0 ? currentYear - founded.year : 0,
    listingAgeYears: listed.year > 0 ? currentYear - listed.year : 0,
    dataSource: lookup.source,
    dataAsOf: lookup.asOf,
    dataNote,
  };
}

// ─── 主要業務（F27）────────────────────────────────────────────
// 舊版的個股業務資料庫（寫錯多檔：2454 寫成晶圓代工、2303 寫成 DRAM…）、產業業務模板與產品模板全部刪除；
// 官方業務欄位由第二批公司輪廓接入（L13）。這裡只留「不是一般公司／查無」的據實說明。
const NON_COMPANY_BUSINESS: Record<string, string> = {
  ETF: 'ETF 是基金，不是營業公司，沒有主要業務與產品；追蹤指數與成分股請見發行投信的公開說明書。',
  ESB: '興櫃公司：主要業務的官方資料尚未接入本頁（來源未提供）。',
  '99': '主要業務：來源未提供。',
};

function getMainBusiness(industry: IndustryInfo): string {
  return NON_COMPANY_BUSINESS[industry.code] ?? '';
}

// ─── Price Prediction（明日高低點參考：公式試算）────────────────────

export interface PricePrediction {
  // 明日高低點參考（公式）；confidence 舊版寫死 72／58，已移除（null；L20 刪鍵）
  nextDayHigh: { price: number; basis: string; confidence: number | null };
  nextDayLow: { price: number; basis: string; confidence: number | null };
  // 價格參考帶（今收 ±%，公式）；strength 為 legacy 鍵值，新前端不顯示
  resistance: Array<{ price: number; label: string; strength: 'strong' | 'medium' | 'weak' }>;
  support: Array<{ price: number; label: string; strength: 'strong' | 'medium' | 'weak' }>;
  buyZoneHigh: number;
  buyZoneLow: number;
  /** legacy（L20 刪除）：目標價類，新前端不渲染；舊 PremarketTab 未防 null 所以保留數字 */
  targetZoneHigh: number;
  targetZoneLow: number;
  // 今日高低差（佔今收）；不是 ATR、也不是振幅（振幅慣例 ÷昨收）
  atr: number;
  atrPercent: number;
  /** 收盤（或目前）位置 0–100；資料不足為 null（不再給 50） */
  pricePositionScore: number | null;
  positionDescription: string;
}

function buildPricePrediction(code: string, q: QuoteFacts | null, qc: QuoteContext, nextDay: NextDayWords): PricePrediction {
  const defaultResult: PricePrediction = {
    nextDayHigh: { price: 0, basis: '資料不足', confidence: null },
    nextDayLow: { price: 0, basis: '資料不足', confidence: null },
    resistance: [],
    support: [],
    buyZoneHigh: 0,
    buyZoneLow: 0,
    targetZoneHigh: 0,
    targetZoneLow: 0,
    atr: 0,
    atrPercent: 0,
    pricePositionScore: null,
    positionDescription: '收盤位置資料不足',
  };
  if (!q) return defaultResult;
  const { close, high, low } = q;
  const anchor = anchorWord(qc);

  // 今日高低差（佔今收）：高低價不可信（closePosOf 回 null）時不得以 0 冒充，改以下限 1.5% 計
  const rangePct = q.closePos == null ? null : ((high - low) / close) * 100;
  const atr = rangePct == null ? 0 : parseFloat((high - low).toFixed(2));
  const atrPct = rangePct == null ? 0 : parseFloat(rangePct.toFixed(2));
  const effectivePct = Math.max(rangePct ?? 0, 1.5);
  const nextHigh = parseFloat((close * (1 + effectivePct / 2 / 100)).toFixed(2));
  const nextLow = parseFloat((close * (1 - effectivePct / 2 / 100)).toFixed(2));
  const basis = basisText(close, rangePct, { phase: qc.phase, quoteAsOfMs: qc.quoteAsOfMs });

  // 明日漲跌停價（F10）：今收 ×1.1／×0.9 取合法檔位。不列：興櫃（無漲跌停）、盤中（今收未定）、
  // ETF（國外成分 ETF 無漲跌幅限制，本站沒有接入名單 ⇒ 來源未知保守不列；2026-10-08 審查）。
  // 過期時「明日」改成明確日期（nextDay）。
  const limits = q.isEsb || code.startsWith('00') || qc.phase === 'intraday' ? null : nextLimitPrices(close, tickSize);
  const resistance: PricePrediction['resistance'] = [
    { price: parseFloat((close * 1.05).toFixed(2)), label: `${anchor} +5%`, strength: 'medium' as const },
    ...(limits ? [{ price: limits.up, label: `${nextDay.word}漲停價${nextDay.limitSuffix}`, strength: 'strong' as const }] : []),
  ];
  const support: PricePrediction['support'] = [
    { price: parseFloat((close * 0.97).toFixed(2)), label: `${anchor} −3%`, strength: 'strong' as const },
    { price: parseFloat((close * 0.95).toFixed(2)), label: `${anchor} −5%`, strength: 'medium' as const },
    ...(limits ? [{ price: limits.down, label: `${nextDay.word}跌停價${nextDay.limitSuffix}`, strength: 'weak' as const }] : []),
  ];

  const pos = q.closePos;
  const P = pos == null ? null : Math.round(pos * 100);
  const reading = closePosReading(pos, { limit: q.limit, phase: qc.phase, quoteAsOfMs: qc.quoteAsOfMs, dataDate: qc.dataDate, auditOutside: q.auditOutside });
  const positionDescription = P == null
    ? reading.stateText
    : qc.phase === 'intraday'
    ? `盤中${qc.quoteAsOfMs != null ? ` ${hhmmTpe(qc.quoteAsOfMs)}` : ''} 位於日內 ${P}%`
    : qc.phase === 'quote'
    ? `位於日內 ${P}%（${reading.stateText}）`
    : `收盤位於日內 ${P}%（${reading.stateText}）`;

  return {
    nextDayHigh: { price: nextHigh, basis, confidence: null },
    nextDayLow: { price: nextLow, basis, confidence: null },
    resistance,
    support,
    buyZoneHigh: parseFloat((close * 1.00).toFixed(2)),
    buyZoneLow: parseFloat((close * 0.98).toFixed(2)),
    targetZoneHigh: parseFloat((close * 1.12).toFixed(2)),
    targetZoneLow: parseFloat((close * 1.05).toFixed(2)),
    atr,
    atrPercent: atrPct,
    pricePositionScore: P,
    positionDescription,
  };
}
