// ============================================================
// Stock news fetcher (server-only). Shared by /api/twse/stock-news and
// the scoring pipeline (/api/rating news sentiment) so the latter never
// has to self-HTTP-call the route (which fails in serverless).
//
// Strict source allow-list: MOPS 重大訊息 + 經濟日報/工商時報/鉅亨網/
// MoneyDJ/自由財經/中央社 + 經濟部/國發會/國科會/金管會. Paid sites dropped.
// ============================================================

export interface NewsItem {
  id: string;
  title: string;
  source: string;
  time: string;
  url: string;
  category: 'company' | 'industry' | 'policy' | 'market';
  snippet?: string;
}

const PAID_DOMAINS = [
  'businessweekly.com.tw', 'wealth.com.tw', 'cw.com.tw', 'mirrormedia.mg', 'stormmedia.com', 'magazine.businessweekly',
];

// 來源優先序（使用者指定 2026-08-29）：**工商時報／經濟日報優先**，
// 其餘財經網次之，Google News 等聚合來源墊底。
// ⚠ 只把它們寫進 FREE_SOURCES 的 site: 過濾是不夠的——那只決定「查哪些站」，
//   回傳順序仍是 Google 的相關性排序（實測 6226 光鼎的清單 MoneyDJ 排最前面）。
//   要真的優先，必須在**結果端**依來源重新排序。
export const SOURCE_RANK: Record<string, number> = {
  工商時報: 0, 工商: 0, ctee: 0,
  經濟日報: 1, udn: 1,
  鉅亨網: 2, 鉅亨: 2, cnyes: 2,
  MoneyDJ: 3, moneydj: 3,
  自由財經: 4, 自由時報: 4,
  中央社: 5, 中央通訊: 5,
};
export function sourceRank(src?: string): number {
  const t = String(src || '');
  for (const k in SOURCE_RANK) if (t.includes(k)) return SOURCE_RANK[k];
  return 9;   // 未知／聚合來源墊底
}

export const FREE_SOURCES = [
  { label: '經濟日報', site: 'money.udn.com' },
  { label: '工商時報', site: 'ctee.com.tw' },
  { label: '鉅亨網',   site: 'news.cnyes.com' },
  { label: 'MoneyDJ',  site: 'moneydj.com' },
  { label: '自由財經', site: 'ec.ltn.com.tw' },
  { label: '中央社',   site: 'cna.com.tw' },
];
export const POLICY_SOURCES = [
  { label: '經濟部', site: 'moea.gov.tw' },
  { label: '國發會', site: 'ndc.gov.tw' },
  { label: '國科會', site: 'nstc.gov.tw' },
  { label: '金管會', site: 'fsc.gov.tw' },
];

const ALLOW_KEYWORDS = [
  '經濟日報', '工商時報', '工商', '鉅亨', 'MoneyDJ', 'moneydj', '自由財經', '自由時報', '自由',
  '中央社', '中央通訊', '經濟部', '國發會', '國家發展', '國科會', '國家科學', '金管會', '證交所',
  // 輔助來源（使用者指定 2026-08-29：工商／經濟優先，其後才用 moneydj／yahoo／google）。
  // 這是**嚴格白名單**，沒列進來的來源會被整個濾掉——Yahoo 先前就是這樣消失的。
  'yahoo', 'Yahoo奇摩', '奇摩',
];

// Per-code in-memory cache (TTL 5 min) — dedupes Google News RSS hits across
// the rating pipeline, the news route and the daemon → fewer rate-limits.
const _newsCache = new Map<string, { at: number; items: NewsItem[] }>();
const NEWS_TTL = 5 * 60 * 1000;

