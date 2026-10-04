import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';
import { isPaidLevel } from '@/lib/require-premium';

// ── 🤖 AI 實驗開通管理（**超級管理員專用**；2026-10-01 使用者「超級管理員要有管理權限能給指定會員開啟這個功能」）──
// GET：所有開通紀錄。POST：{ uid, swing: boolean }——開通／關閉指定會員的 AI 實驗·波段（當沖尚未開放給會員）。
// 只能開通高級會員（premium／admin／superadmin）；開通紀錄存 aiLabAccess/{uid}（前端不能寫，見 firestore.rules）。
export const dynamic = 'force-dynamic';

const OWNER = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'nicholas@gmii.tw';
const UID_RE = /^[A-Za-z0-9]{10,64}$/;

async function superGate(request: Request): Promise<{ ok: true; email: string | null } | { ok: false; res: NextResponse }> {
  const g = await requireAdmin(request);
  if (!g.ok) return { ok: false, res: NextResponse.json({ error: g.error }, { status: g.status }) };
  if (g.level !== 'superadmin' && g.email !== OWNER) return { ok: false, res: NextResponse.json({ error: '僅限超級管理員' }, { status: 403 }) };
  return { ok: true, email: g.email };
}

export async function GET(request: Request) {
  const gate = await superGate(request); if (!gate.ok) return gate.res;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });
  try {
    const snap = await db.collection('aiLabAccess').get();
    const grants = snap.docs.map(d => { const x = d.data(); return { uid: d.id, swing: x.swing === true, updatedAt: x.updatedAt ?? null, updatedBy: x.updatedBy ?? null }; });
    return NextResponse.json({ grants }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    // G1-24：錯誤細節只進 server log，不回前端
    console.error('[api/admin/ai-lab-access]', e);
    return NextResponse.json({ error: 'internal error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function POST(request: Request) {
  const gate = await superGate(request); if (!gate.ok) return gate.res;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });
  let body: { uid?: unknown; swing?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: '格式錯誤' }, { status: 400 }); }
  const uid = typeof body.uid === 'string' ? body.uid : '';
  if (!UID_RE.test(uid)) return NextResponse.json({ error: '會員 uid 格式錯誤' }, { status: 400 });
  if (typeof body.swing !== 'boolean') return NextResponse.json({ error: 'swing 應為 true 或 false' }, { status: 400 });
  try {
    const user = (await db.collection('users').doc(uid).get()).data();
    if (!user) return NextResponse.json({ error: '找不到此會員' }, { status: 404 });
    // 開通資格與使用端（api/ai/my-ai-lab）同一份定義：付費等級（體驗期不算，G4-24）
    if (body.swing && !isPaidLevel(user.level)) return NextResponse.json({ error: '只能開通高級會員（請先把等級調為 premium）' }, { status: 409 });
    await db.collection('aiLabAccess').doc(uid).set({ swing: body.swing, daytrade: false, updatedAt: Date.now(), updatedBy: gate.email || '超級管理員' }, { merge: true });
    return NextResponse.json({ ok: true, uid, swing: body.swing });
  } catch (e) {
    // G1-24：錯誤細節只進 server log，不回前端
    console.error('[api/admin/ai-lab-access]', e);
    return NextResponse.json({ error: 'internal error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
