// ─────────────────────────────────────────────────────────────────────────────
// newsVerdict 文件的壓縮格式——讀取端唯一實作（daemon、本機腳本、網站路由共用；2026-10-08）
//
// 事故：2026-10-07 23:30 起盤後趟寫 newsVerdict/2026-10-08 時，verdictJson（拿掉稽核軌跡後仍 551～666KB）＋seenJson（已見標題）
//   超過 Firestore 單檔上限 1,048,576 bytes ⇒ 分段存檔與最終寫入全部 INVALID_ARGUMENT、午夜後又不重試 ⇒ 整趟丟失，
//   10-08 覆蓋只剩 115 檔（10-07 為 373 檔）。違反「交易日不得有資料缺漏」。
// 格式：大欄位放不下時改存 gzip＋base64 字串（寫入端見 news-verdict-write.mjs）——
//   verdictGz ＝ verdictJson 的壓縮版；seenGz ＝ seenJson（代號→已見標題）的壓縮版。
//   寫入端保證同一份文件同一欄位只有一種格式（寫壓縮欄位時刪掉明文欄位，反之亦然）；萬一並存，壓縮欄位優先（較新的寫入端才會寫它）。
//   舊文件（只有明文欄位）照讀，不回溯改寫歷史文件。
// ⚠ 只給伺服器／node 用（node:zlib）：不可被前端元件 import——warroom-news.mjs、news-rule-*.mjs 這些前後端共用的模組不要 import 這支；
//   它們吃明文欄位，呼叫端先用 plainNewsVerdictDoc 轉好再交給它們。
// 單元測試 news-verdict-codec.test.mjs。
// ─────────────────────────────────────────────────────────────────────────────
import { gzipSync, gunzipSync } from 'node:zlib';

/** Firestore 單一文件上限（bytes） */
export const NV_DOC_LIMIT = 1_048_576;
/** 明文欄位 → 壓縮欄位 */
export const NV_GZ_FIELD = Object.freeze({ verdictJson: 'verdictGz', seenJson: 'seenGz' });

/** 字串 → gzip → base64 */
export function gzB64(str) {
  return gzipSync(Buffer.from(String(str ?? ''), 'utf8')).toString('base64');
}

/** base64 → gunzip → 字串（壞資料會丟錯，由呼叫端決定要當「不存在」還是中止） */
export function unGzB64(b64) {
  return gunzipSync(Buffer.from(String(b64), 'base64')).toString('utf8');
}

const isDoc = d => !!d && typeof d === 'object' && !Array.isArray(d);

function jsonField(doc, plainKey) {
  if (!isDoc(doc)) return null;
  const gz = doc[NV_GZ_FIELD[plainKey]];
  if (typeof gz === 'string' && gz.length) return unGzB64(gz);
  const s = doc[plainKey];
  return typeof s === 'string' ? s : null;
}

/**
 * 文件 → 判別表的 JSON 字串（壓縮優先、否則明文；兩者都沒有回 null）。
 * @param {Record<string, unknown> | null | undefined} doc
 * @returns {string | null}  壓縮欄位壞掉時丟錯
 */
export function verdictJsonOf(doc) { return jsonField(doc, 'verdictJson'); }

/**
 * 文件 → 已見標題的 JSON 字串（同上）。
 * @param {Record<string, unknown> | null | undefined} doc
 * @returns {string | null}
 */
export function seenJsonOf(doc) { return jsonField(doc, 'seenJson'); }

/**
 * 文件 → 判別表物件（沒有回 {}）。壞資料（壓縮壞、JSON 壞）丟錯：寫入端靠它讀前一份，吞掉會把整份判別覆寫成空的。
 * @param {Record<string, unknown> | null | undefined} doc
 * @returns {Record<string, any>}
 */
export function verdictsOf(doc) {
  const j = verdictJsonOf(doc);
  return j ? JSON.parse(j) : {};
}

/**
 * 文件 → 已見標題物件（代號→標題陣列；沒有回 {}）。壞資料丟錯（理由同上）。
 * @param {Record<string, unknown> | null | undefined} doc
 * @returns {Record<string, string[]>}
 */
export function seenOf(doc) {
  const j = seenJsonOf(doc);
  return j ? JSON.parse(j) : {};
}

/**
 * 文件 → verdictJson／seenJson 為明文的淺拷貝（給只認明文欄位的既有解析：warroom-news newsBoardFromDoc、
 * ai-stoploss-event ruleBearEvents、網站路由）。沒有壓縮欄位就原物件奉還（不複製）。
 * 壓縮欄位壞掉 ⇒ 該欄位當作不存在（不拿可能過時的明文頂替），並在 nvDecodeError 記原因——讀取端照「無資料」處理，不捏造。
 * @template {Record<string, unknown> | null | undefined} T
 * @param {T} doc
 * @returns {T}
 */
export function plainNewsVerdictDoc(doc) {
  if (!isDoc(doc)) return doc;
  const hasGz = Object.values(NV_GZ_FIELD).some(k => typeof doc[k] === 'string');
  if (!hasGz) return doc;
  /** @type {Record<string, unknown>} */
  const out = { ...doc };
  for (const [plainKey, gzKey] of Object.entries(NV_GZ_FIELD)) {
    delete out[gzKey];
    if (typeof doc[gzKey] !== 'string') continue;
    try { out[plainKey] = jsonField(doc, plainKey); }
    catch (e) {
      delete out[plainKey];
      out.nvDecodeError = `${gzKey}: ${String(e?.message || e).slice(0, 60)}`;
    }
  }
  return /** @type {T} */ (out);
}