/** Fetch and filter stock news. Returns up to 25 allow-listed items, newest first. */
export async function getStockNews(code: string, stockName = '', industry = ''): Promise<NewsItem[]> {
  // 查詢字串同時吃 stockName（有名字時查「名稱 代號」，沒有時查「代號 股票」），
  // 快取鍵漏掉它 ⇒ 兩種查法會共用同一筆快取，互相污染。
  const cacheKey = `${code}|${stockName}|${industry}`;
  const cached = _newsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < NEWS_TTL) return cached.items;

  const allNews: NewsItem[] = [];

  // 1. TWSE MOPS 重大訊息 (company-specific)
  try {
    const mopsRes = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap04_L', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' },
      cache: 'no-store',
    });
    if (mopsRes.ok) {
      const data = await mopsRes.json();
      if (Array.isArray(data)) {
        data.filter((item: Record<string, string>) => (item['公司代號'] || item.CODE || item.Code || '') === code)
          .slice(0, 5)
          .forEach((item: Record<string, string>, idx: number) => {
            allNews.push({
              id: `mops-${code}-${idx}`,
              title: (item['主旨 '] || item['主旨'] || item.SUBJECT || '公司重大訊息').trim(),
              source: '證交所公告',
              time: parseROCDateTime(item['發言日期'] || item.DATE || '', item['發言時間'] || item.TIME || ''),
              url: 'https://mops.twse.com.tw/mops/web/t05st02_1',
              category: 'company',
              snippet: `${item['公司名稱'] || ''} (${code}) 重大訊息公告`,
            });
          });
      }
    }
  } catch (e) {
    console.error('[news-server] MOPS fetch error:', e);
  }

  // ⚠ **優先來源必須單獨查，不能併進 site: A OR B 的大查詢**（2026-08-29 實測）：
  //   「台積電 2330 (site:money.udn.com OR site:ctee.com.tw OR …四站)」→ 工商 0 則、經濟日報 0 則，
  //   全被自由財經／MoneyDJ 吃掉；但單獨問 site:money.udn.com 有 6 則、site:ctee.com.tw 有 6 則。
  //   Google News 對 OR 的站台**不會平均分配**，只挑它自己排名高的。
  //   ⇒ 使用者要的「工商／經濟優先」若只靠結果端排序是做不到的——它們根本沒進結果集。
  //   這也與 daemon 的 fetchStockNewsMulti 一致（那邊本來就分開打 fetchCtee / fetchUdnMoney）。
  const PRIORITY = FREE_SOURCES.slice(0, 2);          // 工商時報、經濟日報
  const REST = FREE_SOURCES.slice(2);                 // 鉅亨／MoneyDJ／自由／中央社
  const siteFilter = REST.map(s => `site:${s.site}`).join(' OR ');
  const subject = stockName ? `${stockName} ${code}` : `${code} 股票`;

  // 併發打，避免多兩次 RSS 就把回應時間拉成三倍（單執行緒下 push/去重仍是原子的）。
  await Promise.all([
    ...PRIORITY.map(src =>
      fetchGoogleNewsRSS(`${subject} site:${src.site}`, 'company', allNews, `stock-${code}-${src.site}`)),
    fetchGoogleNewsRSS(`${subject} (${siteFilter})`, 'company', allNews, `stock-${code}`),
  ]);

  if (industry) {
    await Promise.all([
      ...PRIORITY.map(src =>
        fetchGoogleNewsRSS(`${industry} 產業 台股 site:${src.site}`, 'industry', allNews, `ind-${industry}-${src.site}`)),
      fetchGoogleNewsRSS(`${industry} 產業 台股 (${siteFilter})`, 'industry', allNews, `ind-${industry}`),
    ]);
    // 政策來源同樣不能併查（H 族，2026-08-29 實測）：
    //   四個機關併成一個 OR 查詢 →「半導體」只回經濟部與國發會，
    //   **國科會 0 則、金管會 0 則**；但單獨問各自都有。
    //   金管會對金融股、國科會對科技股都是必要來源，被餓死等於整類消息看不到。
    await Promise.all(POLICY_SOURCES.map(src =>
      fetchGoogleNewsRSS(`${industry} site:${src.site}`, 'policy', allNews, `policy-${src.site}`)));
  }

  // Strict allow-list by source name (Google News links are redirects).
  const isAllowed = (n: NewsItem) => {
    if (n.id.startsWith('mops-')) return true;
    const src = (n.source || '').toLowerCase();
    return ALLOW_KEYWORDS.some(k => src.includes(k.toLowerCase()));
  };
  const filtered = allNews.filter(n => isAllowed(n) && !PAID_DOMAINS.some(d => n.url.includes(d)));
  // 排序＝「鮮度層 → 來源優先序 → 時間」三層（使用者指定 2026-08-29）。
  // 為什麼不是純粹按來源排：股票新聞的時效性是硬需求，
  //   若只看來源，三天前的工商時報會壓在今天的即時新聞上面，那是另一種錯。
  // 為什麼不是純粹按時間（舊版）：那等於來源優先序完全沒作用，
  //   實測 6226 光鼎的清單 MoneyDJ 排在工商／經濟前面，正是使用者截圖回報的問題。
  // 折衷：先分鮮度層（當日／3日內／更舊），**層內**才讓工商／經濟優先。
  const freshTier = (t: string) => {
    const ageH = (Date.now() - new Date(t).getTime()) / 36e5;
    return !isFinite(ageH) ? 2 : ageH <= 24 ? 0 : ageH <= 72 ? 1 : 2;
  };
  const cmp = (a: NewsItem, b: NewsItem) =>
    freshTier(a.time) - freshTier(b.time) ||
    sourceRank(a.source) - sourceRank(b.source) ||
    new Date(b.time).getTime() - new Date(a.time).getTime();
  filtered.sort(cmp);
  // 政策消息要保留名額，否則永遠進不來（2026-08-29 實測）：
  //   政策來源在 sourceRank 是墊底的 9，排序後穩定落在 25 名之外，
  //   實測 2330／6526／2412／1264／8383 全部 0 則 —— UI 的「🏦 政策」分頁
  //   有做出來卻永遠是空的（使用者截圖裡它根本沒出現）。
  //   政策消息的價值是真的（6548 那則「臺印度產業鏈結論壇·6 項 MOU·10 億商機」
  //   就是有效訊息），不能因為排序墊底就整類消失。
  const CAP = 25, POLICY_QUOTA = 4;
  const pol = filtered.filter(n => n.category === 'policy');
  const rest = filtered.filter(n => n.category !== 'policy');
  const result = [...rest.slice(0, CAP - Math.min(POLICY_QUOTA, pol.length)), ...pol.slice(0, POLICY_QUOTA)]
    .sort(cmp);   // 保留名額後再依同一把尺重排，維持清單順序一致
  // Cache non-empty results only (don't cache a rate-limited empty fetch).
  if (result.length > 0) _newsCache.set(cacheKey, { at: Date.now(), items: result });
  return result;
}

