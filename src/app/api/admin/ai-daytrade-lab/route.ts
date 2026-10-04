import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { labStats, type AiLabRecord } from '../../../../../scripts/lib/ai-daytrade-lab.mjs';
import { DT_DAILY_LIMIT } from '../../../../../scripts/lib/dt-trading-limit.mjs';

// ── 🤖 當沖 AI 實驗（**超級管理員專用**）──────────────────────────────
// GET：累積統計（AI 做 vs 不做的反事實 vs 規則全做）、信心分組、每日列表、指定日明細、今日盤中 live。
// POST：人工檢討 { date, notes }——只寫 adminNotes／adminNotesAt／adminBy，**不改 AI 凍結記錄**；
//   daemon 每 15 分鐘把它同步成 second-brain/daytrade-ai-lab/{date}-人工檢討.md。
// POST：交易額度審核 { action: 'limit', decision: 'approve'|'reject', amount? }（2026-10-01 使用者「AI 交易員發訊息申請、我確認後再提高」）
//   ——只處理待審中的申請；核准寫入 aiLabAccounts/daytradeLimit.limit（daemon 5 分鐘內生效），並留審核紀錄。
export const dynamic = 'force-dynamic';

const OWNER = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'nicholas@gmii.tw';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NOTES = 4000;
const LIMIT_MIN = 100_000, LIMIT_MAX = 100_000_000;   // 額度核准金額的合理範圍（防手誤多打零）
interface LimitRequest { current: number; cash: number; proposed: number; status: 'pending' | 'approved' | 'rejected'; at: number; decidedAt?: number; decidedBy?: string; approved?: number }
interface LimitDoc { limit?: number; request?: LimitRequest | null; history?: { at: number; from: number; to: number; by: string }[] }

async function superGate(request: Request): Promise<{ ok: true; email: string | null } | { ok: false; res: NextResponse }> {
  const g = await requireAdmin(request);
  if (!g.ok) return { ok: false, res: NextResponse.json({ error: g.error }, { status: g.status }) };
  if (g.level !== 'superadmin' && g.email !== OWNER) return { ok: false, res: NextResponse.json({ error: '僅限超級管理員' }, { status: 403 }) };
  return { ok: true, email: g.email };
}

interface LabDoc { date: string; records?: AiLabRecord[]; review?: { summary: string } | null; frozenAt?: number; adminNotes?: string; adminNotesAt?: number }

