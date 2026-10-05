import { cacheHeader, unavailable } from '@/lib/api-cache';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { openWarReader } from '@/lib/warroom/reader';
import { buildTop } from '@/lib/warroom/build-top';
import { buildFocus } from '@/lib/warroom/build-focus';
import type { PulsePayload } from '@/lib/warroom/types';

export const runtime = 'nodejs';

// 盤中戰情 v2「中層」聚合路由（前端 useWarRoomBus 每 30 秒；交易日 08:30–13:45 才輪詢）。
// 只讀 Firestore（openWarReader：每路徑 memoize 2–5 秒＋合流＋負快取），不打任何上游——請求數與線上人數脫鉤。
// 無 query 參數：所有人同一個 URL，CDN 全體共享（tick 層 s-maxage=3）。
// 每個區段各自成敗（Section）：一塊失敗回 ok:false，不拖垮整支；全部失敗才回 503＋no-store（不把故障釘在 CDN 上）。
export async function GET() {
  const reader = await openWarReader();
  const [top, focus] = await Promise.all([buildTop(reader), buildFocus(reader)]);
  if (!top.ok && !focus.ok) return unavailable('warroom/pulse');
  const payload: PulsePayload = { top, focus, at: reader.now };
  return gzipJsonAuto(payload, { 'Cache-Control': cacheHeader('tick') });
}
