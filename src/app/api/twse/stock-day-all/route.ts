import { NextRequest, NextResponse } from 'next/server';
import { gzipSync } from 'node:zlib';
import { getStockDayAllDataInternal } from '@/lib/twse-api-server';
import { cacheHeader } from '@/lib/api-cache';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  // 專屬限流（G1-23）：快照缺時會退回打 openapi／TPEx 收盤；前端 30 秒輪詢 ⇒ 240/分鐘很寬，只擋濫用。
  const limited = await rateLimit(request, 'stock-day-all', 240);
  if (limited) return limited;
  try {
    const data = await getStockDayAllDataInternal();
    const misCount = data.filter(d => d._source === 'mis_merged').length;
    console.log(`[stock-day-all] total=${data.length} mis_merged=${misCount} fallback=${data.length - misCount}`);

    // ── 盤中不可以是 no-store（2026-08-12 實測修正；同日改走層級表）──────
    //
    // 原本盤中設 no-store ⇒ CDN 實測連續 x-cache: MISS，646KB 的全站最大 payload
    // 每個使用者每次輪詢都打穿 origin，正面違反「請求數與線上人數脫鉤」不變式。
    // 數值與理由（daemon 掃描 25~32 秒、MIS 5 秒更新、s-maxage=2 為使用者指定的
    // 保守值）都收斂在 api-cache 的 'hot' 層級——**不要在這裡再手寫字串**，
    // CLAUDE.md「Cache-Control 走層級表」就是為了讓策略可以被統一調整。
    // cacheHeader 另外免費多做兩件事：假日 priming（getSession 查休市日曆）、
    // 收盤後自動切長 TTL（14:00–14:31 結算窗除外，修正不會被釘住）。
    const header = cacheHeader('hot');

    const headers: Record<string, string> = {
      'Cache-Control': header,
      'X-Data-Date': data[0]?.Date ?? 'unknown',
      'X-MIS-Merged': misCount.toString(),
    };
    // 手動 gzip：此回應 ~650KB、盤中被高頻輪詢，未壓縮是 Hosting 下載量主因(可省 ~85%)。
    if ((request.headers.get('accept-encoding') || '').includes('gzip')) {
      const gz = gzipSync(Buffer.from(JSON.stringify(data)));
      return new Response(new Uint8Array(gz), { headers: { ...headers, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } });
    }
    return NextResponse.json(data, { headers });
  } catch (error) {
    console.error('TWSE stock-day-all proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch from TWSE API' },
      { status: 500 }
    );
  }
}
