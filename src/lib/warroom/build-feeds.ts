// B2 即時異動流、C1 族群資金、C2 漲停順序流 的伺服器端組裝（路由：/api/warroom/board 的 feeds 區段）。
// 只讀 Firestore（reader），不打上游；不得 import twse-api-server／twse-api／risk-stocks-source／任何 components。
// 純邏輯全在 scripts/lib/warroom-feeds.mjs（有單元測試）；這裡只負責「讀哪幾份文件、各自的資料時間、各區段成敗」。
//
// 三個子區段各自帶 asOf（族群約 3.5 分一輪、漲停流與爆量約 60–90 秒一輪，節奏不同），各自成敗：
//   events     B2：爆量急拉急殺（volSurge／當日歸檔）、首觸漲停（漲停流）、雷達新進共識（intradayRadar）、
//              搶漲停排隊（limitQueue，09:00–09:15；專注模式不掛全頁排隊警示，由這裡承接）、
//              新聞判別（newsVerdict，M：今日盤中趟 AI 讀內文的利多／利空，權重同盤後報告、研究期·只顯示、不以權重篩選；
//              解析與規範強制在 warroom-news.mjs，與 board.news 區段共用同一份記憶化精簡表）、重訊（mopsNews，O）
//              ——合併後固定回最近 40 則（不收 ?since=，前端去重累積）。
//              另附 index（每檔最新一則重訊），讓前端用使用者自己的持股補出「我的」重訊；「我的」新聞判別由前端從 board.news 產生。
//   sectors    C1：marketWind/latest 的題材（成交值加權漲跌、成交占比）；觸及漲停家數＝題材成分股 ∩ 今日漲停流（檔位口徑）。
//   limitFlow  C2：limitUpForecast/live 的 flow（首次觸及漲停的時間序；不追蹤開板，第二階段）。
// 沒有 daemon 文件的事件類型（首觸跌停、新增處置）不產生——寫在前端頁尾與交付說明，不捏造。
import type { WarReader, DocData, DocRead } from './reader';
import { asOfOf, errSection, guardSection, okSection, type Section } from './section';
import { taipeiYmd } from './session';
import {
  buildThemeIndex, buildSectorRows, sectorSummary, buildLimitFlow, surgeEvents, limitTouchEvents, consensusEvents, queueEvents,
  mopsEvents, mergeServerEvents, fillNames, normYmd, taipeiMsOf,
  type FeedEvent, type FeedCodeIndex, type SectorRow, type SectorSummary, type LimitFlowPayload, type ThemeIndex,
} from '../../../scripts/lib/warroom-feeds.mjs';
import { b2MarketNewsEvents, activeNewsCodes } from '../../../scripts/lib/warroom-news.mjs';
import { newsBoardOf } from './build-news';

export type { FeedEvent, FeedKind, FeedCodeIndex, SectorRow, SectorSummary, LimitFlowRow, LimitFlowPayload } from '../../../scripts/lib/warroom-feeds.mjs';

/** B2 */
export interface FeedEventsData {
  /** 最近 40 則（新到舊） */
  items: FeedEvent[];
  /** 市場事件來源（爆量／雷達／漲停流）的最新資料時間——盤中資料章看這個，避免「重訊很新」掩蓋「盤中事件停更」 */
  marketAsOf: number | null;
  /** 每檔最新一則重訊（前端補「我的」事件用） */
  index: FeedCodeIndex;
  /** 這一輪讀取失敗的來源（畫面註明「部分來源讀取失敗」；文件不存在不算） */
  failed: string[];
}

/** C1 */
export interface SectorsData {
  rows: SectorRow[];
  summary: SectorSummary | null;
  /** 風向資料日（YYYY-MM-DD；daemon 自報） */
  dataDate: string | null;
  marketOpen: boolean;
  /** 有沒有讀到題材成分股對照（沒有時「我的族群」只能用領漲股比對） */
  mapped: boolean;
}

/** C2 */
export type LimitFlowData = LimitFlowPayload;

