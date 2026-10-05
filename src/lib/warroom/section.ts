// 聚合路由的「區段包裝」：每個區塊各自成敗，一塊失敗不拖垮整支路由。
// build-* 一律回 Section<T>：成功 { ok:true, data, asOf }，失敗 { ok:false, error, asOf:null }。
// asOf＝資料本身的時間（daemon 寫入的 updatedAt／at／revealAt 等，epoch ms），不是路由組裝時間——前端據此畫資料章。
import { toEpochMs } from '../../../scripts/lib/warroom-freshness.mjs';

export type Section<T> =
  | { ok: true; data: T; asOf: number | null }
  | { ok: false; error: string; asOf: null };

export function okSection<T>(data: T, asOf: number | null): Section<T> {
  return { ok: true, data, asOf };
}

/** error 是給畫面看的短句（繁中、不含內部細節），例：「資料尚未產生」「讀取失敗」 */
export function errSection<T = never>(error: string): Section<T> {
  return { ok: false, error, asOf: null };
}

/** 包住 build 主體：丟錯 ⇒ 記 server log、回 ok:false（錯誤細節不回給公開呼叫端） */
export async function guardSection<T>(name: string, fn: () => Promise<Section<T>>): Promise<Section<T>> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[warroom] ${name} 組裝失敗`, e instanceof Error ? e.message : e);
    return errSection<T>('組裝失敗');
  }
}

/** 任意時間欄位值（ms／秒／ISO／Firestore Timestamp）→ epoch ms；認不得回 null */
export { toEpochMs };

/** 依序取文件的第一個可用時間欄位（預設 updatedAt → at → generatedAt → revealAt）→ epoch ms */
export function asOfOf(
  doc: Record<string, unknown> | null | undefined,
  keys: readonly string[] = ['updatedAt', 'at', 'generatedAt', 'revealAt'],
): number | null {
  if (!doc) return null;
  for (const k of keys) {
    const t = toEpochMs(doc[k]);
    if (t != null) return t;
  }
  return null;
}
