import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';

// ── 🧠 軋空判讀模型狀態（superadmin 專用·唯讀）──────────────────────
// 回傳：主判讀模型 + 軋空機率模型 + 分支模型狀態 + 歷史訓練報表清單
// + 訓練資料集累積狀況。訓練由 scripts/squeeze-train.mjs 每週二/五 01:00 產生。
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });
  try {
    const url = new URL(request.url);
    const runId = url.searchParams.get('runId');

    // 指定報表 → 回完整那一份（含全部單因子與組合明細）
    if (runId) {
      const r = (await db.collection('squeezeReport').doc(runId).get()).data();
      if (!r) return NextResponse.json({ found: false });
      return NextResponse.json({ found: true, report: r }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const [modelSnap, reportsSnap, trainSnap, globalSnap, reviewSnap, reviewSum] = await Promise.all([
      db.collection('squeezeModel').doc('latest').get(),
      db.collection('squeezeReport').orderBy('updatedAt', 'desc').limit(20).get(),
      db.collection('squeezeTraining').orderBy('date', 'desc').limit(400).get(),
      db.collection('squeezeTraining').doc('global').get(),
      db.collection('squeezeReview').orderBy('date', 'desc').limit(30).get(),
      db.collection('squeezeReview').doc('summary').get(),
    ]);

    const model = modelSnap.exists ? modelSnap.data() : null;
    const reports = reportsSnap.docs.map(d => {
      const x = d.data();
      return {
        runId: d.id, updatedAt: x.updatedAt, status: x.status,
        period: x.period, samples: x.samples,
        mainName: x.main?.name ?? null,
        mainOot: x.main?.oot ?? null,
        edge: x.main?.edgeVsMomentum ?? null,
        sqName: x.squeezeProb?.name ?? null,
        sqLift: x.squeezeProb?.lift ?? null,
        survivorCount: x.survivorCount ?? null,
      };
    });
    // 訓練資料集累積（排除 global 這份設定文件）
    const dataset = trainSnap.docs
      .filter(d => d.id !== 'global')
      .map(d => { const x = d.data(); return { date: x.date ?? d.id, n: x.n ?? 0, nLimitUp: x.nLimitUp ?? 0, nControl: x.nControl ?? 0 }; });
    const g = globalSnap.exists ? globalSnap.data() : null;

    return NextResponse.json({
      found: !!model,
      model,
      reports,
      dataset: {
        days: dataset.length,
        totalRows: dataset.reduce((s, x) => s + (x.n || 0), 0),
        totalLimitUp: dataset.reduce((s, x) => s + (x.nLimitUp || 0), 0),
        recent: dataset.slice(0, 30),
      },
      globalHistory: g ? { days: g.days ?? null, updatedAt: g.updatedAt ?? null, syms: g.syms ?? [] } : null,
      review: {
        summary: reviewSum.exists ? reviewSum.data() : null,
        daily: reviewSnap.docs.filter(x => x.id !== 'summary').map(x => x.data()),
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