export interface FeedsData {
  events: Section<FeedEventsData>;
  sectors: Section<SectorsData>;
  limitFlow: Section<LimitFlowData>;
}

type Doc = DocData | null;
const MISSING = '資料尚未產生';
const READ_FAIL = '讀取失敗';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const docOf = (r: DocRead): Doc => (r.ok ? r.data : null);
const maxOf = (...xs: (number | null | undefined)[]): number | null => {
  const ok = xs.filter(isNum);
  return ok.length ? Math.max(...ok) : null;
};

/** 題材成分股對照（themeMap/seed＋custom；約 40 條鏈、一兩百檔，每次重建成本可忽略） */
function themeIndexOf(seed: Doc, custom: Doc): ThemeIndex | null {
  if (!seed && !custom) return null;
  const idx = buildThemeIndex(seed?.chains, custom?.chains);
  return idx.themes.length ? idx : null;
}

/** 收盤後的資料：資料時間記為資料日 13:30（daemon 盤後仍會重算 updatedAt，但內容是收盤那一刻的） */
function closeAsOf(ymd: string | null, updatedAt: number | null): number | null {
  const close = ymd ? taipeiMsOf(ymd, '13:30') : null;
  if (close == null) return updatedAt;
  return updatedAt == null ? close : Math.min(close, updatedAt);
}

function buildLimitFlowSection(luRead: DocRead, themes: ThemeIndex | null, windOrder: string[]): Section<LimitFlowData> {
  if (!luRead.ok) return errSection(READ_FAIL);
  const lu = luRead.data;
  if (!lu) return errSection(MISSING);
  const flow = buildLimitFlow(lu, themes, windOrder);
  const updatedAt = asOfOf(lu, ['updatedAt']);
  const asOf = lu.mode === 'live' ? updatedAt : closeAsOf(flow.flowDate, updatedAt);
  return okSection<LimitFlowData>(flow, asOf);
}

function buildSectorsSection(windRead: DocRead, themes: ThemeIndex | null, flow: LimitFlowData | null): Section<SectorsData> {
  if (!windRead.ok) return errSection(READ_FAIL);
  const wind = windRead.data;
  if (!wind) return errSection(MISSING);
  const dataDate = normYmd(wind.dataDate) ?? normYmd(wind.date);
  // 觸及漲停家數只在「漲停流與風向是同一個資料日」時才給（盤前風向是前一交易日、漲停流已換日 ⇒ 不湊）
  const touched = flow && flow.flowDate && flow.flowDate === dataDate ? new Set(flow.rows.map((r) => r.code)) : null;
  const rows = buildSectorRows(wind, themes, touched);
  const marketOpen = wind.marketOpen === true;
  const updatedAt = asOfOf(wind, ['updatedAt']);
  return okSection<SectorsData>(
    { rows, summary: sectorSummary(wind, rows), dataDate, marketOpen, mapped: themes != null },
    marketOpen ? updatedAt : closeAsOf(dataDate, updatedAt),
  );
}

interface EventSources {
  ymd: string;
  now: number;
  surge: DocRead; archive: DocRead; radar: DocRead; verdict: DocRead; mops: DocRead; queue: DocRead;
  flow: LimitFlowData | null;
  flowFailed: boolean;
}

