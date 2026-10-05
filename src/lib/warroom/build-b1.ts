// B1 盤中機會榜的伺服器端組裝（路由：/api/warroom/board 的 b1 區段）。
// 做多＝intradayRadar/latest（8 策略合併去重，前 40 檔）；做空＝marketSnapshot/latest（已疊 hot）以 fade-patterns 的
// 轉空型態算 A／B 級（只列可先賣當沖，前 20 檔）。純邏輯在 scripts/lib/warroom-b1.mjs（有單元測試與漂移守門）。
// 只讀 Firestore，不打上游（不得 import twse-api-server／twse-api）。
// ⚠ 只能從 fade-patterns 取 FADE_PATTERNS（規則資料）——不可呼叫 classifyFade：它用的 statusOf 來自 'use client' 模組，
//   在伺服器端是 client reference，一呼叫就丟錯（同口徑流程見 warroom-b1.mjs classifyShortRows）。
//   fade-patterns 在做空分支內才動態載入：它的 import 鏈含 'use client' 模組，萬一打包或載入出狀況，
//   只會讓 b1.short 回「組裝失敗」，不會拖垮整支 /api/warroom/board（B2／C1／C2／新聞同一支路由）。
import type { WarReader } from './reader';
import { asOfOf, errSection, guardSection, okSection, toEpochMs, type Section } from './section';
import { taipeiYmd, warClock } from './session';
import { taipeiMsOf } from '../../../scripts/lib/warroom-feeds.mjs';
import {
  mergeRadar, parseDtCodes, parseAvg20, fadeClockAt, snapToFadeSnaps, classifyShortRows,
  type B1Long, type B1Short,
} from '../../../scripts/lib/warroom-b1.mjs';

export type { B1Long, B1Short, B1LongRow, B1ShortRow, B1Market, B1Limit, FadeTier } from '../../../scripts/lib/warroom-b1.mjs';
export type { RadarStratKey, StratSelect } from '../../../scripts/lib/warroom-b1-view.mjs';

/** board.b1 的資料：做多與做空各自成敗、各自的資料時間（asOf） */
export interface B1Data {
  long: Section<B1Long>;
  short: Section<B1Short>;
}

/** 盤前／試撮清空窗／交易日 08:30 前：不送昨天的榜（前端顯示「09:00 開盤後產生」） */
function isPreOpen(now: number): boolean {
  const c = warClock(now);
  return c.segment === 'pre' || c.segment === 'preclear' || c.beforeOpen;
}

async function buildLong(reader: WarReader, preOpen: boolean): Promise<Section<B1Long>> {
  const r = await reader.doc('intradayRadar', 'latest', 'quote');
  if (!r.ok) return errSection(r.error);
  if (!r.data) return errSection('資料尚未產生');
  const asOf = asOfOf(r.data, ['updatedAt']);
  const merged = mergeRadar(r.data);
  if (preOpen) return okSection<B1Long>({ dataDate: merged.dataDate, rows: [], total: 0 }, asOf);
  return okSection(merged, asOf);
}

async function buildShort(reader: WarReader, preOpen: boolean): Promise<Section<B1Short>> {
  if (preOpen) {
    return okSection<B1Short>({ dataDate: null, rows: [], total: 0, demoted: 0, noonDemote: false, marketOpen: false }, null);
  }
  const [snapR, dtR, avgR] = await Promise.all([
    reader.snapshot(),
    reader.doc('dayTradeEligible', 'latest', 'daily'),
    reader.doc('volAvg20', 'latest', 'daily'),
  ]);
  if (!snapR.ok) return errSection(snapR.error);
  if (!snapR.data) return errSection('資料尚未產生');
  // 只列可先賣當沖：名單讀不到或殘缺就不列（寧缺勿錯；FadeWatch 名單未載入時不過濾，這裡刻意更嚴）
  if (!dtR.ok || !dtR.data) return errSection('當沖資格名單尚未載入');
  const dt = parseDtCodes(dtR.data);
  if (!dt) return errSection('當沖資格名單不完整');
  const avg = avgR.ok ? parseAvg20(avgR.data) : {};
  const snap = snapR.data;
  const marketOpen = !!snap.marketOpen;
  const { hm, frac } = fadeClockAt(reader.now, marketOpen);
  const { FADE_PATTERNS } = await import('@/lib/fade-patterns');
  const res = classifyShortRows(snapToFadeSnaps(snap, avg), {
    hm, frac, marketOpen, patterns: FADE_PATTERNS, dtStatus: (code) => dt.get(code) ?? 0,
  });
  // 資料日＝快照自報的 dataDate（daemon boardDataDate；非交易日＝最後交易日）。sweepAt 只是寫入時刻（盤外每 5 分鐘、週末也重寫），
  // 不可拿來當資料日。盤中 asOf＝sweepAt；收盤後＝資料日 13:30 與 sweepAt 取早（內容是收盤那一刻的，同 build-feeds closeAsOf）。
  const sweepAt = toEpochMs(snap.sweepAt);
  const dataDate = snap.dataDate ?? (marketOpen && sweepAt != null ? taipeiYmd(sweepAt) : null);
  const close = dataDate ? taipeiMsOf(dataDate, '13:30') : null;
  const asOf = marketOpen || close == null ? sweepAt : sweepAt == null ? close : Math.min(close, sweepAt);
  return okSection<B1Short>({ dataDate, ...res, marketOpen }, asOf);
}

export async function buildB1(reader: WarReader): Promise<Section<B1Data>> {
  return guardSection('b1', async () => {
    const preOpen = isPreOpen(reader.now);
    const [long, short] = await Promise.all([
      guardSection('b1.long', () => buildLong(reader, preOpen)),
      guardSection('b1.short', () => buildShort(reader, preOpen)),
    ]);
    // 兩邊都失敗才整段失敗（前端匯流排會沿用上一份成功的 b1）
    if (!long.ok && !short.ok) return errSection<B1Data>(long.error);
    return okSection<B1Data>({ long, short }, long.ok ? long.asOf : short.asOf);
  });
}
