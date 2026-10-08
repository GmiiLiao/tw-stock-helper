import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader, unavailable } from '@/lib/api-cache';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { memoize } from '@/lib/singleflight';
import { rankMediaVerdicts, rankOfficial } from '../../../../../scripts/lib/after-market-news.mjs';
import { seenJsonOf, verdictJsonOf } from '../../../../../scripts/lib/news-verdict-codec.mjs';   // newsVerdict 新舊格式（2026-10-08）

export const runtime = 'nodejs';

// 盤後報告「當晚新聞與分析消息」：只讀 Firestore（daemon 已寫好的判別與索引），在此組裝並依影響比重排序。
//   媒體＝newsVerdict（AI 讀完內文判別）；官方＝mopsNews 重大訊息主旨。要聞導讀（newsDigest）與盤後回顧（dailyPost）
//   大盤總覽／每日新聞分頁已有，不在此重複；dailyPost 只用來取最後交易日。
//   O、M 兩條管線分開排、不加總；權重全是先驗顯示排序，不是分數（見 scripts/lib/after-market-news.mjs 檔頭）。
// 「當晚」＝最後交易日收盤後（13:30 起）到現在的官方公告；媒體判別取 newsVerdict/latest（盤後趟＋夜間補判）。

const TWO_DAYS = 2 * 86400e3;
const CLOSE_MS = (13 * 60 + 30) * 60e3;
const iso = (ms: number) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

interface MopsItem { code: string; name: string; subject: string; at: number; body?: string }

// ── 官方欄方向一律「未判讀」（X11，2026-10-08「其它錯誤依建議修正」）────────────
//   rankOfficial 的方向來自 classifyOfficial 的**公告主旨正則**（未讀內文），已實測誤判
//   （4927「營運未受淹水影響」被判工安利空、1802、4950、6140），違反新聞技能 §1.2。
//   只在網站路由層把方向清成 null 並標「未判讀」——**不改共用的 classifyOfficial**：
//   分析師團隊 pack 也用它篩觀察池與必附風險（scripts/lib/analyst-desk），改共用模組會改到分析師輸出（反證 I10）。
//   類型與排序權重照舊（顯示順序，非分數）；元件對 dir=null 顯示「需讀內文」。J3 後改由 Jev 讀內文給方向。
const unjudgedOfficial = <T extends { dir: unknown }>(items: T[]) =>
  items.map(x => ({ ...x, dir: null, dirStatus: '未判讀' as const }));

const build = memoize('after-market-news', 120_000, async () => {
  const db = getAdminDb();
  if (!db) throw new Error('admin db unavailable');
  const get = async (c: string, d: string) => (await db.collection(c).doc(d).get()).data() ?? null;
  const [nv, post] = await Promise.all([get('newsVerdict', 'latest'), get('dailyPost', 'latest')]); // post 只用來取最後交易日
  const lastTrading: string | null = typeof post?.dataDate === 'string' ? post.dataDate : null;
  const sinceMs = lastTrading ? new Date(`${lastTrading}T00:00:00+08:00`).getTime() + CLOSE_MS : Date.now() - TWO_DAYS;

  // 官方重大訊息：最後交易日當天文件＋之後各日（含 latest 今日索引），過濾收盤後
  const days = new Set<string>();
  for (let t = sinceMs; t <= Date.now() + 86400e3; t += 86400e3) days.add(iso(t));
  const mops = new Map<string, MopsItem>();
  for (const d of days) {
    const doc = await get('mopsNews', d);
    const items = doc?.itemsJson ? Object.values(JSON.parse(doc.itemsJson as string)) as MopsItem[] : [];
    for (const x of items) if (x?.at >= sinceMs) mops.set(`${x.code}|${x.subject}|${x.at}`, x);
  }
  const latestMops = await get('mopsNews', 'latest');
  for (const x of (latestMops?.items ?? []) as MopsItem[]) if (x?.at >= sinceMs) mops.set(`${x.code}|${x.subject}|${x.at}`, x);

  const vj = verdictJsonOf(nv);
  const verdicts = vj ? JSON.parse(vj) : {};
  const media = rankMediaVerdicts(verdicts);
  // 判讀所讀到的新聞標題（newsVerdict/{適用日}.seenJson：代號→標題清單，只有標題沒有連結；連結由前端展開時另查 /api/twse/stock-news）
  //   2026-10-08 起大文件改存壓縮欄位 seenGz（seenJsonOf 新舊格式都讀）；壓縮壞掉只少了標題，不擋整份報告
  const tDate = typeof nv?.targetDate === 'string' ? nv.targetDate : null;
  const full = tDate ? await get('newsVerdict', tDate) : null;
  let seenRaw: string | null = null;
  try { seenRaw = seenJsonOf(full); } catch { seenRaw = null; }
  const seen: Record<string, string[]> = seenRaw ? JSON.parse(seenRaw) : {};
  media.items = media.items.map(x => ({ ...x, titles: (seen[x.code] ?? []).slice(-6).map(t => String(t).slice(0, 120)) }));
  const official = rankOfficial([...mops.values()]);
  return {
    dataDate: lastTrading,
    media: { ...media, targetDate: nv?.targetDate ?? null, lastPass: nv?.lastPass ?? null, updatedAt: nv?.updatedAt ?? null, covered: nv?.covered ?? null },
    official: { ...official, items: unjudgedOfficial(official.items), since: sinceMs },
    note: '排序＝顯示用先驗權重，不是分數；媒體＝AI 讀完內文判別，官方＝公告主旨只用來分類（未讀內文，方向一律未判讀）；兩條管線分開，不加總。非投資建議。',
  };
});

export async function GET() {
  const data = await build();
  if (!data) return unavailable('after-market-news');
  return gzipJsonAuto(data, cacheHeader('intraday'));
}
