// ============================================================
// 上櫃收盤（server-only, admin）：讀 daemon 寫的 Firestore tpexClose/latest。
//
// 為什麼不再直打 TPEx（2026-10-08）：櫃買 openapi 收盤檔 4.78MB 未壓縮，本機實測 15–240KB/s，
// 網站的 8 秒總逾時要 ≥600KB/s 才收得完 ⇒ 推定常失敗；而 cacheValid 要求上市、上櫃兩份都有，
// 上櫃從沒成功過的 instance 快取永遠無效 ⇒ 每個打到 origin 的請求都重打 STOCK_DAY_ALL 與 TPEx
// （上游請求數隨請求量成長，違反唯一不變式）。
// 現在：daemon（台灣 IP、共用取得層、已驗證）寫 tpexClose/latest；這裡 memoize 10 分鐘＋stale-if-error，
// 每個 instance 每 10 分鐘最多 1 次 Firestore 讀取，與線上人數無關；對 TPEx 的請求＝0。
//
// 文件格式（scripts/lib/tpex-close-parse.mjs firestoreDocOf）：
//   dataDate（來源自報 YYYY-MM-DD）、roc（民國 YYYMMDD）、fields（欄名陣列）、rowsJson（每列依 fields 排的字串陣列）、
//   rows（列數）、stocks4、etf00、source、sha256、fetchedAt、updatedAt。
// ============================================================

import { getAdminDb } from './firebase-admin';
import { memoize } from './singleflight';
import { decodeTpexCloseDoc as decodeDoc } from '../../scripts/lib/tpex-close-parse.mjs';

/** openapi 形狀（twse-api-server 的 mappedOtc 讀這些欄位） */
export interface TpexCloseRow {
  Date: string;
  SecuritiesCompanyCode: string;
  CompanyName: string;
  Close: string;
  Change: string;
  Open: string;
  High: string;
  Low: string;
  TradingShares: string;
  TransactionAmount: string;
  TransactionNumber: string;
}

export interface TpexClose {
  /** 來源自報資料日 YYYY-MM-DD */
  dataDate: string;
  /** 民國 YYYMMDD（每列 Date 欄同值） */
  roc: string;
  rows: TpexCloseRow[];
  source: string | null;
}

const TTL_MS = 10 * 60_000;

/**
 * Firestore 文件 → 列；格式不符回 null（不捏造欄位）。
 * 實作在 scripts/lib/tpex-close-parse.mjs（與寫入端 firestoreDocOf 放一起，往返有自動測試——2026-10-08 審查 LOW）。
 */
export function decodeTpexCloseDoc(d: Record<string, unknown> | undefined | null): TpexClose | null {
  return decodeDoc(d) as TpexClose | null;
}

const _readTpexClose = memoize<TpexClose | null>('tpex-close', TTL_MS, async () => {
  const db = getAdminDb();
  if (!db) return null;
  const s = await db.collection('tpexClose').doc('latest').get();
  return decodeTpexCloseDoc(s.exists ? (s.data() as Record<string, unknown>) : null);
}, {
  // 文件不存在／格式不符＝降級：走 30 秒負快取，有舊值就供應舊值（最多 6 小時；上櫃收盤一天只變一次）
  isDegraded: v => !v || (v as TpexClose).rows.length === 0,
  maxStaleMs: 6 * 3600_000,
});

/** 最近一份上櫃收盤（daemon 已驗證）；讀不到回 null——呼叫端照舊走「上櫃缺」的後備路徑 */
export async function readTpexClose(): Promise<TpexClose | null> {
  try { return await _readTpexClose(); } catch { return null; }
}
