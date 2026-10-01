import { NextResponse } from 'next/server';
import { requirePremium } from '@/lib/require-premium';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { rateLimit } from '@/lib/rate-limit';
import { accountSummary } from '../../../../../scripts/lib/ai-swing-history.mjs';
import { applyMemberSettings, goalProgress, netInvestedOf, pendingFlowOf, withdrawableNow } from '../../../../../scripts/lib/ai-lab-member.mjs';

// ── 🤖 會員 AI 實驗·波段（2026-10-01 使用者：開放高級會員、先開放波段；超級管理員逐一開通）─────────────
// 權限：高級會員（requirePremium）且 aiLabAccess/{uid}.swing＝true（只有超級管理員能開通，見 /api/admin/ai-lab-access）。
// 資料：aiSwingMembers/{uid}（設定與資金異動）、…/days/{日}（會員專屬 AI 交易員的決策與成交）、…/state/account（帳戶快照）。
//   這些集合不開放前端直接讀寫（firestore.rules 未列＝拒絕），一律經此 API：只讀得到自己的帳戶、設定由伺服器驗證。
// GET ?probe=1：只回開通狀態（投資組合頁決定是否顯示「AI 實驗」分頁）。GET：帳戶快照、設定、目標進度、近 30 個決策日。
// POST：{ capital?, goalDays?, growthTarget? }——投入資金變更＝加碼／提領（提領不可超過可提領現金）；
//   獲利期間 5／10／20／60／120／240 個交易日（2026-10-01 使用者：取消當沖額度設定項，改為獲利期間），目標或期間變更＝重新起算。
export const dynamic = 'force-dynamic';

const HISTORY_MAX = 250, DECISIONS_MAX = 30;

type Gate = { ok: true; uid: string; db: NonNullable<ReturnType<typeof getAdminDb>>; access: { swing: boolean; daytrade: boolean } } | { ok: false; res: NextResponse };

async function gate(request: Request, probe = false): Promise<Gate> {
  const p = await requirePremium(request);
  if (!p.ok) return { ok: false, res: probe && p.status === 403 ? NextResponse.json({ access: { swing: false, daytrade: false } }, { headers: { 'Cache-Control': 'private, no-store' } }) : NextResponse.json({ error: p.error }, { status: p.status }) };
  const db = getAdminDb();
  if (!db) return { ok: false, res: NextResponse.json({ error: 'DB unavailable' }, { status: 503 }) };
  const acc = (await db.collection('aiLabAccess').doc(p.uid).get()).data() || {};
  const access = { swing: acc.swing === true, daytrade: false };   // 當沖尚未開放給會員
  if (probe) return { ok: false, res: NextResponse.json({ access }, { headers: { 'Cache-Control': 'private, no-store' } }) };
  if (!access.swing) return { ok: false, res: NextResponse.json({ error: '尚未開通 AI 實驗（請洽管理員）', access }, { status: 403 }) };
  return { ok: true, uid: p.uid, db, access };
}

const taipeiToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

// 快照之後的入金／提領、目前可提領、獲利期間進度：一律走 scripts/lib/ai-lab-member.mjs（有單元測試；審查 MEDIUM：原本寫在這裡沒有測試）

interface Flow { date: string; amount: number; at?: number }
interface Pick { code: string; name?: string; confidence?: number; horizon?: number | null; reason?: string; risk?: string; priceAtDecision?: number | null; position?: { shares?: number; estCost?: number; reason?: string } }
interface DecisionDoc { date: string; note?: string; model?: { name?: string } | null; frozenAt?: number; picks?: Pick[]; review?: { sells?: { code: string; name?: string; reason?: string; shares?: number }[] } }

