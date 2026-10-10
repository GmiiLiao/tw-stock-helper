// 上市／上櫃公司「主要經營業務」（官方：公開資訊觀測站 t05st03）——讀 Firestore companyBusiness/latest
//   寫入端：scripts/publish-company-business.mjs（股票 wiki 夜間排程末段；內容 sha 沒變不寫）。
//   文件 gz＝gzip+base64 的 { 代號: 主要經營業務 }，約 2,300 檔、壓縮後約 100KB。
//   唯一不變式：memoize 6 小時（in-flight 合流、失敗負快取 10 分鐘），Firestore 讀取次數與線上人數脫鉤。
//   讀不到（文件不存在／解析失敗）回空表 ⇒ 頁面顯示「來源未提供」，不捏造。
import { gunzipSync } from 'node:zlib';
import { getAdminDb } from './firebase-admin';
import { memoize } from './singleflight';

const TTL_MS = 6 * 60 * 60_000;
const NEGATIVE_TTL_MS = 10 * 60_000;

export interface IndustryFacts { count: number | null; pe: number | null; pb: number | null; yield: number | null; revYoY: number | null; chains: string[] }
export interface StockFacts { ind?: string; products?: Array<{ n: string; s?: string }> }
export interface CompanyBusinessTable {
  map: Record<string, string>;
  /** factsGz（2026-10-10 L13）：每檔官方產業別、2025 年報產品；每個官方產業的檔數／同業表中位數／相關產業鏈 */
  stocks: Record<string, StockFacts>;
  industries: Record<string, IndustryFacts>;
  source: string | null;
  fetchedTo: string | null;
}

const EMPTY: CompanyBusinessTable = { map: {}, stocks: {}, industries: {}, source: null, fetchedTo: null };

export const getCompanyBusinessTable = memoize('companyBusiness', TTL_MS, async (): Promise<CompanyBusinessTable> => {
  const db = getAdminDb();
  if (!db) return EMPTY;
  const snap = await db.collection('companyBusiness').doc('latest').get();
  const d = snap.data();
  if (!d || typeof d.gz !== 'string') return EMPTY;
  const map = JSON.parse(gunzipSync(Buffer.from(d.gz, 'base64')).toString('utf8')) as Record<string, string>;
  const facts = typeof d.factsGz === 'string'
    ? JSON.parse(gunzipSync(Buffer.from(d.factsGz, 'base64')).toString('utf8')) as { stocks?: Record<string, StockFacts>; industries?: Record<string, IndustryFacts> }
    : {};
  return { map, stocks: facts.stocks || {}, industries: facts.industries || {}, source: typeof d.source === 'string' ? d.source : null, fetchedTo: typeof d.fetchedTo === 'string' ? d.fetchedTo : null };
}, { negativeTtlMs: NEGATIVE_TTL_MS });

/** 單一代號的官方主要經營業務；讀不到回 null（呼叫端不得捏造預設值） */
export async function mainBusinessOf(code: string): Promise<{ text: string; source: string | null } | null> {
  try {
    const t = await getCompanyBusinessTable();
    const text = t?.map[code];
    return text ? { text, source: t?.source ?? null } : null;
  } catch {
    return null;
  }
}

export interface CompanyFacts {
  /** 官方主要經營業務（MOPS t05st03 原文）；查無 null */
  business: string | null;
  /** 官方產業別名稱（MOPS／證交所）；興櫃也有；查無 null */
  officialIndustry: string | null;
  /** 只收出自 2025 年報的產品（AI 知識補的不收）；沒有就空陣列 */
  products: Array<{ n: string; s?: string }>;
  /** 該官方產業的事實（檔數、站內同業表中位數、相關產業鏈；不含展望）；查無 null */
  industry: (IndustryFacts & { name: string }) | null;
}

/** 單一代號的公司事實；讀不到回全空（呼叫端據實顯示「來源未提供」） */
export async function companyFactsOf(code: string): Promise<CompanyFacts> {
  try {
    const t = await getCompanyBusinessTable();
    const st = t?.stocks[code];
    const ind = st?.ind ? t?.industries[st.ind] : undefined;
    return {
      business: t?.map[code] || null,
      officialIndustry: st?.ind || null,
      products: st?.products || [],
      industry: ind && st?.ind ? { ...ind, name: st.ind } : null,
    };
  } catch {
    return { business: null, officialIndustry: null, products: [], industry: null };
  }
}
