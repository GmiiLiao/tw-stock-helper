import { NextRequest, NextResponse } from 'next/server';
import { getStockNews, FREE_SOURCES, POLICY_SOURCES } from '@/lib/news-server';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

// 代號：4~6 碼數字，允許一個尾碼字母（00631L／00632R 等槓反 ETF；同 candles route 口徑）。
const CODE_RE = /^\d{4,6}[A-Za-z]?$/;
// name／industry 由呼叫端帶入、直接拼進 Google News 查詢字串，也是快取鍵的一部分（G1-02）：
//   不設限 ⇒ 每組新字串都打穿 CDN、在 instance 快取開新 key、並對上游扇出最多 11 次。
//   正規股名／產業名最長約 10 字；上限 20 字保留餘裕。
const MAX_TEXT_LEN = 20;
// 每 IP 每分鐘（只計 CDN miss 打到 origin 的請求）。daemon 從單一 IP 逐檔順序呼叫
// （新聞 wiki 最多 40 檔＋持股／波段分析），一次 miss 需數秒，60 足以容納。
const RATE_LIMIT_PER_MIN = 60;

/**
 * 正規化呼叫端文字：只留文字／數字／組合記號與股名常見符號（-*&+.·），收斂空白、截長。
 * 目的是擋 Google 查詢運算子（site:、引號、括號、OR 群組）與無界快取鍵；
 * 正常股名（台積電、康控-KY、國巨*、統一FANG+）與產業名不受影響。
 */
function normaliseText(raw: string | null): string {
  return (raw || '')
    .replace(/[^\p{L}\p{N}\p{M}\s\-*&+.·]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LEN)
    .trim();
}

/** GET /api/twse/stock-news?code=2330&name=台積電&industry=半導體 */
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, 'stock-news', RATE_LIMIT_PER_MIN);
  if (limited) return limited;

  const { searchParams } = request.nextUrl;
  const code = (searchParams.get('code') || '').trim();
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  if (!CODE_RE.test(code)) return NextResponse.json({ error: 'invalid code' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  const name = normaliseText(searchParams.get('name'));
  const industry = normaliseText(searchParams.get('industry'));

  const news = await getStockNews(code, name, industry);
  return NextResponse.json(
    {
      news, code, industry,
      sources: [...FREE_SOURCES.map(s => s.label), ...POLICY_SOURCES.map(s => s.label)],
      fetchedAt: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60', 'Access-Control-Allow-Origin': '*' } },
  );
}
