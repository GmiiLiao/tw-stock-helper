import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJsonAuto } from '@/lib/gzip-response';

// ── 🧠 AI 交易員經驗庫（**超級管理員專用**）：盤後訓練結果 aiLabLearn/latest（daemon 18:30 後寫入）──
export const dynamic = 'force-dynamic';

const OWNER = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'nicholas@gmii.tw';

export async function GET(request: Request) {
  const g = await requireAdmin(request);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status, headers: { 'Cache-Control': 'no-store' } });
  if (g.level !== 'superadmin' && g.email !== OWNER) return NextResponse.json({ error: '僅限超級管理員' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  try {
    const doc = (await db.collection('aiLabLearn').doc('latest').get()).data() || null;
    return gzipJsonAuto({ found: !!doc, doc }, { 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error('[ai-lab-learn]', (e as Error)?.message);
    return NextResponse.json({ error: 'internal error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