async function fetchGoogleNewsRSS(query: string, category: NewsItem['category'], target: NewsItem[], idPrefix: string) {
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(rssUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'application/xml, text/xml, application/rss+xml' },
      cache: 'no-store',
    });
    clearTimeout(timeoutId);
    if (!res.ok) return;
    const items = parseRSSItems(await res.text());
    items.slice(0, 10).forEach((item, idx) => {
      const dup = target.some(n => n.title === item.title ||
        (n.title.length > 10 && item.title.length > 10 && (item.title.includes(n.title.slice(0, 12)) || n.title.includes(item.title.slice(0, 12)))));
      const paid = PAID_DOMAINS.some(d => (item.link || '').includes(d));
      if (!dup && !paid && item.title) {
        target.push({
          id: `gn-${idPrefix}-${idx}`,
          title: item.title,
          source: mapSourceName(item.source, item.link),
          time: item.pubDate || new Date().toISOString(),
          url: item.link || '',
          category,
          snippet: usefulSnippet(item.title, item.description),
        });
      }
    });
  } catch (e) {
    console.warn(`[news-server] RSS (${idPrefix}) error:`, e);
  }
}

function mapSourceName(rssSource: string, url: string): string {
  if (rssSource) return rssSource;
  const domainMap: Record<string, string> = {
    'money.udn.com': '經濟日報', 'udn.com': '聯合新聞網', 'ctee.com.tw': '工商時報',
    'news.cnyes.com': '鉅亨網', 'cnyes.com': '鉅亨網', 'moneydj.com': 'MoneyDJ',
    'ec.ltn.com.tw': '自由財經', 'ltn.com.tw': '自由時報', 'cna.com.tw': '中央社',
    'moea.gov.tw': '經濟部', 'ndc.gov.tw': '國發會', 'nstc.gov.tw': '國科會', 'fsc.gov.tw': '金管會',
  };
  for (const [domain, n] of Object.entries(domainMap)) if (url.includes(domain)) return n;
  return 'Google News';
}

