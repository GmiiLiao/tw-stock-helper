// 開盤感應器（openSensor-v2.1·影子）的伺服器端組裝（路由：/api/admin/open-sensor，超管專用·private no-store）。
// ⚠ 影子資料**不放進** /api/warroom/pulse、/board（不需登入、CDN 共享；規格 v2.1 §9.1 審查修正）——build-top 不讀 openSensor。
// 只讀 Firestore（reader：每路徑 memoize＋合流＋負快取），0 上游請求。
//   openSensor/{date}            今天 10:06 前 quote 層（5 秒）；之後 slow（定格後只剩盤後 post 會補寫）；過去日 daily
//   openSensorUniverse/{date}    名單存證摘要（codesJson 不送前端）
//   openSensorMeta/threshold     門檻 H 區段表
//   openSensorStats/outside      「不在狀態內」計次
// 看板日期：?date=YYYY-MM-DD；省略＝今天是交易日用今天，否則最後交易日（休市日曆由 openWarReader 先填好）。
import { isTradingYmd } from '@/lib/market-clock';
import type { WarReader, DocRead, ReadTier } from './reader';
import { taipeiYmd } from './session';
import { taipeiMinuteOfDay } from '../../../scripts/lib/warroom-session.mjs';
import {
  normalizeOpenSensor, summarizeOsUniverse, normalizeOsThreshold, normalizeOsOutsideStats, resolveBoardYmd, OS_TIMES,
  type OpenSensorPayload,
} from '../../../scripts/lib/warroom-open-sensor.mjs';

export type { OpenSensorPayload } from '../../../scripts/lib/warroom-open-sensor.mjs';

export const OS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 10:06 之後今天的文件改慢層快取（indexRing 10:03:30、逾時定格 10:05 都已寫完；盤後 post 晚 20 秒出現無妨） */
const SLOW_AFTER_MINUTE = OS_TIMES.timeoutFreeze + 1;

export type OpenSensorBuild =
  | { ok: true; payload: OpenSensorPayload }
  | { ok: false; status: 400 | 502; error: string };

const dataOf = (r: DocRead): Record<string, unknown> | null => (r.ok ? r.data : null);

/** want：呼叫端給的 ?date（已是字串或 null）。主文件讀取故障回 502（前端匯流排保留上一份）；其餘來源故障記進 failed。 */
export async function buildOpenSensor(reader: WarReader, want: string | null): Promise<OpenSensorBuild> {
  if (want !== null && !OS_DATE_RE.test(want)) return { ok: false, status: 400, error: 'date 格式應為 YYYY-MM-DD' };
  const today = taipeiYmd(reader.now);
  const date = want ?? resolveBoardYmd(today, isTradingYmd);
  if (!date) return { ok: false, status: 502, error: '找不到最後交易日' };
  const isToday = date === today;
  const docTier: ReadTier = !isToday ? 'daily' : taipeiMinuteOfDay(reader.now) < SLOW_AFTER_MINUTE ? 'quote' : 'slow';
  const [docR, uniR, thR, stR] = await Promise.all([
    reader.doc('openSensor', date, docTier),
    reader.doc('openSensorUniverse', date, isToday ? 'slow' : 'daily'),
    reader.doc('openSensorMeta', 'threshold', 'slow'),
    reader.doc('openSensorStats', 'outside', 'slow'),
  ]);
  if (!docR.ok) return { ok: false, status: 502, error: '讀取失敗' };
  const failed: string[] = [];
  if (!uniR.ok) failed.push('名單存證');
  if (!thR.ok) failed.push('門檻');
  if (!stR.ok) failed.push('計次');
  const doc = normalizeOpenSensor(dataOf(docR));
  return {
    ok: true,
    payload: {
      at: reader.now,
      date,
      today,
      tradingToday: isTradingYmd(today),
      doc: doc && doc.date === date ? doc : null,
      universe: summarizeOsUniverse(dataOf(uniR)),
      threshold: normalizeOsThreshold(dataOf(thR)),
      outsideStats: normalizeOsOutsideStats(dataOf(stR)),
      failed,
    },
  };
}