export async function GET(request: Request) {
  const gate = await superGate(request); if (!gate.ok) return gate.res;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });
  try {
    const want = new URL(request.url).searchParams.get('date');
    const snap = await db.collection('aiDaytradeLab').orderBy('date', 'desc').limit(61).get();
    const docs = snap.docs.filter(d => d.id !== 'live').map(d => d.data() as LabDoc).slice(0, 60);
    const all = docs.flatMap(d => d.records || []);
    const conf = (lo: number, hi: number) => {
      const xs = all.filter(r => r.status === 'filled' && (r.confidence ?? -1) >= lo && (r.confidence ?? -1) < hi && r.aiNetR != null);
      return { range: `${lo}–${hi - 1}`, n: xs.length, avgR: xs.length ? +(xs.reduce((a, r) => a + (r.aiNetR as number), 0) / xs.length).toFixed(2) : null };
    };
    const live = (await db.collection('aiDaytradeLab').doc('live').get()).data() || null;
    const limDoc = ((await db.collection('aiLabAccounts').doc('daytradeLimit').get()).data() || {}) as LimitDoc;
    const limitInfo = { limit: (limDoc.limit ?? 0) > 0 ? limDoc.limit : DT_DAILY_LIMIT, request: limDoc.request ?? null, history: (limDoc.history || []).slice(-10) };
    const detail = want && DATE_RE.test(want) ? (docs.find(d => d.date === want) || null) : (docs[0] || null);
    // 當沖帳戶 50 萬（與波段帳戶分開、不互通）：已凍結各日＋今日盤中的 AI 成交交易單重算
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const liveRecs = live && (live as LabDoc).date === today && !docs.some(d => d.date === today) ? ((live as LabDoc).records || []) : [];
    const acctTrades = [...all, ...liveRecs].filter(r => r.status === 'filled').map(r => (r.ledger ? { pnlTwd: r.ledger.pnlTwd } : { open: true, cost: Math.round((r.fillPx || 0) * (r.shares || 1000)) }));
    const realized = acctTrades.reduce((a, t) => a + (t.pnlTwd ?? 0), 0), openCost = acctTrades.reduce((a, t) => a + (t.cost ?? 0), 0);
    const account = { initial: 500000, realized, equity: 500000 + realized, openCost, cash: 500000 + realized - openCost, retPct: +(realized / 500000 * 100).toFixed(2), trades: acctTrades.length };
    // 交易時間清單（新→舊）＋每日結算（舊→新累計帳戶淨值）——只列 AI 實際成交（有交易單）者
    const dated = [...docs.map(d => ({ date: d.date, recs: d.records || [] })), ...(liveRecs.length ? [{ date: today, recs: liveRecs }] : [])];
    const tradeList = dated.flatMap(d => d.recs.filter(r => r.status === 'filled').map(r => ({
      date: d.date, code: r.code, name: r.name, side: r.side, type: r.type, decidedAt: r.decidedAt ?? null, shares: r.shares ?? r.ledger?.shares ?? 1000,
      buy: r.ledger?.buy ?? null, sell: r.ledger?.sell ?? null, legs: r.ledger?.legs?.length ?? null, costTwd: r.ledger?.costTwd ?? null,
      pnlTwd: r.ledger?.pnlTwd ?? null, retPct: r.ledger?.retPct ?? null, exitReason: r.exitReason ?? null, open: !r.ledger, noLookahead: r.ledger?.noLookahead ?? null,
    }))).sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
    let eq = 500000;
    const daily = dated.map(d => {
      const ls = d.recs.filter(r => r.status === 'filled' && r.ledger).map(r => r.ledger!);
      const sum = (f: (l: NonNullable<AiLabRecord['ledger']>) => number) => ls.reduce((a, l) => a + f(l), 0);
      return { date: d.date, wins: ls.filter(l => l.pnlTwd > 0).length, losses: ls.filter(l => l.pnlTwd < 0).length, n: ls.length, open: d.recs.filter(r => r.status === 'filled' && !r.ledger).length, buyAmt: sum(l => l.buy.amount), sellAmt: sum(l => l.sell.amount), fee: sum(l => l.buy.fee + l.sell.fee), tax: sum(l => l.sell.tax), pnl: sum(l => l.pnlTwd) };
    }).sort((a, b) => a.date.localeCompare(b.date)).map(x => { const before = eq; eq += x.pnl; return { ...x, equity: eq, dayRetPct: +((x.pnl / before) * 100).toFixed(2), cumRetPct: +((eq / 500000 - 1) * 100).toFixed(2) }; }).reverse();
    // G2-11：下載資料一律壓縮（Cloud Run 前無自動 gzip）；JSON 內容與舊版相同。
    return gzipJsonAuto({
      found: docs.length > 0 || !!live,
      account, tradeList, daily, limit: limitInfo,
      days: docs.map(d => ({ date: d.date, n: (d.records || []).length, stats: labStats(d.records || []).all, summary: d.review?.summary || null, hasNotes: !!d.adminNotes, frozenAt: d.frozenAt || null })),
      cumulative: labStats(all), confidence: [conf(80, 101), conf(60, 80), conf(0, 60)],
      live, detail,
    }, { 'Cache-Control': 'no-store' });
  } catch (e) {
    // G1-24：錯誤細節只進 server log，不回前端
    console.error('[api/admin/ai-daytrade-lab]', e);
    return NextResponse.json({ error: 'internal error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function POST(request: Request) {
  const gate = await superGate(request); if (!gate.ok) return gate.res;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });
  let body: { date?: unknown; notes?: unknown; action?: unknown; decision?: unknown; amount?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: '格式錯誤' }, { status: 400 }); }
  if (body.action === 'limit') return decideLimit(db, body, gate.email || '超級管理員');
  const date = typeof body.date === 'string' ? body.date : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim() : null;
  if (!DATE_RE.test(date)) return NextResponse.json({ error: '日期格式應為 YYYY-MM-DD' }, { status: 400 });
  if (notes == null || notes.length > MAX_NOTES) return NextResponse.json({ error: `檢討內容需為 1～${MAX_NOTES} 字` }, { status: 400 });
  try {
    const ref = db.collection('aiDaytradeLab').doc(date);
    const doc = await ref.get();
    if (!doc.exists) return NextResponse.json({ error: '該日尚未凍結（盤後 13:40 起才有記錄檔）' }, { status: 404 });
    await ref.update({ adminNotes: notes, adminNotesAt: Date.now(), adminBy: gate.email || '超級管理員' });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // G1-24：錯誤細節只進 server log，不回前端
    console.error('[api/admin/ai-daytrade-lab]', e);
    return NextResponse.json({ error: 'internal error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

/** 交易額度申請審核：只處理待審中的申請；核准金額需為整數且在合理範圍內 */
async function decideLimit(db: NonNullable<ReturnType<typeof getAdminDb>>, body: { decision?: unknown; amount?: unknown }, by: string) {
  const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : null;
  if (!decision) return NextResponse.json({ error: 'decision 應為 approve 或 reject' }, { status: 400 });
  const amount = typeof body.amount === 'number' ? body.amount : NaN;
  if (decision === 'approve' && !(Number.isInteger(amount) && amount >= LIMIT_MIN && amount <= LIMIT_MAX)) {
    return NextResponse.json({ error: `核准額度需為 ${LIMIT_MIN.toLocaleString()}～${LIMIT_MAX.toLocaleString()} 元的整數` }, { status: 400 });
  }
  try {
    const ref = db.collection('aiLabAccounts').doc('daytradeLimit');
    const out = await db.runTransaction(async tx => {
      const cur = ((await tx.get(ref)).data() || {}) as LimitDoc;
      if (cur.request?.status !== 'pending') return { error: '目前沒有待審的額度申請' };
      const from = (cur.limit ?? 0) > 0 ? cur.limit as number : DT_DAILY_LIMIT, now = Date.now();
      const to = decision === 'approve' ? amount : from;
      tx.set(ref, {
        limit: to,
        request: { ...cur.request, status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: now, decidedBy: by, ...(decision === 'approve' ? { approved: amount } : {}) },
        history: [...(cur.history || []), ...(decision === 'approve' ? [{ at: now, from, to, by }] : [])].slice(-50),
      });
      return { ok: true, limit: to };
    });
    if ('error' in out) return NextResponse.json({ error: out.error }, { status: 409 });
    return NextResponse.json(out);
  } catch (e) {
    // G1-24：錯誤細節只進 server log，不回前端
    console.error('[api/admin/ai-daytrade-lab]', e);
    return NextResponse.json({ error: 'internal error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
