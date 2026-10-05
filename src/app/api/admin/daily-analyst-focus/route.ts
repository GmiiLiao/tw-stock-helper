import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader } from '@/lib/api-cache';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { memoize } from '@/lib/singleflight';

// ── 資料觀察名單（AI 分析師團隊·管理員專用·唯讀）──────────────────────────────
// dailyAnalystFocus/latest：含 cards[].focus.stocks 與對應 refTable，由 scripts/publish-daily-analyst.mjs 寫入
// （客戶端規則預設拒絕，只能經此 API 讀）。研究期（對答案累積 ≥20 交易日前）個股名單不對一般使用者公開，分析文字走公開
// /api/twse/daily-analyst。回應 Cache-Control: private（管理員私有資料，不進 CDN）；讀取以 memoize 合流，次數與人數脫鉤。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/** Firestore Timestamp → ISO 字串；其餘值原樣（只處理頂層，文件內文是純 JSON）。 */
function plain(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    const v = data[k] as { toDate?: () => Date } | null;
    out[k] = v && typeof v === 'object' && typeof v.toDate === 'function' ? v.toDate().toISOString() : data[k];
  }
  return out;
}

// 包一層 { doc }：memoize 失敗時回 null——要分得出「讀取失敗」與「還沒發佈（doc=null）」
const readFocus = memoize<{ doc: Record<string, unknown> | null }>('daily-analyst-focus', 60_000, async () => {
  const db = getAdminDb();
  if (!db) throw new Error('DB unavailable');
  const snap = await db.collection('dailyAnalystFocus').doc('latest').get();
  return { doc: snap.exists ? plain(snap.data() ?? {}) : null };
}, { timeoutMs: 15_000 });

// 放行前管理員審閱用：同樣的公開分析文字文件（dailyAnalyst/latest，不含個股名單），不經 CDN、private 快取
const readAnalysis = memoize<{ doc: Record<string, unknown> | null }>('daily-analyst-admin-analysis', 60_000, async () => {
  const db = getAdminDb();
  if (!db) throw new Error('DB unavailable');
  const snap = await db.collection('dailyAnalyst').doc('latest').get();
  return { doc: snap.exists ? plain(snap.data() ?? {}) : null };
}, { timeoutMs: 15_000 });

export async function GET(request: Request) {
  const g = await requireAdmin(request);
  if (!g.ok) return fail(g.error, g.status);
  const wantAnalysis = new URL(request.url).searchParams.get('doc') === 'analysis';
  try {
    const got = wantAnalysis ? await readAnalysis() : await readFocus();
    if (!got) return fail('讀取資料觀察名單失敗', 503);
    // 下載資料一律壓縮（Cloud Run 前無自動 gzip）
    return gzipJsonAuto(got.doc ?? { found: false }, { 'Cache-Control': cacheHeader('private') });
  } catch (e) {
    console.error('[daily-analyst-focus] 讀取失敗', e);
    return fail('讀取資料觀察名單失敗', 500);
  }
}
