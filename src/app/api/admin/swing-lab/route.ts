import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';

// ── 🧪 波段技巧實驗室（superadmin 專用·唯讀）────────────────────────
// scripts/swing-lab.mjs 的事件驅動回測結果（swingLab/latest.reportJson）。
// 流水線：技巧 → 回測實證 → 本視窗視覺驗證 → 判定 pass 才生成 skill。
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });
  try {
    const d = (await db.collection('swingLab').doc('latest').get()).data();
    if (!d?.reportJson) return NextResponse.json({ found: false });
    return NextResponse.json({ found: true, ...JSON.parse(d.reportJson) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    // G1-24：錯誤細節只進 server log，不回前端
    console.error('[api/admin/swing-lab]', e);
    return NextResponse.json({ error: 'internal error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
