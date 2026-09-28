import { NextResponse } from 'next/server';
import { latestDoc, cacheHeader } from '@/lib/api-cache';
import { requirePremium } from '@/lib/require-premium';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

    // volJson/prevVolJson 為 daemon 內部用的量能存檔，不需傳給前端
// 2026-08-01：改用 latestDoc。原本手寫的版本**已經有 s-maxage**（先前誤報為 no-store，
// 那個字串只出現在錯誤分支），真正缺的是這三項：
//   ① 行程內 memoize＋in-flight 合流 —— CDN 快取到期那一瞬間的 thundering herd，
//      原本是 N 個併發各讀一次 Firestore，現在同一實例只讀 1 次
//   ② 失敗負快取 —— Firestore 抖動時不會被重打放大
//   ③ stale-if-error —— 上游掛掉時供應舊資料而不是空白（31 支裡 30 支都沒有）
// ⚠ 2026-08-01 補修：latestDoc 轉換時弄丟了原版的欄位剝除——volJson/prevVolJson/
// prevLock/closesHist 是 daemon 內部量能存檔，整包吐給前端是純頻寬浪費。
// 🔒 2026-09-28 WM-SCAN G1-07：選股策略是高級會員功能（含 14 天體驗），原本只在前端擋、API 公開。
//   現在伺服器端驗 token＋會員資格；回應改 private（帶 Authorization 的內容不可進共享 CDN 快取），
//   Firestore 讀取仍由 latestDoc 的行程內 memoize 合流，不隨人數放大。
//   順序：IP 限流（便宜）→ 驗證（verifyIdToken）→ 邏輯（同 wm-edge-gateway 規則）。
export async function GET(request: Request) {
  const limited = await rateLimit(request, 'strategy-picks', 60);
  if (limited) return limited;
  const gate = await requirePremium(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status, headers: { 'Cache-Control': 'no-store' } });
  const res = await latestDoc('strategyPicks', 'intraday', { request, strip: ['volJson', 'prevVolJson', 'prevLock', 'closesHist'] });
  const headers = new Headers(res.headers);
  if (res.ok) headers.set('Cache-Control', cacheHeader('private'));
  return new Response(res.body, { status: res.status, headers });
}
