import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader, unavailable } from '@/lib/api-cache';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { memoize } from '@/lib/singleflight';
import { rankMediaVerdicts, rankOfficial } from '../../../../../scripts/lib/after-market-news.mjs';

export const runtime = 'nodejs';

// 盤後報告「當晚新聞與分析消息」：只讀 Firestore（daemon 已寫好的判別與索引），在此組裝並依影響比重排序。
//   媒體＝newsVerdict（AI 讀完內文判別）；官方＝mopsNews 重大訊息主旨；導讀＝newsDigest／dailyPost。
//   O、M 兩條管線分開排、不加總；權重全是先驗顯示排序，不是分數（見 scripts/lib/after-market-news.mjs 檔頭）。
// 「當晚」＝最後交易日收盤後（13:30 起）到現在的官方公告；媒體判別取 newsVerdict/latest（盤後趟＋夜間補判）。

const TWO_DAYS = 2 * 86400e3;
const CLOSE_MS = (13 * 60 + 30) * 60e3;
const iso = (ms: number) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

interface MopsItem { code: string; name: string; subject: string; at: number }

const build = memoize('after-market-news', 120_000, async () => {
  const db = getAdminDb();
  if (!db) throw new Error('admin db unavailable');
  const get = async (c: string, d: string) => (await db.collection(c).doc(d).get()).data() ?? null;
  const [nv, digest, post] = await Promise.all([get('newsVerdict', 'latest'), get('newsDigest', 'latest'), get('dailyPost', 'latest')]);
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

  const verdicts = nv?.verdictJson ? JSON.parse(nv.verdictJson as string) : {};
  return {
    dataDate: lastTrading,
    media: { ...rankMediaVerdicts(verdicts), targetDate: nv?.targetDate ?? null, lastPass: nv?.lastPass ?? null, updatedAt: nv?.updatedAt ?? null, covered: nv?.covered ?? null },
    official: { ...rankOfficial([...mops.values()]), since: sinceMs },
    digest: digest ? {
      date: digest.date ?? null, updatedAt: digest.updatedAt ?? null,
      cats: ((digest.cats ?? []) as { key: string; label: string; brief?: string; items?: { title: string; link: string }[] }[])
        .map(c => ({ key: c.key, label: c.label, brief: c.brief ?? null, items: (c.items ?? []).slice(0, 5) })),
    } : null,
    dailyPost: post ? { dataDate: post.dataDate ?? null, post: post.post ?? null } : null,
    note: '排序＝顯示用先驗權重，不是分數；媒體＝AI 讀完內文判別，官方＝公告主旨比對（未讀內文，方向僅規則類）；兩條管線分開，不加總。非投資建議。',
  };
});

export async function GET() {
  const data = await build();
  if (!data) return unavailable('after-market-news');
  return gzipJsonAuto(data, cacheHeader('intraday'));
}
