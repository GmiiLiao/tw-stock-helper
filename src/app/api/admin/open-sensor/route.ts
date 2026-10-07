import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { openWarReader } from '@/lib/warroom/reader';
import { buildOpenSensor } from '@/lib/warroom/build-open-sensor';

// ── 開盤感應器（openSensor-v2.1·影子）**超級管理員專用·唯讀** ─────────────────────────
// 戰情 v2 匯流排的「影子層」讀這支（交易日 08:55–10:15 每 30 秒；其餘時間掛載時一次）。
// 影子資料不放進公開、CDN 共享的 /api/warroom/pulse、/board（規格 v2.1 §9.1）：一律 private, no-store，含錯誤分支。
// 只讀 Firestore（openWarReader：memoize 5 秒級＋合流＋負快取），0 上游請求。組裝在 src/lib/warroom/build-open-sensor.ts。
//   GET ?date=YYYY-MM-DD（省略＝今天是交易日用今天，否則最後交易日）
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OWNER = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'nicholas@gmii.tw';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

export async function GET(request: Request) {
  const g = await requireAdmin(request);
  if (!g.ok) return fail(g.error, g.status);
  if (g.level !== 'superadmin' && g.email !== OWNER) return fail('僅限超級管理員', 403);
  const want = new URL(request.url).searchParams.get('date');
  try {
    const reader = await openWarReader();
    const r = await buildOpenSensor(reader, want);
    if (!r.ok) return fail(r.error, r.status);
    return gzipJsonAuto(r.payload, NO_STORE);
  } catch (e) {
    console.error('[admin/open-sensor] 組裝失敗', e instanceof Error ? e.message : e);
    return fail('組裝失敗', 500);
  }
}