export async function GET(request: Request) {
  const limited = await rateLimit(request, 'my-ai-lab', 120);
  if (limited) return limited;
  const probe = new URL(request.url).searchParams.get('probe') === '1';
  const g = await gate(request, probe);
  if (!g.ok) return g.res;
  try {
    const base = g.db.collection('aiSwingMembers').doc(g.uid);
    const [setSnap, accSnap, daySnap, cashSnap] = await Promise.all([
      base.get(), base.collection('state').doc('account').get(), base.collection('days').orderBy('date', 'desc').limit(DECISIONS_MAX).get(),
      g.db.collection('users').doc(g.uid).collection('data').doc('cashLedger').get(),   // 會員自己的券商折讓（模擬手續費依此計）
    ]);
    const rawDisc = cashSnap.data()?.broker?.discount;
    const feeDiscount = typeof rawDisc === 'number' && rawDisc >= 0.01 && rawDisc <= 1 ? rawDisc : 1;   // 與 sim-ledger validDiscount 同規則
    const settings = setSnap.data() || {};
    const flows: Flow[] = Array.isArray(settings.flows) ? settings.flows : [];
    const capital = netInvestedOf(flows);
    const snapshot = accSnap.data() || null;
    const fullHistory = snapshot?.history || [];
    const history = fullHistory.slice(-HISTORY_MAX);
    const goal: number | null = settings.growthTarget ?? null;
    const goalDays: number | null = settings.goalDays ?? null;
    const goalStartDate: string | null = settings.goalStartDate ?? null;
    const pendingFlow = pendingFlowOf(flows, snapshot);
    // 決策：只給會員看得懂的欄位（不含 prompt／原始回覆）
    const decisions = daySnap.docs.map(d => d.data() as DecisionDoc).map(d => ({
      date: d.date, note: d.note || null, model: d.model?.name || null, frozenAt: d.frozenAt ?? null,
      picks: (d.picks || []).map(p => ({ code: p.code, name: p.name || p.code, confidence: p.confidence ?? null, horizon: p.horizon ?? null, reason: p.reason || '', risk: p.risk || '', priceAtDecision: p.priceAtDecision ?? null, shares: p.position?.shares ?? 0, estCost: p.position?.estCost ?? 0, skipReason: p.position?.reason ?? null })),
      sells: (d.review?.sells || []).map(x => ({ code: x.code, name: x.name || x.code, reason: x.reason || '', shares: x.shares ?? null })),
    }));
    return gzipJsonAuto({
      access: g.access,
      settings: { capital, growthTarget: goal, goalDays, goalStartDate, flows: flows.slice(-30), createdAt: settings.createdAt ?? null },
      withdrawable: withdrawableNow(snapshot, flows),
      pendingFlow,   // 快照之後的入金／提領（尚未反映在帳戶明細；畫面總值與總損益要補上）
      feeDiscount,   // 模擬手續費折讓（會員自己的券商設定；1＝全額 0.1425%）
      snapshot: snapshot ? { at: snapshot.at ?? null, dataDate: snapshot.dataDate ?? null, provisional: !!snapshot.provisional, liveAt: snapshot.liveAt ?? null, holdings: snapshot.holdings || [], closed: snapshot.closed || [], history } : null,
      summary: snapshot ? (snapshot.summary ?? accountSummary(snapshot)) : null,
      target: goalProgress(fullHistory, { growthTarget: goal, goalDays, goalStartDate }),   // 獲利期間進度（滾動期間；沒設目標＝null）
      decisions,
    }, { 'Cache-Control': 'private, no-store' });
  } catch (e) {
    console.error('[my-ai-lab] GET', (e as Error)?.message);
    return NextResponse.json({ error: '讀取失敗，請稍後再試' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const limited = await rateLimit(request, 'my-ai-lab-post', 20);
  if (limited) return limited;
  const g = await gate(request);
  if (!g.ok) return g.res;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: '格式錯誤' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: '格式錯誤' }, { status: 400 });
  const pick: { capital?: unknown; goalDays?: unknown; growthTarget?: unknown } = {};
  for (const k of ['capital', 'goalDays', 'growthTarget'] as const) if (k in body) pick[k] = body[k];
  if (!Object.keys(pick).length) return NextResponse.json({ error: '沒有要變更的設定' }, { status: 400 });
  try {
    const base = g.db.collection('aiSwingMembers').doc(g.uid);
    const out = await g.db.runTransaction(async tx => {
      const cur = (await tx.get(base)).data() || {};
      const acc = (await tx.get(base.collection('state').doc('account'))).data() || null;
      const flows0: Flow[] = Array.isArray(cur.flows) ? cur.flows : [];
      const r = applyMemberSettings(pick, cur, { today: taipeiToday(), now: Date.now(), withdrawable: withdrawableNow(acc, flows0) });
      if (!r.ok) return r;
      tx.set(base, { flows: r.next.flows, growthTarget: r.next.growthTarget, goalDays: r.next.goalDays, goalStartDate: r.next.goalStartDate, updatedAt: Date.now(), ...(cur.createdAt ? {} : { createdAt: Date.now() }) }, { merge: true });
      return r;
    });
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: 400 });
    return NextResponse.json({ ok: true, flow: out.flow, capital: netInvestedOf(out.next.flows) });
  } catch (e) {
    console.error('[my-ai-lab] POST', (e as Error)?.message);
    return NextResponse.json({ error: '儲存失敗，請稍後再試' }, { status: 500 });
  }
}