function buildEventsSection(s: EventSources): Section<FeedEventsData> {
  const failed: string[] = [];
  const note = (r: DocRead, label: string) => { if (!r.ok) failed.push(label); };
  note(s.surge, '爆量'); note(s.radar, '雷達'); note(s.verdict, '新聞判別'); note(s.mops, '重訊'); note(s.queue, '排隊');
  if (s.flowFailed) failed.push('漲停流');
  if (failed.length >= 6) return errSection(READ_FAIL);

  const surge = docOf(s.surge), archive = docOf(s.archive), radar = docOf(s.radar), verdict = docOf(s.verdict), mops = docOf(s.mops);
  const surgeEv = surgeEvents(surge, archive, s.ymd);
  const limitEv = limitTouchEvents(s.flow, s.ymd);
  const radarEv = consensusEvents(radar, s.ymd);
  const queueEv = queueEvents(docOf(s.queue), s.ymd);
  const board = newsBoardOf(verdict);
  const newsEv = b2MarketNewsEvents(board, { todayYmd: s.ymd });

  // 重訊只列「今日有動靜」的代號（漲停流、雷達、爆量、新聞判別），整批營收公告不淹沒異動流
  const active = new Set<string>();
  for (const e of [...surgeEv, ...limitEv, ...radarEv, ...queueEv]) active.add(e.code);
  if (radar && normYmd(radar.date) === s.ymd && radar.groups && typeof radar.groups === 'object') {
    for (const list of Object.values(radar.groups as Record<string, unknown>)) {
      if (Array.isArray(list)) for (const it of list) if (it && typeof (it as { code?: unknown }).code === 'string') active.add((it as { code: string }).code);
    }
  }
  for (const code of activeNewsCodes(board, s.ymd)) active.add(code);
  const mo = mopsEvents(mops, s.ymd, active);

  const names = new Map<string, string>();
  for (const e of [...surgeEv, ...limitEv, ...radarEv, ...queueEv, ...mo.events]) if (e.name && e.name !== e.code) names.set(e.code, e.name);
  const items = fillNames(mergeServerEvents([surgeEv, limitEv, radarEv, queueEv, newsEv, mo.events]), names);

  const today = (d: Doc) => (d && normYmd(d.date) === s.ymd ? asOfOf(d, ['updatedAt']) : null);
  const marketAsOf = maxOf(today(surge), today(radar), queueEv.length ? queueEv[0].at : null,
    s.flow && s.flow.flowDate === s.ymd ? maxOf(...s.flow.rows.map((r) => r.at)) : null);
  const asOf = maxOf(marketAsOf, asOfOf(verdict, ['updatedAt']), asOfOf(mops, ['updatedAt']));
  return okSection<FeedEventsData>({ items, marketAsOf, index: { mops: mo.index }, failed }, asOf);
}

export async function buildFeeds(reader: WarReader): Promise<Section<FeedsData>> {
  return guardSection('feeds', async () => {
    const ymd = taipeiYmd(reader.now);
    const [surge, archive, radar, lu, verdict, mops, wind, seed, custom, queue] = await Promise.all([
      reader.doc('volSurge', 'latest', 'quote'),
      reader.doc('volSurgeArchive', ymd, 'slow'),   // 約 200KB、只取當日量增最大幾檔當歷史 ⇒ 20 秒層即可
      reader.doc('intradayRadar', 'latest', 'quote'),
      reader.doc('limitUpForecast', 'live', 'quote'),
      reader.doc('newsVerdict', 'latest', 'slow'),
      reader.doc('mopsNews', 'latest', 'slow'),
      reader.doc('marketWind', 'latest', 'slow'),
      reader.doc('themeMap', 'seed', 'daily'),
      reader.doc('themeMap', 'custom', 'daily'),
      reader.doc('limitQueue', 'latest', 'quote'),   // 小文件（≤30 檔）；只在 09:00–09:15 產生事件
    ]);
    const themes = themeIndexOf(docOf(seed), docOf(custom));
    const windDoc = docOf(wind);
    const windOrder = Array.isArray(windDoc?.themes)
      ? (windDoc.themes as { key?: unknown }[]).map((t) => (typeof t?.key === 'string' ? t.key : '')).filter(Boolean)
      : [];

    const limitFlow = buildLimitFlowSection(lu, themes, windOrder);
    const flow = limitFlow.ok ? limitFlow.data : null;
    const sectors = buildSectorsSection(wind, themes, flow);
    const events = buildEventsSection({ ymd, now: reader.now, surge, archive, radar, verdict, mops, queue, flow, flowFailed: !lu.ok });

    if (!events.ok && !sectors.ok && !limitFlow.ok) return errSection<FeedsData>(READ_FAIL);
    return okSection<FeedsData>({ events, sectors, limitFlow }, maxOf(events.asOf, sectors.asOf, limitFlow.asOf));
  });
}