function parseROCDateTime(dateStr: string, timeStr: string): string {
  try {
    if (!dateStr) return new Date().toISOString();
    const y = parseInt(dateStr.slice(0, 3)) + 1911;
    const m = dateStr.slice(3, 5), d = dateStr.slice(5, 7);
    const hh = timeStr?.slice(0, 2) || '00', mm = timeStr?.slice(2, 4) || '00';
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:00+08:00`).toISOString();
  } catch { return new Date().toISOString(); }
}

function parseRSSItems(xml: string): Array<{ title: string; link: string; pubDate: string; source: string; description: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; source: string; description: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const content = match[1];
    const title = extractTag(content, 'title');
    if (!title) continue;
    items.push({
      title: decodeHTMLEntities(title),
      link: extractTag(content, 'link'),
      pubDate: (() => { const p = extractTag(content, 'pubDate'); return p ? new Date(p).toISOString() : ''; })(),
      source: decodeHTMLEntities(extractTag(content, 'source')),
      // ⚠ 順序不可顛倒（2026-08-29 使用者截圖回報「畫面出現 <a href=...」）：
      //   Google News RSS 的 description 是**HTML 逃脫過的**（&lt;a href=...&gt;），
      //   舊版先 replace(/<[^>]*>/) 再 decode ⇒ 去標籤時還沒有真正的「<」，
      //   等 decode 完標籤**又長回來**，原封不動印到畫面上。
      //   必須：先解碼 → 再去標籤 → 再解一次（有些來源雙重編碼）→ 收斂空白。
      description: decodeHTMLEntities(
        decodeHTMLEntities(extractTag(content, 'description'))
          .replace(/<[^>]*>/g, ' ')
      ).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
    });
  }
  return items;
}

function extractTag(xml: string, tag: string): string {
  const cdata = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i').exec(xml);
  if (cdata) return cdata[1].trim();
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

// Google News RSS 的 description 多半只是「標題＋來源名」再印一次，
// 直接顯示會變成同一句話上下兩行（2026-08-29 使用者截圖回報「重複了，只要一列就好」）。
// 正規化後若兩者互相包含就不給摘要——讓畫面只留標題那一列。
// 只在**確實多出內容**時才顯示摘要。
function usefulSnippet(title: string, desc?: string): string | undefined {
  if (!desc) return undefined;
  const norm = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const [nt, nd] = [norm(title), norm(desc)];
  if (!nd || nt.includes(nd) || nd.includes(nt)) return undefined;
  return desc;
}

function decodeHTMLEntities(str: string): string {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/')
    // 實測 Google News RSS 的 description 尾巴帶 &nbsp;&nbsp;（2026-08-29 抓 6226 光鼎驗證），
    // 舊表沒有它 ⇒ 畫面直接印出「&nbsp;」。連同數值實體一起補，避免下一個漏網實體。
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}
