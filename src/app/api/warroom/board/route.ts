import { cacheHeader, unavailable } from '@/lib/api-cache';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { openWarReader } from '@/lib/warroom/reader';
import { buildB1 } from '@/lib/warroom/build-b1';
import { buildFeeds } from '@/lib/warroom/build-feeds';
import { buildNews } from '@/lib/warroom/build-news';
import type { BoardPayload } from '@/lib/warroom/types';

export const runtime = 'nodejs';

// 盤中戰情 v2「慢層」聚合路由（前端 useWarRoomBus 每 60 秒；交易日 08:30–13:45 才輪詢）。
// B1 機會榜、B2 異動流／C1 族群／C2 漲停順序流、今日新聞判別 map。
// 只讀 Firestore（openWarReader），不打任何上游；無 query 參數（B2 不收 ?since=，固定回最近 N 則、前端去重），
// 所有人同一個 URL，CDN 全體共享（quote 層 s-maxage=10）。
// 每個區段各自成敗；全部失敗才回 503＋no-store。
export async function GET() {
  const reader = await openWarReader();
  const [b1, feeds, news] = await Promise.all([buildB1(reader), buildFeeds(reader), buildNews(reader)]);
  if (!b1.ok && !feeds.ok && !news.ok) return unavailable('warroom/board');
  const payload: BoardPayload = { b1, feeds, news, at: reader.now };
  return gzipJsonAuto(payload, { 'Cache-Control': cacheHeader('quote') });
}
