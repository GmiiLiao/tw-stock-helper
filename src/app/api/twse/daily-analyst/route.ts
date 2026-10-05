import { NextResponse } from 'next/server';
import { latestDoc } from '@/lib/api-cache';
import { getAdminDb } from '@/lib/firebase-admin';
import { memoize } from '@/lib/singleflight';

export const runtime = 'nodejs';

// 每日 AI 分析師團隊報告（盤後報告頁「分析報告」分頁）。scripts/publish-daily-analyst.mjs 發佈 dailyAnalyst/latest；
// 一天最多兩次變動（evening 盤後版＋morning 晨間定版）→ daily tier。只讀 Firestore，不打上游。
// 公開文件**不含個股名單**（cards[].focus 只留 kind/poolRule/poolSize/excludedCount/count）；
// 個股「資料觀察名單」研究期僅管理員可見，走 /api/admin/daily-analyst-focus。
// 放行閘門（使用者 2026-10-05 裁定「研究期先抽樣審閱再放行」）：Firestore system/analystRelease.released 不是 true 時，
// 一般使用者拿到 {found:false,gated:true}（頁面退回資料模板版）；管理員走 /api/admin/daily-analyst-focus?doc=analysis 看全文。
// 讀不到放行旗標＝視為未放行（fail closed）。放行／撤回：scripts/release-daily-analyst.mjs。
const GATE_NO_STORE = { 'Cache-Control': 'no-store' };

const readReleased = memoize<{ released: boolean }>('daily-analyst-release', 60_000, async () => {
  const db = getAdminDb();
  if (!db) throw new Error('DB unavailable');
  const snap = await db.collection('system').doc('analystRelease').get();
  return { released: snap.exists && snap.data()?.released === true };
}, { timeoutMs: 10_000 });

export async function GET(request: Request) {
  const rel = await readReleased().catch(() => null);
  if (!rel?.released) return NextResponse.json({ found: false, gated: true }, { headers: GATE_NO_STORE });
  return latestDoc('dailyAnalyst', 'daily', { request });
}
