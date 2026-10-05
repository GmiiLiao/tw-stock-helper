import { NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { memoize } from '@/lib/singleflight';
import { LAB_DOC_IDS, parseRowsQuery, resolveRowsDoc, queryRows, type CvDoc, type RowsTable } from '../../../../../scripts/lib/surge-lab-report.mjs';
import { TRACKS_INDEX_ID, DAY_RE as TRACKS_DAY_RE, dayDocId as tracksDayDocId, type TracksIndexDoc } from '../../../../../scripts/lib/surge-tracks-report.mjs';

// ── 🚀 起漲影子名單＋研究後台（**超級管理員專用·唯讀**）──────────────────────
// 研究模型盤後凍結的「隔日漲停」影子名單（sha256 封印）＋隔一交易日收盤後的對答案。
// 資料由 Mac 上 scripts/surge-lab/a35_shadow_publish.mjs（名單）與 surge_lab_publish.mjs（lab-*）寫入 surgeShadow/*
// （客戶端規則預設拒絕，只能經此 API 讀）。影子模式：不取代、不修改站上漲停預測。
//   GET ?day=fwd-YYYY-MM-DD｜hist-YYYY-MM-DD（省略＝最新一天）——影子名單（原行為）
//   GET ?view=cv｜mirror｜pipeline——官方化重訓驗證摘要／鏡像健康／每日影子管線狀態（lab-* 單一文件）
//   GET ?view=cvrows&task&version&model&kind[&market&rankMin&rankMax&from&to&q&sort&page]——命中／漏網／母體外逐列（伺服器端篩選，每頁 200 列）
//   GET ?view=tracks[&day=YYYY-MM-DD]——T1 分軌前向影子索引＋一天（省略＝最新凍結日）；?view=tracksDay&day=YYYY-MM-DD——只取那一天
//       （surgeShadow/tracks-index、tracks-fwd-{日}，由 scripts/surge-lab/a37_tracks_publish.mjs 寫；文件本身不含任何報酬欄位）
// 全部回應（含錯誤）Cache-Control: no-store：超級管理員私有資料，不進 CDN。
export const dynamic = 'force-dynamic';

const OWNER = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'nicholas@gmii.tw';
const DAY_ID_RE = /^(fwd|hist)-\d{4}-\d{2}-\d{2}$/;   // 與 scripts/lib/surge-shadow-report.mjs DAY_ID_RE 同一格式
const NO_STORE = { 'Cache-Control': 'no-store' };
const VIEWS = ['cv', 'cvrows', 'mirror', 'pipeline', 'tracks', 'tracksDay'] as const;
type View = typeof VIEWS[number];
type Db = NonNullable<ReturnType<typeof getAdminDb>>;

const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });
const tsIso = (v: unknown): string | null => { const t = v as { toDate?: () => Date } | null; return typeof t?.toDate === 'function' ? t.toDate().toISOString() : null; };   // Firestore Timestamp → ISO

async function readLab(db: Db, id: string): Promise<{ report: unknown; updatedAt: string | null } | null> {
  const d = (await db.collection('surgeShadow').doc(id).get()).data();
  return typeof d?.reportJson === 'string' ? { report: JSON.parse(d.reportJson), updatedAt: tsIso(d.updatedAt) } : null;
}

// 翻頁時不要每次重讀 0.1～0.3MB 的逐列文件：摘要合流 60 秒；逐列以「文件 id＋內容 sha256」為鍵快取 5 分鐘（重新發佈＝新 sha＝新鍵）
// 包一層 { doc }：memoize 失敗時回 null——要分得出「讀取失敗」與「還沒發佈（doc=null）」
const getCvDoc = memoize<{ doc: CvDoc | null }>('surge-lab-cv', 60_000, async () => {
  const db = getAdminDb();
  if (!db) throw new Error('DB unavailable');
  const r = await readLab(db, LAB_DOC_IDS.cv);
  return { doc: r ? (r.report as CvDoc) : null };
});
const rowLoaders = new Map<string, () => Promise<RowsTable | null>>();
function rowsLoader(id: string, sha: string) {
  const key = `${id}:${sha}`;
  const hit = rowLoaders.get(key);
  if (hit) return hit;
  if (rowLoaders.size >= 64) rowLoaders.clear();   // 鍵只來自摘要清單（≤ 數十份），此行只是上限保險
  const f = memoize<RowsTable>(`surge-lab-rows:${key}`, 300_000, async () => {
    const db = getAdminDb();
    if (!db) throw new Error('DB unavailable');
    const d = (await db.collection('surgeShadow').doc(id).get()).data();
    if (!d?.gz) throw new Error(`缺逐列文件 ${id}`);
    const buf = Buffer.from(d.gz as Uint8Array);
    if (createHash('sha256').update(buf).digest('hex') !== sha) throw new Error(`${id} 與摘要清單的 sha256 不符（發佈中途或只發佈了一半）`);
    return JSON.parse(gunzipSync(buf).toString('utf8')) as RowsTable;
  }, { timeoutMs: 15_000 });
  rowLoaders.set(key, f);
  return f;
}

