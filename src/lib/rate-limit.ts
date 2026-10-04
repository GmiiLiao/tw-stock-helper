// ============================================================
// Per-IP 速率限制（wm-security-model「sliding-window rate limiting」）
//
// 保護對象不是「所有 route」—— 多數 GET 已有 CDN s-maxage 擋著，重複請求
// 打不到 origin。真正要限的是兩類：
//   ① 扇出上游的（yahoo-quote/candles/history…）：每次呼叫放大成多次
//      Yahoo/TWSE 請求，違反唯一不變式的攻擊面就在這裡。
//   ② 昂貴或敏感的操作（ai-analysis trigger：Ollama＋多路外抓）。
//
// 後端兩段式：
//   • 有 UPSTASH_REDIS_REST_URL/TOKEN → Upstash 固定窗（INCR+PEXPIRE），
//     跨 instance 全域一致。帳號要你自己開（免費層即可），填進 .env 就自動啟用。
//   • 沒有 → in-memory 滑動窗。**誠實界定**：maxInstances=5 之下每個 instance
//     各數各的，有效上限≈設定值×5 —— 仍是真實的濫用天花板（單一攻擊來源
//     通常黏在同一 instance），只是不精確。wm-multi-tier-cache 稱這種為
//     「Isolate-local fallback（有界 Map + TTL）」：橋接沒有 Redis 的日子。
//
// 失敗語意：限制器自身故障一律 fail-open（放行）——
// 讀端點的可用性優先於精確限流；真要 fail-closed 的是授權，不是限流。
// ============================================================

import { NextResponse } from 'next/server';

const WINDOW_MS = 60_000;
const MAX_KEYS = 20_000;               // 有界 Map：防「大量偽造 IP 撐爆記憶體」
const buckets = new Map<string, number[]>();

/** 限流與「每來源配額」共用的 client 鍵（live-requests-store 也用；改這裡前先驗 XFF 拓撲，見記憶 tw_stock_xff_topology）。 */
export function clientIp(request: Request): string {
  // Firebase Hosting → Cloud Run：x-forwarded-for 第一跳是真實 client
  const xff = request.headers.get('x-forwarded-for') || '';
  return xff.split(',')[0].trim() || 'unknown';
}

function memoryHit(key: string, limit: number): { ok: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) {
    // 有界：超過上限就把最舊的 5% 淘汰（Map 迭代序＝插入序）
    if (buckets.size >= MAX_KEYS) {
      let n = MAX_KEYS / 20;
      for (const k of buckets.keys()) { buckets.delete(k); if (--n <= 0) break; }
    }
    arr = [];
    buckets.set(key, arr);
  }
  // 滑動窗：丟掉窗外的時間戳
  while (arr.length && now - arr[0] > WINDOW_MS) arr.shift();
  if (arr.length >= limit) {
    return { ok: false, remaining: 0, resetMs: WINDOW_MS - (now - arr[0]) };
  }
  arr.push(now);
  return { ok: true, remaining: limit - arr.length, resetMs: WINDOW_MS };
}

async function upstashHit(key: string, limit: number): Promise<{ ok: boolean; remaining: number; resetMs: number } | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    // 固定窗（INCR + 首次設 TTL）：比滑動窗粗，但單次往返、夠用。
    const win = Math.floor(Date.now() / WINDOW_MS);
    const k = `rl:${key}:${win}`;
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([["INCR", k], ["PEXPIRE", k, String(WINDOW_MS), "NX"]]),
      signal: AbortSignal.timeout(1500),   // 限流器不能反過來拖慢請求
    });
    if (!r.ok) return null;
    const j = await r.json();
    const count = Number(j?.[0]?.result ?? 0);
    return { ok: count <= limit, remaining: Math.max(0, limit - count), resetMs: WINDOW_MS - (Date.now() % WINDOW_MS) };
  } catch (e) { console.error('[rateLimit] Upstash 故障，退回 in-memory', (e as Error)?.message); return null; }
}

/**
 * 回傳 null＝放行；回傳 Response＝429（呼叫端直接 return 它）。
 *
 *   const limited = await rateLimit(request, 'yahoo-quote', 30);
 *   if (limited) return limited;
 */
export async function rateLimit(request: Request, name: string, limit: number): Promise<Response | null> {
  try {
    const key = `${name}:${clientIp(request)}`;
    const hit = (await upstashHit(key, limit)) ?? memoryHit(key, limit);
    if (hit.ok) return null;
    const retrySec = Math.ceil(hit.resetMs / 1000);
    return NextResponse.json(
      { error: 'rate limited', retryAfter: retrySec },
      {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',          // 429 絕不能被 CDN 快取
          'Retry-After': String(retrySec),
          // IETF draft rate-limit headers（wm-security-model：降級要可觀測）
          'RateLimit-Limit': String(limit),
          'RateLimit-Remaining': '0',
          'RateLimit-Reset': String(retrySec),
        },
      },
    );
  } catch (e) {
    // fail-open（使用者 2026-09-28 定案：限流故障不阻擋請求），但要留 log——降級要可觀測
    console.error('[rateLimit] 限流器故障，放行', name, (e as Error)?.message);
    return null;
  }
}
