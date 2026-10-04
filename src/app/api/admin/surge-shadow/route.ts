import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJsonAuto } from '@/lib/gzip-response';

// ── 🚀 起漲影子名單（**超級管理員專用·唯讀**）────────────────────────
// 研究模型盤後凍結的「隔日漲停」影子名單（sha256 封印）＋隔一交易日收盤後的對答案。
// 資料由 Mac 上 scripts/surge-lab/a35_shadow_publish.mjs 寫入 surgeShadow/*（客戶端規則預設拒絕，只能經此 API 讀）。
// 影子模式：不取代、不修改站上漲停預測。GET ?day=fwd-YYYY-MM-DD｜hist-YYYY-MM-DD（省略＝最新一天）。
export const dynamic = 'force-dynamic';

const OWNER = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'nicholas@gmii.tw';
const DAY_ID_RE = /^(fwd|hist)-\d{4}-\d{2}-\d{2}$/;   // 與 scripts/lib/surge-shadow-report.mjs DAY_ID_RE 同一格式

export async function GET(request: Request) {
  const g = await requireAdmin(request);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });
  if (g.level !== 'superadmin' && g.email !== OWNER) return NextResponse.json({ error: '僅限超級管理員' }, { status: 403 });
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });
  const want = new URL(request.url).searchParams.get('day');
  if (want !== null && !DAY_ID_RE.test(want)) return NextResponse.json({ error: 'day 格式應為 fwd-YYYY-MM-DD 或 hist-YYYY-MM-DD' }, { status: 400 });
  try {
    const col = db.collection('surgeShadow');
    const ix = (await col.doc('index').get()).data();
    if (typeof ix?.reportJson !== 'string') return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store' } });
    const index = JSON.parse(ix.reportJson) as { days?: Array<{ id?: string }> };
    const id = want ?? index.days?.[0]?.id ?? null;
    const dd = id ? (await col.doc(id).get()).data() : undefined;
    const day = typeof dd?.reportJson === 'string' ? JSON.parse(dd.reportJson) : null;
    // G2-11：下載資料一律壓縮（Cloud Run 前無自動 gzip）
    return gzipJsonAuto({ found: true, index, day, dayId: day ? id : null }, { 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error('[surge-shadow] 讀取失敗', e);
    return NextResponse.json({ error: '讀取影子名單失敗' }, { status: 500 });
  }
}
