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
];

// Per-code in-memory cache (TTL 5 min) — dedupes Google News RSS hits across
// the rating pipeline, the news route and the daemon → fewer rate-limits.
const _newsCache = new Map<string, { at: number; items: NewsItem[] }>();
const NEWS_TTL = 5 * 60 * 1000;

/** Fetch and filter stock news. Returns up to 25 allow-listed items, newest first. */
export async function getStockNews(code: string, stockName = '', industry = ''): Promise<NewsItem[]> {
  const cacheKey = `${code}|${industry}`;
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

  const siteFilter = FREE_SOURCES.map(s => `site:${s.site}`).join(' OR ');
  const stockQuery = stockName ? `${stockName} ${code} (${siteFilter})` : `${code} 股票 (${siteFilter})`;
  await fetchGoogleNewsRSS(stockQuery, 'company', allNews, `stock-${code}`);

  if (industry) {
    await fetchGoogleNewsRSS(`${industry} 產業 台股 (${siteFilter})`, 'industry', allNews, `ind-${industry}`);
    const policyFilter = POLICY_SOURCES.map(s => `site:${s.site}`).join(' OR ');
    await fetchGoogleNewsRSS(`${industry} (${policyFilter})`, 'policy', allNews, 'policy');
  }

  // Strict allow-list by source name (Google News links are redirects).
  const isAllowed = (n: NewsItem) => {
    if (n.id.startsWith('mops-')) return true;
    const src = (n.source || '').toLowerCase();
    return ALLOW_KEYWORDS.some(k => src.includes(k.toLowerCase()));
  };
  const filtered = allNews.filter(n => isAllowed(n) && !PAID_DOMAINS.some(d => n.url.includes(d)));
  filtered.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  const result = filtered.slice(0, 25);
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
          snippet: item.description || undefined,
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
      description: decodeHTMLEntities(extractTag(content, 'description').replace(/<[^>]*>/g, '').slice(0, 200)),
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

function decodeHTMLEntities(str: string): string {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/');
}
