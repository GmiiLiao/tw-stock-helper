import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { memoize } from '@/lib/singleflight';

// ── 🧪 飆股模型 v2（影子實驗）後台讀取（**超級管理員專用·唯讀**）──────────────────────
// 研究管線每晚把整份報告字串化成 reportJson 寫進 Firestore surgeShadow/surge-v2（最新）與 surge-v2-{YYYY-MM-DD}（每日一份）。
// 客戶端規則預設拒絕，只能經此 API 讀。影子實驗：未通過驗證、不進任何分數、不影響站上功能。
//   GET                       → surgeShadow/surge-v2
//   GET ?day=YYYY-MM-DD       → surgeShadow/surge-v2-{day}（day 只收這個格式；文件 id 由伺服器組，呼叫端不能指定任意文件）
//   回 { found, report, updatedAt }；found=false＝管線尚未產出（文件不存在或沒有 reportJson）。
// 400＝day 格式不符；502＝Firestore 讀取／解析失敗（不吞錯、也不把失敗偽裝成「尚未產出」）。
// 全部回應（含錯誤）Cache-Control: no-store：超級管理員私有資料，不進 CDN。
export const dynamic = 'force-dynamic';

const OWNER = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'nicholas@gmii.tw';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LATEST_ID = 'surge-v2';
const NO_STORE = { 'Cache-Control': 'no-store' };
const MERGE_TTL_MS = 30_000;   // 同文件 30 秒內合流：多人／連按重新整理只讀一次 Firestore
const LOADER_CAP = 64;         // day 由使用者給（雖限格式），loader 表設上限防無界成長

interface Loaded { found: boolean; report: unknown; updatedAt: string | null }

const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });
const tsIso = (v: unknown): string | null => {   // Firestore Timestamp → ISO
  const t = v as { toDate?: () => Date } | null;
  return typeof t?.toDate === 'function' ? t.toDate().toISOString() : null;
};

async function readDoc(id: string): Promise<Loaded> {
  const db = getAdminDb();
  if (!db) throw new Error('DB unavailable');
  const d = (await db.collection('surgeShadow').doc(id).get()).data();
  if (typeof d?.reportJson !== 'string') return { found: false, report: null, updatedAt: null };
  let report: unknown;
  try { report = JSON.parse(d.reportJson); } catch { throw new Error(`${id} 的 reportJson 不是合法 JSON`); }
  return { found: true, report, updatedAt: tsIso(d.updatedAt) };
}

const loaders = new Map<string, () => Promise<Loaded | null>>();
function loaderFor(id: string): () => Promise<Loaded | null> {
  const hit = loaders.get(id);
  if (hit) return hit;
  if (loaders.size >= LOADER_CAP) loaders.clear();
  // memoize 失敗（含逾時、冷卻期）回 null——呼叫端據此回 502，與「文件不存在」（found:false）分開
  const f = memoize<Loaded>(`surge-v2:${id}`, MERGE_TTL_MS, () => readDoc(id), { timeoutMs: 10_000 });
  loaders.set(id, f);
  return f;
}

export async function GET(request: Request) {
  const g = await requireAdmin(request);
  if (!g.ok) return fail(g.error, g.status);
  if (g.level !== 'superadmin' && g.email !== OWNER) return fail('僅限超級管理員', 403);
  const want = new URL(request.url).searchParams.get('day');
  if (want !== null && !DAY_RE.test(want)) return fail('day 格式應為 YYYY-MM-DD', 400);
  try {
    const got = await loaderFor(want ? `${LATEST_ID}-${want}` : LATEST_ID)();
    if (!got) return fail('讀取飆股模型 v2 報告失敗', 502);
    return gzipJsonAuto(got, NO_STORE);   // 下載資料一律壓縮（Cloud Run 前無自動 gzip）
  } catch (e) {
    console.error('[surge-v2] 讀取失敗', want ?? 'latest', e);
    return fail('讀取飆股模型 v2 報告失敗', 502);
  }
}
