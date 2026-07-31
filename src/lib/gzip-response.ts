import { gzipSync } from 'node:zlib';

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
