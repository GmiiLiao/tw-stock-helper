import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { swingStats, swingAccount, type SwingLabDoc } from '../../../../../scripts/lib/ai-swing-lab.mjs';
import { portfolioState } from '../../../../../scripts/lib/ai-swing-portfolio.mjs';

// ── 🤖 AI 實驗·波段持有（**超級管理員專用**）──────────────────────────
// GET：各持有期（5/10/20/60/120 日）AI 選股 vs 整池、依模型分組、逐日列表與明細（含選股原因、prompt 與原始回覆供稽核）。
// POST：人工檢討 { date, notes }——只寫 adminNotes*，不改凍結的選股與結算；daemon 15 分鐘內同步到第二大腦。
export const dynamic = 'force-dynamic';

const OWNER = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'nicholas@gmii.tw';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NOTES = 4000;

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
    const want = new URL(request.url).searchParams.get('date');
    const snap = await db.collection('aiSwingLab').orderBy('date', 'desc').limit(250).get();
    const docs = snap.docs.map(d => d.data() as SwingLabDoc);
    // 依模型分組：換模型後的成績不可與舊模型混算
    const byModel: Record<string, ReturnType<typeof swingStats>> = {};
    for (const name of [...new Set(docs.map(d => d.model?.name || '未知'))]) byModel[name] = swingStats(docs.filter(d => (d.model?.name || '未知') === name));
    const detail = want && DATE_RE.test(want) ? docs.find(d => d.date === want) || null : docs[0] || null;
    // 持有清單（最新收盤計市值）與結算清單：daemon 每日結算後寫 aiLabAccounts/swing
    const snapshot = (await db.collection('aiLabAccounts').doc('swing').get()).data() || null;
    // G2-11：下載資料一律壓縮（Cloud Run 前無自動 gzip）；JSON 內容與舊版相同。
    return gzipJsonAuto({
      found: docs.length > 0,
      stats: swingStats(docs), byModel, snapshot,
      // 波段帳戶 50 萬（與當沖帳戶分開、不互通）：由成交記錄重算（v3 AI 主動操作）
      // 帳戶以 daemon 快照為準（含日線：成交裁減、T+2 應收應付、委託保留）；無快照才由成交記錄估算
      account: snapshot?.account ?? swingAccount(docs),
      // v3：持倉＝AI 尚未賣出成交的部位（待進場／持有中／賣出委託中），由成交記錄重建
      openPositions: portfolioState(docs).lots.filter(l => l.status === 'pending' || l.status === 'held' || l.status === 'selling').map(l => ({ date: l.date, code: l.code, name: l.name, shares: l.shares, status: l.status })),
      days: docs.map(d => ({ date: d.date, model: d.model?.name || null, picks: d.picks.map(p => p.code), settled: Object.keys(d.outcomes || {}).map(Number), hasNotes: !!d.adminNotes })),
      detail,
    }, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = await superGate(request); if (!gate.ok) return gate.res;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });
  let body: { date?: unknown; notes?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: '格式錯誤' }, { status: 400 }); }
  const date = typeof body.date === 'string' ? body.date : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim() : null;
  if (!DATE_RE.test(date)) return NextResponse.json({ error: '日期格式應為 YYYY-MM-DD' }, { status: 400 });
  if (notes == null || notes.length > MAX_NOTES) return NextResponse.json({ error: `檢討內容需為 1～${MAX_NOTES} 字` }, { status: 400 });
  try {
    const ref = db.collection('aiSwingLab').doc(date);
    if (!(await ref.get()).exists) return NextResponse.json({ error: '該日沒有選股記錄' }, { status: 404 });
    await ref.update({ adminNotes: notes, adminNotesAt: Date.now(), adminBy: gate.email || '超級管理員' });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
