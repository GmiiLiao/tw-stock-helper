// ─────────────────────────────────────────────────────────────────────────────
// 上市／上櫃公司清單（t187ap03_L／t187ap03_O）：上游抓取＋memoize＋打包進 bundle 的備援
//
// ⚠ 備援檔一律**靜態 import**，讓 bundler 把內容打進 server chunk。
//   舊版用 fs.readFile(process.cwd()/src/lib/...) ——部署產物不含 src/，線上永遠讀不到
//   （2026-10-08 線上實測 2330 公司資訊空白、產業「未分類」）。不要改回執行期讀檔。
//
// 唯一不變式：兩個上游都走 singleflight memoize（TTL 6 小時、in-flight 合流、失敗冷卻 10 分鐘），
// 上游請求數與線上人數脫鉤；上游壞掉時每個實例每 10 分鐘最多重試一次，其餘請求直接走備援。
//
// 備援檔重產（只讀本機官方鏡像 second-brain/official，不打上游）：
//   L ← openapi.twse.com.tw/twse_oa_opendata_t187ap03_L 最新一份 payload，只留 CompanyInfo 欄位（中文鍵）
//   O ← www.tpex.org.tw/tpex_oa_mopsfin_t187ap03_O 最新一份 payload，只留 normalizeOtc 用到的英文鍵，
//       **去掉 WebAddress**、不像信箱的 EmailAddress 清空——check-source-registry 只豁免 L 快照，
//       O 備援檔不得含 http(s) 網址（scripts/lib/company-list.test.mjs 會擋）。
// 目前內容：L 出表日期 115/10/03（1,095 檔）、O 出表日期 115/10/04（892 檔），鏡像 2026-10-04 取得。
// ─────────────────────────────────────────────────────────────────────────────
import { memoize } from './singleflight';
import listedFallbackRaw from './t187ap03_L_fallback.json';
import otcFallbackRaw from './t187ap03_O_fallback.json';
import {
  findCompany, normalizeListed, normalizeOtc,
  type CompanyInfo, type CompanyLookup,
} from './company-list';

const LISTED_URL = 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L';
const OTC_URL = 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O';

/** 公司基本資料一天最多變一次（openapi 還固定落後一日）——6 小時 TTL 足夠 */
const COMPANY_LIST_TTL_MS = 6 * 60 * 60_000;
/** 上游失敗後冷卻 10 分鐘：線上 openapi 長期失敗時，不要每個請求都重打 */
const COMPANY_LIST_NEGATIVE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
/** memoize 的硬逾時略長於 fetch 逾時，讓 fetch 自己的 AbortSignal 先觸發 */
const MEMO_TIMEOUT_MS = 10_000;
/** Next 資料快取的重新驗證秒數（沿用舊值） */
const REVALIDATE_SECONDS = 3600;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    next: { revalidate: REVALIDATE_SECONDS },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // HTML 錯誤頁／WAF 擋頁在這裡拋 SyntaxError ⇒ memoize 記負快取，呼叫端走備援
  return res.json();
}

const memoOpts = { negativeTtlMs: COMPANY_LIST_NEGATIVE_TTL_MS, timeoutMs: MEMO_TIMEOUT_MS };
const getListedLive = memoize<CompanyInfo[]>('t187ap03_L', COMPANY_LIST_TTL_MS,
  async () => normalizeListed(await fetchJson(LISTED_URL)), memoOpts);
const getOtcLive = memoize<CompanyInfo[]>('t187ap03_O', COMPANY_LIST_TTL_MS,
  async () => normalizeOtc(await fetchJson(OTC_URL)), memoOpts);

/** 備援快照在模組載入時正規化一次；萬一檔案壞了只記錄、回空陣列，不讓整支 API 掛掉 */
function loadFallback(label: string, normalize: () => CompanyInfo[]): CompanyInfo[] {
  try {
    return normalize();
  } catch (err) {
    console.error(`[company-list] 備援快照 ${label} 無法使用：`, err instanceof Error ? err.message : String(err));
    return [];
  }
}
const LISTED_FALLBACK = loadFallback('t187ap03_L', () => normalizeListed(listedFallbackRaw));
const OTC_FALLBACK = loadFallback('t187ap03_O', () => normalizeOtc(otcFallbackRaw));

/** 查單一代號的公司基本資料：即時清單優先，查無或上游不可用時用打包的官方鏡像快照（source='fallback'） */
export async function lookupCompany(code: string): Promise<CompanyLookup> {
  const [listedLive, otcLive] = await Promise.all([getListedLive(), getOtcLive()]);
  return findCompany(code, {
    listedLive,
    otcLive,
    listedFallback: LISTED_FALLBACK,
    otcFallback: OTC_FALLBACK,
  });
}
