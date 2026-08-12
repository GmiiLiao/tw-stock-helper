import { NextRequest, NextResponse } from 'next/server';
import { gzipSync } from 'node:zlib';
import { getStockDayAllDataInternal, isMarketOpen } from '@/lib/twse-api-server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const data = await getStockDayAllDataInternal();
    const misCount = data.filter(d => d._source === 'mis_merged').length;
    console.log(`[stock-day-all] total=${data.length} mis_merged=${misCount} fallback=${data.length - misCount}`);

    // ── 盤中不可以是 no-store（2026-08-12 實測修正）────────────────────
    //
    // 這支回應約 646KB，是全站最大的 payload，而且盤中被前端高頻輪詢。
    // 原本盤中設 `no-store` ⇒ CDN 實測 `x-cache: MISS`（連續三次全 MISS），
    // 也就是**每一個使用者、每一次輪詢都打穿到 origin**。
    // 這正面違反「對上游/origin 的請求數必須與線上人數脫鉤」那條不變式，
    // 也是 maxInstances 5×80=400 in-flight 這個天花板最快被撞破的地方。
    //
    // no-store 換不到任何新鮮度：
    //   · 資料來源本身就有 5 秒的 instance 記憶體快取（market-snapshot-store）
    //   · daemon 的掃描週期實測 25~32 秒
    //   · MIS 本身 5 秒才更新一次（CLAUDE.md 硬約束：輪詢快過 5 秒沒有資訊增益）
    // 取 s-maxage=2（保守值，使用者指定）：落後量遠小於資料本身的更新週期，
    // 卻已能把 N 個同時在線的使用者收斂成每 2 秒 1 次 origin 取用。
    // stale-while-revalidate 讓過期瞬間仍由邊緣供應、背景更新，不會出現延遲尖峰。
    // 若日後要再往上調，先確認 AlertEngine 的價格警示可接受的延遲。
    //
    // 這份回應對所有使用者完全相同（全市場清單，無個人化），共用快取是安全的。
    const marketOpen = isMarketOpen();
    const cacheHeader = marketOpen
      ? 'public, s-maxage=2, stale-while-revalidate=20'
      : 'public, s-maxage=120, stale-while-revalidate=60';

    const headers: Record<string, string> = {
      'Cache-Control': cacheHeader,
      'Access-Control-Allow-Origin': '*',
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