async function cvRows(params: URLSearchParams): Promise<Response> {
  const p = parseRowsQuery(params);
  if (!p.ok) return fail(p.error, 400);
  const got = await getCvDoc();
  if (!got) return fail('讀取研究摘要失敗', 502);
  const cv = got.doc;
  if (!cv) return gzipJsonAuto({ found: false }, NO_STORE);
  const ref = resolveRowsDoc(cv, p.query);
  if (!ref) return gzipJsonAuto({ found: false, note: '這個組合沒有發佈逐列資料（版本不存在、與修正前相同，或內容與本版 CV 摘要不符而未發佈）' }, NO_STORE);
  const table = await rowsLoader(ref.id, ref.sha256)();
  if (!table) return fail('讀取逐列資料失敗（文件不存在或與摘要版本不一致——剛重新發佈請 1 分鐘後再試，否則重新執行 surge_lab_publish.mjs）', 502);
  const page = queryRows(table, p.query);
  return gzipJsonAuto({ found: true, doc: { id: ref.id, totalRows: ref.totalRows, keptRows: ref.keptRows, filterNote: ref.filterNote, model: ref.model, verified: ref.verified, verifyNote: ref.verifyNote }, dataDate: cv.dataDate, ...page }, NO_STORE);
}

// T1 分軌前向影子：索引（tracks）＋單日（tracksDay）。day 參數只接受 YYYY-MM-DD，文件 id 由伺服器組（不讓呼叫端指定任意文件）。
async function tracksView(db: Db, params: URLSearchParams, dayOnly: boolean): Promise<Response> {
  const want = params.get('day');
  if (want !== null && !TRACKS_DAY_RE.test(want)) return fail('day 格式應為 YYYY-MM-DD', 400);
  if (dayOnly && want === null) return fail('tracksDay 需要 day=YYYY-MM-DD', 400);
  let index: TracksIndexDoc | null = null;
  let updatedAt: string | null = null;
  if (!dayOnly) {
    const r = await readLab(db, TRACKS_INDEX_ID);
    if (!r) return gzipJsonAuto({ found: false }, NO_STORE);
    index = r.report as TracksIndexDoc;
    updatedAt = r.updatedAt;
  }
  const dayId = want ? tracksDayDocId(want) : (index?.days?.find(d => d.status === 'frozen')?.id ?? null);
  const dr = dayId ? await readLab(db, dayId) : null;
  return gzipJsonAuto({ found: true, index, updatedAt, day: dr ? dr.report : null, dayId: dr ? dayId : null }, NO_STORE);
}

async function labView(db: Db, view: Exclude<View, 'cvrows' | 'tracks' | 'tracksDay'>): Promise<Response> {
  const r = await readLab(db, LAB_DOC_IDS[view]);
  if (!r) return gzipJsonAuto({ found: false }, NO_STORE);
  return gzipJsonAuto({ found: true, updatedAt: r.updatedAt, [view]: r.report }, NO_STORE);
}

export async function GET(request: Request) {
  const g = await requireAdmin(request);
  if (!g.ok) return fail(g.error, g.status);
  if (g.level !== 'superadmin' && g.email !== OWNER) return fail('僅限超級管理員', 403);
  const db = getAdminDb();
  if (!db) return fail('DB unavailable', 503);
  const params = new URL(request.url).searchParams;
  const view = params.get('view');
  if (view !== null && !(VIEWS as readonly string[]).includes(view)) return fail(`view 應為 ${VIEWS.join('｜')}`, 400);
  try {
    if (view === 'cvrows') return await cvRows(params);
    if (view === 'tracks' || view === 'tracksDay') return await tracksView(db, params, view === 'tracksDay');
    if (view) return await labView(db, view as Exclude<View, 'cvrows' | 'tracks' | 'tracksDay'>);
    const want = params.get('day');
    if (want !== null && !DAY_ID_RE.test(want)) return fail('day 格式應為 fwd-YYYY-MM-DD 或 hist-YYYY-MM-DD', 400);
    const col = db.collection('surgeShadow');
    const ix = (await col.doc('index').get()).data();
    if (typeof ix?.reportJson !== 'string') return NextResponse.json({ found: false }, { headers: NO_STORE });
    const index = JSON.parse(ix.reportJson) as { days?: Array<{ id?: string }> };
    const id = want ?? index.days?.[0]?.id ?? null;
    const dd = id ? (await col.doc(id).get()).data() : undefined;
    const day = typeof dd?.reportJson === 'string' ? JSON.parse(dd.reportJson) : null;
    // G2-11：下載資料一律壓縮（Cloud Run 前無自動 gzip）
    return gzipJsonAuto({ found: true, index, day, dayId: day ? id : null }, NO_STORE);
  } catch (e) {
    console.error('[surge-shadow] 讀取失敗', view ?? 'day', e);
    return fail(view ? '讀取研究資料失敗' : '讀取影子名單失敗', 500);
  }
}
