import { gzipSync } from 'node:zlib';
import { headers } from 'next/headers';

// 手動 gzip JSON 回應：frameworksBackend(Cloud Run)不會自動壓縮，
// 大 payload(K線、快照)未壓縮是 Hosting 下載量主因。JSON 通常可省 ~75%。
export function gzipJson(request: Request, data: unknown, cacheControl: string): Response {
  const body = JSON.stringify(data);
  const base: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': cacheControl };
  if ((request.headers.get('accept-encoding') || '').includes('gzip')) {
    const gz = gzipSync(Buffer.from(body));
    return new Response(new Uint8Array(gz), { headers: { ...base, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } });
  }
  return new Response(body, { headers: base });
}

// 2026-09-18 Hosting 下載量事故：62 支 route 用 NextResponse.json，Cloud Run 前面**沒有任何一層會壓縮**，
// market-snapshot 308KB／ai-recommend 232KB 原樣送出，戰情室每 10 秒一份 ⇒ 單一分頁一個交易日 ~500MB。
// 不帶 request 的呼叫端（latestDoc 12 支、各 route）改用這支：從 next/headers 讀 accept-encoding。
// 第二參數可給 Cache-Control 字串，或整個 headers 物件（route 普查要看得到 'Cache-Control' 宣告）。
export async function gzipJsonAuto(data: unknown, cacheControl: string | Record<string, string>, extra: Record<string, string> = {}): Promise<Response> {
  const body = JSON.stringify(data);
  const cc = typeof cacheControl === 'string' ? { 'Cache-Control': cacheControl } : cacheControl;
  const base: Record<string, string> = { 'Content-Type': 'application/json', ...cc, ...extra };
  let accept = '';
  try { accept = (await headers()).get('accept-encoding') || ''; } catch { accept = ''; }
  if (accept.includes('gzip')) {
    const gz = gzipSync(Buffer.from(body));
    return new Response(new Uint8Array(gz), { headers: { ...base, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } });
  }
  return new Response(body, { headers: base });
}
