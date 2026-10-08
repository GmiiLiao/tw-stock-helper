// ============================================================
// 個股判讀（server-only）：只讀 Firestore，不打任何上游（2026-10-08 hardcoded-to-real-spec F1、§1.4）
//
// 讀取三份 daemon 產出的文件（每 instance 每 10 分鐘最多 3 次讀取，與線上人數無關）：
//   - chipCharacter/latest：byCodeJson[code] = { f20, t20, d20, fStreak, tStreak, … }（法人 20 日累計）
//   - volAvg20/latest：avgJson[code] = 20 日均量（張）
//   - chipDaily 最新一份的 date／at（資料日核對閘門；只取兩欄）
// ⚠ chipDaily 查詢必須用 orderBy('date','desc')：orderBy(documentId,'desc') 缺索引會回 FAILED_PRECONDITION，
//   memoize 會一直負快取、整欄變「暫時無法取得」（2026-10-08 實測）。
// ⚠ 公開頁文字不得出現集合名——集合名只寫在這支 server 檔的註解與查詢裡。
// ============================================================

import { getAdminDb } from '@/lib/firebase-admin';
import { memoize } from '@/lib/singleflight';
import { primeHolidays } from '@/lib/api-cache';
import { isTradingYmd } from '@/lib/market-clock';
import { buildInstFlowTable, ymdTpe, type InstFlowTable } from '@/lib/stock-readings';

const INST_FLOW_TTL_MS = 10 * 60_000;
const INST_FLOW_NEGATIVE_TTL_MS = 60_000;
const INST_FLOW_TIMEOUT_MS = 8_000;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const ymdOrNull = (v: unknown): string | null => (typeof v === 'string' && YMD_RE.test(v) ? v : null);
const msOrNull = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const ts = v as { toMillis?: () => number } | null;
  return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null;
};

function parseJsonObject(raw: unknown, where: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error(`${where}: JSON 欄位不存在`);
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${where}: JSON 不是物件`);
  return parsed as Record<string, unknown>;
}

/** 逐日籌碼最新一份的資料日；失敗回 null（不丟錯——只讓核對閘門寫「未能核對」） */
async function readLatestDailyYmd(): Promise<string | null> {
  const db = getAdminDb();
  if (!db) return null;
  try {
    const q = await db.collection('chipDaily').orderBy('date', 'desc').limit(1).select('date', 'at').get();
    return q.empty ? null : ymdOrNull(q.docs[0].get('date'));
  } catch (err) {
    console.warn('[stock-readings] 逐日籌碼資料日讀取失敗（只影響核對閘門）:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * F1 法人籌碼動向的比較表。memoize 10 分鐘＋負快取 60 秒＋8 秒逾時；
 * 兩份主文件讀不到或 JSON 解析失敗就丟錯（memoize 負快取，route 收到 null → unavailable）。
 */
export const getInstFlowTable = memoize<InstFlowTable>('inst-flow-20', INST_FLOW_TTL_MS, async () => {
  const db = getAdminDb();
  if (!db) throw new Error('Admin Firestore unavailable');
  const [charSnap, volSnap, dailyYmd] = await Promise.all([
    db.collection('chipCharacter').doc('latest').get(),
    db.collection('volAvg20').doc('latest').get(),
    readLatestDailyYmd(),
  ]);
  if (!charSnap.exists) throw new Error('法人 20 日彙整文件不存在');
  if (!volSnap.exists) throw new Error('20 日均量文件不存在');
  const ch = charSnap.data() ?? {};
  const va = volSnap.data() ?? {};
  return buildInstFlowTable({
    charByCode: parseJsonObject(ch.byCodeJson, '法人 20 日彙整'),
    charYmd: ymdOrNull(ch.date),
    charWrittenMs: msOrNull(ch.at),
    avgByCode: parseJsonObject(va.avgJson, '20 日均量'),
    volYmd: ymdOrNull(va.date),
    volWrittenMs: msOrNull(va.at),
    dailyYmd,
  });
}, { negativeTtlMs: INST_FLOW_NEGATIVE_TTL_MS, timeoutMs: INST_FLOW_TIMEOUT_MS });

/** 過期判定用的「今天」與交易日判定（先載入休市日曆；失敗 fail-open 只擋週末） */
export async function readingClock(): Promise<{ todayYmd: string; isTradingYmd: (ymd: string) => boolean }> {
  try { await primeHolidays(); } catch { /* fail-open：只擋週末 */ }
  return { todayYmd: ymdTpe(Date.now()), isTradingYmd };
}
